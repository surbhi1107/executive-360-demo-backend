// deepvox.ai Executive 360° — Express API (and static host for the built React app).
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import express from 'express';
import * as ask from './ask.js';
import config from './config.js';
import { getPortfolio } from './data.js';
import { agreementFiles } from './agreements.js';
import { assessProject } from './penalties.js';
import * as store from './store.js';
import { buildDashboard } from './views.js';
import { localDMonYear, localDMonYearHhmm, localHhmm } from './dates.js';

const ACTIONS = ['approve', 'auto', 'call', 'send', 'undo'];
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

  const dashboard = async (force = false) => buildDashboard(await getPortfolio(force));

  const sourcesInfo = (dash) => {
    const wb = config.WORKBOOK;
    return {
      workbook: { name: path.basename(wb), modified: localDMonYearHhmm(fs.statSync(wb).mtime), loaded: dash.loaded_at },
      agreements: agreementFiles().map((f) => ({
        ref: path.basename(f).split('_')[0],
        name: path.basename(f),
        modified: localDMonYear(fs.statSync(f).mtime),
      })),
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

  // ------------------------------------------------------------------ data
  app.get('/api/dashboard', ...P(async (req, res) => {
    const dash = await dashboard(req.query.reload === '1');
    dash.sources = sourcesInfo(dash);
    dash.flag_states = store.flagStates();
    dash.assistant = Boolean(config.ANTHROPIC_API_KEY);
    res.json(dash);
  }));

  app.get('/api/projects', ...P(async (req, res) => res.json((await dashboard()).projects)));

  app.get('/api/projects/:pid', ...P(async (req, res) => {
    const p = (await dashboard()).projects.find((x) => x.id.toLowerCase() === req.params.pid.toLowerCase());
    return p ? res.json(p) : res.status(404).json({ error: 'Not found' });
  }));

  app.get('/api/flags', ...P(async (req, res) => {
    const states = store.flagStates();
    res.json((await dashboard()).flags.map((f) => ({ ...f, state: states[f.id] ?? null })));
  }));

  app.get('/api/penalties', ...P(async (req, res) => {
    const pf = await getPortfolio();
    const out = [...pf.projects.values()].sort(byNumber).map((p) => assessProject(p));
    const total = Math.round(out.reduce((s, r) => s + r.exposure_cr, 0) * 1e4) / 1e4;
    res.json({ as_of: config.asOf().toISOString().slice(0, 10), total_cr: total, projects: out });
  }));

  // ------------------------------------------------------------------ flag actions
  app.post('/api/flags/:flagId/action', ...P(async (req, res) => {
    const body = req.body && typeof req.body === 'object' && !Array.isArray(req.body) ? req.body : {};
    const { action } = body;
    if (!ACTIONS.includes(action)) return res.status(400).json({ error: `action must be one of ${JSON.stringify(ACTIONS).replace(/"/g, "'").replace(/,/g, ', ')}` });
    const flagId = req.params.flagId;
    const flag = (await dashboard()).flags.find((f) => f.id === flagId);
    if (!flag) return res.status(404).json({ error: 'This flag no longer exists (the data may have changed). Reload the page.' });
    if (action === 'auto' && !flag.auto.allowed) return res.status(400).json({ error: flag.auto.reason });

    const t = localHhmm();
    let summary;
    let payload;
    if (action === 'call') {
      summary = `Call booked with ${flag.call.who.split(' · ')[0]}: ${flag.call.slot}.`;
      payload = flag.call;
    } else if (action === 'send') {
      const subject = String(body.subject || flag.email.subject).trim().slice(0, 200);
      summary = `Email “${subject}” sent to ${flag.email.to} at ${t}.`;
      payload = { to: flag.email.to, subject, body: String(body.body || flag.email.body).slice(0, 5000) };
    } else if (action === 'auto') {
      summary = `Automatic: ${flag.auto.done.replaceAll('{t}', t)}`;
      payload = { text: flag.auto.text };
    } else if (action === 'approve') {
      summary = `Approved at ${t}: ${flag.approval}`;
      payload = { approval: flag.approval };
    } else {
      summary = '';
      payload = {};
    }

    // Where the real work would happen: send the email (Gmail / Outlook API), book the meeting (calendar API),
    // or schedule the reminder. Until those are connected, the action is only recorded.
    console.log(`flag action ${flagId} ${action}`);
    const rec = store.recordAction(flagId, flag.proj, action, summary, payload);
    res.json({ ok: true, state: action === 'undo' ? null : { action, done: summary }, id: rec.id });
  }));

  // ------------------------------------------------------------------ ask
  app.post('/api/ask', ...P(async (req, res) => {
    const body = req.body && typeof req.body === 'object' && !Array.isArray(req.body) ? req.body : {};
    const q = String(body.question ?? '').trim();
    if (!q) return res.status(400).json({ error: 'Please type a question.' });
    let result;
    try {
      result = await ask.answer(q, await dashboard(), Array.isArray(body.history) ? body.history : []);
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
