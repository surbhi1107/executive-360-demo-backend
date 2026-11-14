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
