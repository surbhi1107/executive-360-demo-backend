// Run with:  npm test
// Uses the sample data frozen at 14 Nov 2026 and a stand-in for Claude, so no API key or internet is needed.
import './setup.js';
import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';

import * as ask from '../src/ask.js';
import config from '../src/config.js';
import { allClauses } from '../src/agreements.js';
import { getPortfolio } from '../src/data.js';
import { assessProject, ruleAmount, weeksLate } from '../src/penalties.js';
import { createApp } from '../src/app.js';
import { closeDb } from '../src/store.js';
import { buildDashboard } from '../src/views.js';
import { utcDay } from '../src/dates.js';

const TODAY = utcDay(2026, 11, 14);
const near = (a, b) => Math.abs(a - b) < 1e-9;

const dash = buildDashboard(await getPortfolio(true), TODAY);

// ---------------------------------------------------------------- penalties
describe('penalties', () => {
  test('weeks late is never negative', () => {
    assert.equal(weeksLate(utcDay(2026, 12, 4), utcDay(2026, 11, 1)), 0);
    assert.equal(weeksLate(utcDay(2026, 12, 4), utcDay(2026, 12, 17)), 1); // 13 days = 1 whole week
  });

  test('grace period and cap', () => {
    assert.deepEqual(ruleAmount(12, 3, 0.2, 10), [9, 1.8]);
    assert.deepEqual(ruleAmount(2, 3, 0.2, 10), [0, 0]);
    assert.deepEqual(ruleAmount(50, 0, 1, 5), [50, 5]); // capped
    assert.deepEqual(ruleAmount(10, 2, 0.5, 100, 3), [5, 2.5]); // excluded weeks come off too
  });

  test('project penalties match the hand calculation', async () => {
    const pf = await getPortfolio(true);
    const got = Object.fromEntries([...pf.projects].map(([id, p]) => [id, assessProject(p).exposure_cr]));
    assert.equal(got.P1, 3.8);
    assert.equal(got.P5, 0.9);
    assert.equal(got.P8, 6.5);
    assert.ok(near(Object.values(got).reduce((a, b) => a + b, 0), 11.2));
  });
});

// ---------------------------------------------------------------- dashboard
describe('dashboard', () => {
  test('summary', () => {
    assert.equal(dash.summary.projects, 12);
    assert.equal(dash.summary.at_risk, 4);
    assert.ok(near(dash.summary.penalty_total_cr, 11.2));
  });

  test('every flag has what the page needs', () => {
    assert.ok(dash.flags.length > 0);
    for (const f of dash.flags) {
      for (const key of ['id', 'type', 'sev', 'proj', 'title', 'body', 'impacts', 'sources', 'suggest', 'call', 'email', 'auto', 'approval']) {
        assert.ok(key in f, `${f.id} is missing ${key}`);
      }
      if (f.type === 'sla' && f.sev === 'risk') assert.equal(f.auto.allowed, false); // money: never automatic
    }
  });

  test('stale schedule flag', () => {
    const ids = new Set(dash.flags.map((f) => f.id));
    assert.ok(ids.has('stale-P8')); // 8 days without an update
    assert.ok(!ids.has('stale-P2')); // updated today
  });

  test('flags are sorted by severity, then type', () => {
    const sev = { risk: 0, watch: 1 };
    for (let i = 1; i < dash.flags.length; i++) assert.ok(sev[dash.flags[i - 1].sev] <= sev[dash.flags[i].sev]);
  });
});

// ---------------------------------------------------------------- agreements
describe('agreements', () => {
  test('all 12 are parsed, with unique clause ids', async () => {
    const c = await allClauses();
    assert.equal(Object.keys(c).length, 12);
    const p1 = c.P1;
    assert.equal(new Set(p1.map((x) => x.id)).size, p1.length);
    assert.ok(p1.some((x) => x.clause === '9.1' && x.text.includes('PR01')));
  });
});

// ---------------------------------------------------------------- API
class FakeClaude {
  constructor() {
    this.calls = [];
    this.messages = { create: async (kw) => this.#create(kw) };
  }

  #create(kw) {
    this.calls.push(kw);
    return {
      content: [{
        type: 'tool_use',
        name: 'answer',
        input: {
          hero: '₹3.8 Cr',
          body: 'Sunrise is <strong>late</strong><script>bad()</script>',
          list: ['PR01 ₹1.8 Cr'],
          followups: ['Why?'],
          sources: [
            { id: 'CALC:penalty:P1', used_for: 'exposure' },
            { id: 'DOC:E360-CA-P01:9.1', used_for: 'rule' },
            { id: 'made-up', used_for: 'x' },
          ],
        },
      }],
      usage: { input_tokens: 1, output_tokens: 1 },
    };
  }
}

describe('HTTP API', () => {
  let server;
  let base;
  let fake;

  const get = (p, opts) => fetch(base + p, opts);
  const post = (p, body) => fetch(base + p, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });

  before(async () => {
    fake = new FakeClaude();
    ask.setClient(fake);
    server = createApp().listen(0);
    await new Promise((r) => server.once('listening', r));
    base = `http://127.0.0.1:${server.address().port}`;
  });

  after(() => {
    ask.setClient(null);
    server.close();
    closeDb();
  });

  test('health', async () => {
    const j = await (await get('/api/health')).json();
    assert.equal(j.ok, true);
    assert.equal(j.as_of, '2026-11-14');
  });

  test('dashboard', async () => {
    const r = await get('/api/dashboard');
    assert.equal(r.status, 200);
    const j = await r.json();
    assert.equal(j.projects.length, 12);
    assert.ok(j.sources.agreements.length === 12);
    assert.equal(j.sources.workbook.name, 'Executive_360_Project_Data_clean.xlsx');
    assert.deepEqual(j.flag_states, {});
  });

  test('projects, one project (any case) and 404', async () => {
    assert.equal((await (await get('/api/projects')).json()).length, 12);
    assert.equal((await (await get('/api/projects/p8')).json()).id, 'P8');
    assert.equal((await get('/api/projects/P99')).status, 404);
  });

  test('penalties', async () => {
    const j = await (await get('/api/penalties')).json();
    assert.ok(near(j.total_cr, 11.2));
    assert.equal(j.projects.length, 12);
  });

  test('downloads: workbook and an agreement; unknown names are refused', async () => {
    const w = await get('/files/workbook');
    assert.equal(w.status, 200);
    assert.match(w.headers.get('content-disposition'), /attachment/);
    const name = (await (await get('/api/dashboard')).json()).sources.agreements[0].name;
    assert.equal((await get(`/files/agreements/${encodeURIComponent(name)}`)).status, 200);
    assert.equal((await get('/files/agreements/..%2Frules.json')).status, 404);
    assert.equal((await get('/files/agreements/nope.docx')).status, 404);
  });

  test('ask: cites, cleans markup, drops made-up sources', async () => {
    const r = await post('/api/ask', { question: 'What is the penalty on Sunrise Solar Park?' });
    const j = await r.json();
    assert.equal(r.status, 200);
    assert.ok(!j.body.includes('<script>'));
    assert.ok(j.body.includes('<strong>late</strong>'));
    assert.deepEqual(j.sources.map((s) => s.kind), ['calc', 'word']); // the made-up id is dropped
    assert.deepEqual(j.projects, ['P1']);
    const sent = fake.calls.at(-1);
    assert.deepEqual(sent.tool_choice, { type: 'auto' });
    assert.ok(sent.system.some((b) => b.text.startsWith('AGREEMENT CLAUSES')));
    assert.deepEqual(sent.system.at(-1).cache_control, { type: 'ephemeral' });
  });

  test('ask: a plain-text reply still shows the files it was based on', async () => {
    const plain = { messages: { create: async () => ({ content: [{ type: 'text', text: 'Sunrise is late.' }], usage: {} }) } };
    ask.setClient(plain);
    try {
      const project = await (await post('/api/ask', { question: 'What is the penalty on Sunrise Solar Park?' })).json();
      assert.ok(project.sources.some((s) => s.kind === 'excel' && s.name === 'Executive_360_Project_Data_clean.xlsx'));
      assert.ok(project.sources.some((s) => s.kind === 'word' && s.name.startsWith('E360-CA-P01')));
      const general = await (await post('/api/ask', { question: 'Which projects are late?' })).json();
      assert.ok(general.sources.some((s) => s.kind === 'excel' && s.name === 'Executive_360_Project_Data_clean.xlsx'));
    } finally {
      ask.setClient(fake);
    }
  });

  test('ask: charts are built from the verified numbers', async () => {
    const ask1 = async (question, history = []) => (await (await post('/api/ask', { question, history })).json()).chart;

    const pen = await ask1('What is the penalty exposure across projects?');
    assert.equal(pen.type, 'bars');
    assert.deepEqual(pen.rows.map((r) => [r.id, r.value]), [['P8', 6.5], ['P1', 3.8], ['P5', 0.9]]); // ranked, same as the dashboard
    assert.deepEqual(pen.table.columns.slice(0, 2), ['Project', 'Agreement']);
    assert.equal(pen.table.rows.length, 3);

    const rules = await ask1('What is the penalty on Sunrise Solar Park?');
    assert.equal(rules.id, 'penalty_rules');
    assert.ok(near(rules.rows.reduce((s, r) => s + r.value, 0), 3.8));

    const prog = await ask1('How is progress against plan across the portfolio?');
    assert.equal(prog.type, 'bullet');
    assert.equal(prog.rows.length, 12);
    for (const r of prog.rows) {
      const p = dash.projects.find((x) => x.id === r.id);
      assert.deepEqual([r.value, r.target], [p.ac, p.pl]);
    }

    const bud = await ask1('Which projects are over budget?');
    assert.equal(bud.type, 'grouped');
    assert.equal(bud.series.length, 2);

    const health = await ask1('Which projects are at risk?');
    assert.deepEqual(health.parts.map((p) => [p.key, p.value]), [['risk', 4], ['watch', 4], ['ok', 4]]);

    const time = await ask1('Why is Sunrise Solar Park behind?');
    assert.equal(time.type, 'range');
    assert.equal(time.today, '2026-11-14');
    assert.ok(time.rows.every((r) => r.from && r.to));

    assert.equal(await ask1('Hello there'), null); // nothing to chart
  });

  test('ask: a portfolio question is not charted for a project from the previous turn', async () => {
    const history = [{ q: 'Why is Sunrise Solar Park behind?', a: 'Because of slow mobilisation.' }];
    const r = await (await post('/api/ask', { question: 'Which projects are late?', history })).json();
    assert.equal(r.chart.id, 'slip_by_project');
    // ...but a follow-up that refers back keeps the project
    const f = await (await post('/api/ask', { question: 'And what about its milestones?', history })).json();
    assert.equal(f.chart.id, 'milestone_dates');
  });

  test('ask: the assistant can pick the chart, limit it to projects, or switch it off', async () => {
    const withHint = (chart) => ({
      messages: { create: async () => ({ content: [{ type: 'tool_use', name: 'answer', input: { hero: '', body: 'ok', sources: [], followups: [], chart } }], usage: {} }) },
    });
    const run = async (chart, question) => {
      ask.setClient(withHint(chart));
      try { return (await (await post('/api/ask', { question })).json()).chart; } finally { ask.setClient(fake); }
    };
    assert.equal(await run({ type: 'none' }, 'What is the penalty exposure?'), null);
    assert.equal((await run({ type: 'timeline', projects: ['P8'] }, 'Tell me about the projects')).title, 'Highway Bypass Package 3: milestone dates');
    assert.equal((await run({ type: 'slip', projects: ['P1', 'P8', 'P99'] }, 'Which are late?')).rows.length, 2); // unknown ids ignored
    assert.equal((await run({ type: 'banana' }, 'What is the penalty exposure?')).type, 'bars'); // invalid type falls back to the question
  });

  test('ask: empty question is a 400', async () => {
    const r = await post('/api/ask', { question: '   ' });
    assert.equal(r.status, 400);
    assert.equal((await r.json()).error, 'Please type a question.');
  });

  test('ask: bad JSON is treated as an empty question, not a crash', async () => {
    const r = await get('/api/ask', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{nope' });
    assert.equal(r.status, 400);
  });

  test('ask: history is passed on (last 3 turns)', async () => {
    const history = [1, 2, 3, 4].map((i) => ({ q: `q${i}`, a: `a${i}` }));
    await post('/api/ask', { question: 'And now?', history });
    const msgs = fake.calls.at(-1).messages;
    assert.equal(msgs.length, 7);
    assert.equal(msgs[0].content, 'q2');
  });

  test('flag action, state and undo', async () => {
    const flags = await (await get('/api/flags')).json();
    const fid = flags[0].id;
    assert.equal((await post(`/api/flags/${fid}/action`, { action: 'call' })).status, 200);
    assert.ok(fid in (await (await get('/api/dashboard')).json()).flag_states);
    await post(`/api/flags/${fid}/action`, { action: 'undo' });
    assert.ok(!(fid in (await (await get('/api/dashboard')).json()).flag_states));
  });

  test('flag action: send uses an edited subject; bad action and missing flag are refused', async () => {
    const r = await (await post('/api/flags/stale-P8/action', { action: 'send', subject: 'Please update today' })).json();
    assert.match(r.state.done, /Email “Please update today” sent to /);
    const bad = await post('/api/flags/stale-P8/action', { action: 'explode' });
    assert.equal(bad.status, 400);
    assert.match((await bad.json()).error, /action must be one of/);
    assert.equal((await post('/api/flags/nope-P0/action', { action: 'call' })).status, 404);
    await post('/api/flags/stale-P8/action', { action: 'undo' });
  });

  test('automatic is refused for penalty flags (money needs the CEO)', async () => {
    const r = await post('/api/flags/sla-P1/action', { action: 'auto' });
    assert.equal(r.status, 400);
    assert.match((await r.json()).error, /needs your decision/);
  });

  test('unknown API route is a JSON 404', async () => {
    const r = await get('/api/nothing');
    assert.equal(r.status, 404);
    assert.equal((await r.json()).error, 'Not found');
  });
});

describe('assistant switched off', () => {
  test('without a key the answer is a clear 503', async () => {
    ask.setClient(null);
    config.ANTHROPIC_API_KEY = '';
    const server = createApp().listen(0);
    await new Promise((r) => server.once('listening', r));
    try {
      const r = await fetch(`http://127.0.0.1:${server.address().port}/api/ask`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ question: 'Which projects are late?' }),
      });
      assert.equal(r.status, 503);
      assert.match((await r.json()).error, /ANTHROPIC_API_KEY/);
    } finally {
      server.close();
      closeDb();
    }
  });

  test('a failing Claude call becomes a 503 with the reason', async () => {
    ask.setClient({ messages: { create: async () => { throw Object.assign(new Error('401 bad key'), { error: { error: { message: 'invalid x-api-key' } } }); } } });
    const server = createApp().listen(0);
    await new Promise((r) => server.once('listening', r));
    try {
      const r = await fetch(`http://127.0.0.1:${server.address().port}/api/ask`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ question: 'Which projects are late?' }),
      });
      assert.equal(r.status, 503);
      assert.match((await r.json()).error, /could not be reached: invalid x-api-key/);
    } finally {
      ask.setClient(null);
      server.close();
      closeDb();
    }
  });
});

describe('optional login', () => {
  test('401 without credentials, 200 with them; health stays open', async () => {
    process.env.E360_USER = 'ceo';
    process.env.E360_PASSWORD = 's3cret';
    const server = createApp().listen(0);
    await new Promise((r) => server.once('listening', r));
    const base = `http://127.0.0.1:${server.address().port}`;
    try {
      const denied = await fetch(`${base}/api/dashboard`);
      assert.equal(denied.status, 401);
      assert.equal(denied.headers.get('www-authenticate'), 'Basic realm="Executive 360"');
      const wrong = await fetch(`${base}/api/dashboard`, { headers: { Authorization: `Basic ${Buffer.from('ceo:nope').toString('base64')}` } });
      assert.equal(wrong.status, 401);
      const ok = await fetch(`${base}/api/dashboard`, { headers: { Authorization: `Basic ${Buffer.from('ceo:s3cret').toString('base64')}` } });
      assert.equal(ok.status, 200);
      assert.equal((await fetch(`${base}/api/health`)).status, 200);
    } finally {
      delete process.env.E360_USER;
      delete process.env.E360_PASSWORD;
      server.close();
      closeDb();
    }
  });
});
