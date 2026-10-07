PRAGMA journal_mode = WAL;

CREATE TABLE IF NOT EXISTS hook_events (
  id INTEGER PRIMARY KEY,
  dedupe_key TEXT NOT NULL UNIQUE,
  event TEXT NOT NULL,
  received_at TEXT,
  task_id TEXT,
  hook_ts INTEGER,
  workspace_root TEXT,
  payload_json TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_hook_events_task ON hook_events(task_id);
CREATE INDEX IF NOT EXISTS idx_hook_events_event ON hook_events(event);

CREATE TABLE IF NOT EXISTS sessions (
  session_id TEXT PRIMARY KEY,
  source TEXT,
  provider TEXT,
  model TEXT,
  cwd TEXT,
  workspace_root TEXT,
  status TEXT,
  started_at TEXT,
  updated_at TEXT,
  prompt TEXT,
  title TEXT,
  tokens_in INTEGER,
  tokens_out INTEGER,
  cost REAL,
  messages_path TEXT,
  system_prompt TEXT,
  hook_task_id TEXT,
  correlation TEXT,
  raw_json TEXT
);

CREATE TABLE IF NOT EXISTS turns (
  id INTEGER PRIMARY KEY,
  session_id TEXT NOT NULL,
  turn_index INTEGER NOT NULL,
  block_index INTEGER NOT NULL,
  role TEXT,
  display_role TEXT,
  kind TEXT,
  text TEXT,
  text_seg TEXT,
  tool_name TEXT,
  tool_call_id TEXT,
  is_error INTEGER,
  content_json TEXT,
  UNIQUE(session_id, turn_index, block_index)
);
CREATE INDEX IF NOT EXISTS idx_turns_session ON turns(session_id);

CREATE VIRTUAL TABLE IF NOT EXISTS turns_fts USING fts5(
  text,
  content='turns',
  content_rowid='id',
  tokenize='unicode61'
);

CREATE TRIGGER IF NOT EXISTS turns_ai AFTER INSERT ON turns BEGIN
  INSERT INTO turns_fts(rowid, text) VALUES (new.id, COALESCE(new.text, ''));
END;
CREATE TRIGGER IF NOT EXISTS turns_ad AFTER DELETE ON turns BEGIN
  INSERT INTO turns_fts(turns_fts, rowid, text) VALUES ('delete', old.id, COALESCE(old.text, ''));
END;
CREATE TRIGGER IF NOT EXISTS turns_au AFTER UPDATE ON turns BEGIN
  INSERT INTO turns_fts(turns_fts, rowid, text) VALUES ('delete', old.id, COALESCE(old.text, ''));
  INSERT INTO turns_fts(rowid, text) VALUES (new.id, COALESCE(new.text, ''));
END;

CREATE TABLE IF NOT EXISTS tool_calls (
  id INTEGER PRIMARY KEY,
  session_id TEXT NOT NULL,
  turn_index INTEGER NOT NULL,
  tool_call_id TEXT,
  tool_name TEXT,
  parameters_json TEXT,
  result_text TEXT,
  success INTEGER,
  duration_ms INTEGER,
  source TEXT,
  UNIQUE(session_id, tool_call_id)
);
CREATE INDEX IF NOT EXISTS idx_tool_calls_session ON tool_calls(session_id);

CREATE TABLE IF NOT EXISTS meta (
  key TEXT PRIMARY KEY,
  value TEXT
);

CREATE TABLE IF NOT EXISTS session_cards (
  session_id TEXT PRIMARY KEY,
  goal TEXT,
  goal_seg TEXT,
  outcome TEXT,
  outcome_seg TEXT,
  tools_json TEXT,
  files_json TEXT,
  errors_json TEXT,
  summary TEXT,
  decisions_json TEXT,
  open_questions_json TEXT,
  lessons_json TEXT,
  generated_by TEXT,
  generated_at TEXT
);

CREATE VIRTUAL TABLE IF NOT EXISTS session_cards_fts USING fts5(
  goal,
  outcome,
  content='session_cards',
  content_rowid='rowid',
  tokenize='unicode61'
);
CREATE TRIGGER IF NOT EXISTS cards_ai AFTER INSERT ON session_cards BEGIN
  INSERT INTO session_cards_fts(rowid, goal, outcome)
  VALUES (new.rowid, COALESCE(new.goal, ''), COALESCE(new.outcome, ''));
END;
CREATE TRIGGER IF NOT EXISTS cards_ad AFTER DELETE ON session_cards BEGIN
  INSERT INTO session_cards_fts(session_cards_fts, rowid, goal, outcome)
  VALUES ('delete', old.rowid, COALESCE(old.goal, ''), COALESCE(old.outcome, ''));
END;
CREATE TRIGGER IF NOT EXISTS cards_au AFTER UPDATE ON session_cards BEGIN
  INSERT INTO session_cards_fts(session_cards_fts, rowid, goal, outcome)
  VALUES ('delete', old.rowid, COALESCE(old.goal, ''), COALESCE(old.outcome, ''));
  INSERT INTO session_cards_fts(rowid, goal, outcome)
  VALUES (new.rowid, COALESCE(new.goal, ''), COALESCE(new.outcome, ''));
END;

CREATE VIRTUAL TABLE IF NOT EXISTS session_cards_fts_seg USING fts5(
  goal_seg,
  outcome_seg,
  content='session_cards',
  content_rowid='rowid',
  tokenize='unicode61'
);
CREATE TRIGGER IF NOT EXISTS cards_seg_ai AFTER INSERT ON session_cards BEGIN
  INSERT INTO session_cards_fts_seg(rowid, goal_seg, outcome_seg)
  VALUES (new.rowid, COALESCE(new.goal_seg, ''), COALESCE(new.outcome_seg, ''));
END;
CREATE TRIGGER IF NOT EXISTS cards_seg_ad AFTER DELETE ON session_cards BEGIN
  INSERT INTO session_cards_fts_seg(session_cards_fts_seg, rowid, goal_seg, outcome_seg)
  VALUES ('delete', old.rowid, COALESCE(old.goal_seg, ''), COALESCE(old.outcome_seg, ''));
END;
CREATE TRIGGER IF NOT EXISTS cards_seg_au AFTER UPDATE ON session_cards BEGIN
  INSERT INTO session_cards_fts_seg(session_cards_fts_seg, rowid, goal_seg, outcome_seg)
  VALUES ('delete', old.rowid, COALESCE(old.goal_seg, ''), COALESCE(old.outcome_seg, ''));
  INSERT INTO session_cards_fts_seg(rowid, goal_seg, outcome_seg)
  VALUES (new.rowid, COALESCE(new.goal_seg, ''), COALESCE(new.outcome_seg, ''));
END;

CREATE TABLE IF NOT EXISTS memory_units (
  id INTEGER PRIMARY KEY,
  type TEXT NOT NULL,
  statement TEXT NOT NULL,
  statement_seg TEXT,
  detail TEXT,
  detail_seg TEXT,
  scope TEXT NOT NULL DEFAULT 'person',
  confidence REAL NOT NULL DEFAULT 0.5,
  status TEXT NOT NULL DEFAULT 'candidate',
  evidence_json TEXT,
  source_session TEXT,
  created_at TEXT,
  updated_at TEXT,
  use_count INTEGER DEFAULT 0,
  pinned INTEGER DEFAULT 0,
  positive_feedback INTEGER DEFAULT 0,
  negative_feedback INTEGER DEFAULT 0,
  supersedes_id INTEGER,
  superseded_by INTEGER
);
CREATE INDEX IF NOT EXISTS idx_units_status ON memory_units(status);
CREATE INDEX IF NOT EXISTS idx_units_type ON memory_units(type);

CREATE VIRTUAL TABLE IF NOT EXISTS memory_units_fts USING fts5(
  statement,
  detail,
  content='memory_units',
  content_rowid='rowid',
  tokenize='unicode61'
);
CREATE TRIGGER IF NOT EXISTS units_ai AFTER INSERT ON memory_units BEGIN
  INSERT INTO memory_units_fts(rowid, statement, detail)
  VALUES (new.rowid, COALESCE(new.statement, ''), COALESCE(new.detail, ''));
END;
CREATE TRIGGER IF NOT EXISTS units_ad AFTER DELETE ON memory_units BEGIN
  INSERT INTO memory_units_fts(memory_units_fts, rowid, statement, detail)
  VALUES ('delete', old.rowid, COALESCE(old.statement, ''), COALESCE(old.detail, ''));
END;
CREATE TRIGGER IF NOT EXISTS units_au AFTER UPDATE ON memory_units BEGIN
  INSERT INTO memory_units_fts(memory_units_fts, rowid, statement, detail)
  VALUES ('delete', old.rowid, COALESCE(old.statement, ''), COALESCE(old.detail, ''));
  INSERT INTO memory_units_fts(rowid, statement, detail)
  VALUES (new.rowid, COALESCE(new.statement, ''), COALESCE(new.detail, ''));
END;

CREATE VIRTUAL TABLE IF NOT EXISTS memory_units_fts_seg USING fts5(
  statement_seg,
  detail_seg,
  content='memory_units',
  content_rowid='rowid',
  tokenize='unicode61'
);
CREATE TRIGGER IF NOT EXISTS units_seg_ai AFTER INSERT ON memory_units BEGIN
  INSERT INTO memory_units_fts_seg(rowid, statement_seg, detail_seg)
  VALUES (new.rowid, COALESCE(new.statement_seg, ''), COALESCE(new.detail_seg, ''));
END;
CREATE TRIGGER IF NOT EXISTS units_seg_ad AFTER DELETE ON memory_units BEGIN
  INSERT INTO memory_units_fts_seg(memory_units_fts_seg, rowid, statement_seg, detail_seg)
  VALUES ('delete', old.rowid, COALESCE(old.statement_seg, ''), COALESCE(old.detail_seg, ''));
END;
CREATE TRIGGER IF NOT EXISTS units_seg_au AFTER UPDATE ON memory_units BEGIN
  INSERT INTO memory_units_fts_seg(memory_units_fts_seg, rowid, statement_seg, detail_seg)
  VALUES ('delete', old.rowid, COALESCE(old.statement_seg, ''), COALESCE(old.detail_seg, ''));
  INSERT INTO memory_units_fts_seg(rowid, statement_seg, detail_seg)
  VALUES (new.rowid, COALESCE(new.statement_seg, ''), COALESCE(new.detail_seg, ''));
END;

CREATE TABLE IF NOT EXISTS distill_state (
  session_id TEXT PRIMARY KEY,
  distilled_at TEXT,
  model TEXT,
  units_created INTEGER DEFAULT 0,
  status TEXT,
  error TEXT
);

CREATE TABLE IF NOT EXISTS injections (
  id INTEGER PRIMARY KEY,
  dedupe_key TEXT NOT NULL UNIQUE,
  ts TEXT,
  task_id TEXT,
  session_id TEXT,
  sections_json TEXT,
  unit_ids_json TEXT,
  cards INTEGER DEFAULT 0,
  turns INTEGER DEFAULT 0,
  chars INTEGER DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_injections_ts ON injections(ts);

CREATE TABLE IF NOT EXISTS forget_list (
  kind TEXT NOT NULL,
  value TEXT NOT NULL,
  created_at TEXT,
  note TEXT,
  PRIMARY KEY (kind, value)
);

CREATE TABLE IF NOT EXISTS embeddings (
  turn_id INTEGER PRIMARY KEY,
  session_id TEXT,
  vector BLOB NOT NULL,
  dims INTEGER NOT NULL,
  model TEXT,
  created_at TEXT
);

CREATE TABLE IF NOT EXISTS unit_feedback (
  id INTEGER PRIMARY KEY,
  unit_id INTEGER NOT NULL,
  signal TEXT NOT NULL,
  note TEXT,
  created_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_feedback_unit ON unit_feedback(unit_id);

CREATE TABLE IF NOT EXISTS skills (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  slug TEXT NOT NULL,
  description TEXT,
  body TEXT,
  status TEXT NOT NULL DEFAULT 'draft',
  evidence_json TEXT,
  source_units_json TEXT,
  path TEXT,
  use_count INTEGER DEFAULT 0,
  success_count INTEGER DEFAULT 0,
  fail_count INTEGER DEFAULT 0,
  created_at TEXT,
  updated_at TEXT,
  activated_at TEXT
);

CREATE TABLE IF NOT EXISTS blobs (
  hash TEXT PRIMARY KEY,
  size INTEGER NOT NULL,
  path TEXT NOT NULL,
  created_at TEXT
);

CREATE TABLE IF NOT EXISTS task_prefs (
  task_id TEXT PRIMARY KEY,
  memory_enabled INTEGER NOT NULL DEFAULT 1,
  capture_enabled INTEGER NOT NULL DEFAULT 1,
  updated_at TEXT
);
