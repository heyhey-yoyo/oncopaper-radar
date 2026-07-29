import { generateProfile, scorePapers, asyncPool, MODEL_LABELS } from './ai.js';

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const path = url.pathname;

    if (request.method === 'OPTIONS') return cors();

    // API routes
    if (path === '/api/settings'    && request.method === 'GET')  return handleGetSettings(env);
    if (path === '/api/settings'    && request.method === 'POST') return handleSaveSettings(request, env);
    if (path === '/api/sync'       && request.method === 'POST') return handleSync(request, env);
    if (path === '/api/generate-profile' && request.method === 'POST') return handleGenerateProfile(request, env);
    if (path === '/api/debug/sync'  && request.method === 'GET')  return handleDebugSync(env);
    if (path === '/api/debug/ai'    && request.method === 'GET')  return handleDebugAI(env);
    if (path === '/api/digests'     && request.method === 'GET')  return handleGetDigests(request, env);
    if (path === '/api/digests/latest' && request.method === 'GET') return handleGetLatestDigest(request, env);
    if (path === '/api/model-info'  && request.method === 'GET')  return handleModelInfo();

    return serveAssets(request, env);
  },

  async scheduled(_event, env) {
    console.log('Cron trigger: starting daily sync...');
    try {
      const result = await runSync(env);
      console.log(`Sync done: ${result.status}, selected ${result.selected_count ?? 0}`);
    } catch (e) {
      console.error(`Sync error: ${e.message}`);
    }
  },
};

/* ── CORS & JSON ──────────────────────────────────────────── */
function cors(headers) {
  const h = new Headers(headers);
  h.set('Access-Control-Allow-Origin', '*');
  h.set('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  h.set('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  return new Response(null, { status: 204, headers: h });
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
  });
}

/* ── Static assets ───────────────────────────────────────── */
async function serveAssets(request, env) {
  const res = await env.ASSETS.fetch(request);
  const ct = res.headers.get('Content-Type') || '';
  const types = { 'text/html': 'text/html; charset=utf-8', 'text/css': 'text/css; charset=utf-8', 'text/javascript': 'text/javascript; charset=utf-8' };
  for (const [key, val] of Object.entries(types)) {
    if (ct.startsWith(key) && !ct.includes('charset')) {
      const h = new Headers(res.headers);
      h.set('Content-Type', val);
      return new Response(res.body, { status: res.status, headers: h });
    }
  }
  return res;
}

/* ── Auth ─────────────────────────────────────────────────── */
function requireAdmin(request, env) {
  const token = request.headers.get('Authorization')?.replace(/^Bearer\s+/i, '');
  if (!env.ADMIN_TOKEN) return true;
  return !!(token && token === env.ADMIN_TOKEN);
}

/* ── GET /api/model-info ──────────────────────────────────── */
function handleModelInfo() {
  return json({
    primary: 'Qwen3-30B-A3B',
    fallback: 'GLM-4.7-Flash',
    cheap_fallback: 'Granite 4.0 H Micro',
    provider: 'Cloudflare Workers AI',
    mode: 'Free tier priority',
  });
}

/* ── GET /api/settings ────────────────────────────────────── */
async function handleGetSettings(env) {
  const row = await env.DB.prepare('SELECT * FROM settings WHERE id = 1').first();
  if (!row) return json({ error: 'Settings not found' }, 404);
  return json({
    query_groups: safeParse(row.query_groups, []),
    focus: row.focus,
    exclude_terms: row.exclude_terms,
    max_articles: row.max_articles,
    lookback_days: row.lookback_days,
    exclude_reviews: row.exclude_reviews,
    enabled: row.enabled,
    updated_at: row.updated_at,
  });
}

/* ── POST /api/settings ───────────────────────────────────── */
async function handleSaveSettings(request, env) {
  if (!requireAdmin(request, env)) return json({ error: 'Unauthorized' }, 401);
  let body;
  try { body = await request.json(); } catch { return json({ error: 'Bad JSON' }, 400); }

  const query_groups = JSON.stringify(body.query_groups ?? []);
  const focus = String(body.focus ?? '');
  const exclude_terms = String(body.exclude_terms ?? '');
  const max_articles = clamp(Number(body.max_articles) || 5, 1, 10);
  const lookback_days = clamp(Number(body.lookback_days) || 7, 1, 30);
  const exclude_reviews = body.exclude_reviews ? 1 : 0;
  const enabled = body.enabled !== false ? 1 : 0;

  await env.DB.prepare(`
    INSERT INTO settings (id, query_groups, focus, exclude_terms, max_articles, lookback_days, exclude_reviews, enabled, updated_at)
    VALUES (1, ?1, ?2, ?3, ?4, ?5, ?6, ?7, datetime('now'))
    ON CONFLICT(id) DO UPDATE SET
      query_groups = ?1, focus = ?2, exclude_terms = ?3, max_articles = ?4,
      lookback_days = ?5, exclude_reviews = ?6, enabled = ?7, updated_at = datetime('now')
  `).bind(query_groups, focus, exclude_terms, max_articles, lookback_days, exclude_reviews, enabled).run();

  return json({ ok: true });
}

/* ── POST /api/sync ───────────────────────────────────────── */
async function handleSync(request, env) {
  if (!requireAdmin(request, env)) return json({ error: 'Unauthorized' }, 401);
  try {
    const result = await runSync(env);
    return json(result);
  } catch (e) {
    return json({ status: 'error', error: friendlyError(e.message) }, 500);
  }
}

/* ── POST /api/generate-profile ───────────────────────────── */
async function handleGenerateProfile(request, env) {
  if (!requireAdmin(request, env)) return json({ error: 'Unauthorized' }, 401);
  let body;
  try { body = await request.json(); } catch { return json({ error: 'Bad JSON' }, 400); }

  const pmids = (body.pmids || []).map(p => String(p).trim()).filter(Boolean);
  if (!pmids.length) return json({ error: 'No PMIDs provided' }, 400);

  const papers = await fetchEuropePMCByPMIDs(pmids);
  console.log(`Fetched ${papers.length}/${pmids.length} papers from Europe PMC`);
  if (!papers.length) return json({ error: 'No papers found for given PMIDs' }, 404);

  try {
    const result = await generateProfile(env, papers);
    console.log(`Profile generated with model ${result.model}`);
    return json(result);
  } catch (e) {
    console.error(`Generate profile error: ${e.message}`, e.stack?.slice(0, 300));
    return json({ error: friendlyError(e.message), detail: e.message }, 500);
  }
}

/* ── GET /api/debug/sync ──────────────────────────────────── */
async function handleDebugSync(env) {
  const settings = await env.DB.prepare('SELECT * FROM settings WHERE id = 1').first();
  if (!settings) return json({ error: 'Settings not found' }, 404);

  const queryGroups = safeParse(settings.query_groups, []);
  const searchQuery = buildEuroPMCQuery(queryGroups, settings.exclude_terms, settings.exclude_reviews);
  const date = new Date();
  date.setDate(date.getDate() - (settings.lookback_days || 7));
  const fromDate = date.toISOString().slice(0, 10);

  const params = new URLSearchParams({ query: searchQuery, resultType: 'core', pageSize: '50', format: 'json', sort: 'P_PDATE_D desc', fromSearchDate: fromDate });
  const euPmcUrl = `https://www.ebi.ac.uk/europepmc/webservices/rest/search?${params}`;

  let raw;
  try {
    raw = await fetch(euPmcUrl, { headers: { 'Accept': 'application/json' } }).then(r => r.json());
  } catch (e) {
    return json({ error: 'Fetch failed', message: e.message }, 500);
  }

  return json({
    query: searchQuery, eupmc_url: euPmcUrl, lookback_days: settings.lookback_days, from_date: fromDate,
    hit_count: raw?.resultList?.result?.length ?? 0, total_hits: raw?.hitCount ?? 0,
    sample: (raw?.resultList?.result ?? []).slice(0, 3).map(r => ({ title: r.title, pubDate: r.firstPublicationDate, source: r.source })),
  });
}

/* ── GET /api/debug/ai ────────────────────────────────────── */
async function handleDebugAI(env) {
  try {
    const result = await env.AI.run('@cf/qwen/qwen3-30b-a3b-fp8', {
      messages: [{ role: 'system', content: 'Reply with JSON: {"status":"ok"}' }, { role: 'user', content: '{"status":"ok"}' }],
      max_completion_tokens: 500,
    });
    return json({ model: '@cf/zai-org/glm-4.7-flash', ai_ok: true, raw_type: typeof result, response: result });
  } catch (e) {
    return json({ model: '@cf/zai-org/glm-4.7-flash', ai_ok: false, error: e.message }, 500);
  }
}

/* ── GET /api/digests ─────────────────────────────────────── */
async function handleGetDigests(request, env) {
  const url = new URL(request.url);
  const limit = clamp(Number(url.searchParams.get('limit')) || 20, 1, 100);
  const rows = (await env.DB.prepare('SELECT * FROM digests ORDER BY run_at DESC LIMIT ?').bind(limit).all()).results;
  return json(rows);
}

/* ── GET /api/digests/latest ──────────────────────────────── */
async function handleGetLatestDigest(request, env) {
  const digest = await env.DB.prepare("SELECT * FROM digests WHERE status = 'ok' ORDER BY run_at DESC LIMIT 1").first();
  if (!digest) {
    const empty = await env.DB.prepare("SELECT * FROM digests ORDER BY run_at DESC LIMIT 1").first();
    return json({ digest: empty ?? null, articles: [] });
  }

  const items = (await env.DB.prepare(`
    SELECT di.*, a.* FROM digest_items di
    JOIN articles a ON di.article_id = a.id
    WHERE di.digest_id = ? ORDER BY di.rank ASC
  `).bind(digest.id).all()).results;

  return json({ digest, articles: items });
}

/* ═══════════════════════════════════════════════════════════════
   SYNC CORE
   ═══════════════════════════════════════════════════════════════ */
async function runSync(env) {
  const settings = await env.DB.prepare('SELECT * FROM settings WHERE id = 1').first();
  if (!settings || !settings.enabled) {
    await logDigest(env, '', 0, 0, 'skipped', 'Disabled or no settings', '');
    return { status: 'skipped' };
  }

  const queryGroups = safeParse(settings.query_groups, []);
  if (!queryGroups.length) {
    await logDigest(env, '', 0, 0, 'empty', 'No query groups', '');
    return { status: 'empty' };
  }

  const searchQuery = buildEuroPMCQuery(queryGroups, settings.exclude_terms, settings.exclude_reviews);
  const candidates = await fetchEuropePMC(searchQuery, settings.lookback_days, 50);
  console.log(`Europe PMC returned ${candidates.length} candidates`);

  if (!candidates.length) {
    await logDigest(env, searchQuery, 0, 0, 'empty', 'No candidates from Europe PMC', '');
    return { status: 'empty', message: 'Europe PMC returned no results. Try broadening search terms or increasing lookback days.' };
  }

  const fresh = await deduplicateArticles(env, candidates);
  console.log(`${fresh.length} fresh after dedup`);

  if (!fresh.length) {
    await logDigest(env, searchQuery, candidates.length, 0, 'empty', 'All duplicates', '');
    return { status: 'empty', message: 'All candidates were already processed.' };
  }

  // AI scoring (with concurrency control: process in batches of 10)
  const toScore = fresh.slice(0, 20);
  const batches = [];
  for (let i = 0; i < toScore.length; i += 10) {
    batches.push(toScore.slice(i, i + 10));
  }

  let scored = [];
  let modelUsed = '';
  for (const batch of batches) {
    try {
      const result = await scorePapers(env, batch, settings.focus, settings.max_articles);
      scored = scored.concat(result.articles);
      modelUsed = result.model;
    } catch (e) {
      console.error(`AI scoring batch error: ${e.message}`);
      // Continue with what we have
    }
  }

  if (!scored.length) {
    await logDigest(env, searchQuery, candidates.length, 0, 'empty', 'AI scoring failed for all batches', '');
    return { status: 'error', message: friendlyError('AI analysis temporarily unavailable. Search results are preserved; please retry later.') };
  }

  // Sort by total and trim
  scored.sort((a, b) => b.total - a.total);
  scored = scored.slice(0, settings.max_articles);

  const digestId = await storeResults(env, searchQuery, candidates.length, scored, modelUsed);

  return { status: 'ok', digest_id: digestId, selected_count: scored.length, model: modelUsed };
}

/* ── Europe PMC query builder ─────────────────────────────── */
function buildEuroPMCQuery(queryGroups, excludeTerms, excludeReviews) {
  const groups = queryGroups.map(g => {
    const terms = g.split('|').map(t => t.trim()).filter(Boolean);
    if (!terms.length) return null;
    return terms.length === 1 ? `(${terms[0]})` : `(${terms.join(' OR ')})`;
  }).filter(Boolean);

  let query = groups.join(' AND ');
  if (!query) return '';

  if (excludeTerms) {
    const excludeList = excludeTerms.split('|').map(t => t.trim()).filter(Boolean);
    for (const term of excludeList) query += ` NOT (${term})`;
  }
  if (excludeReviews) query += ' NOT (REVIEW_TYPE:"Review")';

  return query;
}

/* ── Europe PMC fetch ─────────────────────────────────────── */
async function fetchEuropePMC(query, lookbackDays, pageSize) {
  const date = new Date();
  date.setDate(date.getDate() - lookbackDays);
  const fromDate = date.toISOString().slice(0, 10);

  const params = new URLSearchParams({ query, resultType: 'core', pageSize: String(pageSize), format: 'json', sort: 'P_PDATE_D desc', fromSearchDate: fromDate });
  const res = await fetch(`https://www.ebi.ac.uk/europepmc/webservices/rest/search?${params}`, { headers: { 'Accept': 'application/json' } });
  if (!res.ok) throw new Error(`Europe PMC HTTP ${res.status}`);

  const data = await res.json();
  return (data.resultList?.result ?? []).map(r => ({
    id: `epmc_${r.source}_${r.id}`, source: r.source, external_id: r.id,
    pmid: r.pmid || null, pmcid: r.pmcid || null, doi: r.doi || null,
    title: r.title || 'Untitled', authors: r.authorString || null,
    journal: r.journalTitle || null,
    pub_date: (r.firstPublicationDate || r.pubYear) ?? null,
    abstract: r.abstractText || null,
    article_url: r.doi ? `https://doi.org/${r.doi}` :
      r.pmcid ? `https://europepmc.org/article/PMC/${r.pmcid}` :
      r.pmid ? `https://pubmed.ncbi.nlm.nih.gov/${r.pmid}` :
      `https://europepmc.org/article/${r.source}/${r.id}`,
    inserted_at: new Date().toISOString(),
  }));
}

/* ── Europe PMC by PMID ───────────────────────────────────── */
async function fetchEuropePMCByPMIDs(pmids) {
  const query = pmids.map(p => `EXT_ID:${p}`).join(' OR ');
  const params = new URLSearchParams({ query, resultType: 'core', pageSize: String(pmids.length), format: 'json', sort: 'P_PDATE_D desc' });
  const res = await fetch(`https://www.ebi.ac.uk/europepmc/webservices/rest/search?${params}`, { headers: { 'Accept': 'application/json' } });
  if (!res.ok) throw new Error(`Europe PMC HTTP ${res.status}`);
  const data = await res.json();
  return (data.resultList?.result ?? []).map(r => ({
    pmid: r.pmid || '', title: r.title || 'Untitled', abstract: r.abstractText || '',
    journal: r.journalTitle || '', pub_date: r.firstPublicationDate || r.pubYear || '',
  }));
}

/* ── Dedup ────────────────────────────────────────────────── */
async function deduplicateArticles(env, candidates) {
  if (!candidates.length) return [];
  const ids = candidates.map(c => c.id);
  const placeholders = ids.map(() => '?').join(',');
  const known = await env.DB.prepare(`SELECT id FROM articles WHERE id IN (${placeholders})`).bind(...ids).all();
  const knownSet = new Set(known.results.map(r => r.id));
  return candidates.filter(c => !knownSet.has(c.id));
}

/* ── Store results ────────────────────────────────────────── */
async function storeResults(env, queryText, candidateCount, scored, model) {
  for (const a of scored) {
    await env.DB.prepare(`
      INSERT OR IGNORE INTO articles (id, source, external_id, pmid, pmcid, doi, title, authors, journal, pub_date, abstract, article_url, inserted_at)
      VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13)
    `).bind(a.id, a.source, a.external_id, a.pmid, a.pmcid, a.doi, a.title, a.authors, a.journal, a.pub_date, a.abstract, a.article_url, a.inserted_at).run();
  }

  const displayModel = MODEL_LABELS[model] || model || 'unknown';
  const digestResult = await env.DB.prepare(`
    INSERT INTO digests (run_at, query_text, candidate_count, selected_count, status, model)
    VALUES (datetime('now'), ?, ?, ?, 'ok', ?)
  `).bind(queryText, candidateCount, scored.length, displayModel).run();

  const digestId = digestResult.meta?.last_row_id;

  for (const a of scored) {
    await env.DB.prepare(`
      INSERT INTO digest_items (digest_id, article_id, rank, relevance, novelty, evidence, surprise, experiment_value, total, evidence_level, why_interesting, mechanism_chain, key_evidence, major_concern, next_experiment)
      VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,?15)
    `).bind(digestId, a.id, a.rank, a.relevance, a.novelty, a.evidence, a.surprise, a.experiment_value, a.total, a.evidence_level, a.why_interesting, a.mechanism_chain, a.key_evidence, a.major_concern, a.next_experiment).run();
  }

  return digestId;
}

/* ── Log digest ───────────────────────────────────────────── */
async function logDigest(env, queryText, candidateCount, selectedCount, status, error, model) {
  await env.DB.prepare(`
    INSERT INTO digests (run_at, query_text, candidate_count, selected_count, status, error, model)
    VALUES (datetime('now'), ?, ?, ?, ?, ?, ?)
  `).bind(queryText, candidateCount, selectedCount, status, error ?? null, model ?? null).run();
}

/* ── Friendly error messages ──────────────────────────────── */
function friendlyError(msg) {
  if (msg.includes('quota') || msg.includes('rate') || msg.includes('429') || msg.includes('limit') || msg.includes('exceeded')) {
    return 'Daily AI quota may be exhausted. Please retry after UTC 00:00 reset. PubMed results are preserved.';
  }
  if (msg.includes('All models failed')) {
    return 'AI analysis temporarily unavailable. Search results are preserved; please retry later.';
  }
  return msg;
}

/* ── Utils ────────────────────────────────────────────────── */
function safeParse(str, fallback) {
  try { const v = JSON.parse(str); return Array.isArray(v) ? v : fallback; } catch { return fallback; }
}
function clamp(v, min, max) {
  return Math.max(min, Math.min(max, Number(v) || min));
}
