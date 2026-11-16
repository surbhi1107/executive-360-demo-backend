// Run with:  npm test
// Uses the sample data frozen at 14 Nov 2026 and a stand-in for Claude and for Gmail, so no API key or internet is needed.
import './setup.js';
import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import MailComposer from 'nodemailer/lib/mail-composer/index.js';

import * as advisor from '../src/advisor.js';
import * as ask from '../src/ask.js';
import * as cases from '../src/cases.js';
import config from '../src/config.js';
import { allClauses } from '../src/agreements.js';
import { getPortfolio } from '../src/data.js';
import { allDepartments } from '../src/depts/index.js';
import { findLinks } from '../src/links.js';
import * as mailer from '../src/mailer.js';
import { assessProject, ruleAmount, weeksLate } from '../src/penalties.js';
import { createApp } from '../src/app.js';
import { closeDb } from '../src/store.js';
import { buildDashboard } from '../src/views.js';
import { daysBetween, utcDay } from '../src/dates.js';

const TODAY = utcDay(2026, 11, 14);
const near = (a, b) => Math.abs(a - b) < 1e-9;

const pf = await getPortfolio(true);
const dash = buildDashboard(pf, TODAY);
const departments = await allDepartments(dash, TODAY);

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
    const got = Object.fromEntries([...(await getPortfolio(true)).projects].map(([id, p]) => [id, assessProject(p).exposure_cr]));
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

  test('internal target is two weeks before the revised target', () => {
    for (const p of pf.projects.values()) for (const m of p.milestones) assert.equal(daysBetween(m.internal, m.revised), 14);
  });

  test('buffer flags are watches, and phases carry the buffer figures', () => {
    const buf = dash.flags.filter((f) => f.type === 'internal');
    assert.ok(buf.length && buf.every((f) => f.sev === 'watch'));
    const ph = dash.projects[0].phases[0];
    assert.ok('internal' in ph && 'buffer_days_left' in ph);
  });

  test('progress confirmed by departments: status and flags', () => {
    const p1 = dash.projects[0].phases;
    assert.equal(p1[0].confirmed.status, 'gap'); // reported 90, confirmed 78
    assert.equal(p1[0].confirmed.pct, 78);
    assert.equal(p1[4].confirmed.status, 'na'); // not started
    const f = dash.flags.find((x) => x.id === 'confirm-P1');
    assert.equal(f.email.to, 'Gautam Reddy');
    assert.ok(f.title.includes('78%'));
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

// ---------------------------------------------------------------- departments
describe('departments', () => {
  test('six departments in order', () => {
    assert.deepEqual(departments.map((d) => d.id), ['finance', 'sales', 'operations', 'customers', 'people', 'projects']);
    for (const d of departments) {
      assert.ok(['ok', 'watch', 'risk'].includes(d.status));
      assert.ok(d.headline && d.kpis.length === 4 && d.agent.endsWith('Agent'), d.id);
    }
  });

  test('department figures', () => {
    const by = Object.fromEntries(departments.map((d) => [d.id, d]));
    assert.equal(by.finance.calc.revenue_year_to_date_cr, 877);
    assert.equal(by.finance.calc.overdue_receivables_cr, 45.4);
    assert.equal(by.sales.calc.booked_this_quarter_cr, 140);
    assert.equal(by.operations.calc.on_time_delivery_pct_last_30_days, 92.7);
    assert.equal(by.customers.calc.revenue_at_risk_cr, 163); // Deccan 126 + Vadodara 37
    assert.equal(by.people.calc.attrition_12_months_pct, 13.3);
  });

  test('department flags are complete and unique', () => {
    const flags = departments.flatMap((d) => d.flags);
    assert.equal(new Set(flags.map((f) => f.id)).size, flags.length);
    for (const f of flags) {
      for (const key of ['dept', 'label', 'short', 'where', 'title', 'body', 'impacts', 'sources', 'suggest', 'call', 'email', 'auto', 'approval']) {
        assert.ok(key in f, `${f.id} is missing ${key}`);
      }
    }
  });

  test('connected issues span departments', () => {
    const found = findLinks(departments);
    const hosur = found.find((g) => g.key === 'site:hosur');
    assert.deepEqual(new Set(hosur.depts), new Set(['operations', 'customers', 'people']));
    assert.ok(found.every((g) => g.depts.length >= 2));
  });
});

describe('routing', () => {
  test('a question goes to the department whose words it uses', () => {
    const r = (q) => ask.route(q, dash.projects);
    assert.equal(r('Why did margin fall last month?'), 'finance');
    assert.equal(r('Which deals are stalled?'), 'sales');
    assert.equal(r('Which plants are below target?'), 'operations');
    assert.equal(r('Which customers are at risk?'), 'customers');
    assert.equal(r('Why is attrition high in Logistics?'), 'people');
    assert.equal(r('What is the penalty on Sunrise Solar Park?'), 'projects');
    assert.equal(r('What needs my attention today?'), 'overview');
  });
});

describe('cleaning what the model sends back', () => {
  test('charts keep only real numbers', () => {
    const c = ask.cleanChart({ title: 'T', unit: 'bananas', rows: [{ label: 'a', value: '3.456', compare: 5 }, { label: 'b', value: 'x' }, { label: 'c' }], compare_label: 'target' });
    assert.deepEqual(c, { title: 'T', unit: 'count', rows: [{ label: 'a', value: 3.46, compare: 5 }], compare_label: 'target' });
    assert.equal(ask.cleanChart({ rows: [] }), null);
    assert.equal(ask.cleanChart('nope'), null);
  });

  test('tables are padded to their columns and capped', () => {
    const t = ask.cleanTable({ columns: ['a', 'b', 'c'], rows: [['1'], ['1', '2', '3', '4'], 'bad'] });
    assert.deepEqual(t.rows, [['1', '', ''], ['1', '2', '3']]);
    assert.equal(ask.cleanTable({ columns: [], rows: [[]] }), null);
  });
});

// ---------------------------------------------------------------- stand-ins for Claude and Gmail
class FakeClaude {
  constructor() {
    this.calls = [];
    this.messages = { create: async (kw) => this.create(kw) };
  }

  create(kw) {
    this.calls.push(kw);
    return {
      content: [{
        type: 'tool_use', name: 'answer',
        input: {
          hero: '₹3.8 Cr', body: 'Sunrise is <strong>late</strong><script>bad()</script>', list: ['PR01 ₹1.8 Cr'], followups: ['Why?'],
          sources: [{ id: 'CALC:penalty:P1', used_for: 'exposure' }, { id: 'DOC:E360-CA-P01:9.1', used_for: 'rule' }, { id: 'made-up', used_for: 'x' }],
        },
      }],
      usage: { input_tokens: 1, output_tokens: 1 },
    };
  }
}

/** Stands in for Claude when it writes the brief or the advice on a flag. */
class Writer extends FakeClaude {
  create(kw) {
    this.calls.push(kw);
    const { name } = kw.tools[0];
    const input = name === 'brief'
      ? {
          headline: 'Deccan is at risk.', summary: 'Three departments are at risk.', links: '',
          items: [{ flag_id: 'customers-account-deccan-data-centres', title: 'Deccan', why: 'w', suggestion: 's' }, { flag_id: 'made-up-flag', title: 'x', why: 'w', suggestion: 's' }],
          sources: [{ id: 'CALC:customers:summary', used_for: 'x' }],
        }
      : {
          explanation: 'e', suggestions: ['a', 'b', 'c'], email_subject: 'S', email_body: 'Hi\n\nBody', call_agenda: 'ag',
          sources: [{ id: 'XLS:finance:Receivables:4', used_for: 'invoice' }],
        };
    return { stop_reason: 'tool_use', content: [{ type: 'tool_use', name, input }], usage: { input_tokens: 1, output_tokens: 1 } };
  }
}

/** A Claude that always answers with this tool input. */
const answering = (input, stop_reason = 'tool_use') => ({ messages: { create: async () => ({ stop_reason, content: [{ type: 'tool_use', name: 'answer', input }], usage: { input_tokens: 1, output_tokens: 1 } }) } });

/** Stands in for Gmail: collects what would be sent, and serves replies from a list. */
class Outbox {
  constructor() {
    this.sent = [];
    this.inbox = [];
  }

  async send(msg) {
    this.sent.push(msg);
  }

  async fetch() {
    return this.inbox;
  }
}

const rawOf = (msg) => new Promise((resolve, reject) => new MailComposer(msg).compile().build((e, b) => (e ? reject(e) : resolve(b))));

// ---------------------------------------------------------------- API
describe('HTTP API', () => {
  let server;
  let base;
  let fake;

  const get = (p, opts) => fetch(base + p, opts);
  const post = (p, body) => fetch(base + p, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const json = async (r) => r.json();
  const withClient = async (client, fn) => {
    ask.setClient(client);
    try {
      return await fn();
    } finally {
      ask.setClient(fake);
    }
  };

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
    const j = await json(await get('/api/health'));
    assert.equal(j.ok, true);
    assert.equal(j.as_of, '2026-11-14');
  });

  test('dashboard', async () => {
    const r = await get('/api/dashboard');
    assert.equal(r.status, 200);
    const j = await r.json();
    assert.equal(j.projects.length, 12);
    assert.equal(j.sources.agreements.length, 12);
    assert.equal(j.sources.departments.length, 5);
    assert.equal(j.sources.workbook.name, 'Executive_360_Project_Data_clean.xlsx');
    assert.deepEqual(j.flag_states, {});
    assert.deepEqual(j.departments.map((d) => d.id), ['finance', 'sales', 'operations', 'customers', 'people', 'projects']);
    assert.deepEqual(j.departments.at(-1).flags, []); // project flags are in dash.flags
    assert.ok(j.departments.every((d) => !Object.keys(d).some((k) => k.startsWith('_'))));
    assert.ok(j.ladder && j.mail && j.clock && j.call_slot && Array.isArray(j.cases));
  });

  test('projects, one project (any case) and 404', async () => {
    assert.equal((await json(await get('/api/projects'))).length, 12);
    assert.equal((await json(await get('/api/projects/p8'))).id, 'P8');
    assert.equal((await get('/api/projects/P99')).status, 404);
  });

  test('departments, one department and a filtered flag list', async () => {
    assert.equal((await json(await get('/api/departments'))).length, 6);
    assert.equal((await json(await get('/api/departments/finance'))).agent, 'Finance Agent');
    assert.equal((await get('/api/departments/nope')).status, 404);
    const fin = await json(await get('/api/flags?dept=finance'));
    assert.ok(fin.length && fin.every((f) => f.dept === 'finance'));
  });

  test('penalties', async () => {
    const j = await json(await get('/api/penalties'));
    assert.ok(near(j.total_cr, 11.2));
    assert.equal(j.projects.length, 12);
  });

  test('downloads: workbooks and an agreement; unknown names are refused', async () => {
    const w = await get('/files/workbook');
    assert.equal(w.status, 200);
    assert.match(w.headers.get('content-disposition'), /attachment/);
    const src = (await json(await get('/api/dashboard'))).sources;
    assert.equal((await get(`/files/agreements/${encodeURIComponent(src.agreements[0].name)}`)).status, 200);
    assert.equal((await get(`/files/departments/${encodeURIComponent(src.departments[0].name)}`)).status, 200);
    assert.equal((await get('/files/agreements/..%2Frules.json')).status, 404);
    assert.equal((await get('/files/agreements/nope.docx')).status, 404);
    assert.equal((await get('/files/departments/nope.xlsx')).status, 404);
  });

  // ------------------------------------------------------------ ask
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

  test('ask: a department agent gets only its own data', async () => {
    const r = await post('/api/ask', { question: 'Who owes us money?', dept: 'finance' });
    assert.equal(r.status, 200);
    assert.deepEqual((await r.json()).agent, { id: 'finance', name: 'Finance Agent', routed: false });
    const sent = fake.calls.at(-1).system;
    assert.ok(sent[0].text.includes('Finance Agent'));
    assert.ok(sent[1].text.includes('INV-2611'));
    assert.ok(!sent[1].text.includes('Sunrise Solar Park'));
  });

  test('ask: a question without a department is routed', async () => {
    const j = await json(await post('/api/ask', { question: 'Which customers are at risk?' }));
    assert.equal(j.agent.id, 'customers');
    assert.equal(j.agent.routed, true);
  });

  test('ask: the overview agent is given the connected issues', async () => {
    await post('/api/ask', { question: 'What needs my attention today?' });
    assert.ok(fake.calls.at(-1).system[1].text.includes('CALC:link:site:hosur'));
  });

  test('ask: a plain-text reply still shows the data it was based on', async () => {
    const plain = { messages: { create: async () => ({ content: [{ type: 'text', text: 'Sunrise is late.' }], usage: {} }) } };
    const j = await withClient(plain, async () => json(await post('/api/ask', { question: 'What is the penalty on Sunrise Solar Park?' })));
    assert.ok(j.sources.length > 0 && j.sources.every((s) => s.kind === 'calc'));
    assert.equal(j.body, 'Sunrise is late.');
  });

  test('ask: the model can add a chart and a table, both cleaned', async () => {
    const claude = answering({
      body: 'Internal targets are two weeks before each revised target.', hero: '', sources: [], followups: [],
      chart: { title: 'Overdue', unit: '₹ Cr', rows: [{ label: 'A', value: 3 }, { label: 'B', value: 'bad' }], compare_label: 'plan' },
      table: { columns: ['Project', 'Phase', 'Internal target'], rows: [['Sunrise Solar Park', 'Phase 1', '20 Nov 2026'], ['Short row']] },
    });
    const j = await withClient(claude, async () => json(await post('/api/ask', { question: 'Internal target timelines', dept: 'projects' })));
    assert.deepEqual(j.chart.rows, [{ label: 'A', value: 3 }]);
    assert.deepEqual(j.table.rows[1], ['Short row', '', '']);
  });

  test('ask: the reply budget is 2500 tokens', async () => {
    await post('/api/ask', { question: 'Which projects are late?' });
    assert.equal(fake.calls.at(-1).max_tokens, 2500);
    assert.equal(config.CLAUDE_MAX_TOKENS, 2500);
  });

  test('ask: an answer that was cut off gives a clear message', async () => {
    const r = await withClient(answering({ hero: '12 of 12' }, 'max_tokens'), () => post('/api/ask', { question: 'Internal target timelines to reach each milestone', dept: 'projects' }));
    assert.equal(r.status, 503);
    assert.match((await r.json()).error, /too long/);
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

  // ------------------------------------------------------------ flag actions
  test('flag action, state and undo', async () => {
    const flags = await json(await get('/api/flags'));
    const fid = flags[0].id;
    assert.equal((await post(`/api/flags/${fid}/action`, { action: 'call' })).status, 200);
    assert.ok(fid in (await json(await get('/api/dashboard'))).flag_states);
    await post(`/api/flags/${fid}/action`, { action: 'undo' });
    assert.ok(!(fid in (await json(await get('/api/dashboard'))).flag_states));
  });

  test('flag action: send uses an edited subject; bad action and missing flag are refused', async () => {
    const r = await json(await post('/api/flags/stale-P8/action', { action: 'send', subject: 'Please update today' }));
    assert.match(r.state.done, /Email “Please update today” to /);
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

  test('department flags: automatic is allowed for a plant, refused for a key customer', async () => {
    assert.equal((await post('/api/flags/operations-plant-hosur-assembly/action', { action: 'auto' })).status, 200);
    assert.equal((await post('/api/flags/customers-account-deccan-data-centres/action', { action: 'auto' })).status, 400);
    await post('/api/flags/operations-plant-hosur-assembly/action', { action: 'undo' });
  });

  test('unknown API route is a JSON 404', async () => {
    const r = await get('/api/nothing');
    assert.equal(r.status, 404);
    assert.equal((await r.json()).error, 'Not found');
  });

  // ------------------------------------------------------------ AI brief and advice
  test('brief: written once, only real flags, then served from the saved copy', async () => {
    const w = new Writer();
    const j = await withClient(w, async () => {
      const first = await json(await get('/api/brief?refresh=1'));
      await get('/api/brief');
      return first;
    });
    assert.equal(j.brief.ai, true);
    assert.deepEqual(j.brief.items.map((i) => i.flag_id), ['customers-account-deccan-data-centres']); // the made-up flag is dropped
    assert.equal(w.calls.length, 1); // the second time comes from the saved copy
  });

  test('brief: imperfect flag ids and a missing headline are repaired', async () => {
    class Sloppy extends Writer {
      create(kw) {
        this.calls.push(kw);
        const input = {
          summary: 's', sources: [],
          items: JSON.stringify([
            { flag_id: 'CALC:flag:customers-account-deccan-data-centers', title: 'Deccan', why: 'w', suggestion: 's' }, // US spelling
            { flag_id: 'Hosur', title: 'Hosur Assembly is running at 71% against a target of 85%', why: 'w', suggestion: 's' },
          ]),
        };
        return { stop_reason: 'tool_use', content: [{ type: 'tool_use', name: 'brief', input }], usage: {} };
      }
    }
    const w = new Sloppy();
    const b = (await withClient(w, async () => json(await get('/api/brief?refresh=1')))).brief;
    assert.equal(b.ai, true);
    assert.equal(b.headline, 'Deccan');
    assert.deepEqual(b.items.map((i) => i.flag_id), ['customers-account-deccan-data-centres', 'operations-plant-hosur-assembly']);
    assert.ok(w.calls.at(-1).tools[0].input_schema.properties.items.items.properties.flag_id.enum.includes('sla-P8'));
  });

  test('flag advice uses only that department', async () => {
    const w = new Writer();
    const j = await withClient(w, async () => json(await get('/api/flags/finance-overdue-inv-2640/advice?refresh=1')));
    assert.equal(j.agent, 'Finance Agent');
    assert.equal(j.suggestions.length, 3);
    assert.equal(j.email.subject, 'S');
    assert.equal(j.sources[0].locator, 'Receivables · row 4');
    const facts = w.calls.at(-1).system[1].text;
    assert.ok(facts.includes('INV-2640') && !facts.includes('Hosur Assembly'));
  });

  test('project flag advice gets only that project and its agreement', async () => {
    const w = new Writer();
    const r = await withClient(w, () => get('/api/flags/sla-P1/advice?refresh=1'));
    assert.equal(r.status, 200);
    const sys = w.calls.at(-1).system;
    assert.ok(sys[1].text.includes('Sunrise Solar Park') && !sys[1].text.includes('Highway Bypass'));
    assert.ok(sys[2].text.startsWith('AGREEMENT CLAUSES'));
  });

  // ------------------------------------------------------------ email, cases and the follow-up ladder
  describe('email and follow-up', () => {
    let box;
    const saved = {};
    const mailOn = (mode = 'test') => {
      box = new Outbox();
      mailer.setTransport(box);
      Object.assign(saved, { m: config.MAIL_MODE, a: config.GMAIL_ADDRESS, p: config.GMAIL_APP_PASSWORD });
      Object.assign(config, { MAIL_MODE: mode, GMAIL_ADDRESS: 'ceo@gmail.com', GMAIL_APP_PASSWORD: 'x' });
      cases.setOffset(0);
    };
    const mailOff = () => {
      Object.assign(config, { MAIL_MODE: saved.m, GMAIL_ADDRESS: saved.a, GMAIL_APP_PASSWORD: saved.p });
      cases.setOffset(0);
    };
    const act = (id, action, extra = {}) => post(`/api/flags/${id}/action`, { action, ...extra });
    const run = async (days) => json(await post('/api/followups/run', { advance_days: days }));

    test('email off: the action is only recorded', async () => {
      const j = await json(await act('sales-stalled-d-316', 'send'));
      assert.match(j.state.done, /recorded only/);
      await act('sales-stalled-d-316', 'undo');
    });

    test('test mode: goes to your own inbox, with a calendar invite', async () => {
      mailOn();
      try {
        await act('customers-renewal-hosur-auto-components', 'call');
        const msg = box.sent.at(-1);
        assert.ok(msg.to.includes('ceo@gmail.com') && msg.subject.includes('[E360-'));
        assert.ok(msg.text.includes('TEST MODE') && msg.text.includes('imran.qureshi@asterion.example'));
        assert.equal(msg.icalEvent.method, 'REQUEST');
        assert.match(msg.icalEvent.content, /METHOD:REQUEST/);
        await act('customers-renewal-hosur-auto-components', 'undo');
      } finally {
        mailOff();
      }
    });

    test('live mode refuses sample addresses', async () => {
      mailOn('live');
      try {
        const res = await mailer.send('Karthik Raman', 'karthik.raman@asterion.example', 's', 'b', 1);
        assert.equal(res.sent, false);
        assert.match(res.note, /sample address/);
        assert.equal(box.sent.length, 0);
      } finally {
        mailOff();
      }
    });

    test('the ladder reminds, escalates, then returns to the CEO', async () => {
      mailOn();
      try {
        const flag = 'operations-delivery-north-delhi-hub';
        await act(flag, 'auto'); // automatic follow-up on
        const mine = (j) => j.cases.find((c) => c.flag_id === flag && c.status !== 'withdrawn');
        assert.equal(mine(await run(1)).contacts, 1); // day 1: too early
        let j = await run(1); // day 2: reminder
        assert.equal(mine(j).events.at(-1).kind, 'reminder');
        assert.match(box.sent.at(-1).subject, /Reminder:/);
        j = await run(2); // day 4: escalated to the manager
        assert.equal(mine(j).events.at(-1).kind, 'escalated');
        assert.match(box.sent.at(-1).to, /Suresh Pillai/);
        j = await run(3); // day 7: back to the CEO
        assert.ok(mine(j).needs_ceo);
        assert.equal(mine(j).contacts, 3);
        await post(`/api/cases/${mine(j).id}/action`, { action: 'close' });
      } finally {
        mailOff();
      }
    });

    test('without automatic follow-up the steps are only suggested', async () => {
      mailOn();
      try {
        await act('finance-overdue-inv-2611', 'send'); // money: automatic is not allowed
        const n = box.sent.length;
        const j = await run(2);
        const c = j.cases.find((x) => x.flag_id === 'finance-overdue-inv-2611' && x.open);
        assert.ok(c.needs_ceo);
        assert.equal(c.events.at(-1).kind, 'suggest');
        assert.equal(box.sent.length, n); // nothing was sent
        assert.equal((await post(`/api/cases/${c.id}/action`, { action: 'auto_on' })).status, 400);
        await post(`/api/cases/${c.id}/action`, { action: 'close' });
      } finally {
        mailOff();
      }
    });

    test('a reply by email is matched to its case, and read only once', async () => {
      mailOn();
      try {
        const flag = 'people-role-senior-planning-engineer';
        await act(flag, 'send');
        const cid = cases.openForFlag(flag).id;
        box.inbox.push(Buffer.from(
          `From: Tanya George <t@x.com>\nSubject: Re: role [E360-${cid}]\nMessage-ID: <abc@x>\nDate: Sun, 15 Nov 2026 10:00:00 +0530\nContent-Type: text/plain; charset=utf-8\n\n` +
          'Offer goes out Monday; joining date 1 Dec.\n\nOn Sat, Anita wrote:\n> please update\n'));
        box.inbox.push(await rawOf(box.sent.at(-1))); // our own outgoing copy must be ignored
        ask.setClient(null);
        const find = (j) => j.cases.find((x) => x.id === cid);
        const c = find(await json(await post('/api/followups/run', {})));
        assert.equal(c.status, 'replied');
        assert.ok(c.reply.summary.startsWith('Offer goes out Monday'));
        assert.ok(!c.reply.summary.includes('please update'));
        assert.equal(find(await json(await post('/api/followups/run', {}))).events.length, c.events.length); // not read twice
        await post(`/api/cases/${cid}/action`, { action: 'close' });
      } finally {
        ask.setClient(fake);
        mailOff();
      }
    });

    test('a reply recorded by hand is summarised', async () => {
      await act('finance-overdue-inv-2640', 'send');
      const cid = cases.openForFlag('finance-overdue-inv-2640').id;
      const r = await post(`/api/cases/${cid}/reply`, { text: 'Payment will be released on Friday.', from: 'Meera Krishnan' });
      assert.equal(r.status, 200);
      const c = (await r.json()).cases.find((x) => x.id === cid);
      assert.equal(c.status, 'replied');
      assert.equal((await post(`/api/cases/${cid}/reply`, { text: '  ' })).status, 400);
      await post(`/api/cases/${cid}/action`, { action: 'close' });
    });

    test('the ladder days are saved and kept in order', async () => {
      const lad = await json(await post('/api/settings/ladder', { remind_days: 3, escalate_days: 2, ceo_days: 2 }));
      assert.deepEqual(lad, { remind_days: 3, escalate_days: 4, ceo_days: 5 });
      assert.equal((await post('/api/settings/ladder', { remind_days: 'x' })).status, 400);
      assert.deepEqual(await json(await post('/api/settings/ladder', { remind_days: 2, escalate_days: 4, ceo_days: 7 })), { remind_days: 2, escalate_days: 4, ceo_days: 7 });
    });

    test('a case resolves when its flag disappears', async () => {
      const flag = { id: 'temp-flag', dept: 'finance', proj: null, title: 'Temp', auto: { allowed: true }, email: { to: 'Meera Krishnan', subject: 's' }, call: { who: 'Meera Krishnan · CFO' } };
      const c = await cases.openCase(flag);
      cases.contact(c, 'email', 'CEO', 'sent');
      const done = await cases.run({}, async () => ({ note: '' }), async () => [], async (t) => t);
      assert.ok(done.some((d) => d.includes('resolved')));
      assert.equal(cases.row(c.id).status, 'resolved');
    });

    test('what changed is calculated by code', () => {
      const old = {
        taken_at: '2026-11-13T09:00:00',
        data: { depts: { finance: { name: 'Finance', status: 'On track', kpis: { Cash: '₹222 Cr' } } }, flags: { gone: { title: 'Old flag', sev: 'watch', dept: 'finance' } } },
      };
      const now = { depts: { finance: { name: 'Finance', status: 'Watch', kpis: { Cash: '₹205 Cr' } } }, flags: { fresh: { title: 'New one', sev: 'risk', dept: 'finance' } } };
      assert.deepEqual(advisor.changesSince(old, now).items.map((c) => c.text),
        ['Finance moved from On track to Watch', 'Finance: cash changed from ₹222 Cr to ₹205 Cr', 'New flag: New one', 'Cleared: Old flag']);
    });
  });
});

describe('assistant switched off', () => {
  const start = async () => {
    const server = createApp().listen(0);
    await new Promise((r) => server.once('listening', r));
    return [server, `http://127.0.0.1:${server.address().port}`];
  };

  test('without a key the answer is a clear 503', async () => {
    ask.setClient(null);
    config.ANTHROPIC_API_KEY = '';
    const [server, base] = await start();
    try {
      const r = await fetch(`${base}/api/ask`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ question: 'Which projects are late?' }) });
      assert.equal(r.status, 503);
      assert.match((await r.json()).error, /ANTHROPIC_API_KEY/);
    } finally {
      server.close();
      closeDb();
    }
  });

  test('a failing Claude call becomes a 503 with the reason', async () => {
    ask.setClient({ messages: { create: async () => { throw Object.assign(new Error('401 bad key'), { error: { error: { message: 'invalid x-api-key' } } }); } } });
    const [server, base] = await start();
    try {
      const r = await fetch(`${base}/api/ask`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ question: 'Which projects are late?' }) });
      assert.equal(r.status, 503);
      assert.match((await r.json()).error, /could not be reached: invalid x-api-key/);
    } finally {
      ask.setClient(null);
      server.close();
      closeDb();
    }
  });

  test('the brief falls back to code when the AI is off', async () => {
    ask.setClient(null);
    config.ANTHROPIC_API_KEY = '';
    const [server, base] = await start();
    try {
      const j = await (await fetch(`${base}/api/brief?refresh=1`)).json();
      assert.equal(j.brief.ai, false);
      assert.equal(j.brief.items.length, 3);
      assert.ok(j.note);
    } finally {
      server.close();
      closeDb();
    }
  });

  test('connected issues fall back to code when the AI is off', async () => {
    ask.setClient(null);
    config.ANTHROPIC_API_KEY = '';
    const [server, base] = await start();
    try {
      const j = await (await fetch(`${base}/api/links?refresh=1`)).json();
      assert.ok(j.links.length && j.links.every((l) => l.ai === false && l.owner));
    } finally {
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
