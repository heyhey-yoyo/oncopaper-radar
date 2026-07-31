/* ── Runtime migration ────────────────────────────────────── */
let schemaReadyPromise = null;

export async function ensureSchema(env) {
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
    env.DB.prepare(`CREATE TABLE IF NOT EXISTS article_aliases (
      alias TEXT PRIMARY KEY,
      canonical_id TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      FOREIGN KEY (canonical_id) REFERENCES processed_articles(canonical_id) ON DELETE CASCADE
    )`),
    env.DB.prepare(`CREATE TABLE IF NOT EXISTS run_leases (
      run_type TEXT PRIMARY KEY,
      run_id TEXT NOT NULL,
      lease_expires_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
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
    env.DB.prepare(`INSERT OR IGNORE INTO article_aliases (alias, canonical_id, created_at, updated_at)
      SELECT 'pmid:' || trim(pmid), canonical_id, datetime('now'), datetime('now')
      FROM processed_articles WHERE pmid IS NOT NULL AND trim(pmid) <> ''`),
    env.DB.prepare(`INSERT OR IGNORE INTO article_aliases (alias, canonical_id, created_at, updated_at)
      SELECT 'pmcid:' || lower(trim(pmcid)), canonical_id, datetime('now'), datetime('now')
      FROM processed_articles WHERE pmcid IS NOT NULL AND trim(pmcid) <> ''`),
    env.DB.prepare(`INSERT OR IGNORE INTO article_aliases (alias, canonical_id, created_at, updated_at)
      SELECT 'doi:' || lower(trim(doi)), canonical_id, datetime('now'), datetime('now')
      FROM processed_articles WHERE doi IS NOT NULL AND trim(doi) <> ''`),
    env.DB.prepare(`INSERT OR IGNORE INTO article_aliases (alias, canonical_id, created_at, updated_at)
      SELECT canonical_id, canonical_id, datetime('now'), datetime('now')
      FROM processed_articles WHERE canonical_id IS NOT NULL AND trim(canonical_id) <> ''`),
    env.DB.prepare(`INSERT OR IGNORE INTO article_aliases (alias, canonical_id, created_at, updated_at)
      SELECT
        'source:' || lower(substr(canonical_id, 1, instr(canonical_id, ':') - 1)) || ':' ||
          lower(substr(canonical_id, instr(canonical_id, ':') + 1)),
        canonical_id,
        datetime('now'),
        datetime('now')
      FROM processed_articles
      WHERE (pmid IS NULL OR trim(pmid) = '')
        AND (pmcid IS NULL OR trim(pmcid) = '')
        AND (doi IS NULL OR trim(doi) = '')
        AND instr(canonical_id, ':') > 1
        AND canonical_id NOT LIKE 'source:%'
        AND canonical_id NOT LIKE 'unknown:%'`),
    env.DB.prepare('CREATE INDEX IF NOT EXISTS idx_digests_run_at ON digests(run_at DESC)'),
    env.DB.prepare('CREATE UNIQUE INDEX IF NOT EXISTS idx_digests_run_id ON digests(run_id)'),
    env.DB.prepare('CREATE INDEX IF NOT EXISTS idx_articles_pmid ON articles(pmid)'),
    env.DB.prepare('CREATE INDEX IF NOT EXISTS idx_articles_doi ON articles(doi)'),
    env.DB.prepare('CREATE INDEX IF NOT EXISTS idx_sync_runs_status ON sync_runs(run_type, status, created_at DESC)'),
    env.DB.prepare('CREATE INDEX IF NOT EXISTS idx_processed_articles_pmid ON processed_articles(pmid)'),
    env.DB.prepare('CREATE INDEX IF NOT EXISTS idx_processed_articles_doi ON processed_articles(doi)'),
    env.DB.prepare('CREATE INDEX IF NOT EXISTS idx_processed_articles_scored ON processed_articles(profile_hash, prompt_version, scored_at)'),
    env.DB.prepare('CREATE INDEX IF NOT EXISTS idx_article_aliases_canonical ON article_aliases(canonical_id)'),
  ]);
}
