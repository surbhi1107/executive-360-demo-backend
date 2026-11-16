// A small SQLite database for what happens in the app:
//   actions : what the CEO chose on each flag (call booked, email sent, automatic, approved, undone)
//   asks    : every question asked, the answer and its cost (audit log)
import fs from 'node:fs';
import path from 'node:path';
import config from './config.js';
import { localIsoSeconds } from './dates.js';

// SQLite comes with Node itself (node:sqlite, Node 22.13+), so there is nothing to compile or download.
// Node prints a one-line "experimental" notice for it; we hide only that line.
const emitWarning = process.emitWarning;
process.emitWarning = (w, ...rest) => (/SQLite/i.test(String(w?.message ?? w)) ? undefined : emitWarning.call(process, w, ...rest));
const { DatabaseSync } = await import('node:sqlite');
process.emitWarning = emitWarning;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS actions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  flag_id TEXT NOT NULL,
  project TEXT,
  action TEXT NOT NULL,           -- call | send | auto | approve | undo
  summary TEXT,                   -- the line shown on the flag, e.g. "Call booked with …"
  payload TEXT,                   -- JSON: email subject/body, call slot, etc.
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS ix_actions_flag ON actions(flag_id);
CREATE TABLE IF NOT EXISTS asks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  question TEXT NOT NULL,
  answer TEXT,
  error TEXT,
  model TEXT,
  input_tokens INTEGER,
  output_tokens INTEGER,
  ms INTEGER,
  created_at TEXT NOT NULL
);
`;

let db = null;
let openedAt = null;

function conn() {
  if (db && openedAt === config.DB_PATH) return db;
  if (db) db.close();
  fs.mkdirSync(path.dirname(config.DB_PATH), { recursive: true });
  db = new DatabaseSync(config.DB_PATH);
  db.exec('PRAGMA journal_mode = WAL');
  openedAt = config.DB_PATH;
  return db;
}

export function initDb() {
  conn().exec(SCHEMA);
}

/** The open database connection, for the other modules that keep their own tables (cases.js). */
export const getDb = () => conn();

/** Run several statements together: all of them are saved, or none. */
export function transaction(fn) {
  const c = conn();
  c.exec('BEGIN');
  try {
    const out = fn(c);
    c.exec('COMMIT');
    return out;
  } catch (e) {
    c.exec('ROLLBACK');
    throw e;
  }
}

export function closeDb() {
  if (db) db.close();
  db = null;
  openedAt = null;
}

export function recordAction(flagId, project, action, summary, payload = {}) {
  const info = conn()
    .prepare('INSERT INTO actions(flag_id, project, action, summary, payload, created_at) VALUES (?,?,?,?,?,?)')
    .run(flagId, project, action, summary, JSON.stringify(payload), localIsoSeconds());
  return { id: Number(info.lastInsertRowid), flag_id: flagId, action, summary };
}

/** The latest action for every flag. A flag whose latest action is 'undo' is open again. */
export function flagStates() {
  const rows = conn()
    .prepare(
      `SELECT a.* FROM actions a
       JOIN (SELECT flag_id, MAX(id) mid FROM actions GROUP BY flag_id) l ON a.id = l.mid`,
    )
    .all();
  const out = {};
  for (const r of rows) if (r.action !== 'undo') out[r.flag_id] = { action: r.action, done: r.summary, at: r.created_at };
  return out;
}

export function recentActions(limit = 50) {
  return conn()
    .prepare('SELECT * FROM actions ORDER BY id DESC LIMIT ?')
    .all(limit)
    .map((r) => ({ ...r, payload: JSON.parse(r.payload || '{}') }));
}

export function recordAsk(question, answer = null, error = null) {
  const meta = answer?.meta ?? {};
  conn()
    .prepare('INSERT INTO asks(question, answer, error, model, input_tokens, output_tokens, ms, created_at) VALUES (?,?,?,?,?,?,?,?)')
    .run(question, answer ? JSON.stringify(answer) : null, error, meta.model ?? null, meta.input_tokens ?? null, meta.output_tokens ?? null, meta.ms ?? null, localIsoSeconds());
}


// ------------------------------------------------------------------ snapshots and saved AI writing
const EXTRA_SCHEMA = `
CREATE TABLE IF NOT EXISTS snapshots (       -- the state of the dashboard each time the data changed
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  day TEXT NOT NULL,                         -- the "as of" date of the data
  taken_at TEXT NOT NULL,
  fingerprint TEXT NOT NULL,
  data TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS ai_cache (        -- AI-written briefs and flag advice, so the same text is not paid for twice
  key TEXT PRIMARY KEY,
  kind TEXT NOT NULL,                        -- brief | advice | links
  data TEXT NOT NULL,
  created_at TEXT NOT NULL
);
`;

export function initExtra() {
  conn().exec(EXTRA_SCHEMA);
}

/** Save the snapshot only if it differs from the latest one. */
export function saveSnapshot(day, fingerprint, data) {
  const c = conn();
  const last = c.prepare('SELECT fingerprint FROM snapshots ORDER BY id DESC LIMIT 1').get();
  if (!last || last.fingerprint !== fingerprint) {
    c.prepare('INSERT INTO snapshots(day, taken_at, fingerprint, data) VALUES (?,?,?,?)').run(day, localIsoSeconds(), fingerprint, JSON.stringify(data));
  }
}

/** The most recent snapshot that is different from the current one. */
export function previousSnapshot(fingerprint) {
  const row = conn().prepare('SELECT * FROM snapshots WHERE fingerprint != ? ORDER BY id DESC LIMIT 1').get(fingerprint);
  return row ? { day: row.day, taken_at: row.taken_at, data: JSON.parse(row.data) } : null;
}

export function cacheGet(key) {
  const row = conn().prepare('SELECT data FROM ai_cache WHERE key = ?').get(key);
  return row ? JSON.parse(row.data) : null;
}

export function cachePut(key, kind, data) {
  conn().prepare('INSERT OR REPLACE INTO ai_cache(key, kind, data, created_at) VALUES (?,?,?,?)').run(key, kind, JSON.stringify(data), localIsoSeconds());
}
