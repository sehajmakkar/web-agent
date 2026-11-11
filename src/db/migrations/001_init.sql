-- 001: conversations, messages (+ FTS5), evidence (sources, claims), notes.
-- All timestamps are ISO-8601 UTC. `local_date` is the calendar date in the conversation's timezone (C5),
-- so "what did I ask on 3 November" is an indexed equality lookup, not a timezone calculation at query time.

CREATE TABLE conversations (
  id          TEXT PRIMARY KEY,
  title       TEXT NOT NULL DEFAULT '',
  summary     TEXT,
  topics      TEXT NOT NULL DEFAULT '[]',          -- JSON array of strings (Phase 4 extraction)
  tz          TEXT NOT NULL,
  started_at  TEXT NOT NULL,
  local_date  TEXT NOT NULL,
  updated_at  TEXT NOT NULL
);
CREATE INDEX conversations_local_date ON conversations(local_date);
CREATE INDEX conversations_updated_at ON conversations(updated_at);

CREATE TABLE messages (
  id               TEXT PRIMARY KEY,
  conversation_id  TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  seq              INTEGER NOT NULL,
  role             TEXT NOT NULL CHECK (role IN ('user', 'assistant')),
  content          TEXT NOT NULL,
  created_at       TEXT NOT NULL,
  local_date       TEXT NOT NULL,
  meta             TEXT,                             -- JSON: model, metrics
  UNIQUE (conversation_id, seq)
);
CREATE INDEX messages_local_date ON messages(local_date);

-- Keyword search over everything said (Phase 3 retrieval). External-content FTS kept in sync by triggers.
CREATE VIRTUAL TABLE messages_fts USING fts5(content, content = 'messages', content_rowid = 'rowid', tokenize = 'porter unicode61');
CREATE TRIGGER messages_ai AFTER INSERT ON messages BEGIN
  INSERT INTO messages_fts (rowid, content) VALUES (new.rowid, new.content);
END;
CREATE TRIGGER messages_ad AFTER DELETE ON messages BEGIN
  INSERT INTO messages_fts (messages_fts, rowid, content) VALUES ('delete', old.rowid, old.content);
END;
CREATE TRIGGER messages_au AFTER UPDATE OF content ON messages BEGIN
  INSERT INTO messages_fts (messages_fts, rowid, content) VALUES ('delete', old.rowid, old.content);
  INSERT INTO messages_fts (rowid, content) VALUES (new.rowid, new.content);
END;

-- Evidence snapshot: what a page said when we read it. One row per (message, page): not deduped across
-- messages on purpose, because "what did neon.com/pricing say on 3 Nov" is exactly what re-verification needs.
CREATE TABLE sources (
  id            INTEGER PRIMARY KEY,
  url           TEXT NOT NULL,
  title         TEXT NOT NULL DEFAULT '',
  provider      TEXT NOT NULL DEFAULT '',
  published_at  TEXT,
  fetched_at    TEXT NOT NULL,
  excerpt       TEXT NOT NULL DEFAULT '',
  content_hash  TEXT NOT NULL
);
CREATE INDEX sources_url ON sources(url);

CREATE TABLE message_sources (
  message_id  TEXT NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  source_id   INTEGER NOT NULL REFERENCES sources(id) ON DELETE CASCADE,
  n           INTEGER NOT NULL,                      -- the [n] used in the message text
  cited       INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (message_id, n)
);

-- Evidence ledger (ADR-007), filled by extraction in Phase 4 (and by seeds).
CREATE TABLE claims (
  id                   INTEGER PRIMARY KEY,
  message_id           TEXT NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  entity               TEXT NOT NULL,
  attribute            TEXT NOT NULL,
  value                TEXT NOT NULL,
  source_id            INTEGER REFERENCES sources(id) ON DELETE SET NULL,
  quote                TEXT,
  observed_at          TEXT NOT NULL,
  supersedes_claim_id  INTEGER REFERENCES claims(id) ON DELETE SET NULL
);
CREATE INDEX claims_entity ON claims(entity);

-- User decisions / shortlists / preferences (C3).
CREATE TABLE notes (
  id               INTEGER PRIMARY KEY,
  conversation_id  TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  kind             TEXT NOT NULL,
  payload          TEXT NOT NULL,                    -- JSON
  created_at       TEXT NOT NULL
);
