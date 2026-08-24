import { MODEL_LABELS, PROMPT_VERSION } from './ai.js';
import { articleIdentityAliases } from './radar.js';
import { chunk, safeParse, D1_BIND_CHUNK, HttpError, friendlyError } from './utils.js';

const RUN_STALE_MINUTES = 120;

/* ── Workflow run storage ─────────────────────────────────── */
export async function createWorkflowRun(env, type, params) {
  const id = `${type}-${Date.now().toString(36)}-${crypto.randomUUID().slice(0, 8)}`;
  const claimed = await claimWorkflowSlot(env, type, id);
  if (!claimed) {
    const active = await findActiveRun(env, type);
    if (active) return { id: active.id, type, alreadyRunning: true };
    const lease = await env.DB.prepare('SELECT run_id FROM run_leases WHERE run_type = ?').bind(type).first();
    if (lease?.run_id) return { id: lease.run_id, type, alreadyRunning: true };
    throw new HttpError(409, `A ${type} workflow is already being started. Try again shortly.`);
  }

  try {
    await env.RADAR_WORKFLOW.create({ id, params: { ...params, type, runId: id } });
    return { id, type, alreadyRunning: false };
  } catch (error) {
    await updateRun(env, id, {
      status: 'failed', stage: 'failed', progress: 100,
      error: friendlyError(error), finished_at: new Date().toISOString(),
    });
    await releaseRunLease(env, type, id);
    throw error;
  }
}

async function claimWorkflowSlot(env, type, runId) {
  const modifier = `+${RUN_STALE_MINUTES} minutes`;
  await env.DB.batch([
    env.DB.prepare(`
      INSERT INTO run_leases (run_type, run_id, lease_expires_at, updated_at)
      VALUES (?, ?, datetime('now', ?), datetime('now'))
      ON CONFLICT(run_type) DO UPDATE SET
        run_id = excluded.run_id,
        lease_expires_at = excluded.lease_expires_at,
        updated_at = excluded.updated_at
      WHERE run_leases.lease_expires_at <= datetime('now')
    `).bind(type, runId, modifier),
    env.DB.prepare(`
      INSERT OR IGNORE INTO sync_runs (id, run_type, status, stage, progress, created_at, updated_at)
      SELECT ?, ?, 'queued', 'queued', 0, datetime('now'), datetime('now')
      WHERE EXISTS (
        SELECT 1 FROM run_leases WHERE run_type = ? AND run_id = ?
      )
    `).bind(runId, type, type, runId),
  ]);
  const run = await env.DB.prepare('SELECT id FROM sync_runs WHERE id = ?').bind(runId).first();
  return run?.id === runId;
}

export async function releaseRunLease(env, type, runId) {
  await env.DB.prepare('DELETE FROM run_leases WHERE run_type = ? AND run_id = ?').bind(type, runId).run();
}

export async function findActiveRun(env, type) {
  return env.DB.prepare(`
    SELECT * FROM sync_runs
    WHERE run_type = ?
      AND status IN ('queued', 'running')
      AND created_at >= datetime('now', ?)
    ORDER BY created_at DESC LIMIT 1
  `).bind(type, `-${RUN_STALE_MINUTES} minutes`).first();
}

export async function updateRun(env, id, fields) {
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

export function serializeRun(row) {
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

/* ── Candidate & digest persistence ───────────────────────── */
export async function loadCandidateMetadata(env, canonicalIds) {
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

export async function upsertCandidateMetadata(env, candidates) {
  const statements = candidates.map(article => env.DB.prepare(`
    INSERT INTO processed_articles (
      canonical_id, article_id, pmid, pmcid, doi, title, metadata_json,
      first_seen_at, last_seen_at
    ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, datetime('now'), datetime('now'))
    ON CONFLICT(canonical_id) DO UPDATE SET
      article_id = processed_articles.article_id,
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

  const aliasStatements = candidates.flatMap(article => articleIdentityAliases(article).map(alias => env.DB.prepare(`
    INSERT INTO article_aliases (alias, canonical_id, created_at, updated_at)
    VALUES (?, ?, datetime('now'), datetime('now'))
    ON CONFLICT(alias) DO UPDATE SET
      canonical_id = excluded.canonical_id,
      updated_at = datetime('now')
  `).bind(alias, article.canonical_id)));
  await batchInChunks(env.DB, aliasStatements, 40);
}

export async function loadCandidateState(env, candidates, profileHash) {
  const canonicalIds = candidates.map(article => article.canonical_id);
  const processed = new Set();

  for (const ids of chunk(canonicalIds, D1_BIND_CHUNK)) {
    if (!ids.length) continue;
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

  return { processed };
}

export async function persistProcessingDecisions(env, settings, selectedArticles, scoredCandidates, preFiltered, scoreModel) {
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
        profile_hash = ?, prompt_version = ?, score_json = NULL, score_model = NULL,
        decision = 'pre_filtered', scored_at = NULL, last_seen_at = datetime('now')
      WHERE canonical_id = ?
    `).bind(settings.profileHash, PROMPT_VERSION, canonicalId));
  }

  await batchInChunks(env.DB, statements, 40);
}

export async function storeDigestResults(env, runId, queryText, candidateCount, scored, model) {
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

export async function storeEmptyDigest(env, runId, queryText, candidateCount, status, error) {
  await env.DB.prepare(`
    INSERT OR IGNORE INTO digests (
      run_at, query_text, candidate_count, selected_count, status, error, model, run_id
    ) VALUES (datetime('now'), ?, ?, 0, ?, ?, '', ?)
  `).bind(queryText, candidateCount, status, error ?? null, runId).run();
}

export async function storeFailureDigest(env, runId, error) {
  const run = await env.DB.prepare('SELECT query_text, candidate_count FROM sync_runs WHERE id = ?').bind(runId).first();
  await storeEmptyDigest(env, runId, run?.query_text ?? '', run?.candidate_count ?? 0, 'error', error);
}

async function batchInChunks(db, statements, size) {
  for (const group of chunk(statements, size)) {
    if (group.length) await db.batch(group);
  }
}
