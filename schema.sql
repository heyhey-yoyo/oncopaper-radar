PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS settings (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  query_groups TEXT NOT NULL DEFAULT '[]',
  focus TEXT NOT NULL DEFAULT '',
  exclude_terms TEXT NOT NULL DEFAULT '',
  max_articles INTEGER NOT NULL DEFAULT 5 CHECK (max_articles BETWEEN 1 AND 10),
  lookback_days INTEGER NOT NULL DEFAULT 7 CHECK (lookback_days BETWEEN 1 AND 30),
  exclude_reviews INTEGER NOT NULL DEFAULT 1 CHECK (exclude_reviews IN (0, 1)),
  enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
  generated_profile TEXT,
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

INSERT OR IGNORE INTO settings (
  id, query_groups, focus, exclude_terms, max_articles,
  lookback_days, exclude_reviews, enabled, updated_at
) VALUES (
  1,
  '["KRAS G12D | KRASG12D","pancreatic cancer | PDAC"]',
  '分子机制；遗传学证据；rescue 实验；体内验证；耐药机制；反直觉发现',
  'prognostic signature | nomogram',
  5,
  7,
  1,
  1,
  datetime('now')
);

CREATE TABLE IF NOT EXISTS digests (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  run_at TEXT NOT NULL,
  query_text TEXT NOT NULL DEFAULT '',
  candidate_count INTEGER NOT NULL DEFAULT 0,
  selected_count INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL CHECK (status IN ('ok', 'empty', 'error', 'skipped')),
  error TEXT,
  model TEXT NOT NULL DEFAULT '',
  run_id TEXT
);

CREATE INDEX IF NOT EXISTS idx_digests_run_at ON digests(run_at DESC);
CREATE UNIQUE INDEX IF NOT EXISTS idx_digests_run_id ON digests(run_id);

CREATE TABLE IF NOT EXISTS articles (
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
);

CREATE INDEX IF NOT EXISTS idx_articles_pub_date ON articles(pub_date DESC);
CREATE INDEX IF NOT EXISTS idx_articles_pmid ON articles(pmid);
CREATE INDEX IF NOT EXISTS idx_articles_doi ON articles(doi);

CREATE TABLE IF NOT EXISTS digest_items (
  digest_id INTEGER NOT NULL,
  article_id TEXT NOT NULL,
  rank INTEGER NOT NULL,
  relevance INTEGER NOT NULL,
  novelty INTEGER NOT NULL,
  evidence INTEGER NOT NULL,
  surprise INTEGER NOT NULL,
  experiment_value INTEGER NOT NULL,
  total INTEGER NOT NULL,
  evidence_level TEXT NOT NULL,
  why_interesting TEXT NOT NULL,
  mechanism_chain TEXT NOT NULL,
  key_evidence TEXT NOT NULL,
  major_concern TEXT NOT NULL,
  next_experiment TEXT NOT NULL,
  PRIMARY KEY (digest_id, article_id),
  FOREIGN KEY (digest_id) REFERENCES digests(id) ON DELETE CASCADE,
  FOREIGN KEY (article_id) REFERENCES articles(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_digest_items_digest ON digest_items(digest_id, rank);

CREATE TABLE IF NOT EXISTS sync_runs (
  id TEXT PRIMARY KEY,
  run_type TEXT NOT NULL CHECK (run_type IN ('sync', 'profile')),
  status TEXT NOT NULL CHECK (status IN ('queued', 'running', 'completed', 'failed')),
  stage TEXT NOT NULL,
  progress INTEGER NOT NULL DEFAULT 0 CHECK (progress BETWEEN 0 AND 100),
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
);

CREATE INDEX IF NOT EXISTS idx_sync_runs_status
  ON sync_runs(run_type, status, created_at DESC);

CREATE TABLE IF NOT EXISTS processed_articles (
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
  decision TEXT CHECK (decision IS NULL OR decision IN ('selected', 'rejected', 'pre_filtered')),
  scored_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_processed_articles_pmid ON processed_articles(pmid);
CREATE INDEX IF NOT EXISTS idx_processed_articles_doi ON processed_articles(doi);
CREATE INDEX IF NOT EXISTS idx_processed_articles_scored
  ON processed_articles(profile_hash, prompt_version, scored_at);
