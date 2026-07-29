export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const path = url.pathname;

    // CORS 预检
    if (request.method === 'OPTIONS') return cors();

    // API 路由
    if (path === '/api/settings' && request.method === 'GET') {
      return handleGetSettings(env);
    }
    if (path === '/api/settings' && request.method === 'POST') {
      return handleSaveSettings(request, env);
    }
    if (path === '/api/sync' && request.method === 'POST') {
      return handleSync(request, env);
    }
    if (path === '/api/debug/sync' && request.method === 'GET') {
      return handleDebugSync(env);
    }
    if (path === '/api/debug/ai' && request.method === 'GET') {
      return handleDebugAI(env);
    }
    if (path === '/api/digests' && request.method === 'GET') {
      return handleGetDigests(request, env);
    }
    if (path === '/api/digests/latest' && request.method === 'GET') {
      return handleGetLatestDigest(request, env);
    }

    // 静态资源：透传并加正确的 charset
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

/* ── CORS ─────────────────────────────────────────────────── */
function cors(headers) {
  const h = new Headers(headers);
  h.set('Access-Control-Allow-Origin', '*');
  h.set('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  h.set('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  return new Response(null, { status: 204, headers: h });
}

function json(data, status = 200) {
  const body = JSON.stringify(data);
  const headers = {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
  };
  return new Response(body, { status, headers });
}

/* ── 静态资源（加 charset）──────────────────────────────── */
async function serveAssets(request, env) {
  const res = await env.ASSETS.fetch(request);
  const ct = res.headers.get('Content-Type') || '';

  // 对文本类资源补 charset=utf-8，解决中文乱码
  if (ct.startsWith('text/html') && !ct.includes('charset')) {
    return fixCharset(res, 'text/html; charset=utf-8');
  }
  if (ct.startsWith('text/css') && !ct.includes('charset')) {
    return fixCharset(res, 'text/css; charset=utf-8');
  }
  if (ct.startsWith('text/javascript') && !ct.includes('charset')) {
    return fixCharset(res, 'text/javascript; charset=utf-8');
  }

  return res;
}

function fixCharset(res, contentType) {
  const headers = new Headers(res.headers);
  headers.set('Content-Type', contentType);
  return new Response(res.body, { status: res.status, headers });
}

/* ── 认证 ─────────────────────────────────────────────────── */
function requireAdmin(request, env) {
  const token = request.headers.get('Authorization')?.replace(/^Bearer\s+/i, '');
  if (!env.ADMIN_TOKEN) return true; // 未设令牌则跳过
  if (!token || token !== env.ADMIN_TOKEN) return false;
  return true;
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
    return json({ status: 'error', error: e.message }, 500);
  }
}

/* ── GET /api/debug/sync ──────────────────────────────────── */
async function handleDebugSync(env) {
  const settings = await env.DB.prepare('SELECT * FROM settings WHERE id = 1').first();
  if (!settings) return json({ error: 'Settings not found' }, 404);

  const queryGroups = safeParse(settings.query_groups, []);
  const searchQuery = buildEuroPMCQuery(queryGroups, settings.exclude_terms, settings.exclude_reviews);

  // 展示构造的查询
  const date = new Date();
  date.setDate(date.getDate() - (settings.lookback_days || 7));
  const fromDate = date.toISOString().slice(0, 10);

  const params = new URLSearchParams({
    query: searchQuery,
    resultType: 'core',
    pageSize: '50',
    format: 'json',
    sort: 'P_PDATE_D desc',
    fromSearchDate: fromDate,
  });

  const euPmcUrl = `https://www.ebi.ac.uk/europepmc/webservices/rest/search?${params}`;

  // 实际调一次
  let raw;
  try {
    const res = await fetch(euPmcUrl, { headers: { 'Accept': 'application/json' } });
    raw = await res.json();
  } catch (e) {
    return json({ error: 'Fetch failed', message: e.message }, 500);
  }

  return json({
    query: searchQuery,
    eupmc_url: euPmcUrl,
    lookback_days: settings.lookback_days,
    from_date: fromDate,
    hit_count: raw?.resultList?.result?.length ?? 0,
    total_hits: raw?.hitCount ?? 0,
    sample: (raw?.resultList?.result ?? []).slice(0, 3).map(r => ({
      title: r.title,
      pubDate: r.firstPublicationDate,
      source: r.source,
    })),
  });
}

/* ── GET /api/debug/ai ────────────────────────────────────── */
async function handleDebugAI(env) {
  const model = env.AI_MODEL || '@cf/meta/llama-3.1-8b-instruct-fast';
  try {
    const result = await env.AI.run(model, {
      messages: [
        { role: 'system', content: '用 JSON 回复，格式：{"status":"ok"}' },
        { role: 'user', content: '回复 {"status":"ok"}' },
      ],
      response_format: { type: 'json_object' },
      max_tokens: 100,
    });
    return json({
      model,
      ai_ok: true,
      raw_type: typeof result,
      response: result,
    });
  } catch (e) {
    return json({
      model,
      ai_ok: false,
      error: e.message,
      stack: e.stack?.slice(0, 500),
    }, 500);
  }
}

/* ── GET /api/digests ─────────────────────────────────────── */
async function handleGetDigests(request, env) {
  const url = new URL(request.url);
  const limit = clamp(Number(url.searchParams.get('limit')) || 20, 1, 100);
  const rows = (await env.DB.prepare(
    'SELECT * FROM digests ORDER BY run_at DESC LIMIT ?'
  ).bind(limit).all()).results;
  return json(rows);
}

/* ── GET /api/digests/latest ──────────────────────────────── */
async function handleGetLatestDigest(request, env) {
  const digest = await env.DB.prepare(
    "SELECT * FROM digests WHERE status = 'ok' ORDER BY run_at DESC LIMIT 1"
  ).first();

  if (!digest) {
    const empty = await env.DB.prepare("SELECT * FROM digests ORDER BY run_at DESC LIMIT 1").first();
    return json({ digest: empty ?? null, articles: [] });
  }

  const items = (await env.DB.prepare(`
    SELECT di.*, a.* FROM digest_items di
    JOIN articles a ON di.article_id = a.id
    WHERE di.digest_id = ?
    ORDER BY di.rank ASC
  `).bind(digest.id).all()).results;

  return json({ digest, articles: items });
}

/* ═══════════════════════════════════════════════════════════════
   SYNC 核心流程
   ═══════════════════════════════════════════════════════════════ */
async function runSync(env) {
  const settings = await env.DB.prepare('SELECT * FROM settings WHERE id = 1').first();
  if (!settings || !settings.enabled) {
    await logDigest(env, '', 0, 0, 'skipped', 'Disabled or no settings');
    return { status: 'skipped' };
  }

  const queryGroups = safeParse(settings.query_groups, []);
  if (!queryGroups.length) {
    await logDigest(env, '', 0, 0, 'empty', 'No query groups');
    return { status: 'empty' };
  }

  const searchQuery = buildEuroPMCQuery(queryGroups, settings.exclude_terms, settings.exclude_reviews);
  const candidates = await fetchEuropePMC(searchQuery, settings.lookback_days, 50);
  console.log(`Europe PMC returned ${candidates.length} candidates`);

  if (!candidates.length) {
    await logDigest(env, searchQuery, 0, 0, 'empty', 'No candidates from Europe PMC');
    return { status: 'empty' };
  }

  // 去重
  const fresh = await deduplicateArticles(env, candidates);
  console.log(`${fresh.length} fresh after dedup`);

  if (!fresh.length) {
    await logDigest(env, searchQuery, candidates.length, 0, 'empty', 'All duplicates');
    return { status: 'empty' };
  }

  // AI 评分
  const scored = await scoreWithAI(env, fresh.slice(0, 20), settings.focus, settings.max_articles);
  console.log(`AI selected ${scored.length} articles`);

  if (!scored.length) {
    await logDigest(env, searchQuery, candidates.length, 0, 'empty', 'AI scored none');
    return { status: 'empty' };
  }

  // 存储
  const digestId = await storeResults(env, searchQuery, candidates.length, scored);

  return { status: 'ok', digest_id: digestId, selected_count: scored.length };
}

/* ── 构造 Europe PMC 查询 ─────────────────────────────────── */
function buildEuroPMCQuery(queryGroups, excludeTerms, excludeReviews) {
  const groups = queryGroups.map(g => {
    const terms = g.split('|').map(t => t.trim()).filter(Boolean);
    if (!terms.length) return null;
    return terms.length === 1 ? `(${terms[0]})` : `(${terms.join(' OR ')})`;
  }).filter(Boolean);

  let query = groups.join(' AND ');

  if (excludeTerms) {
    const excludeList = excludeTerms.split('|').map(t => t.trim()).filter(Boolean);
    for (const term of excludeList) {
      query += ` NOT (${term})`;
    }
  }

  if (excludeReviews) {
    query += ' NOT (REVIEW_TYPE:"Review")';
  }

  // 不强制限制 SRC:"MED" — MEDLINE 索引有几周延迟，会漏掉最新论文
  // 如需限制，在排除词中加入

  return query;
}

/* ── 调 Europe PMC REST API ───────────────────────────────── */
async function fetchEuropePMC(query, lookbackDays, pageSize) {
  const date = new Date();
  date.setDate(date.getDate() - lookbackDays);
  const fromDate = date.toISOString().slice(0, 10);

  const params = new URLSearchParams({
    query,
    resultType: 'core',
    pageSize: String(pageSize),
    format: 'json',
    sort: 'P_PDATE_D desc',
    fromSearchDate: fromDate,
  });

  const url = `https://www.ebi.ac.uk/europepmc/webservices/rest/search?${params}`;
  const res = await fetch(url, { headers: { 'Accept': 'application/json' } });
  if (!res.ok) throw new Error(`Europe PMC HTTP ${res.status}`);

  const data = await res.json();
  return (data.resultList?.result ?? []).map(r => ({
    id: `epmc_${r.source}_${r.id}`,
    source: r.source,
    external_id: r.id,
    pmid: r.pmid || null,
    pmcid: r.pmcid || null,
    doi: r.doi || null,
    title: r.title || 'Untitled',
    authors: r.authorString || null,
    journal: r.journalTitle || null,
    pub_date: (r.firstPublicationDate || r.pubYear) ?? null,
    abstract: r.abstractText || null,
    article_url:
      r.doi ? `https://doi.org/${r.doi}` :
      r.pmcid ? `https://europepmc.org/article/PMC/${r.pmcid}` :
      r.pmid ? `https://pubmed.ncbi.nlm.nih.gov/${r.pmid}` :
      `https://europepmc.org/article/${r.source}/${r.id}`,
    inserted_at: new Date().toISOString(),
  }));
}

/* ── D1 去重 ──────────────────────────────────────────────── */
async function deduplicateArticles(env, candidates) {
  if (!candidates.length) return [];
  const ids = candidates.map(c => c.id);
  const placeholders = ids.map(() => '?').join(',');

  const known = await env.DB.prepare(
    `SELECT id FROM articles WHERE id IN (${placeholders})`
  ).bind(...ids).all();

  const knownSet = new Set(known.results.map(r => r.id));
  return candidates.filter(c => !knownSet.has(c.id));
}

/* ── Workers AI 评分 ──────────────────────────────────────── */
async function scoreWithAI(env, articles, focus, maxArticles) {
  const model = env.AI_MODEL || '@cf/meta/llama-3.1-8b-instruct-fast';

  // 分批：一次最多评 10 篇，取 top N 合并后再评
  const batch = articles.slice(0, 10);

  const focusText = focus || '优先原创机制研究；关注遗传学证据和体内模型';

  const articlesText = batch.map((a, i) =>
    `[${i}] 标题: ${a.title}\n摘要: ${(a.abstract || '无摘要').slice(0, 1500)}`
  ).join('\n\n');

  const systemPrompt = `你是肿瘤分子机制领域的资深研究员。根据以下研究者偏好，从候选论文中选出最值得关注的 ${maxArticles} 篇（最多不超过${maxArticles}篇），并给出结构化评分。

研究者偏好：${focusText}

对每篇入选论文，给出：
- relevance (1-10): 与研究偏好的相关度
- novelty (1-10): 新颖性
- evidence (1-10): 证据强度（考虑模型、实验设计、样本量）
- surprise (1-10): 反直觉程度
- experiment_value (1-10): 对实验设计的启发价值
- evidence_level: "强" / "中" / "弱"
- why_interesting: 2-3句，为什么值得关注
- mechanism_chain: 涉及的分子机制链（1-2句）
- key_evidence: 最关键的一条证据
- major_concern: 最主要的一个疑点或局限
- next_experiment: 最直接的下一步验证实验

只输出 JSON 数组。对于不入选的论文不要输出。按综合得分从高到低排列。`;

  const userMessage = `候选论文：\n\n${articlesText}\n\n请选出最多 ${maxArticles} 篇最值得关注的论文，只输出 JSON 数组。`;

  try {
    const result = await env.AI.run(model, {
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userMessage },
      ],
      response_format: { type: 'json_object' },
      max_tokens: 4096,
    });

    // Workers AI 返回格式: { response: { choices: [{ message: { content: "..." } }] } }
    const text = result?.response?.choices?.[0]?.message?.content
      ?? (typeof result?.response === 'string' ? result.response : null)
      ?? result?.response
      ?? result;
    if (!text || typeof text !== 'string') throw new Error('Empty AI response');

    // 尝试解析 JSON
    let parsed;
    try {
      parsed = JSON.parse(text);
    } catch {
      const match = text.match(/\[[\s\S]*\]/);
      if (match) parsed = JSON.parse(match[0]);
      else throw new Error('Cannot parse AI response');
    }

    // 统一成数组
    const items = Array.isArray(parsed) ? parsed : (parsed.articles ?? parsed.results ?? [parsed]);

    // 映射回候选论文
    return items.slice(0, maxArticles).map((item, idx) => {
      const articleIdx = item.index ?? item.idx ?? idx;
      const article = batch[articleIdx] ?? batch[idx];
      const total = (item.relevance ?? 0) + (item.novelty ?? 0) + (item.evidence ?? 0) +
                    (item.surprise ?? 0) + (item.experiment_value ?? 0);

      return {
        ...article,
        rank: idx + 1,
        relevance: item.relevance ?? 5,
        novelty: item.novelty ?? 5,
        evidence: item.evidence ?? 5,
        surprise: item.surprise ?? 5,
        experiment_value: item.experiment_value ?? 5,
        total,
        evidence_level: item.evidence_level ?? '中',
        why_interesting: item.why_interesting ?? '',
        mechanism_chain: item.mechanism_chain ?? '',
        key_evidence: item.key_evidence ?? '',
        major_concern: item.major_concern ?? '',
        next_experiment: item.next_experiment ?? '',
      };
    });
  } catch (e) {
    console.error(`AI scoring error: ${e.message}`);
    // 降级：AI 失败时直接返回前 N 篇，默认评分
    return articles.slice(0, maxArticles).map((a, i) => ({
      ...a,
      rank: i + 1,
      relevance: 5, novelty: 5, evidence: 5, surprise: 5, experiment_value: 5, total: 25,
      evidence_level: '中',
      why_interesting: `AI 评分暂时不可用：${e.message}`,
      mechanism_chain: '', key_evidence: '', major_concern: '', next_experiment: '',
    }));
  }
}

/* ── 存储结果 ─────────────────────────────────────────────── */
async function storeResults(env, queryText, candidateCount, scored) {
  // 先去重存 articles
  for (const a of scored) {
    await env.DB.prepare(`
      INSERT OR IGNORE INTO articles (id, source, external_id, pmid, pmcid, doi,
        title, authors, journal, pub_date, abstract, article_url, inserted_at)
      VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13)
    `).bind(a.id, a.source, a.external_id, a.pmid, a.pmcid, a.doi,
            a.title, a.authors, a.journal, a.pub_date, a.abstract, a.article_url, a.inserted_at).run();
  }

  // 存 digest
  const digestResult = await env.DB.prepare(`
    INSERT INTO digests (run_at, query_text, candidate_count, selected_count, status)
    VALUES (datetime('now'), ?, ?, ?, 'ok')
  `).bind(queryText, candidateCount, scored.length).run();

  const digestId = digestResult.meta?.last_row_id;

  // 存 digest_items
  for (const a of scored) {
    await env.DB.prepare(`
      INSERT INTO digest_items (digest_id, article_id, rank,
        relevance, novelty, evidence, surprise, experiment_value, total,
        evidence_level, why_interesting, mechanism_chain, key_evidence,
        major_concern, next_experiment)
      VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15)
    `).bind(digestId, a.id, a.rank,
            a.relevance, a.novelty, a.evidence, a.surprise, a.experiment_value, a.total,
            a.evidence_level, a.why_interesting, a.mechanism_chain, a.key_evidence,
            a.major_concern, a.next_experiment).run();
  }

  return digestId;
}

/* ── 记录 digest 日志 ─────────────────────────────────────── */
async function logDigest(env, queryText, candidateCount, selectedCount, status, error) {
  await env.DB.prepare(`
    INSERT INTO digests (run_at, query_text, candidate_count, selected_count, status, error)
    VALUES (datetime('now'), ?, ?, ?, ?, ?)
  `).bind(queryText, candidateCount, selectedCount, status, error ?? null).run();
}

/* ── 工具 ─────────────────────────────────────────────────── */
function safeParse(str, fallback) {
  try { const v = JSON.parse(str); return Array.isArray(v) ? v : fallback; }
  catch { return fallback; }
}

function clamp(v, min, max) {
  return Math.max(min, Math.min(max, Number(v) || min));
}
