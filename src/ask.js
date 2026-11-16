// The AI agents. There is one agent per department (Finance Agent, Sales Agent, Operations Agent, Customers Agent,
// People Agent, Projects Agent) and one for the whole company (Executive 360°).
//
// How a question is answered:
//   1. Pick the agent. On a department page the page says which one. From the home screen or the Ask page, route()
//      picks the department by the words in the question.
//   2. Build that agent's FACTS in code: the department's calculated figures, its flags, and the rows of its workbook.
//      Every fact has a source ID such as  XLS:finance:Receivables:2.
//      The Projects Agent also gets the AGREEMENT CLAUSES of any project named in the question.
//   3. Claude replies through the "answer" tool: headline, paragraph, optional bullets, optional chart, the source IDs
//      it used, and follow-up questions.
//   4. Source IDs are turned back into the citation chips the dashboard shows.
//
// Claude explains; code calculates. Agents are told to use only the numbers in their facts.
import config from './config.js';
import { allClauses } from './agreements.js';
import { BY_ID, OVERVIEW, PROJECTS } from './depts/index.js';
import { isoDay } from './dates.js';
import { findLinks } from './links.js';

const SYSTEM = `You are the {agent} in Executive 360°, the CEO dashboard of the company. You work for {ceo}, the CEO. Today is {today}.
You cover {scope}.

Answer ONLY from the FACTS{clauses_word} provided below. They come from the company's own files. If the answer is not in them, say so plainly and suggest who could know.
{handoff}
Rules:
- Write for a busy CEO: plain English, short sentences, no jargon. Lead with the answer.
- Use only numbers that appear in the facts. Figures under "summary" and in flags were calculated by the system; prefer them to working things out yourself. You may add up or compare a few numbers from the rows when needed.
- Dates: write them like 4 Dec 2026. Money: ₹ crore written as ₹3.8 Cr.
- Charts: the dashboard draws a bar chart when you fill the "chart" field. Add one whenever the user asks for a chart, graph or visual, or when comparing a number across 3 or more items. Use only numbers from the facts. Never say you cannot draw charts.
- Tables: when the answer is a list of more than 8 items, or needs several columns (for example dates for every milestone), put it in the "table" field instead of "list". Keep cells short. If the full answer would need more than 25 rows, show the most important rows and say how to narrow the question (for example, name one project).
- Always write "body" first: one to four sentences that answer the question, even when a table or chart follows.
- "hero" is a short figure or verdict about the business (e.g. '₹11.2 Cr', '4 of 12', '81% of target'), never a remark about yourself. Leave it empty if there is no single key figure.
- Cite every fact you use by its source ID in the sources list. Do not put source IDs in the text.
- Bold at most two key phrases with <strong>…</strong>. No other HTML or markdown.
- Always reply by calling the answer tool, exactly once, and write nothing outside it.{extra}`;

const PROJECT_RULES = `
- Each milestone has four dates: contract date (original), revised target (the date now committed, which penalties are counted from), internal target (set earlier than the revised target to leave a buffer) and forecast (when the team now expects to finish). Buffer left = days from the forecast to the revised target; negative means late.
- Each milestone (deliverable) has two progress figures: "progress_pct" reported by the project team, and "progress_confirmed_pct" formally confirmed by the responsible department ("confirmed_by", "confirmed_on"). When asked about confirmed or signed-off status, answer from the confirmed figures and say who confirmed and when.
- Penalties are already calculated by the system; never do penalty arithmetic yourself. Always call them "estimated penalty exposure" because they are based on forecast dates.
- For "what if" questions about further delay, use the system's figures in "if_all_forecasts_slip_further" (2, 4 or 8 more weeks; a month is 4 weeks). For other periods, give the nearest figures and explain the rule (rate per week, grace period, cap) in words.`;

export const CHART_UNITS = ['₹ Cr', '%', 'weeks', 'days', 'count'];

export const ANSWER_TOOL = {
  name: 'answer',
  description: 'Give the answer to show on the dashboard. Always use this tool to reply.',
  input_schema: {
    type: 'object',
    properties: {
      body: { type: 'string', description: 'The answer in 1-4 sentences. Always fill this in, and write it first.' },
      hero: { type: 'string', description: "The key figure or verdict in 1-4 words, e.g. '₹3.8 Cr', '4 of 12', '+12 weeks'. Empty if none." },
      list: { type: 'array', items: { type: 'string' }, description: 'Optional bullet points, one per item. At most 8.' },
      sources: {
        type: 'array', description: 'Every source ID used.',
        items: {
          type: 'object',
          properties: { id: { type: 'string' }, used_for: { type: 'string', description: 'What this source supplied, in a few words.' } },
          required: ['id', 'used_for'],
        },
      },
      followups: { type: 'array', items: { type: 'string' }, description: '2 or 3 short follow-up questions the CEO might ask next.' },
      table: {
        type: 'object', description: 'Optional table, for more than 8 items or several columns. At most 8 columns and 25 rows.',
        properties: {
          title: { type: 'string' },
          columns: { type: 'array', items: { type: 'string' } },
          rows: { type: 'array', items: { type: 'array', items: { type: 'string' } } },
        },
        required: ['columns', 'rows'],
      },
      chart: {
        type: 'object', description: 'Optional horizontal bar chart drawn under the answer.',
        properties: {
          title: { type: 'string', description: "Short title, e.g. 'Overdue receivables by customer'." },
          unit: { type: 'string', enum: CHART_UNITS },
          rows: {
            type: 'array', description: 'One bar per item, at most 12, largest first unless order matters.',
            items: {
              type: 'object',
              properties: {
                label: { type: 'string' }, value: { type: 'number' },
                compare: { type: 'number', description: 'Optional second value shown as a dashed marker, e.g. plan or target.' },
              },
              required: ['label', 'value'],
            },
          },
          compare_label: { type: 'string', description: "What the dashed marker means, e.g. 'target'." },
        },
        required: ['title', 'unit', 'rows'],
      },
    },
    required: ['hero', 'body', 'sources', 'followups'],
  },
};

/** Raised when Claude cannot be called (no key, network error, etc.). */
export class AskUnavailable extends Error {
  constructor(message) {
    super(message);
    this.name = 'AskUnavailable';
  }
}

// ------------------------------------------------------------------ Claude client (replaceable in tests)
let client = null;

export function setClient(c) {
  client = c;
}

export async function getClient() {
  if (!client) {
    if (!config.ANTHROPIC_API_KEY) {
      throw new AskUnavailable('The assistant is not switched on yet: add ANTHROPIC_API_KEY to backend/.env and restart.');
    }
    const { default: Anthropic } = await import('@anthropic-ai/sdk');
    client = new Anthropic({ apiKey: config.ANTHROPIC_API_KEY, maxRetries: 2, timeout: 60_000 });
  }
  return client;
}

/** The message to show when a Claude call fails. */
export const failureDetail = (e) => e?.error?.error?.message || e?.message || String(e);

// ------------------------------------------------------------------ choosing the agent
const SKIP_WORDS = new Set(['phase', 'package', 'project', 'upgrade']);

export function mentionedProjects(question, projects) {
  const q = question.toLowerCase();
  const found = [];
  for (const p of projects) {
    const name = p.name.toLowerCase();
    const words = name.split(/[^a-z0-9]+/).filter((w) => w.length > 3 && !SKIP_WORDS.has(w));
    if (q.includes(name) || new RegExp(`\\b${p.id.toLowerCase()}\\b`).test(q) || (words.length && q.includes(words[0]))) found.push(p.id);
  }
  return found;
}

/** Pick the department whose words appear most in the question; 'overview' if none stands out. */
export function route(question, projects) {
  const q = question.toLowerCase();
  if (['connected', 'across departments', 'linked', 'related issues'].some((k) => q.includes(k))) return 'overview'; // a question about links between departments
  const count = (words) => words.filter((k) => q.includes(k)).length;
  const scores = {};
  for (const m of Object.values(BY_ID)) scores[m.ID] = count(m.KEYWORDS) + count(m.STRONG);
  const named = projects.filter((p) => q.includes(p.name.toLowerCase()) || new RegExp(`\\b${p.id.toLowerCase()}\\b`).test(q));
  scores.projects = count(PROJECTS.keywords) + count(PROJECTS.strong) + 3 * named.length;
  let best = null;
  for (const [k, v] of Object.entries(scores)) if (best === null || v > scores[best]) best = k;
  const top = scores[best];
  if (top === 0 || Object.values(scores).filter((v) => v === top).length > 1) return 'overview';
  return best;
}

// ------------------------------------------------------------------ facts: Projects
const phaseFact = (ph) => ({
  phase: ph.name, scope: ph.scope, contract_date: ph.contract, revised_target: ph.revised, internal_target: ph.internal, forecast: ph.forecast,
  buffer_days_left_before_revised_target: ph.buffer_days_left, progress_confirmed_pct: ph.confirmed.pct, confirmed_by: ph.confirmed.by,
  confirmed_on: ph.confirmed.on, confirmation_status: ph.confirmed.word, progress_pct: ph.ac, status: ph.status,
});

/** Returns { facts, index }. index maps every source ID to what is needed to build its citation chip. */
export function projectFacts(dash) {
  const facts = [];
  const index = {};
  const wb = { kind: 'excel', ref: 'workbook', name: dash.source };
  const s = dash.summary;
  facts.push({ source: 'CALC:projects:summary', portfolio_summary: s });
  index['CALC:projects:summary'] = {
    kind: 'calc', locator: 'Projects summary',
    record: [['Projects', s.projects], ['At risk', s.at_risk], ['Estimated penalty exposure', `₹${s.penalty_total_cr} Cr`]],
  };

  for (const p of dash.projects) {
    const pid = p.id;
    facts.push({
      source: `XLS:Projects:${pid}`, project: pid, name: p.name, sector: p.type, location_scale: p.where, client: p.client, lead: p.pm, health: p.health,
      current_stage: p.stage, progress_pct: p.ac, planned_pct_by_today: p.pl, next_milestone: p.next,
    });
    index[`XLS:Projects:${pid}`] = { ...wb, locator: `Projects · ${pid}`, record: [['Project', p.name], ['Health', p.health], ['Progress', `${p.ac}%`], ['Plan', `${p.pl}%`]] };

    facts.push({
      source: `XLS:Updates:${pid}`, project: pid, schedule_last_updated: p.updated.when, updated_by: p.updated.by, days_since_update: p.updated.days,
      budget_cr: p.budget.cr, budget_used_pct: p.budget.used,
    });
    index[`XLS:Updates:${pid}`] = { ...wb, locator: `Project Updates · ${pid}`, record: [['Last updated', p.updated.when], ['By', p.updated.by], ['Budget used', `${p.budget.used}%`]] };

    for (const ph of p.phases) {
      const sid = `XLS:Milestones:${pid}|${ph.name}`;
      facts.push({ source: sid, project: pid, ...phaseFact(ph) });
      index[sid] = {
        ...wb, locator: `Milestones · ${pid} · ${ph.name}`,
        record: [
          ['Phase', ph.name], ['Internal target', ph.internal], ['Revised target', ph.revised], ['Forecast', ph.forecast], ['Progress', `${ph.ac}%`],
          ['Confirmed', ph.confirmed.pct !== null && ph.confirmed.pct !== undefined ? `${ph.confirmed.pct}%` : 'Not confirmed'], ['Confirmed by', ph.confirmed.by || '-'],
        ],
      };
    }

    const stages = Object.entries(p.stage_progress);
    if (stages.length) {
      facts.push({ source: `XLS:Stages:${pid}`, project: pid, stages_done_vs_plan_pct: Object.fromEntries(stages.map(([k, v]) => [k, { done: v[0], plan: v[1] }])) });
      index[`XLS:Stages:${pid}`] = { ...wb, locator: `Stages · ${pid}`, record: stages.map(([k, v]) => [k, `${v[0]}% (plan ${v[1]}%)`]) };
    }
    if (p.reasons.length) {
      facts.push({ source: `XLS:Reasons:${pid}`, project: pid, delay_reasons: p.reasons });
      index[`XLS:Reasons:${pid}`] = { ...wb, locator: `Delay Reasons · ${pid}`, record: p.reasons.map((r) => ['Reason', r]) };
    }

    const pen = p.penalty;
    facts.push({
      source: `CALC:penalty:${pid}`, project: pid, agreement: pen.agreement, estimated_penalty_exposure_cr: pen.exposure_cr, overall_cap_cr: pen.aggregate_cap_cr ?? null,
      if_all_forecasts_slip_further: pen.if_all_forecasts_slip_further ?? null, rules_charging: pen.charging, rules_one_week_from_charging: pen.near,
    });
    index[`CALC:penalty:${pid}`] = {
      kind: 'calc', locator: `Penalty calculation · ${pid}`,
      record: [['Agreement', pen.agreement], ['Estimated exposure', `₹${pen.exposure_cr} Cr`], ...pen.charging.map((r) => [r.id, `${r.applies_to}: ${r.weeks_late} wks late, ₹${r.amount_cr} Cr`])],
    };
  }
  flagFacts(dash.flags, facts, index);
  return { facts, index };
}

const KEY_SECTIONS = ['Key facts', 'Programme', 'Delay', 'Liquidated', 'Extension', 'Schedule', 'Milestone', 'Time'];

/** Agreement clauses for the named projects (all clauses for up to 2 projects, key sections for more). */
export async function clauseContext(projectIds) {
  const every = await allClauses();
  const picked = [];
  const index = {};
  const full = projectIds.length <= 2;
  for (const pid of projectIds) {
    for (const c of every[pid] ?? []) {
      const keep = full || KEY_SECTIONS.some((k) => c.section.startsWith(k)) || ['6.', '8.', '9.'].some((k) => (c.clause || '').startsWith(k));
      if (!keep) continue;
      const sid = `DOC:${c.id}`;
      picked.push({ source: sid, section: c.section, clause: c.clause, text: c.text });
      index[sid] = {
        kind: 'word', ref: c.agreement, name: c.file,
        locator: c.clause && /^\d/.test(c.clause) ? `Clause ${c.clause}` : c.clause ? `Recital ${c.clause}` : c.section,
        excerpt: c.text,
      };
    }
  }
  return { picked, index };
}

// ------------------------------------------------------------------ facts: the other departments
const plain = (v) => {
  if (v instanceof Date) return v.getUTCHours() === 0 && v.getUTCMinutes() === 0 ? isoDay(v) : v.toISOString().slice(0, 16);
  return v;
};

export function flagFacts(flags, facts, index) {
  for (const f of flags) {
    const sid = `CALC:flag:${f.id}`;
    facts.push({ source: sid, flag: f.label ?? f.type, severity: f.sev, about: f.where ?? '', title: f.title, detail: f.body, suggested_actions: f.suggest });
    index[sid] = { kind: 'calc', locator: `Flag · ${f.title}`, record: [['Detail', f.body]] };
  }
}

function summaryFact(dept, facts, index, withCalc = true) {
  const sid = `CALC:${dept.id}:summary`;
  const fact = {
    source: sid, department: dept.name, status: dept.status_word, headline: dept.headline,
    kpis: dept.kpis.map((k) => ({ name: k.label, value: k.value, detail: k.foot })),
  };
  if (withCalc) fact.summary = dept.calc;
  facts.push(fact);
  index[sid] = { kind: 'calc', locator: `${dept.name} summary`, record: dept.kpis.map((k) => [k.label, k.value]) };
}

/** Facts for a workbook-based department: calculated summary, flags and every row of its workbook. */
export function departmentFacts(dept) {
  const facts = [];
  const index = {};
  summaryFact(dept, facts, index);
  flagFacts(dept.flags, facts, index);
  for (const [tab, rows] of Object.entries(dept._tabs)) {
    for (const r of rows) {
      const clean = Object.fromEntries(Object.entries(r).filter(([k, v]) => !k.startsWith('_') && v !== null && v !== undefined && v !== '').map(([k, v]) => [k, plain(v)]));
      const sid = `XLS:${dept.id}:${tab}:${r._row}`;
      facts.push({ source: sid, tab, ...clean });
      index[sid] = {
        kind: 'excel', ref: dept.source.ref, name: dept.source.name, locator: `${tab} · row ${r._row}`,
        record: Object.entries(clean).slice(0, 7).map(([k, v]) => [k, String(v)]),
      };
    }
  }
  return { facts, index };
}

/** A short summary of every department, for questions about the whole company. */
export function overviewFacts(depts) {
  const facts = [];
  const index = {};
  for (const d of depts) {
    summaryFact(d, facts, index, false);
    flagFacts(d.flags.filter((f) => f.sev === 'risk').slice(0, 6), facts, index);
  }
  return { facts, index };
}

/** The connected issues as facts (used by the overview agent). */
function linkFacts(depts, facts, index) {
  const allFlags = Object.fromEntries(depts.flatMap((d) => d.flags).map((f) => [f.id, f]));
  for (const g of findLinks(depts)) {
    const sid = `CALC:link:${g.key}`;
    facts.push({
      source: sid, connected_issue: `${g.kind_word}: ${g.entity}`, departments: g.dept_names,
      flags: g.flag_ids.map((i) => ({ department: allFlags[i].dept, title: allFlags[i].title, detail: allFlags[i].body, owner: allFlags[i].call.who })),
      other_rows_that_mention_it: g.evidence.map((e) => `${e.dept} · ${e.tab}: ${e.text}`),
    });
    index[sid] = {
      kind: 'calc', locator: `Connected issue · ${g.entity}`,
      record: g.flag_ids.map((i) => [allFlags[i].dept[0].toUpperCase() + allFlags[i].dept.slice(1), allFlags[i].title]),
    };
  }
}

// ------------------------------------------------------------------ answer
const escapeHtml = (s, quote = true) => {
  let t = String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  if (quote) t = t.replace(/"/g, '&quot;').replace(/'/g, '&#x27;');
  return t;
};

/** Escape everything, then allow <strong> back. Keeps the dashboard safe from stray markup. */
export const cleanHtml = (text) => escapeHtml(text, false).replace(/&lt;(\/?)strong&gt;/g, '<$1strong>');

const round2 = (x) => Math.round((x + Number.EPSILON) * 100) / 100;

/** Keep only a well-formed chart with real numbers. */
export function cleanChart(c) {
  if (!c || typeof c !== 'object' || Array.isArray(c) || !Array.isArray(c.rows)) return null;
  const rows = [];
  for (const r of c.rows.slice(0, 12)) {
    try {
      const value = Number(r.value);
      if (r.label === undefined || r.label === null || r.value === null || r.value === undefined || !Number.isFinite(value)) continue;
      const row = { label: String(r.label).slice(0, 60), value: round2(value) };
      if (r.compare !== null && r.compare !== undefined) {
        const cmp = Number(r.compare);
        if (!Number.isFinite(cmp)) continue;
        row.compare = round2(cmp);
      }
      rows.push(row);
    } catch {
      /* skip a malformed row */
    }
  }
  if (!rows.length) return null;
  return { title: String(c.title ?? '').slice(0, 80), unit: CHART_UNITS.includes(c.unit) ? c.unit : 'count', rows, compare_label: String(c.compare_label ?? '').slice(0, 40) };
}

/** Keep only a well-formed table: text cells, at most 8 columns and 60 rows. */
export function cleanTable(t) {
  if (!t || typeof t !== 'object' || !Array.isArray(t.columns) || !Array.isArray(t.rows)) return null;
  const cols = t.columns.slice(0, 8).map((c) => String(c).slice(0, 40));
  const rows = t.rows.slice(0, 60).filter(Array.isArray).map((r) => {
    const cells = r.slice(0, cols.length).map((c) => String(c).slice(0, 120));
    while (cells.length < cols.length) cells.push('');
    return cells;
  });
  return cols.length && rows.length ? { title: String(t.title ?? '').slice(0, 80), columns: cols, rows } : null;
}

export function citation(sid, usedFor, index) {
  const info = index[sid];
  if (!info) return null;
  if (info.kind === 'word') return { kind: 'word', ref: info.ref, name: info.name, locator: info.locator, used_for: usedFor, excerpt: info.excerpt.slice(0, 900) };
  const record = (info.record ?? []).map(([a, b]) => [String(a), String(b)]).slice(0, 8);
  if (info.kind === 'excel') return { kind: 'excel', ref: info.ref, name: info.name, locator: info.locator, used_for: usedFor, record };
  return { kind: 'calc', ref: 'calc', name: 'Executive 360 calculations', locator: info.locator, used_for: usedFor, record };
}

/** Answer a question. deptId is the agent to use; leave it empty to route by the question. */
export async function answer(question, dash, depts, deptId = null, history = []) {
  question = String(question ?? '').trim().slice(0, 1000);
  if (!question) throw new Error('Empty question');
  const c = await getClient();
  const hist = Array.isArray(history) ? history.filter((h) => h && typeof h === 'object') : [];

  const byId = Object.fromEntries(depts.map((d) => [d.id, d]));
  const routed = !(deptId in byId) && deptId !== 'overview';
  const recent = `${question} ${hist.slice(-2).map((h) => h.q ?? '').join(' ')}`;
  if (routed) deptId = route(question, dash.projects);

  let clauses = [];
  let pids = [];
  let info;
  let facts;
  let index;
  if (deptId === 'projects') {
    info = PROJECTS;
    ({ facts, index } = projectFacts(dash));
    pids = mentionedProjects(recent, dash.projects);
    const ctx = await clauseContext(pids);
    clauses = ctx.picked;
    Object.assign(index, ctx.index);
  } else if (deptId in byId) {
    const d = byId[deptId];
    info = { id: d.id, name: d.name, agent: d.agent, scope: d.scope };
    ({ facts, index } = departmentFacts(d));
  } else {
    deptId = 'overview';
    info = OVERVIEW;
    ({ facts, index } = overviewFacts(depts));
    linkFacts(depts, facts, index); // issues that connect across departments
  }

  const others = depts.filter((d) => d.id !== deptId).map((d) => d.agent).join(', ');
  const handoff = deptId === 'overview'
    ? `For detail beyond these summaries, name the department agent that can go deeper (${others}).\n`
    : `If the question is about another department, say so in one sentence and name the agent to ask (${others}).\n`;
  const system = [
    {
      type: 'text',
      text: SYSTEM.replace('{agent}', info.agent).replace('{ceo}', config.CEO_NAME).replace('{today}', dash.as_of).replace('{scope}', info.scope)
        .replace('{clauses_word}', deptId === 'projects' ? ' and AGREEMENT CLAUSES' : '').replace('{handoff}', handoff).replace('{extra}', deptId === 'projects' ? PROJECT_RULES : ''),
    },
    { type: 'text', text: `FACTS (JSON):\n${JSON.stringify(facts)}` },
  ];
  if (clauses.length) system.push({ type: 'text', text: `AGREEMENT CLAUSES (JSON):\n${JSON.stringify(clauses)}` });
  system[system.length - 1].cache_control = { type: 'ephemeral' };

  const messages = [];
  for (const h of hist.slice(-3)) {
    // short memory of the conversation for follow-ups
    if (h.q && h.a) messages.push({ role: 'user', content: String(h.q).slice(0, 500) }, { role: 'assistant', content: String(h.a).slice(0, 800) });
  }
  messages.push({ role: 'user', content: question });

  const t0 = Date.now();
  let resp;
  try {
    resp = await c.messages.create({ model: config.CLAUDE_MODEL, max_tokens: config.CLAUDE_MAX_TOKENS, system, messages, tools: [ANSWER_TOOL], tool_choice: { type: 'auto' } });
  } catch (e) {
    if (e instanceof AskUnavailable) throw e;
    const detail = failureDetail(e); // network, auth, rate limit, no credit…
    console.error(`Claude call failed: ${detail}`);
    throw new AskUnavailable(`The assistant could not be reached: ${detail}`);
  }

  // Newer models do not allow forcing a tool, so the instructions ask for it and we accept plain text as a fallback.
  const blocks = resp.content ?? [];
  const block = blocks.find((b) => b.type === 'tool_use' && b.name === 'answer');
  let out;
  if (block) {
    out = block.input ?? {};
  } else {
    const text = blocks.map((b) => (b.type === 'text' ? b.text : '')).join(' ').trim();
    if (!text) throw new AskUnavailable('The assistant replied in an unexpected format. Please try again.');
    out = { hero: '', body: text, sources: [], followups: [] };
  }

  const table = cleanTable(out.table);
  if (!String(out.body ?? '').trim()) {
    if (resp.stop_reason === 'max_tokens' || !(table || (out.list ?? []).length)) {
      // The reply was cut off before it finished (too long), or came back empty.
      console.warn(`Answer incomplete: stop_reason=${resp.stop_reason} keys=${Object.keys(out)}`);
      throw new AskUnavailable('The answer was too long to finish. Please ask about one project or one department at a time, or ask for the top few items.');
    }
  }

  const cites = [];
  const seen = new Set();
  for (const s of out.sources ?? []) {
    const sid = s?.id ?? '';
    if (seen.has(sid)) continue;
    seen.add(sid);
    const cc = citation(sid, s.used_for ?? '', index);
    if (cc) cites.push(cc);
  }
  // The model sometimes answers in plain text or cites IDs we do not know. The answer must still show which
  // files it was built from, so fall back to the summary of the data that was actually sent to it.
  if (!cites.length) {
    const summaryId = deptId === 'overview' ? null : `CALC:${deptId}:summary`;
    const ids = summaryId ? [summaryId] : Object.keys(index).filter((k) => k.endsWith(':summary')).slice(0, 6);
    for (const sid of ids) {
      const cc = citation(sid, 'Data the answer was based on', index);
      if (cc) cites.push(cc);
    }
  }
  const usage = resp.usage ?? {};
  return {
    agent: { id: deptId, name: info.agent, routed },
    hero: escapeHtml(String(out.hero ?? '').trim().slice(0, 40)) || null,
    body: cleanHtml(out.body ?? ''),
    list: (out.list ?? []).slice(0, 8).map(cleanHtml),
    sources: cites,
    followups: (out.followups ?? []).slice(0, 3).map((x) => String(x).slice(0, 120)),
    table,
    chart: cleanChart(out.chart),
    projects: pids,
    meta: { model: config.CLAUDE_MODEL, agent: deptId, ms: Date.now() - t0, input_tokens: usage.input_tokens ?? null, output_tokens: usage.output_tokens ?? null },
  };
}
