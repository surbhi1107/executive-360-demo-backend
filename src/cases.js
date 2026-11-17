// The case log: what was done about each flag, what came back, and what happens next.
//
// A case opens the first time the CEO acts on a flag. Every step is an event on its timeline:
//   email sent, call booked, reply received, reminder, escalation, data changed, resolved.
//
// "Did they act on it?" is judged from the DATA, not from the reply: if the flag disappears the case is resolved;
// if the flag's wording changes (new forecast, new amount) the data has moved; otherwise nothing has changed since the last contact.
//
// The follow-up ladder (days are set by the CEO in Settings):
//   1. no reply and no change for `remind_days`   -> reminder to the owner
//   2. still nothing by `escalate_days`           -> escalate to the owner's manager
//   3. still nothing by `ceo_days`                -> back to the CEO for a decision
// With automatic follow-up on, steps 1 and 2 are sent by the system. Otherwise (and always for flags about money, customers or
// individual employees) they are only suggested and wait for the CEO.
//
// All dates use clock(), which is the real time plus a demo offset, so a demo can "move forward" several days and show the ladder working.
import config from './config.js';
import * as contacts from './contacts.js';
import { MONTHS, localIsoSeconds } from './dates.js';
import { getDb } from './store.js';

export const STATUS_WORD = {
  waiting: 'Waiting for reply', replied: 'Replied', acted: 'Data updated', needs_ceo: 'Needs you', resolved: 'Resolved', withdrawn: 'Withdrawn',
};
export const OPEN = ['waiting', 'replied', 'acted', 'needs_ceo'];
export const DEFAULT_LADDER = { remind_days: 2, escalate_days: 4, ceo_days: 7 };
const AI = 'Executive 360°';
const DAY_MS = 86_400_000;
const IN_OPEN = `(${OPEN.map(() => '?').join(',')})`;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS cases (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  flag_id TEXT NOT NULL, dept TEXT NOT NULL, proj TEXT,
  title TEXT NOT NULL,              -- the flag's wording when the case opened
  last_title TEXT NOT NULL,         -- the flag's wording at the latest check
  owner TEXT NOT NULL, owner_role TEXT, manager TEXT,
  status TEXT NOT NULL,
  auto INTEGER NOT NULL DEFAULT 0,          -- automatic follow-up switched on by the CEO
  auto_allowed INTEGER NOT NULL DEFAULT 1,  -- 0 for flags about money, customers or individuals
  subject TEXT,
  contacts INTEGER NOT NULL DEFAULT 0,
  ladder_step INTEGER NOT NULL DEFAULT 0,
  opened_at TEXT NOT NULL, first_contact_at TEXT, last_contact_at TEXT,
  last_reply_at TEXT, reply_summary TEXT, data_changed_at TEXT, closed_at TEXT
);
CREATE TABLE IF NOT EXISTS case_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  case_id INTEGER NOT NULL, at TEXT NOT NULL,
  kind TEXT NOT NULL,       -- opened email call auto approved reply reminder escalated suggest ceo data resolved closed undo note
  actor TEXT NOT NULL,      -- the CEO's name, "Executive 360°" for automatic steps, or the person who replied
  text TEXT NOT NULL, payload TEXT
);
CREATE TABLE IF NOT EXISTS mail_seen (message_id TEXT PRIMARY KEY);
CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
`;

export function init() {
  getDb().exec(SCHEMA);
}

const db = () => getDb();
const all = (sql, ...args) => db().prepare(sql).all(...args).map((r) => ({ ...r }));
const one = (sql, ...args) => {
  const r = db().prepare(sql).get(...args);
  return r ? { ...r } : null;
};
const run1 = (sql, ...args) => db().prepare(sql).run(...args);

// ------------------------------------------------------------------ settings and clock
const getSetting = (key, dflt) => {
  const row = one('SELECT value FROM settings WHERE key = ?', key);
  return row ? JSON.parse(row.value) : dflt;
};
const setSetting = (key, value) => run1('INSERT OR REPLACE INTO settings(key, value) VALUES (?,?)', key, JSON.stringify(value));

export const ladder = () => ({ ...DEFAULT_LADDER, ...getSetting('ladder', {}) });

export function setLadder(values) {
  const lad = ladder();
  for (const k of Object.keys(DEFAULT_LADDER)) {
    if (k in values) lad[k] = Math.max(1, Math.min(60, Math.trunc(Number(values[k]))));
  }
  lad.escalate_days = Math.max(lad.escalate_days, lad.remind_days + 1); // each step must come after the one before
  lad.ceo_days = Math.max(lad.ceo_days, lad.escalate_days + 1);
  setSetting('ladder', lad);
  return lad;
}

export const offsetDays = () => Math.trunc(Number(getSetting('demo_days', 0)));
export function setOffset(days) {
  setSetting('demo_days', Math.max(0, Math.trunc(Number(days))));
  return offsetDays();
}

/** Now, plus the demo offset (whole seconds). */
export const clock = () => new Date(Math.floor(Date.now() / 1000) * 1000 + offsetDays() * DAY_MS);

const iso = (d) => (d ? localIsoSeconds(d) : null);
const dt = (s) => (s ? new Date(s) : null); // "2026-11-14T10:00:00" is read as local time
const daysBetween = (a, b) => Math.floor((a.getTime() - b.getTime()) / DAY_MS); // (a - b).days
const addMs = (d, days) => new Date(d.getTime() + days * DAY_MS);
const dayLabel = (d) => `${d.getDate()} ${MONTHS[d.getMonth()]}`;

// ------------------------------------------------------------------ writing
export function addEvent(caseId, kind, actor, text, payload = null, at = null) {
  run1('INSERT INTO case_events(case_id, at, kind, actor, text, payload) VALUES (?,?,?,?,?,?)', caseId, iso(at ?? clock()), kind, actor, text, JSON.stringify(payload ?? {}));
}

function update(caseId, fields) {
  const keys = Object.keys(fields);
  run1(`UPDATE cases SET ${keys.map((k) => `${k} = ?`).join(', ')} WHERE id = ?`, ...keys.map((k) => fields[k]), caseId);
}

export const row = (caseId) => one('SELECT * FROM cases WHERE id = ?', caseId);
export const openForFlag = (flagId) => one(`SELECT * FROM cases WHERE flag_id = ? AND status IN ${IN_OPEN} ORDER BY id DESC LIMIT 1`, flagId, ...OPEN);

/** The open case for this flag; created if there is none. */
export async function openCase(flag) {
  const existing = openForFlag(flag.id);
  if (existing) return existing;
  const owner = flag.email.to;
  const mgr = await contacts.managerOf(owner);
  const info = run1(
    'INSERT INTO cases(flag_id, dept, proj, title, last_title, owner, owner_role, manager, status, auto_allowed, subject, opened_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)',
    flag.id, flag.dept, flag.proj ?? null, flag.title, flag.title, owner, flag.call.who.split(' · ').pop(), mgr ? mgr.name : '', 'waiting',
    flag.auto.allowed ? 1 : 0, flag.email.subject, iso(clock()));
  const cid = Number(info.lastInsertRowid);
  addEvent(cid, 'opened', config.CEO_NAME, `Case opened: ${flag.title}`);
  return row(cid);
}

/** Record a contact with the owner (or manager) and restart the wait. */
export function contact(c, kind, actor, text, payload = null, extra = {}) {
  const now = iso(clock());
  addEvent(c.id, kind, actor, text, payload);
  update(c.id, { contacts: c.contacts + 1, last_contact_at: now, first_contact_at: c.first_contact_at || now, status: 'waiting', ...extra });
}

export function recordReply(caseId, sender, text, summary, at = null) {
  addEvent(caseId, 'reply', sender, summary, { full_text: text }, at);
  update(caseId, { last_reply_at: iso(at ?? clock()), reply_summary: summary, status: 'replied' });
}

export function withdraw(flagId) {
  const c = openForFlag(flagId);
  if (c) {
    addEvent(c.id, 'undo', config.CEO_NAME, 'Marked as not handled by the CEO. The case is closed.');
    update(c.id, { status: 'withdrawn', closed_at: iso(clock()) });
  }
}

export function close(caseId, text = 'Closed by the CEO.') {
  addEvent(caseId, 'closed', config.CEO_NAME, text);
  update(caseId, { status: 'resolved', closed_at: iso(clock()) });
}

export function setAuto(caseId, on) {
  const c = row(caseId);
  if (on && !c.auto_allowed) throw new Error('Automatic follow-up is not available for this case: it involves money, a customer or an individual employee.');
  update(caseId, { auto: on ? 1 : 0 });
  addEvent(caseId, 'auto', config.CEO_NAME, 'Automatic follow-up turned ' + (on ? 'on: reminders and escalation will be sent without asking.' : 'off.'));
}

// ------------------------------------------------------------------ reading
/** Has the data moved since the last contact? Judged from the flag, not from what anyone said. */
function dataState(c, flag, now) {
  const last = dt(c.last_contact_at);
  const days = last ? daysBetween(now, last) : 0;
  if (['resolved', 'withdrawn'].includes(c.status)) return { state: 'closed', text: 'Closed' };
  if (!flag) return { state: 'cleared', text: 'The issue no longer appears in the data' };
  const changed = dt(c.data_changed_at);
  if (changed && last && changed >= last) return { state: 'changed', text: `Data changed after the last contact: now “${flag.title}”` };
  return { state: 'unchanged', text: last ? `No change in the data since the last contact (${days} day${days !== 1 ? 's' : ''})` : 'No contact made yet' };
}

function nextStep(c, lad) {
  if (!OPEN.includes(c.status) || !c.first_contact_at) return '';
  if (c.status === 'needs_ceo') return 'Waiting for your decision';
  if (c.status === 'acted') return 'Watching the data until the flag clears';
  const first = dt(c.first_contact_at);
  const last = dt(c.last_contact_at);
  const how = c.auto && c.auto_allowed ? 'automatically' : 'suggested to you';
  if (c.status === 'replied') return `If the data has not changed by ${dayLabel(addMs(dt(c.last_reply_at), lad.escalate_days))}, it comes back to you`;
  if (c.ladder_step === 0) return `Reminder to ${c.owner} on ${dayLabel(addMs(last, lad.remind_days))} (${how})`;
  if (c.ladder_step === 1) return `Escalation to ${c.manager || 'the manager'} on ${dayLabel(addMs(first, lad.escalate_days))} (${how})`;
  if (c.ladder_step === 2) return `Back to you on ${dayLabel(addMs(first, lad.ceo_days))} if there is still no response`;
  return '';
}

/** Every case, newest first, with its timeline and where it stands. */
export function listCases(flagsById) {
  const now = clock();
  const lad = ladder();
  const rows = all('SELECT * FROM cases ORDER BY id DESC LIMIT 200');
  const byCase = {};
  for (const e of all('SELECT * FROM case_events ORDER BY id')) (byCase[e.case_id] ??= []).push({ at: e.at, kind: e.kind, actor: e.actor, text: e.text });
  return rows.map((c) => ({
    id: c.id, flag_id: c.flag_id, dept: c.dept, proj: c.proj, title: c.title, owner: c.owner, owner_role: c.owner_role, manager: c.manager,
    status: c.status, status_word: STATUS_WORD[c.status], open: OPEN.includes(c.status), needs_ceo: c.status === 'needs_ceo',
    auto: Boolean(c.auto), auto_allowed: Boolean(c.auto_allowed), contacts: c.contacts, opened_at: c.opened_at, last_contact_at: c.last_contact_at,
    reply: c.last_reply_at ? { at: c.last_reply_at, summary: c.reply_summary } : null,
    data: dataState(c, flagsById[c.flag_id], now), next: nextStep(c, lad), events: byCase[c.id] ?? [],
  }));
}

// ------------------------------------------------------------------ the follow-up run
export function reminderBody(c) {
  return `${c.owner.split(/\s+/)[0]},\n\nI wrote to you on ${dayLabel(dt(c.first_contact_at))} about this:\n\n    ${c.last_title}\n\n` +
    `I have not had a reply and the figures have not changed. Please send me your update today.\n\n${config.CEO_NAME}`;
}

export function escalationBody(c) {
  return `${(c.manager || 'Hello').split(/\s+/)[0]},\n\nI asked ${c.owner} on ${dayLabel(dt(c.first_contact_at))} about this:\n\n    ${c.last_title}\n\n` +
    `There has been no reply and the figures have not changed. Please take this up and come back to me by tomorrow.\n\n${config.CEO_NAME}`;
}

/** Read the mailbox and save each new reply on its case. Sends nothing. Returns a line per reply saved. */
export async function captureReplies(fetchReplies, summarise) {
  const saved = [];
  for (const r of await fetchReplies(new Date(Date.now() - 30 * DAY_MS))) {
    const seen = one('SELECT 1 AS x FROM mail_seen WHERE message_id = ?', r.message_id);
    if (!seen) run1('INSERT INTO mail_seen(message_id) VALUES (?)', r.message_id);
    const c = row(r.case_id);
    if (seen || !c || !OPEN.includes(c.status) || !r.text) continue;
    recordReply(c.id, r.from, r.text, await summarise(r.text, c), addMs(r.at, offsetDays()));
    console.log(`[mail] reply from ${r.from} saved on case ${c.id}`);
    saved.push(`Reply from ${r.from} recorded on case ${c.id}`);
  }
  return saved;
}

/**
 * One pass over every open case: read replies, check the data, and take the next step on the ladder.
 *   send(toName, subject, body, caseId) -> { note }     sends (or records) an email
 *   fetchReplies(since) -> [{ case_id, from, at, text, message_id }]
 *   summarise(text, case) -> string                      one or two sentences
 * Returns a plain list of what was done.
 */
export async function run(flagsById, send, fetchReplies, summarise) {
  const now = clock();
  const lad = ladder();
  const done = [];

  // 1. Replies from the mailbox
  done.push(...(await captureReplies(fetchReplies, summarise)));

  for (const c of all(`SELECT * FROM cases WHERE status IN ${IN_OPEN}`, ...OPEN)) {
    const flag = flagsById[c.flag_id];
    // 2. The data
    if (!flag) {
      addEvent(c.id, 'resolved', AI, 'Resolved: this issue no longer appears in the data.');
      update(c.id, { status: 'resolved', closed_at: iso(now) });
      done.push(`Case ${c.id} resolved: no longer flagged`);
      continue;
    }
    if (flag.title !== c.last_title) {
      addEvent(c.id, 'data', AI, `The data changed: now “${flag.title}”`);
      update(c.id, { last_title: flag.title, data_changed_at: iso(now) });
      Object.assign(c, { last_title: flag.title, data_changed_at: iso(now) });
      done.push(`Case ${c.id}: data changed`);
    }
    if (!c.first_contact_at) continue;
    const first = dt(c.first_contact_at);
    const last = dt(c.last_contact_at);
    const changed = dt(c.data_changed_at);
    const replied = dt(c.last_reply_at);
    if (changed && changed >= last) {
      if (c.status !== 'acted') update(c.id, { status: 'acted' });
      continue;
    }
    if (c.status === 'needs_ceo') continue;
    const auto = Boolean(c.auto && c.auto_allowed);
    const sinceLast = daysBetween(now, last);
    const sinceFirst = daysBetween(now, first);
    // 3. A reply came but nothing moved
    if (replied && replied >= last) {
      if (daysBetween(now, replied) >= lad.escalate_days && c.ladder_step < 9) {
        addEvent(c.id, 'ceo', AI, `${c.owner} replied on ${dayLabel(replied)}, but the data has not changed in ${daysBetween(now, replied)} days. Your decision is needed.`);
        update(c.id, { status: 'needs_ceo', ladder_step: 9 });
        done.push(`Case ${c.id}: replied but no change; back to the CEO`);
      }
      continue;
    }
    // 4. No reply and no change: the ladder
    if (c.ladder_step === 0 && sinceLast >= lad.remind_days) {
      if (auto) {
        const res = await send(c.owner, `Reminder: ${c.subject || c.title}`, reminderBody(c), c.id);
        contact(c, 'reminder', AI, `Reminder sent to ${c.owner}: no reply for ${sinceLast} days (${res.note}).`, null, { ladder_step: 1 });
      } else {
        addEvent(c.id, 'suggest', AI, `No reply from ${c.owner} for ${sinceLast} days and no change in the data. Suggested next step: send a reminder.`);
        update(c.id, { status: 'needs_ceo', ladder_step: 1 });
      }
      done.push(`Case ${c.id}: reminder ${auto ? 'sent' : 'suggested'}`);
    } else if (c.ladder_step === 1 && sinceFirst >= lad.escalate_days && sinceLast >= 1) {
      const mgr = c.manager || 'the manager';
      if (auto && c.manager) {
        const res = await send(c.manager, `Escalation: ${c.subject || c.title}`, escalationBody(c), c.id);
        contact(c, 'escalated', AI, `Escalated to ${mgr}: no reply from ${c.owner} after ${sinceFirst} days (${res.note}).`, null, { ladder_step: 2 });
      } else {
        addEvent(c.id, 'suggest', AI, `Still no reply from ${c.owner} after ${sinceFirst} days. Suggested next step: escalate to ${mgr}.`);
        update(c.id, { status: 'needs_ceo', ladder_step: 2 });
      }
      done.push(`Case ${c.id}: escalation ${auto && c.manager ? 'sent' : 'suggested'}`);
    } else if (c.ladder_step === 2 && sinceFirst >= lad.ceo_days) {
      addEvent(c.id, 'ceo', AI, `No response after ${sinceFirst} days and ${c.contacts} contacts. This needs your decision.`);
      update(c.id, { status: 'needs_ceo', ladder_step: 3 });
      done.push(`Case ${c.id}: back to the CEO`);
    }
  }
  return done;
}
