import { WorkflowEntrypoint } from 'cloudflare:workers';
import {
  generateProfile,
  heuristicScore,
  MODEL_LABELS,
  PROMPT_VERSION,
  scorePapers,
} from './ai.js';
import {
  buildEuropePMCQuery,
  buildPubMedQuery,
  normalizeExcludeTerms,
  normalizeQueryGroups,
} from './query.js';

// ⚠️ D1 SQL变量上限较低，chunk 控制在 30 以内避免 "too many SQL variables"
const D1_BIND_CHUNK = 30;
const MAX_CANDIDATES = 80;
const MIN_SEARCH_RESULTS = 5;
const RUN_STALE_MINUTES = 120;
const NETWORK_STEP_CONFIG = {
  retries: { limit: 3, delay: '5 seconds', backoff: 'exponential' },
  timeout: '5 minutes',
};
const AI_STEP_CONFIG = {
  // AI already has a bounded two-model fallback. Workflow-level retries would
  // multiply inference cost, so this step receives one durable attempt.
  retries: { limit: 1, delay: '1 second', backoff: 'constant' },
  timeout: '10 minutes',
};
let schemaReadyPromise = null;

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const path = url.pathname;

    if (request.method === 'OPTIONS') return corsResponse(request);

    try {
      if (path.startsWith('/api/')) await ensureSchema(env);

      if (path === '/api/auth/check' && request.method === 'GET') {
        return requireAdminResponse(request, env) ?? json({ ok: true });
      }
      if (path === '/api/settings' && request.method === 'GET') return handleGetSettings(env);
      if (path === '/api/settings' && request.method === 'POST') return handleSaveSettings(request, env);
      if (path === '/api/sync' && request.method === 'POST') return handleStartSync(request, env);
      if (path === '/api/generate-profile' && request.method === 'POST') return handleStartProfile(request, env);
      if (path === '/api/runs/active' && request.method === 'GET') return handleGetActiveRun(request, env);
      if (path.startsWith('/api/runs/') && request.method === 'GET') return handleGetRun(request, env, path);
      if (path === '/api/digests' && request.method === 'GET') return handleGetDigests(request, env);
      if (path === '/api/digests/latest' && request.method === 'GET') return handleGetLatestDigest(env);
      if (path === '/api/model-info' && request.method === 'GET') return handleModelInfo();
      if (path.startsWith('/api/')) return json({ error: 'API route not found.' }, 404);

      return serveAssets(request, env);
    } catch (error) {
      console.error('[HTTP] unhandled error', error);
      const status = error instanceof HttpError ? error.status : 500;
      return json({ error: friendlyError(error) }, status);
    }
  },

  async scheduled(_event, env) {
    try {
      await ensureSchema(env);
      const settings = await getSettingsRow(env);
      if (!settings?.enabled) return;
      const active = await findActiveRun(env, 'sync');
      if (active) {
        console.log(`[Cron] sync already active: ${active.id}`);
        return;
      }
      const run = await createWorkflowRun(env, 'sync', {});
      console.log(`[Cron] started workflow ${run.id}`);
    } catch (error) {
      console.error('[Cron] failed to start workflow', error);
    }
  },
};

export class RadarWorkflow extends WorkflowEntrypoint {
  async run(event, step) {
    const payload = event.payload ?? {};
    const runId = String(payload.runId ?? event.instanceId ?? '');
    const runType = payload.type === 'profile' ? 'profile' : 'sync';

    try {
      await step.do('initialize-run', async () => {
        await ensureSchema(this.env);
        await updateRun(this.env, runId, {
          status: 'running',
          stage: 'initializing',
          progress: 3,
        });
      });

      if (runType === 'profile') {
        return await this.runProfile(runId, payload, step);
      }
      return await this.runSync(runId, step);
    } catch (error) {
      const message = friendlyError(error);
      console.error(`[Workflow ${runId}] ${message}`, error);
      try {
        await updateRun(this.env, runId, {
          status: 'failed',
          stage: 'failed',
          progress: 100,
          error: message,
          finished_at: new Date().toISOString(),
        });
        if (runType === 'sync') await storeFailureDigest(this.env, runId, message);
      } catch (updateError) {
        console.error(`[Workflow ${runId}] failed to persist error`, updateError);
      }
      throw error;
    }
  }

  async runProfile(runId, payload, step) {
    const pmids = Array.isArray(payload.pmids) ? payload.pmids : [];

    const papers = await step.do('load-seed-papers', NETWORK_STEP_CONFIG, async () => {
      await updateRun(this.env, runId, { stage: 'loading PMIDs', progress: 15 });
      const result = await fetchPapersByPMIDs(pmids, this.env.NCBI_API_KEY);
      if (!result.length) throw new Error('No matching PubMed records were found for the supplied PMIDs.');
      return result;
    });

    const profile = await step.do('generate-profile', AI_STEP_CONFIG, async () => {
      await updateRun(this.env, runId, { stage: 'generating profile', progress: 55 });
      return generateProfile(this.env, papers);
    });

    const result = {
      ...profile,
      model: MODEL_LABELS[profile.model] || profile.model,
      paper_count: papers.length,
    };

    await step.do('complete-profile', async () => {
      await updateRun(this.env, runId, {
        status: 'completed',
        stage: 'completed',
        progress: 100,
        model: result.model,
        result_json: JSON.stringify(result),
        finished_at: new Date().toISOString(),
      });
    });

    return result;
  }

  async runSync(runId, step) {
    const prepared = await step.do('prepare-sync', async () => {
      await updateRun(this.env, runId, { stage: 'reading settings', progress: 8 });
      const settings = await getSettingsRow(this.env);
      if (!settings || !settings.enabled) {
        const result = { status: 'skipped', selected_count: 0 };
        await storeEmptyDigest(this.env, runId, '', 0, 'skipped', 'Disabled or no settings');
        await updateRun(this.env, runId, {
          status: 'completed', stage: 'skipped', progress: 100,
          result_json: JSON.stringify(result), finished_at: new Date().toISOString(),
        });
        return { stop: true, result };
      }

      const queryGroups = normalizeQueryGroups(safeParse(settings.query_groups, []));
      if (!queryGroups.length) {
        const result = { status: 'empty', selected_count: 0, message: 'No query groups configured.' };
        await storeEmptyDigest(this.env, runId, '', 0, 'empty', result.message);
        await updateRun(this.env, runId, {
          status: 'completed', stage: 'completed', progress: 100,
          result_json: JSON.stringify(result), finished_at: new Date().toISOString(),
        });
        return { stop: true, result };
      }

      const normalized = {
        queryGroups,
        focus: cleanText(settings.focus, 3500),
        excludeTerms: normalizeExcludeTerms(settings.exclude_terms),
        maxArticles: clampInt(settings.max_articles, 1, 10),
        lookbackDays: clampInt(settings.lookback_days, 1, 30),
        excludeReviews: Number(settings.exclude_reviews) !== 0,
        queryPlan: normalizeQueryPlan(safeParse(settings.generated_profile, null)),
      };
      normalized.profileHash = await stableHash(JSON.stringify({
        queryGroups: normalized.queryGroups,
        focus: normalized.focus,
        excludeTerms: normalized.excludeTerms,
        queryPlan: normalized.queryPlan,
      }));
      return normalized;
    });

    if (prepared.stop) return prepared.result;

    const searchResult = await step.do('search-literature', NETWORK_STEP_CONFIG, async () => {
      await updateRun(this.env, runId, { stage: 'searching Europe PMC and PubMed', progress: 22 });
      const result = await searchLiterature(this.env, prepared);
      await upsertCandidateMetadata(this.env, result.candidates);
      const compact = {
        queryText: result.queryText,
        tierLabel: result.tierLabel,
        counts: result.counts,
        candidateCount: result.candidates.length,
        candidateIds: result.candidates.map(article => article.canonical_id),
      };
      await updateRun(this.env, runId, {
        query_text: compact.queryText,
        query_tier: compact.tierLabel,
        candidate_count: compact.candidateCount,
        stage: 'search complete',
        progress: 42,
      });
      return compact;
    });

    const candidates = await step.do('prepare-candidates', async () => {
      await updateRun(this.env, runId, { stage: 'deduplicating and pre-ranking', progress: 48 });
      return prepareCandidates(this.env, runId, prepared, searchResult);
    });

    if (candidates.stop) {
      await step.do('complete-empty-sync', async () => {
        await updateRun(this.env, runId, {
          status: 'completed', stage: 'completed', progress: 100,
          result_json: JSON.stringify(candidates.result), finished_at: new Date().toISOString(),
        });
      });
      return candidates.result;
    }

    const scored = await step.do('score-papers', AI_STEP_CONFIG, async () => {
      await updateRun(this.env, runId, { stage: 'AI ranking and analysis', progress: 62 });
      return scorePapers(
        this.env, candidates.toScore, prepared.focus, prepared.maxArticles, prepared.queryGroups,
      );
    });

    const finalResult = await step.do('store-digest', async () => {
      await updateRun(this.env, runId, {
        stage: 'storing digest', progress: 88,
        selected_count: scored.articles.length, model: scored.model,
      });
      const digestId = await storeDigestResults(
        this.env, runId, searchResult.queryText, searchResult.candidateCount, scored.articles, scored.model,
      );
      await persistProcessingDecisions(
        this.env, prepared, scored.articles, candidates.toScore, candidates.preFilteredIds, scored.model,
      );
      return {
        status: 'ok',
        digest_id: digestId,
        candidate_count: searchResult.candidateCount,
        fresh_count: candidates.freshCount,
        scored_count: candidates.toScore.length,
        selected_count: scored.articles.length,
        model: scored.model,
        query_tier: searchResult.tierLabel,
      };
    });

    await step.do('complete-sync', async () => {
      await updateRun(this.env, runId, {
        status: 'completed',
        stage: 'completed',
        progress: 100,
        selected_count: finalResult.selected_count ?? 0,
        model: finalResult.model ?? '',
        result_json: JSON.stringify(finalResult),
        finished_at: new Date().toISOString(),
      });
    });

    return finalResult;
  }
}

/* ── HTTP handlers ────────────────────────────────────────── */
async function handleGetSettings(env) {
  const row = await getSettingsRow(env);
  if (!row) return json({ error: 'Settings not found. Initialize D1 first.' }, 404);
  return json({
    query_groups: normalizeQueryGroups(safeParse(row.query_groups, [])),
    focus: row.focus ?? '',
    exclude_terms: row.exclude_terms ?? '',
    max_articles: row.max_articles,
    lookback_days: row.lookback_days,
    exclude_reviews: row.exclude_reviews,
    enabled: row.enabled,
    generated_profile: normalizeQueryPlan(safeParse(row.generated_profile, null)),
    updated_at: row.updated_at,
  });
}

async function handleSaveSettings(request, env) {
  const denied = requireAdminResponse(request, env);
  if (denied) return denied;

  const body = await readJSON(request, 32_000);
  const queryGroups = normalizeQueryGroups(body.query_groups ?? []);
  if (!queryGroups.length) return json({ error: 'At least one valid query group is required.' }, 400);

  const focus = cleanText(body.focus, 3500);
  const excludeTerms = normalizeExcludeTerms(body.exclude_terms).join(' | ');
  const maxArticles = clampInt(body.max_articles, 1, 10);
  const lookbackDays = clampInt(body.lookback_days, 1, 30);
  const excludeReviews = body.exclude_reviews === false ? 0 : 1;
  const enabled = body.enabled === false ? 0 : 1;
  const generatedProfile = normalizeQueryPlan(body.generated_profile);

  await env.DB.prepare(`
    INSERT INTO settings (
      id, query_groups, focus, exclude_terms, max_articles,
      lookback_days, exclude_reviews, enabled, generated_profile, updated_at
    ) VALUES (1, ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, datetime('now'))
    ON CONFLICT(id) DO UPDATE SET
      query_groups = excluded.query_groups,
      focus = excluded.focus,
      exclude_terms = excluded.exclude_terms,
      max_articles = excluded.max_articles,
      lookback_days = excluded.lookback_days,
      exclude_reviews = excluded.exclude_reviews,
      enabled = excluded.enabled,
      generated_profile = excluded.generated_profile,
      updated_at = datetime('now')
  `).bind(
    JSON.stringify(queryGroups), focus, excludeTerms, maxArticles,
    lookbackDays, excludeReviews, enabled,
    generatedProfile ? JSON.stringify(generatedProfile) : null,
  ).run();

  return json({ ok: true, query_groups: queryGroups, generated_profile: generatedProfile });
}

async function handleStartSync(request, env) {
  const denied = requireAdminResponse(request, env);
  if (denied) return denied;

  const active = await findActiveRun(env, 'sync');
  if (active) {
    return json({ status: active.status, run_id: active.id, already_running: true }, 202);
  }

  const run = await createWorkflowRun(env, 'sync', {});
  return json({ status: 'queued', run_id: run.id }, 202);
}

async function handleStartProfile(request, env) {
  const denied = requireAdminResponse(request, env);
  if (denied) return denied;

  const body = await readJSON(request, 12_000);
  const pmids = [...new Set((Array.isArray(body.pmids) ? body.pmids : [])
    .map(value => String(value).trim())
    .filter(value => /^\d{5,10}$/.test(value)))]
    .slice(0, 12);

  if (!pmids.length) return json({ error: 'Provide 1-12 valid numeric PMIDs.' }, 400);
  const active = await findActiveRun(env, 'profile');
  if (active) {
    return json({ status: active.status, run_id: active.id, already_running: true }, 202);
  }
  const run = await createWorkflowRun(env, 'profile', { pmids });
  return json({ status: 'queued', run_id: run.id }, 202);
}

async function handleGetRun(request, env, path) {
  const denied = requireAdminResponse(request, env);
  if (denied) return denied;
  const id = decodeURIComponent(path.slice('/api/runs/'.length));
  if (!/^[a-z0-9-]{8,100}$/i.test(id)) return json({ error: 'Invalid run ID.' }, 400);
  const row = await env.DB.prepare('SELECT * FROM sync_runs WHERE id = ?').bind(id).first();
  if (!row) return json({ error: 'Run not found.' }, 404);
  return json(serializeRun(row));
}

async function handleGetActiveRun(request, env) {
  const denied = requireAdminResponse(request, env);
  if (denied) return denied;
  const type = new URL(request.url).searchParams.get('type') === 'profile' ? 'profile' : 'sync';
  const row = await findActiveRun(env, type);
  return json({ run: row ? serializeRun(row) : null });
}

async function handleGetDigests(request, env) {
  const limit = clampInt(new URL(request.url).searchParams.get('limit') || 20, 1, 100);
  const rows = (await env.DB.prepare('SELECT * FROM digests ORDER BY run_at DESC LIMIT ?').bind(limit).all()).results;
  return json(rows);
}

async function handleGetLatestDigest(env) {
  const digest = await env.DB.prepare("SELECT * FROM digests WHERE status = 'ok' ORDER BY run_at DESC LIMIT 1").first();
  if (!digest) {
    const latest = await env.DB.prepare('SELECT * FROM digests ORDER BY run_at DESC LIMIT 1').first();
    return json({ digest: latest ?? null, articles: [] });
  }

  const items = (await env.DB.prepare(`
    SELECT di.*, a.*
    FROM digest_items di
    JOIN articles a ON di.article_id = a.id
    WHERE di.digest_id = ?
    ORDER BY di.rank ASC
  `).bind(digest.id).all()).results;

  return json({ digest, articles: items });
}

// ⚠️ 改模型时同步更新这里的字符串（与 src/ai.js 的 MODEL_LABELS 保持一致）
function handleModelInfo() {
  return json({
    primary: 'Qwen3-30B-A3B',
    fallback: 'Granite 4.0 H Micro',
    provider: 'Cloudflare Workers AI',
    execution: 'Cloudflare Workflows',
    prompt_version: PROMPT_VERSION,
  });
}

/* ── Workflow run storage ─────────────────────────────────── */
async function createWorkflowRun(env, type, params) {
  const id = `${type}-${Date.now().toString(36)}-${crypto.randomUUID().slice(0, 8)}`;
  await env.DB.prepare(`
    INSERT INTO sync_runs (id, run_type, status, stage, progress, created_at, updated_at)
    VALUES (?, ?, 'queued', 'queued', 0, datetime('now'), datetime('now'))
  `).bind(id, type).run();

  try {
    await env.RADAR_WORKFLOW.create({ id, params: { ...params, type, runId: id } });
  } catch (error) {
    await updateRun(env, id, {
      status: 'failed', stage: 'failed', progress: 100,
      error: friendlyError(error), finished_at: new Date().toISOString(),
    });
    throw error;
  }
  return { id, type };
}

async function findActiveRun(env, type) {
  return env.DB.prepare(`
    SELECT * FROM sync_runs
    WHERE run_type = ?
      AND status IN ('queued', 'running')
      AND created_at >= datetime('now', ?)
    ORDER BY created_at DESC LIMIT 1
  `).bind(type, `-${RUN_STALE_MINUTES} minutes`).first();
}

async function updateRun(env, id, fields) {
  const allowed = [
    'status', 'stage', 'progress', 'query_text', 'query_tier',
    'candidate_count', 'selected_count', 'model', 'result_json',
    'error', 'finished_at',
  ];
  const entries = Object.entries(fields).filter(([key]) => allowed.includes(key));
  if (!entries.length) return;
  const assignments = entries.map(([key], index) => `${key} = ?${index + 1}`);
  assignments.push('updated_at = datetime(\'now\')');
  const values = entries.map(([, value]) => value ?? null);
  await env.DB.prepare(`UPDATE sync_runs SET ${assignments.join(', ')} WHERE id = ?${values.length + 1}`)
    .bind(...values, id).run();
}

function serializeRun(row) {
  return {
    id: row.id,
    type: row.run_type,
    status: row.status,
    stage: row.stage,
    progress: row.progress,
    query_text: row.query_text,
    query_tier: row.query_tier,
    candidate_count: row.candidate_count,
    selected_count: row.selected_count,
    model: row.model,
    error: row.error,
    result: safeParse(row.result_json, null),
    created_at: row.created_at,
    updated_at: row.updated_at,
    finished_at: row.finished_at,
  };
}

/* ── Search ───────────────────────────────────────────────── */
async function searchLiterature(env, settings) {
  const tiers = buildQueryTiers(settings);
  const counts = [];
  let chosen = null;

  for (const tier of tiers) {
    try {
      const count = await countEuropePMC(tier.europeQuery);
      counts.push({ label: tier.label, count });
      if (count >= MIN_SEARCH_RESULTS) {
        chosen = { ...tier, count };
        break;
      }
    } catch (error) {
      counts.push({ label: tier.label, count: null });
      console.error(`[Europe PMC] count failed for ${tier.label}`, error);
    }
  }

  if (!chosen) {
    const positive = counts
      .map((item, index) => ({ ...item, tier: tiers[index] }))
      .filter(item => Number(item.count) > 0)
      .sort((a, b) => b.count - a.count)[0];
    if (positive) chosen = { ...positive.tier, count: positive.count };
  }

  // If the count endpoint is unavailable or every preflight count is zero,
  // probe the real search tiers in order. This prevents a transient count
  // failure from forcing the strictest query or being misreported as no papers.
  const tiersToProbe = chosen ? [chosen] : tiers;
  const sourceErrors = [];
  for (const tier of tiersToProbe) {
    const [europeResult, pubmedResult] = await Promise.allSettled([
      fetchEuropePMC(tier.europeQuery, 60),
      fetchPubMed(tier.pubmedQuery, env.NCBI_API_KEY),
    ]);

    const europeArticles = europeResult.status === 'fulfilled' ? europeResult.value.articles : [];
    if (europeResult.status === 'rejected') {
      sourceErrors.push(`Europe PMC (${tier.label}): ${friendlyError(europeResult.reason)}`);
      console.error('[Search] Europe PMC', europeResult.reason);
    }

    let pubmedArticles = [];
    let pubmedIDs = [];
    if (pubmedResult.status === 'fulfilled') {
      pubmedIDs = pubmedResult.value.slice(0, 50);
      const existingPMIDs = new Set(europeArticles.map(article => article.pmid).filter(Boolean));
      const missing = pubmedIDs.filter(pmid => !existingPMIDs.has(pmid));
      if (missing.length) pubmedArticles = await fetchPapersByPMIDs(missing, env.NCBI_API_KEY);
    } else {
      sourceErrors.push(`PubMed (${tier.label}): ${friendlyError(pubmedResult.reason)}`);
      console.error('[Search] PubMed', pubmedResult.reason);
    }

    if (europeResult.status === 'rejected' && pubmedResult.status === 'rejected') {
      continue;
    }

    const candidates = mergeArticles([...europeArticles, ...pubmedArticles]).slice(0, MAX_CANDIDATES);
    if (candidates.length || chosen || tier === tiers[tiers.length - 1]) {
      return {
        candidates,
        queryText: `Europe PMC: ${tier.europeQuery}\nPubMed: ${tier.pubmedQuery}`,
        tierLabel: tier.label,
        counts,
        sourceCounts: {
          europePMC: europeResult.status === 'fulfilled' ? europeResult.value.hitCount : null,
          pubmed: pubmedIDs.length,
        },
      };
    }
  }

  throw new Error(`Both literature sources failed. ${sourceErrors.slice(-4).join(' | ')}`);
}

function buildQueryTiers(settings) {
  const groups = settings.queryGroups;
  const planMustCount = clampInt(settings.queryPlan?.must_count ?? Math.min(2, groups.length), 1, groups.length);
  const from = new Date();
  from.setUTCDate(from.getUTCDate() - settings.lookbackDays);
  const fromDate = from.toISOString().slice(0, 10);
  const toDate = new Date().toISOString().slice(0, 10);
  const tiers = [];

  // Generated profiles store required groups first and optional preference
  // groups last. Remove optional groups before weakening a required concept.
  for (let count = groups.length; count >= planMustCount; count -= 1) {
    const activeGroups = groups.slice(0, count);
    tiers.push({
      label: count === groups.length ? `strict-${count}-groups` : `without-optional-${count}-groups`,
      europeQuery: buildEuropePMCQuery(activeGroups, settings.excludeTerms, settings.excludeReviews, fromDate, toDate),
      pubmedQuery: buildPubMedQuery(activeGroups, settings.excludeTerms, settings.excludeReviews, fromDate, toDate),
    });
  }

  const strongest = groups.slice(0, planMustCount);
  tiers.push({
    label: 'required-without-negative-terms',
    europeQuery: buildEuropePMCQuery(strongest, [], settings.excludeReviews, fromDate, toDate),
    pubmedQuery: buildPubMedQuery(strongest, [], settings.excludeReviews, fromDate, toDate),
  });

  for (let count = planMustCount - 1; count >= 1; count -= 1) {
    const activeGroups = groups.slice(0, count);
    tiers.push({
      label: `relaxed-required-${count}-groups`,
      europeQuery: buildEuropePMCQuery(activeGroups, settings.excludeTerms, settings.excludeReviews, fromDate, toDate),
      pubmedQuery: buildPubMedQuery(activeGroups, settings.excludeTerms, settings.excludeReviews, fromDate, toDate),
    });
  }

  if (planMustCount > 1) {
    tiers.push({
      label: 'single-core-without-negative-terms',
      europeQuery: buildEuropePMCQuery(groups.slice(0, 1), [], settings.excludeReviews, fromDate, toDate),
      pubmedQuery: buildPubMedQuery(groups.slice(0, 1), [], settings.excludeReviews, fromDate, toDate),
    });
  }

  return deduplicateBy(tiers, item => item.europeQuery);
}

async function countEuropePMC(query) {
  const params = new URLSearchParams({
    query,
    resultType: 'lite',
    pageSize: '1',
    format: 'json',
    synonym: 'true',
  });
  const response = await fetch('https://www.ebi.ac.uk/europepmc/webservices/rest/searchPOST', {
    method: 'POST',
    headers: { Accept: 'application/json', 'Content-Type': 'application/x-www-form-urlencoded' },
    body: params,
  });
  if (!response.ok) throw new Error(`Europe PMC count HTTP ${response.status}`);
  const data = await response.json();
  return Number(data.hitCount ?? 0);
}

async function fetchEuropePMC(query, pageSize) {
  const params = new URLSearchParams({
    query,
    resultType: 'core',
    pageSize: String(pageSize),
    format: 'json',
    sort: 'P_PDATE_D desc',
    synonym: 'true',
  });
  const response = await fetch('https://www.ebi.ac.uk/europepmc/webservices/rest/searchPOST', {
    method: 'POST',
    headers: { Accept: 'application/json', 'Content-Type': 'application/x-www-form-urlencoded' },
    body: params,
  });
  if (!response.ok) throw new Error(`Europe PMC HTTP ${response.status}`);
  const data = await response.json();
  return {
    hitCount: Number(data.hitCount ?? 0),
    articles: (data.resultList?.result ?? []).map(mapEuropePMCArticle),
  };
}

async function fetchPubMed(query, apiKey) {
  const params = new URLSearchParams({
    db: 'pubmed', retmode: 'json', retmax: '50', sort: 'pub date', term: query,
    tool: 'oncopaper-radar',
  });
  if (apiKey) params.set('api_key', apiKey);
  const response = await fetch('https://eutils.ncbi.nlm.nih.gov/entrez/eutils/esearch.fcgi', {
    method: 'POST',
    headers: { Accept: 'application/json', 'Content-Type': 'application/x-www-form-urlencoded' },
    body: params,
  });
  if (!response.ok) throw new Error(`PubMed ESearch HTTP ${response.status}`);
  const data = await response.json();
  return data.esearchresult?.idlist ?? [];
}

async function fetchPapersByPMIDs(pmids, apiKey) {
  const unique = [...new Set(pmids.map(String).filter(value => /^\d+$/.test(value)))].slice(0, 50);
  if (!unique.length) return [];

  const chunks = chunk(unique, 20);
  const articles = [];
  const errors = [];
  let successfulMetadataRequest = false;

  for (const ids of chunks) {
    const query = `(${ids.map(id => `EXT_ID:${id}`).join(' OR ')}) AND SRC:MED`;
    const params = new URLSearchParams({
      query, resultType: 'core', pageSize: String(ids.length), format: 'json',
    });
    try {
      const response = await fetch('https://www.ebi.ac.uk/europepmc/webservices/rest/searchPOST', {
        method: 'POST',
        headers: { Accept: 'application/json', 'Content-Type': 'application/x-www-form-urlencoded' },
        body: params,
      });
      if (!response.ok) throw new Error(`Europe PMC PMID lookup HTTP ${response.status}`);
      const data = await response.json();
      successfulMetadataRequest = true;
      articles.push(...(data.resultList?.result ?? []).map(mapEuropePMCArticle));
    } catch (error) {
      errors.push(friendlyError(error));
      console.error('[Europe PMC] PMID lookup failed; PubMed fallback will be used', error);
    }
  }

  const found = new Set(articles.map(article => article.pmid).filter(Boolean));
  const missing = unique.filter(id => !found.has(id));
  if (missing.length) {
    try {
      const summaries = await fetchPubMedSummaries(missing, apiKey);
      successfulMetadataRequest = true;
      articles.push(...summaries);
    } catch (error) {
      errors.push(friendlyError(error));
      console.error('[PubMed] summary fallback failed', error);
    }
  }

  if (!successfulMetadataRequest) {
    throw new Error(`Unable to load PubMed metadata. ${errors.join(' | ')}`);
  }
  return mergeArticles(articles);
}

async function fetchPubMedSummaries(pmids, apiKey) {
  const params = new URLSearchParams({ db: 'pubmed', retmode: 'json', id: pmids.join(','), tool: 'oncopaper-radar' });
  if (apiKey) params.set('api_key', apiKey);
  const response = await fetch(`https://eutils.ncbi.nlm.nih.gov/entrez/eutils/esummary.fcgi?${params}`, {
    headers: { Accept: 'application/json' },
  });
  if (!response.ok) throw new Error(`PubMed ESummary HTTP ${response.status}`);
  const data = await response.json();
  return pmids.map(pmid => {
    const record = data.result?.[pmid];
    if (!record) return null;
    const doi = record.articleids?.find(item => item.idtype === 'doi')?.value ?? null;
    return {
      id: `pubmed_${pmid}`,
      canonical_id: canonicalId({ pmid, doi, source: 'MED', external_id: pmid }),
      source: 'MED', external_id: pmid, pmid, pmcid: null, doi,
      title: cleanText(record.title || 'Untitled', 1000),
      authors: (record.authors ?? []).map(author => author.name).filter(Boolean).join(', ') || null,
      journal: record.fulljournalname || record.source || null,
      pub_date: record.pubdate || null,
      abstract: null,
      article_url: doi ? `https://doi.org/${doi}` : `https://pubmed.ncbi.nlm.nih.gov/${pmid}/`,
      inserted_at: new Date().toISOString(),
    };
  }).filter(Boolean);
}

function mapEuropePMCArticle(record) {
  const source = record.source || 'MED';
  const externalId = String(record.id || record.pmid || record.pmcid || crypto.randomUUID());
  const article = {
    id: `epmc_${source}_${externalId}`,
    source,
    external_id: externalId,
    pmid: record.pmid || null,
    pmcid: record.pmcid || null,
    doi: record.doi || null,
    title: cleanText(record.title || 'Untitled', 1000),
    authors: cleanText(record.authorString, 1500) || null,
    journal: cleanText(record.journalTitle || record.bookTitle || record.source, 300) || null,
    pub_date: record.firstPublicationDate || record.electronicPublicationDate || record.pubYear || null,
    abstract: cleanText(record.abstractText, 12_000) || null,
    article_url: record.doi
      ? `https://doi.org/${record.doi}`
      : record.pmid
        ? `https://pubmed.ncbi.nlm.nih.gov/${record.pmid}/`
        : `https://europepmc.org/article/${source}/${externalId}`,
    inserted_at: new Date().toISOString(),
  };
  article.canonical_id = canonicalId(article);
  return article;
}

function mergeArticles(articles) {
  const map = new Map();
  for (const article of articles) {
    if (!article?.title) continue;
    const key = article.canonical_id || canonicalId(article);
    const existing = map.get(key);
    if (!existing || (!existing.abstract && article.abstract)) map.set(key, { ...article, canonical_id: key });
  }
  return [...map.values()];
}

/* ── Dedup, scoring, persistence ──────────────────────────── */
async function prepareCandidates(env, runId, settings, searchResult) {
  const candidates = await loadCandidateMetadata(env, searchResult.candidateIds);
  if (!candidates.length) {
    const result = {
      status: 'empty', selected_count: 0, candidate_count: 0,
      message: 'Europe PMC and PubMed returned no results after automatic query relaxation.',
      query_tier: searchResult.tierLabel,
    };
    await storeEmptyDigest(env, runId, searchResult.queryText, 0, 'empty', result.message);
    return { stop: true, result };
  }

  const state = await loadCandidateState(env, candidates, settings.profileHash);
  const fresh = candidates.filter(article => !state.selected.has(article.canonical_id)
    && !state.processed.has(article.canonical_id));

  if (!fresh.length) {
    const result = {
      status: 'empty', selected_count: 0, candidate_count: candidates.length,
      message: 'All matching papers were already processed for the current profile.',
      query_tier: searchResult.tierLabel,
    };
    await storeEmptyDigest(env, runId, searchResult.queryText, candidates.length, 'empty', result.message);
    return { stop: true, result };
  }

  const ranked = fresh.map(article => ({
    article,
    preScore: heuristicScore(article, settings.queryGroups).total,
    dateScore: parseDateScore(article.pub_date),
    abstractScore: article.abstract ? Math.min(article.abstract.length / 500, 2) : 0,
  })).sort((a, b) => (b.preScore + b.dateScore + b.abstractScore)
    - (a.preScore + a.dateScore + a.abstractScore));

  const scoringLimit = Math.min(10, Math.max(settings.maxArticles * 2, 6));
  return {
    stop: false,
    freshCount: fresh.length,
    toScore: ranked.slice(0, scoringLimit).map(item => item.article),
    preFilteredIds: ranked.slice(scoringLimit).map(item => item.article.canonical_id),
  };
}

async function loadCandidateMetadata(env, canonicalIds) {
  const map = new Map();
  for (const ids of chunk(canonicalIds, D1_BIND_CHUNK)) {
    if (!ids.length) continue;
    const placeholders = ids.map(() => '?').join(',');
    const rows = (await env.DB.prepare(`
      SELECT canonical_id, metadata_json
      FROM processed_articles
      WHERE canonical_id IN (${placeholders})
    `).bind(...ids).all()).results;
    for (const row of rows) {
      const article = safeParse(row.metadata_json, null);
      if (article) map.set(row.canonical_id, article);
    }
  }
  return canonicalIds.map(id => map.get(id)).filter(Boolean);
}

async function upsertCandidateMetadata(env, candidates) {
  const statements = candidates.map(article => env.DB.prepare(`
    INSERT INTO processed_articles (
      canonical_id, article_id, pmid, pmcid, doi, title, metadata_json,
      first_seen_at, last_seen_at
    ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, datetime('now'), datetime('now'))
    ON CONFLICT(canonical_id) DO UPDATE SET
      article_id = excluded.article_id,
      pmid = COALESCE(excluded.pmid, processed_articles.pmid),
      pmcid = COALESCE(excluded.pmcid, processed_articles.pmcid),
      doi = COALESCE(excluded.doi, processed_articles.doi),
      title = excluded.title,
      metadata_json = excluded.metadata_json,
      last_seen_at = datetime('now')
  `).bind(
    article.canonical_id, article.id, article.pmid, article.pmcid, article.doi,
    article.title, JSON.stringify(article),
  ));
  await batchInChunks(env.DB, statements, 40);
}

async function loadCandidateState(env, candidates, profileHash) {
  const canonicalIds = candidates.map(article => article.canonical_id);
  const selected = new Set();
  const processed = new Set();

  for (const ids of chunk(canonicalIds, D1_BIND_CHUNK)) {
    const placeholders = ids.map(() => '?').join(',');
    const rows = (await env.DB.prepare(`
      SELECT canonical_id, profile_hash, prompt_version, scored_at
      FROM processed_articles WHERE canonical_id IN (${placeholders})
    `).bind(...ids).all()).results;
    for (const row of rows) {
      if (row.profile_hash === profileHash && row.prompt_version === PROMPT_VERSION && row.scored_at) {
        processed.add(row.canonical_id);
      }
    }
  }

  // Query articles table in chunks to stay under D1's SQL variable limit.
  // Each chunk uses at most 50 IDs/PMIDs/DOIs (~150 bindings max).
  const selectedPMIDs = new Set();
  const selectedDOIs = new Set();
  const selectedIds = new Set();
  const chunkSize = D1_BIND_CHUNK;

  for (let offset = 0; offset < candidates.length; offset += chunkSize) {
    const slice = candidates.slice(offset, offset + chunkSize);
    const ids = slice.map(article => article.id);
    const pmids = [...new Set(slice.map(article => article.pmid).filter(Boolean))];
    const dois = [...new Set(slice.map(article => article.doi?.toLowerCase()).filter(Boolean))];

    const clauses = [];
    const bindings = [];
    if (ids.length) {
      clauses.push(`id IN (${ids.map(() => '?').join(',')})`);
      bindings.push(...ids);
    }
    if (pmids.length) {
      clauses.push(`pmid IN (${pmids.map(() => '?').join(',')})`);
      bindings.push(...pmids);
    }
    if (dois.length) {
      clauses.push(`lower(doi) IN (${dois.map(() => '?').join(',')})`);
      bindings.push(...dois);
    }

    if (clauses.length) {
      const rows = (await env.DB.prepare(`SELECT id, pmid, doi FROM articles WHERE ${clauses.join(' OR ')}`)
        .bind(...bindings).all()).results;
      for (const row of rows) {
        if (row.id) selectedIds.add(row.id);
        if (row.pmid) selectedPMIDs.add(row.pmid);
        if (row.doi) selectedDOIs.add(row.doi.toLowerCase());
      }
    }
  }

  for (const article of candidates) {
    if (selectedIds.has(article.id) || (article.pmid && selectedPMIDs.has(article.pmid))
      || (article.doi && selectedDOIs.has(article.doi.toLowerCase()))) {
      selected.add(article.canonical_id);
    }
  }

  return { selected, processed };
}

async function persistProcessingDecisions(env, settings, selectedArticles, scoredCandidates, preFiltered, scoreModel) {
  const selectedIds = new Set(selectedArticles.map(article => article.canonical_id));
  const scoreMap = new Map(selectedArticles.map(article => [article.canonical_id, article]));
  const statements = [];

  for (const article of scoredCandidates) {
    const selected = selectedIds.has(article.canonical_id);
    const score = scoreMap.get(article.canonical_id) ?? null;
    statements.push(env.DB.prepare(`
      UPDATE processed_articles SET
        profile_hash = ?, prompt_version = ?, score_json = ?, score_model = ?,
        decision = ?, scored_at = datetime('now'), last_seen_at = datetime('now')
      WHERE canonical_id = ?
    `).bind(
      settings.profileHash,
      PROMPT_VERSION,
      score ? JSON.stringify(score) : null,
      scoreModel || MODEL_LABELS.heuristic,
      selected ? 'selected' : 'rejected',
      article.canonical_id,
    ));
  }

  for (const canonicalId of preFiltered) {
    statements.push(env.DB.prepare(`
      UPDATE processed_articles SET
        profile_hash = ?, prompt_version = ?, decision = 'pre_filtered',
        scored_at = datetime('now'), last_seen_at = datetime('now')
      WHERE canonical_id = ?
    `).bind(settings.profileHash, PROMPT_VERSION, canonicalId));
  }

  await batchInChunks(env.DB, statements, 40);
}

async function storeDigestResults(env, runId, queryText, candidateCount, scored, model) {
  const articleStatements = scored.map(article => env.DB.prepare(`
    INSERT INTO articles (
      id, source, external_id, pmid, pmcid, doi, title, authors,
      journal, pub_date, abstract, article_url, inserted_at
    ) VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13)
    ON CONFLICT(id) DO UPDATE SET
      pmid = excluded.pmid, pmcid = excluded.pmcid, doi = excluded.doi,
      title = excluded.title, authors = excluded.authors, journal = excluded.journal,
      pub_date = excluded.pub_date, abstract = excluded.abstract,
      article_url = excluded.article_url
  `).bind(
    article.id, article.source, article.external_id, article.pmid, article.pmcid,
    article.doi, article.title, article.authors, article.journal, article.pub_date,
    article.abstract, article.article_url, article.inserted_at,
  ));
  await batchInChunks(env.DB, articleStatements, 30);

  await env.DB.prepare(`
    INSERT OR IGNORE INTO digests (
      run_at, query_text, candidate_count, selected_count, status, model, run_id
    ) VALUES (datetime('now'), ?, ?, ?, 'ok', ?, ?)
  `).bind(queryText, candidateCount, scored.length, model, runId).run();

  const digest = await env.DB.prepare('SELECT id FROM digests WHERE run_id = ?').bind(runId).first();
  if (!digest) throw new Error('Failed to create digest record.');

  const itemStatements = scored.map((article, index) => env.DB.prepare(`
    INSERT OR REPLACE INTO digest_items (
      digest_id, article_id, rank, relevance, novelty, evidence, surprise,
      experiment_value, total, evidence_level, why_interesting,
      mechanism_chain, key_evidence, major_concern, next_experiment
    ) VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,?15)
  `).bind(
    digest.id, article.id, index + 1, article.relevance, article.novelty,
    article.evidence, article.surprise, article.experiment_value, article.total,
    article.evidence_level, article.why_interesting, article.mechanism_chain,
    article.key_evidence, article.major_concern, article.next_experiment,
  ));
  await batchInChunks(env.DB, itemStatements, 30);
  return digest.id;
}

async function storeEmptyDigest(env, runId, queryText, candidateCount, status, error) {
  await env.DB.prepare(`
    INSERT OR IGNORE INTO digests (
      run_at, query_text, candidate_count, selected_count, status, error, model, run_id
    ) VALUES (datetime('now'), ?, ?, 0, ?, ?, '', ?)
  `).bind(queryText, candidateCount, status, error ?? null, runId).run();
}

async function storeFailureDigest(env, runId, error) {
  const run = await env.DB.prepare('SELECT query_text, candidate_count FROM sync_runs WHERE id = ?').bind(runId).first();
  await storeEmptyDigest(env, runId, run?.query_text ?? '', run?.candidate_count ?? 0, 'error', error);
}

/* ── Runtime migration ────────────────────────────────────── */
async function ensureSchema(env) {
  if (!schemaReadyPromise) schemaReadyPromise = migrateSchema(env);
  try {
    await schemaReadyPromise;
  } catch (error) {
    schemaReadyPromise = null;
    throw error;
  }
}

async function migrateSchema(env) {
  const statements = [
    env.DB.prepare(`CREATE TABLE IF NOT EXISTS settings (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      enabled INTEGER NOT NULL DEFAULT 1,
      query_groups TEXT NOT NULL DEFAULT '["KRAS G12D | KRASG12D","pancreatic cancer | PDAC"]',
      exclude_terms TEXT NOT NULL DEFAULT '',
      exclude_reviews INTEGER NOT NULL DEFAULT 1,
      lookback_days INTEGER NOT NULL DEFAULT 7,
      max_articles INTEGER NOT NULL DEFAULT 5,
      focus TEXT NOT NULL DEFAULT '',
      generated_profile TEXT,
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    )`),
    env.DB.prepare(`INSERT OR IGNORE INTO settings (
      id, enabled, query_groups, exclude_terms, exclude_reviews,
      lookback_days, max_articles, focus, updated_at
    ) VALUES (
      1, 1, '["KRAS G12D | KRASG12D","pancreatic cancer | PDAC"]',
      'prognostic signature | nomogram', 1, 7, 5,
      '分子机制；遗传学证据；rescue 实验；体内验证；耐药机制；反直觉发现',
      datetime('now')
    )`),
    env.DB.prepare(`CREATE TABLE IF NOT EXISTS digests (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      run_at TEXT NOT NULL,
      query_text TEXT NOT NULL DEFAULT '',
      candidate_count INTEGER NOT NULL DEFAULT 0,
      selected_count INTEGER NOT NULL DEFAULT 0,
      status TEXT NOT NULL DEFAULT 'ok',
      error TEXT,
      model TEXT NOT NULL DEFAULT '',
      run_id TEXT
    )`),
    env.DB.prepare(`CREATE TABLE IF NOT EXISTS articles (
      id TEXT PRIMARY KEY,
      source TEXT NOT NULL,
      external_id TEXT NOT NULL,
      pmid TEXT,
      pmcid TEXT,
      doi TEXT,
      title TEXT NOT NULL,
      authors TEXT,
      journal TEXT,
      pub_date TEXT,
      abstract TEXT,
      article_url TEXT NOT NULL,
      inserted_at TEXT NOT NULL
    )`),
    env.DB.prepare(`CREATE TABLE IF NOT EXISTS digest_items (
      digest_id INTEGER NOT NULL,
      article_id TEXT NOT NULL,
      rank INTEGER NOT NULL,
      relevance INTEGER NOT NULL,
      novelty INTEGER NOT NULL,
      evidence INTEGER NOT NULL,
      surprise INTEGER NOT NULL,
      experiment_value INTEGER NOT NULL,
      total INTEGER NOT NULL,
      evidence_level TEXT,
      why_interesting TEXT,
      mechanism_chain TEXT,
      key_evidence TEXT,
      major_concern TEXT,
      next_experiment TEXT,
      PRIMARY KEY (digest_id, article_id),
      FOREIGN KEY (digest_id) REFERENCES digests(id) ON DELETE CASCADE,
      FOREIGN KEY (article_id) REFERENCES articles(id) ON DELETE CASCADE
    )`),
    env.DB.prepare(`CREATE TABLE IF NOT EXISTS sync_runs (
      id TEXT PRIMARY KEY,
      run_type TEXT NOT NULL,
      status TEXT NOT NULL,
      stage TEXT NOT NULL,
      progress INTEGER NOT NULL DEFAULT 0,
      query_text TEXT,
      query_tier TEXT,
      candidate_count INTEGER NOT NULL DEFAULT 0,
      selected_count INTEGER NOT NULL DEFAULT 0,
      model TEXT NOT NULL DEFAULT '',
      result_json TEXT,
      error TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      finished_at TEXT
    )`),
    env.DB.prepare(`CREATE TABLE IF NOT EXISTS processed_articles (
      canonical_id TEXT PRIMARY KEY,
      article_id TEXT NOT NULL,
      pmid TEXT,
      pmcid TEXT,
      doi TEXT,
      title TEXT NOT NULL,
      metadata_json TEXT NOT NULL,
      first_seen_at TEXT NOT NULL,
      last_seen_at TEXT NOT NULL,
      profile_hash TEXT,
      prompt_version TEXT,
      score_json TEXT,
      score_model TEXT,
      decision TEXT,
      scored_at TEXT
    )`),
  ];
  await env.DB.batch(statements);

  // Existing installations may predate these columns. Introspection makes the
  // migration repeatable and allows GitHub/Cloudflare auto-deploy without a
  // separate manual D1 migration step.
  const settingsColumns = (await env.DB.prepare('PRAGMA table_info(settings)').all()).results.map(row => row.name);
  if (!settingsColumns.includes('generated_profile')) {
    await env.DB.prepare('ALTER TABLE settings ADD COLUMN generated_profile TEXT').run();
  }

  const digestColumns = (await env.DB.prepare('PRAGMA table_info(digests)').all()).results.map(row => row.name);
  if (!digestColumns.includes('model')) {
    await env.DB.prepare("ALTER TABLE digests ADD COLUMN model TEXT NOT NULL DEFAULT ''").run();
  }
  if (!digestColumns.includes('run_id')) {
    await env.DB.prepare('ALTER TABLE digests ADD COLUMN run_id TEXT').run();
  }

  await env.DB.batch([
    env.DB.prepare('CREATE INDEX IF NOT EXISTS idx_digests_run_at ON digests(run_at DESC)'),
    env.DB.prepare('CREATE UNIQUE INDEX IF NOT EXISTS idx_digests_run_id ON digests(run_id)'),
    env.DB.prepare('CREATE INDEX IF NOT EXISTS idx_articles_pmid ON articles(pmid)'),
    env.DB.prepare('CREATE INDEX IF NOT EXISTS idx_articles_doi ON articles(doi)'),
    env.DB.prepare('CREATE INDEX IF NOT EXISTS idx_sync_runs_status ON sync_runs(run_type, status, created_at DESC)'),
    env.DB.prepare('CREATE INDEX IF NOT EXISTS idx_processed_articles_pmid ON processed_articles(pmid)'),
    env.DB.prepare('CREATE INDEX IF NOT EXISTS idx_processed_articles_doi ON processed_articles(doi)'),
    env.DB.prepare('CREATE INDEX IF NOT EXISTS idx_processed_articles_scored ON processed_articles(profile_hash, prompt_version, scored_at)'),
  ]);
}
/* ── Utilities ────────────────────────────────────────────── */
function requireAdminResponse(request, env) {
  if (!env.ADMIN_TOKEN) {
    return json({ error: 'ADMIN_TOKEN is not configured. Add it with: npx wrangler secret put ADMIN_TOKEN' }, 503);
  }
  const token = request.headers.get('Authorization')?.replace(/^Bearer\s+/i, '') ?? '';
  if (!token || token !== env.ADMIN_TOKEN) return json({ error: 'Unauthorized' }, 401);
  return null;
}

function normalizeQueryPlan(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const mustCount = clampInt(value.must_count ?? 1, 1, 2);
  const shouldCount = clampInt(value.should_count ?? 0, 0, 2);
  return {
    must_count: mustCount,
    should_count: shouldCount,
    fallback: value.fallback === true,
    rationale: cleanText(value.rationale, 800),
  };
}

async function getSettingsRow(env) {
  return env.DB.prepare('SELECT * FROM settings WHERE id = 1').first();
}

async function readJSON(request, maxBytes) {
  const contentLength = Number(request.headers.get('Content-Length') ?? 0);
  if (contentLength > maxBytes) throw new HttpError(413, 'Request body is too large.');
  const text = await request.text();
  if (text.length > maxBytes) throw new HttpError(413, 'Request body is too large.');
  try { return JSON.parse(text || '{}'); } catch { throw new HttpError(400, 'Invalid JSON body.'); }
}

function cleanText(value, maxLength = 1000) {
  return String(value ?? '')
    .replace(/[\u0000-\u001F\u007F]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, maxLength);
}

function canonicalId(article) {
  if (article.doi) return `doi:${String(article.doi).trim().toLowerCase()}`;
  if (article.pmid) return `pmid:${String(article.pmid).trim()}`;
  if (article.pmcid) return `pmcid:${String(article.pmcid).trim().toLowerCase()}`;
  return `${String(article.source || 'unknown').toLowerCase()}:${String(article.external_id || article.id)}`;
}

function parseDateScore(value) {
  const timestamp = Date.parse(value || '');
  if (!Number.isFinite(timestamp)) return 0;
  const days = Math.max(0, (Date.now() - timestamp) / 86_400_000);
  return Math.max(0, 3 - days / 10);
}

async function stableHash(value) {
  const bytes = new TextEncoder().encode(value);
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(digest)].slice(0, 12).map(byte => byte.toString(16).padStart(2, '0')).join('');
}

async function batchInChunks(db, statements, size) {
  for (const group of chunk(statements, size)) {
    if (group.length) await db.batch(group);
  }
}

function chunk(items, size) {
  const output = [];
  for (let index = 0; index < items.length; index += size) output.push(items.slice(index, index + size));
  return output;
}

function deduplicateBy(items, keyFn) {
  const seen = new Set();
  return items.filter(item => {
    const key = keyFn(item);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function safeParse(value, fallback) {
  try { return JSON.parse(value); } catch { return fallback; }
}

function clampInt(value, min, max) {
  const number = Number(value);
  if (!Number.isFinite(number)) return min;
  return Math.min(max, Math.max(min, Math.round(number)));
}

function friendlyError(error) {
  const message = error instanceof Error ? error.message : String(error);
  if (/3007|timeout/i.test(message)) return 'Workers AI timed out. The workflow can be retried without blocking the page.';
  if (/3036|quota|account limited/i.test(message)) return 'Workers AI quota is exhausted. The next run will use the available quota after reset.';
  if (/3040|capacity/i.test(message)) return 'The selected Workers AI model is temporarily at capacity.';
  return cleanText(message, 1000) || 'Unexpected error.';
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'same-origin',
    },
  });
}

function corsResponse(request) {
  const origin = request.headers.get('Origin');
  const ownOrigin = new URL(request.url).origin;
  if (origin && origin !== ownOrigin) {
    return new Response(null, { status: 403, headers: { Vary: 'Origin' } });
  }
  return new Response(null, {
    status: 204,
    headers: {
      'Access-Control-Allow-Origin': ownOrigin,
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization',
      'Access-Control-Max-Age': '86400',
      Vary: 'Origin',
    },
  });
}

async function serveAssets(request, env) {
  const response = await env.ASSETS.fetch(request);
  const headers = new Headers(response.headers);
  const contentType = headers.get('Content-Type') || '';
  if ((contentType.startsWith('text/') || contentType.includes('javascript')) && !contentType.includes('charset')) {
    headers.set('Content-Type', `${contentType}; charset=utf-8`);
  }
  headers.set('X-Content-Type-Options', 'nosniff');
  headers.set('Referrer-Policy', 'same-origin');
  headers.set('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
  return new Response(response.body, { status: response.status, headers });
}

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}
