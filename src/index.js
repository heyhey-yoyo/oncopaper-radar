import { WorkflowEntrypoint } from 'cloudflare:workers';
import {
  generateProfile,
  heuristicScore,
  GRANITE,
  MODEL_LABELS,
  PROMPT_VERSION,
  QWEN,
  scorePapers,
} from './ai.js';
import { normalizeExcludeTerms, normalizeQueryGroups } from './query.js';
import { chooseDigestForDisplay, processingFingerprintPayload } from './radar.js';
import { fetchPapersByPMIDs, searchLiterature } from './search.js';
import {
  createWorkflowRun,
  findActiveRun,
  loadCandidateMetadata,
  loadCandidateState,
  persistProcessingDecisions,
  releaseRunLease,
  serializeRun,
  storeDigestResults,
  storeEmptyDigest,
  storeFailureDigest,
  updateRun,
  upsertCandidateMetadata,
} from './storage.js';
import { ensureSchema } from './migrate.js';
import { cleanText, clampInt, safeParse, HttpError, friendlyError } from './utils.js';

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
      if (path === '/api/settings' && request.method === 'GET') return handleGetSettings(request, env);
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
      const run = await createWorkflowRun(env, 'sync', {});
      console.log(run.alreadyRunning
        ? `[Cron] sync already active: ${run.id}`
        : `[Cron] started workflow ${run.id}`);
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
    } finally {
      try {
        await releaseRunLease(this.env, runType, runId);
      } catch (leaseError) {
        console.error(`[Workflow ${runId}] failed to release run lease`, leaseError);
      }
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

    await step.do('complete-profile', () => finishRun(this.env, runId, {
      result,
      model: result.model,
    }));

    return result;
  }

  async runSync(runId, step) {
    const prepared = await step.do('prepare-sync', async () => {
      await updateRun(this.env, runId, { stage: 'reading settings', progress: 8 });
      const settings = await getSettingsRow(this.env);
      if (!settings || !settings.enabled) {
        const result = { status: 'skipped', selected_count: 0 };
        await storeEmptyDigest(this.env, runId, '', 0, 'skipped', 'Disabled or no settings');
        await finishRun(this.env, runId, { stage: 'skipped', result });
        return { stop: true, result };
      }

      const queryGroups = normalizeQueryGroups(safeParse(settings.query_groups, []));
      if (!queryGroups.length) {
        const result = { status: 'empty', selected_count: 0, message: 'No query groups configured.' };
        await storeEmptyDigest(this.env, runId, '', 0, 'empty', result.message);
        await finishRun(this.env, runId, { result });
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
      normalized.profileHash = await stableHash(JSON.stringify(
        processingFingerprintPayload(normalized, PROMPT_VERSION),
      ));
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
      await step.do('complete-empty-sync', () => finishRun(this.env, runId, {
        result: candidates.result,
      }));
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

    await step.do('complete-sync', () => finishRun(this.env, runId, {
      result: finalResult,
      model: finalResult.model ?? '',
    }));

    return finalResult;
  }
}

/* ── HTTP handlers ────────────────────────────────────────── */
async function handleGetSettings(request, env) {
  const denied = requireAdminResponse(request, env);
  if (denied) return denied;

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

  const run = await createWorkflowRun(env, 'sync', {});
  return json({
    status: run.alreadyRunning ? 'running' : 'queued',
    run_id: run.id,
    already_running: run.alreadyRunning,
  }, 202);
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
  const run = await createWorkflowRun(env, 'profile', { pmids });
  return json({
    status: run.alreadyRunning ? 'running' : 'queued',
    run_id: run.id,
    already_running: run.alreadyRunning,
  }, 202);
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
  const denied = requireAdminResponse(request, env);
  if (denied) return denied;
  const limit = clampInt(new URL(request.url).searchParams.get('limit') || 20, 1, 100);
  const rows = (await env.DB.prepare('SELECT * FROM digests ORDER BY run_at DESC LIMIT ?').bind(limit).all()).results;
  return json(rows);
}

async function handleGetLatestDigest(env) {
  const latestAttempt = await env.DB.prepare('SELECT * FROM digests ORDER BY run_at DESC LIMIT 1').first();
  const latestSuccess = latestAttempt?.status === 'ok'
    ? latestAttempt
    : await env.DB.prepare("SELECT * FROM digests WHERE status = 'ok' ORDER BY run_at DESC LIMIT 1").first();
  const display = chooseDigestForDisplay(latestAttempt, latestSuccess);

  if (!latestSuccess) {
    return json({
      digest: display.digest ? publicDigest(display.digest) : null,
      latest_attempt: display.latestAttempt ? publicDigest(display.latestAttempt) : null,
      articles: [],
    });
  }

  const items = (await env.DB.prepare(`
    SELECT di.*, a.*
    FROM digest_items di
    JOIN articles a ON di.article_id = a.id
    WHERE di.digest_id = ?
    ORDER BY di.rank ASC
  `).bind(latestSuccess.id).all()).results;

  return json({
    digest: publicDigest(latestSuccess),
    latest_attempt: display.latestAttempt ? publicDigest(display.latestAttempt) : null,
    articles: items,
  });
}

// 模型信息自动跟随 src/ai.js 的 MODEL_LABELS，无需手动同步
function handleModelInfo() {
  return json({
    primary: MODEL_LABELS[QWEN],
    fallback: MODEL_LABELS[GRANITE],
    provider: 'Cloudflare Workers AI',
    execution: 'Cloudflare Workflows',
    prompt_version: PROMPT_VERSION,
  });
}

/* ── Dedup, pre-ranking ───────────────────────────────────── */
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
  const fresh = candidates.filter(article => !state.processed.has(article.canonical_id));

  if (!fresh.length) {
    const result = {
      status: 'empty', selected_count: 0, candidate_count: candidates.length,
      message: 'All matching papers were already scored for the current settings.',
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

/* ── Utilities ────────────────────────────────────────────── */
async function finishRun(env, runId, { stage = 'completed', result, model } = {}) {
  await updateRun(env, runId, {
    status: 'completed',
    stage,
    progress: 100,
    ...(result !== undefined ? { result_json: JSON.stringify(result) } : {}),
    ...(model !== undefined ? { model } : {}),
    finished_at: new Date().toISOString(),
  });
}

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

function publicDigest(row) {
  return {
    id: row.id,
    run_at: row.run_at,
    candidate_count: row.candidate_count,
    selected_count: row.selected_count,
    status: row.status,
    model: row.model,
    message: row.status === 'ok' ? null : cleanText(row.error, 300),
  };
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

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'same-origin',
      'X-Frame-Options': 'DENY',
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
  headers.set('X-Frame-Options', 'DENY');
  headers.set('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'");
  return new Response(response.body, { status: response.status, headers });
}
