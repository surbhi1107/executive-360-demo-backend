// deepvox.ai Executive 360° — Express API (and static host for the built React app).
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import express from 'express';
import * as advisor from './advisor.js';
import * as ask from './ask.js';
import * as cases from './cases.js';
import config from './config.js';
import * as contacts from './contacts.js';
import { getPortfolio } from './data.js';
import { agreementFiles } from './agreements.js';
import { MODULES, allDepartments, publicDept } from './depts/index.js';
import { findLinks } from './links.js';
import * as mailer from './mailer.js';
import { assessProject } from './penalties.js';
import * as store from './store.js';
import { buildDashboard } from './views.js';
import { localDMonYear, localDMonYearHhmm, localHhmm, localIsoSeconds, pad } from './dates.js';

const ACTIONS = ['approve', 'auto', 'call', 'send', 'undo'];
const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const isWeekend = (d) => d.getDay() === 0 || d.getDay() === 6;
const wholeNumber = (v) => {
  const n = typeof v === 'number' ? v : typeof v === 'string' && /^\s*[+-]?\d+\s*$/.test(v) ? Number(v) : typeof v === 'boolean' ? Number(v) : NaN;
  if (!Number.isFinite(n)) throw new TypeError('Days must be whole numbers.');
  return Math.trunc(n);
};
const asObject = (b) => (b && typeof b === 'object' && !Array.isArray(b) ? b : {});

/** The next sensible time for a short call: 17:00 today if it is still early, otherwise 10:00 on the next working day. */
export function callSlot() {
  const now = cases.clock();
  let start = new Date(now);
  start.setHours(17, 0, 0, 0);
  if (now.getHours() >= 16 || isWeekend(now)) {
    start = new Date(now.getTime() + 86_400_000);
    start.setHours(10, 0, 0, 0);
    while (isWeekend(start)) start = new Date(start.getTime() + 86_400_000);
  }
  return [start, `${WEEKDAYS[start.getDay()]} ${pad(start.getDate())} ${MONTHS[start.getMonth()]}, ${pad(start.getHours())}:${pad(start.getMinutes())}`];
}
const byNumber = (a, b) => parseInt(a.id.slice(1), 10) - parseInt(b.id.slice(1), 10);

const safeEqual = (a, b) => {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && crypto.timingSafeEqual(x, y);
};

const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

export function createApp() {
  const app = express();
  app.disable('x-powered-by');
  store.initDb();
  store.initExtra();
  cases.init();

  // Lets the React app call this API from another address (a separate Vercel project, for example).
  app.use((req, res, next) => {
    res.set({
      'Access-Control-Allow-Origin': config.CORS_ORIGIN || '*',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      Vary: 'Origin',
    });
    return req.method === 'OPTIONS' ? res.sendStatus(204) : next();
  });

  // Bad JSON is treated as an empty body (the handlers then answer with a clear 400).
  app.use((req, res, next) => express.json({ limit: '1mb' })(req, res, (err) => {
    if (err) req.body = {};
    next();
  }));

  // Optional simple login for a pilot: set E360_USER and E360_PASSWORD in backend/.env
  const USER = process.env.E360_USER || '';
  const PASSWORD = process.env.E360_PASSWORD || '';
  const protectedRoute = (req, res, next) => {
    if (USER && PASSWORD) {
      const [scheme, token] = (req.get('authorization') || '').split(' ');
      let ok = false;
      if (scheme?.toLowerCase() === 'basic' && token) {
        const decoded = Buffer.from(token, 'base64').toString('utf8');
        const i = decoded.indexOf(':');
        ok = i >= 0 && safeEqual(decoded.slice(0, i), USER) && safeEqual(decoded.slice(i + 1), PASSWORD);
      }
      if (!ok) return res.status(401).set('WWW-Authenticate', 'Basic realm="Executive 360"').type('text').send('Login required');
    }
    return next();
  };
  const P = (fn) => [protectedRoute, wrap(fn)];

  /** Projects: everything calculated from the project workbook. */
  const dashboard = async (force = false) => buildDashboard(await getPortfolio(force));
  /** All six departments, in dashboard order (Projects is last). */
  const departments = (dash, force = false) => allDepartments(dash, null, force);
  const allFlags = (depts) => depts.flatMap((d) => d.flags);
  const flagMap = (depts) => Object.fromEntries(allFlags(depts).map((f) => [f.id, f]));

  const sourcesInfo = (dash) => {
    const wb = config.WORKBOOK;
    return {
      departments: MODULES.map((m) => ({ ref: `wb:${m.ID}`, name: m.FILE, dept: m.NAME, modified: localDMonYearHhmm(fs.statSync(path.join(config.DEPT_DIR, m.FILE)).mtime) })),
      workbook: { name: path.basename(wb), modified: localDMonYearHhmm(fs.statSync(wb).mtime), loaded: dash.loaded_at },
      agreements: agreementFiles().map((f) => ({ ref: path.basename(f).split('_')[0], name: path.basename(f), modified: localDMonYear(fs.statSync(f).mtime) })),
    };
  };

  /** Send an email to a person in the contacts workbook (or record it, if email is off). */
  const deliver = async (toName, subject, body, caseId, ics = null) => mailer.send(toName, (await contacts.find(toName)).email, subject, body, caseId, ics);

  const casesPayload = async (dash = null, depts = null) => {
    dash ??= await dashboard();
    depts ??= await departments(dash);
    const now = cases.clock();
    return {
      cases: cases.listCases(flagMap(depts)), ladder: cases.ladder(), mail: mailer.status(),
      clock: { now: localIsoSeconds(now).slice(0, 16), offset_days: cases.offsetDays() },
    };
  };

  // ------------------------------------------------------------------ pages
  const indexHtml = path.join(config.FRONTEND_DIST, 'index.html');
  app.get('/', protectedRoute, (req, res) => {
    if (!fs.existsSync(indexHtml)) {
      return res
        .status(200)
        .type('text')
        .send('Executive 360 API is running, but the React app has not been built.\nRun "npm run build" in the project root (or "npm run dev" and open http://localhost:5173).');
    }
    return res.sendFile(indexHtml);
  });
  app.use(express.static(config.FRONTEND_DIST, { index: false }));

  app.get('/api/health', (req, res) =>
    res.json({ ok: true, assistant: Boolean(config.ANTHROPIC_API_KEY), model: config.CLAUDE_MODEL, as_of: config.asOf().toISOString().slice(0, 10) }));

  app.get('/files/workbook', ...P((req, res) => res.download(config.WORKBOOK, path.basename(config.WORKBOOK))));

  app.get('/files/agreements/:name', ...P((req, res) => {
    const file = agreementFiles().find((f) => path.basename(f) === req.params.name);
    if (!file) return res.status(404).json({ error: 'Not found' });
    return res.download(file, path.basename(file));
  }));

  app.get('/files/departments/:name', ...P((req, res) => {
    const m = MODULES.find((x) => x.FILE === req.params.name);
    if (!m) return res.status(404).json({ error: 'Not found' });
    return res.download(path.join(config.DEPT_DIR, m.FILE), m.FILE);
  }));

  // ------------------------------------------------------------------ data
  app.get('/api/dashboard', ...P(async (req, res) => {
    const force = req.query.reload === '1';
    const dash = await dashboard(force);
    const depts = await departments(dash, force);
    const list = depts.map(publicDept);
    list[list.length - 1] = { ...list[list.length - 1], flags: [] }; // project flags are already in dash.flags
    dash.departments = list;
    dash.sources = sourcesInfo(dash);
    dash.flag_states = store.flagStates();
    Object.assign(dash, await casesPayload(dash, depts)); // cases, ladder, mail, clock
    dash.call_slot = callSlot()[1];
    dash.assistant = Boolean(config.ANTHROPIC_API_KEY);
    res.json(dash);
  }));

  app.get('/api/projects', ...P(async (req, res) => res.json((await dashboard()).projects)));

  app.get('/api/projects/:pid', ...P(async (req, res) => {
    const p = (await dashboard()).projects.find((x) => x.id.toLowerCase() === req.params.pid.toLowerCase());
    return p ? res.json(p) : res.status(404).json({ error: 'Not found' });
  }));

  app.get('/api/departments', ...P(async (req, res) => res.json((await departments(await dashboard())).map(publicDept))));

  app.get('/api/departments/:id', ...P(async (req, res) => {
    const d = (await departments(await dashboard())).find((x) => x.id === req.params.id.toLowerCase());
    return d ? res.json(publicDept(d)) : res.status(404).json({ error: 'Not found' });
  }));

  /** Every flag from every department. Add ?dept=finance to filter. */
  app.get('/api/flags', ...P(async (req, res) => {
    const states = store.flagStates();
    let flags = allFlags(await departments(await dashboard()));
    if (req.query.dept) flags = flags.filter((f) => f.dept === String(req.query.dept).toLowerCase());
    res.json(flags.map((f) => ({ ...f, state: states[f.id] ?? null })));
  }));

  app.get('/api/penalties', ...P(async (req, res) => {
    const pf = await getPortfolio();
    const out = [...pf.projects.values()].sort(byNumber).map((p) => assessProject(p));
    const total = Math.round(out.reduce((s, r) => s + r.exposure_cr, 0) * 1e4) / 1e4;
    res.json({ as_of: config.asOf().toISOString().slice(0, 10), total_cr: total, projects: out });
  }));

  // ------------------------------------------------------------------ flag actions
  app.post('/api/flags/:flagId/action', ...P(async (req, res) => {
    const body = asObject(req.body);
    const { action } = body;
    if (!ACTIONS.includes(action)) return res.status(400).json({ error: `action must be one of ${JSON.stringify(ACTIONS).replace(/"/g, "'").replace(/,/g, ', ')}` });
    const flagId = req.params.flagId;
    const flag = allFlags(await departments(await dashboard())).find((f) => f.id === flagId);
    if (!flag) return res.status(404).json({ error: 'This flag no longer exists (the data may have changed). Reload the page.' });
    if (action === 'auto' && !flag.auto.allowed) return res.status(400).json({ error: flag.auto.reason });

    const t = localHhmm(cases.clock());
    const owner = flag.email.to;
    let summary;
    let payload;
    if (action === 'undo') {
      cases.withdraw(flagId);
      summary = '';
      payload = {};
    } else {
      const c = await cases.openCase(flag);
      if (action === 'send') {
        const subject = String(body.subject || flag.email.subject).trim().slice(0, 200);
        const text = String(body.body || flag.email.body).slice(0, 5000);
        const r = await deliver(owner, subject, text, c.id);
        summary = `Email “${subject}” to ${owner} at ${t} (${r.note}).`;
        payload = { to: owner, subject, body: text };
        cases.contact(c, 'email', config.CEO_NAME, summary, payload, { subject });
      } else if (action === 'call') {
        const [start, label] = callSlot();
        const agenda = String(body.agenda || flag.call.agenda).slice(0, 300);
        const ics = mailer.invite(start, 15, `${config.CEO_NAME} / ${owner}: ${flag.title.slice(0, 80)}`, agenda, (await contacts.find(owner)).email || 'unknown@example.com');
        const r = await deliver(owner, `Call: ${flag.title.slice(0, 120)}`, `${owner.split(/\s+/)[0]},\n\nPlease join me for a 15-minute call on ${label}.\n\nAgenda: ${agenda}\n\n${config.CEO_NAME}`, c.id, ics);
        summary = `Call with ${owner} booked for ${label}; invite ${r.sent ? 'sent' : 'not sent'} (${r.note}).`;
        payload = { who: owner, when: localIsoSeconds(start), agenda };
        cases.contact(c, 'call', config.CEO_NAME, summary, payload);
      } else if (action === 'auto') {
        const r = await deliver(owner, flag.email.subject, flag.email.body, c.id);
        const lad = cases.ladder();
        summary = `Automatic follow-up on: first message to ${owner} at ${t} (${r.note}). A reminder goes after ${lad.remind_days} days without a reply, ` +
          `then it is escalated to ${c.manager || 'the manager'} after ${lad.escalate_days} days.`;
        payload = { text: flag.auto.text };
        cases.contact(c, 'email', config.CEO_NAME, `First message sent to ${owner} (${r.note}).`, { subject: flag.email.subject, body: flag.email.body });
        cases.setAuto(c.id, true);
      } else { // approve
        summary = `Approved at ${t}: ${flag.approval}`;
        payload = { approval: flag.approval };
        cases.addEvent(c.id, 'approved', config.CEO_NAME, summary);
      }
    }
    console.log(`flag action ${flagId} ${action}`);
    const rec = store.recordAction(flagId, flag.proj || flag.dept, action, summary, payload);
    res.json({ ok: true, state: action === 'undo' ? null : { action, done: summary }, id: rec.id });
  }));

  // ------------------------------------------------------------------ email, cases and follow-up
  app.get('/api/cases', ...P(async (req, res) => res.json(await casesPayload())));

  /** Read replies, check whether the data moved, and take the next step on each open case.
   *  Body (optional): { advance_days: 1 } moves the demo clock forward first; { reset_clock: true } sets it back to today. */
  app.post('/api/followups/run', ...P(async (req, res) => {
    const body = asObject(req.body);
    if (body.reset_clock) cases.setOffset(0);
    else if (body.advance_days) cases.setOffset(cases.offsetDays() + Math.max(0, Math.min(30, wholeNumber(body.advance_days))));
    const dash = await dashboard();
    const depts = await departments(dash);
    const done = await cases.run(flagMap(depts), deliver, mailer.fetchReplies, advisor.summariseReply);
    res.json({ done, ...(await casesPayload(dash, depts)) });
  }));

  /** Record a reply by hand (for example from a phone call). The AI summarises it for the timeline. */
  app.post('/api/cases/:id/reply', ...P(async (req, res) => {
    const body = asObject(req.body);
    const text = String(body.text ?? '').trim().slice(0, 4000);
    const id = Number(req.params.id);
    const payload = await casesPayload();
    const c = payload.cases.find((x) => x.id === id);
    if (!c || !text) return res.status(400).json({ error: 'Case not found, or the reply is empty.' });
    cases.recordReply(id, String(body.from || c.owner).slice(0, 80), text, await advisor.summariseReply(text, c));
    return res.json(await casesPayload());
  }));

  /** The CEO's decision on a case: remind | escalate | close | auto_on | auto_off. */
  app.post('/api/cases/:id/action', ...P(async (req, res) => {
    const { action } = asObject(req.body);
    const id = Number(req.params.id);
    const c = cases.row(id);
    if (!c || !cases.OPEN.includes(c.status)) return res.status(400).json({ error: 'This case is not open.' });
    try {
      if (action === 'remind') {
        const r = await deliver(c.owner, `Reminder: ${c.subject || c.title}`, cases.reminderBody(c), id);
        cases.contact(c, 'reminder', config.CEO_NAME, `Reminder sent to ${c.owner} (${r.note}).`, null, { ladder_step: Math.max(c.ladder_step, 1) });
      } else if (action === 'escalate') {
        if (!c.manager) return res.status(400).json({ error: `No manager is recorded for ${c.owner} in the contacts workbook.` });
        const r = await deliver(c.manager, `Escalation: ${c.subject || c.title}`, cases.escalationBody(c), id);
        cases.contact(c, 'escalated', config.CEO_NAME, `Escalated to ${c.manager} (${r.note}).`, null, { ladder_step: Math.max(c.ladder_step, 2) });
      } else if (action === 'close') {
        cases.close(id);
      } else if (action === 'auto_on' || action === 'auto_off') {
        cases.setAuto(id, action === 'auto_on');
      } else {
        return res.status(400).json({ error: 'action must be remind, escalate, close, auto_on or auto_off' });
      }
    } catch (e) {
      return res.status(400).json({ error: e.message });
    }
    return res.json(await casesPayload());
  }));

  app.get('/api/settings/ladder', ...P((req, res) => res.json(cases.ladder())));
  app.post('/api/settings/ladder', ...P((req, res) => {
    const body = asObject(req.body);
    try {
      const values = {};
      for (const k of Object.keys(cases.DEFAULT_LADDER)) if (k in body) values[k] = wholeNumber(body[k]);
      return res.json(cases.setLadder(values));
    } catch {
      return res.status(400).json({ error: 'Days must be whole numbers.' });
    }
  }));

  /** Issues that connect across departments. Found by code; the story is written by Claude (or by code if Claude is off). */
  app.get('/api/links', ...P(async (req, res) => {
    const dash = await dashboard();
    const depts = await departments(dash);
    res.json({ links: await advisor.writeLinks(findLinks(depts), flagMap(depts), dash.as_of, req.query.refresh === '1') });
  }));

  // ------------------------------------------------------------------ AI brief and AI advice
  /** The Home brief. Written by Claude and saved; written by code if Claude is off or fails. */
  app.get('/api/brief', ...P(async (req, res) => {
    const dash = await dashboard();
    const depts = await departments(dash);
    const [fingerprint, changes] = advisor.recordAndCompare(dash, depts);
    let brief;
    let note = '';
    try {
      brief = await advisor.writeBrief(dash, depts, fingerprint, changes, req.query.refresh === '1');
    } catch (e) {
      if (!(e instanceof ask.AskUnavailable)) throw e;
      brief = advisor.fallbackBrief(depts, changes);
      note = e.message;
    }
    res.json({ brief, changes, note });
  }));

  /** Explanation, suggestions, email draft and call agenda written by the department's agent for this flag. */
  app.get('/api/flags/:flagId/advice', ...P(async (req, res) => {
    const dash = await dashboard();
    const depts = await departments(dash);
    const flag = allFlags(depts).find((f) => f.id === req.params.flagId);
    if (!flag) return res.status(404).json({ error: 'This flag no longer exists (the data may have changed). Reload the page.' });
    try {
      return res.json(await advisor.writeAdvice(flag, dash, depts, req.query.refresh === '1'));
    } catch (e) {
      if (e instanceof ask.AskUnavailable) return res.status(503).json({ error: e.message });
      throw e;
    }
  }));

  // ------------------------------------------------------------------ ask
  app.post('/api/ask', ...P(async (req, res) => {
    const body = asObject(req.body);
    const q = String(body.question ?? '').trim();
    if (!q) return res.status(400).json({ error: 'Please type a question.' });
    let result;
    try {
      const dash = await dashboard();
      // "dept" names the agent (finance, sales, operations, customers, people, projects). Empty = pick by the question.
      result = await ask.answer(q, dash, await departments(dash), String(body.dept ?? '').toLowerCase() || null, Array.isArray(body.history) ? body.history : []);
    } catch (e) {
      if (e instanceof ask.AskUnavailable) {
        store.recordAsk(q, null, e.message);
        return res.status(503).json({ error: e.message });
      }
      throw e;
    }
    store.recordAsk(q, result);
    return res.json(result);
  }));

  // ------------------------------------------------------------------ errors
  app.use('/api', (req, res) => res.status(404).json({ error: 'Not found' }));

  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => {
    console.error('Unhandled error', err);
    res.status(500).json({ error: 'Something went wrong on the server. Check the logs.' });
  });

  return app;
}
