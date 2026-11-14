// Answers the CEO's questions with Claude.
//
// How it works:
//   1. Code builds a compact set of FACTS from the dashboard (already calculated: progress, dates,
//      penalties, flags). Each fact has a source ID such as  XLS:Milestones:P1|Phase 2.
//   2. For projects named in the question, the matching AGREEMENT CLAUSES are added (source IDs such
//      as DOC:E360-CA-P01:9.1).
//   3. Claude replies through the "answer" tool: a short headline, a paragraph, optional bullet
//      points, the source IDs it used, and follow-up questions.
//   4. Source IDs are turned back into the citation chips the dashboard shows.
//
// Claude never calculates penalties itself; it explains the numbers code has calculated.
import config from './config.js';
import { allClauses } from './agreements.js';
import { CHART_KINDS, chooseChart } from './charts.js';

const SYSTEM = `You are Executive 360°, the project assistant for {ceo}, the CEO. Today is {today}.

Answer ONLY from the FACTS and AGREEMENT CLAUSES provided. They come from the company's project workbook ({workbook}) and the signed project agreements. If the answer is not in them, say so plainly and suggest who could know (usually the project lead).

Rules:
- Write for a busy CEO: plain English, short sentences, no jargon. Lead with the answer.
- Use only numbers that appear in the facts. Penalties are already calculated by the system; never recalculate them. Always call them "estimated penalty exposure" because they are based on forecast dates.
- For "what if" questions (for example, another month of delay), explain the rule from the agreement (rate per week, grace period, cap) and what it means in words. You may multiply a rate by a number of weeks, but say it is a rough estimate and that the cap still applies.
- Dates: write them like 4 Dec 2026. Money: ₹ crore written as ₹3.8 Cr.
- Cite every fact you use by its source ID in the sources list. Do not put source IDs in the text.
- Bold at most two key phrases with <strong>…</strong>. No other HTML or markdown.
- Choose the chart that best supports your answer in the chart field (penalty, slip, progress, budget, timeline for one project, health), or none when a chart would add nothing. The system draws the chart from the verified data, so never put numbers for it in your reply beyond what the text needs.
- Always reply by calling the answer tool, exactly once, and write nothing outside it.`;

export const ANSWER_TOOL = {
  name: 'answer',
  description: 'Give the answer to show on the dashboard. Always use this tool to reply.',
  input_schema: {
    type: 'object',
    properties: {
      hero: { type: 'string', description: "The key figure or verdict in 1-4 words, e.g. '₹3.8 Cr', '4 of 12', '+12 weeks'. Empty if none." },
      body: { type: 'string', description: 'The answer in 1-4 sentences.' },
      list: { type: 'array', items: { type: 'string' }, description: 'Optional bullet points, one per project or item. At most 8.' },
      sources: {
        type: 'array',
        description: 'Every source ID used.',
        items: {
          type: 'object',
          properties: { id: { type: 'string' }, used_for: { type: 'string', description: 'What this source supplied, in a few words.' } },
          required: ['id', 'used_for'],
        },
      },
      followups: { type: 'array', items: { type: 'string' }, description: '2 or 3 short follow-up questions the CEO might ask next.' },
      chart: {
        type: 'object',
        description: 'The chart to show under the answer. The system builds it from the verified data.',
        properties: {
          type: { type: 'string', enum: [...CHART_KINDS, 'none'], description: 'penalty = exposure by project (or by rule for one project); slip = weeks late by project; progress = progress against plan; budget = budget used against progress; timeline = milestone dates of ONE project; health = projects by health; none = no chart.' },
          projects: { type: 'array', items: { type: 'string' }, description: 'Optional project IDs (such as P1) to limit the chart to.' },
        },
        required: ['type'],
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

async function getClient() {
  if (!client) {
    if (!config.ANTHROPIC_API_KEY) {
      throw new AskUnavailable('The assistant is not switched on yet: add ANTHROPIC_API_KEY to backend/.env and restart.');
    }
    const { default: Anthropic } = await import('@anthropic-ai/sdk');
    client = new Anthropic({ apiKey: config.ANTHROPIC_API_KEY, maxRetries: 2, timeout: 60_000 });
  }
  return client;
}

// ------------------------------------------------------------------ facts
const phaseFact = (ph) => ({
  phase: ph.name, scope: ph.scope, contract_date: ph.contract, revised_target: ph.revised,
  forecast: ph.forecast, progress_pct: ph.ac, status: ph.status,
});

/** Returns { facts, index }. index maps every source ID to a description used to build citations. */
export function buildFacts(dash) {
  const facts = [];
  const index = {};
  const s = dash.summary;
  facts.push({ source: 'CALC:portfolio', portfolio_summary: s });
  index['CALC:portfolio'] = {
    kind: 'calc', locator: 'Portfolio summary',
    record: [['Projects', s.projects], ['At risk', s.at_risk], ['Estimated penalty exposure', `₹${s.penalty_total_cr} Cr`]],
  };

  index['XLS:workbook'] = {
    kind: 'excel', locator: 'Projects, Project Updates, Milestones, Stages and Delay Reasons tabs',
    record: [['Workbook', dash.source], ['Projects', s.projects], ['As of', dash.as_of]],
  };

  for (const p of dash.projects) {
    const pid = p.id;
    facts.push({
      source: `XLS:Projects:${pid}`, project: pid, name: p.name, sector: p.type, location_scale: p.where, client: p.client,
      lead: p.pm, health: p.health, current_stage: p.stage, progress_pct: p.ac, planned_pct_by_today: p.pl, next_milestone: p.next,
    });
    index[`XLS:Projects:${pid}`] = {
      kind: 'excel', locator: `Projects · ${pid}`,
      record: [['Project', p.name], ['Health', p.health], ['Progress', `${p.ac}%`], ['Plan', `${p.pl}%`]],
    };

    facts.push({
      source: `XLS:Updates:${pid}`, project: pid, schedule_last_updated: p.updated.when, updated_by: p.updated.by,
      days_since_update: p.updated.days, budget_cr: p.budget.cr, budget_used_pct: p.budget.used,
    });
    index[`XLS:Updates:${pid}`] = {
      kind: 'excel', locator: `Project Updates · ${pid}`,
      record: [['Last updated', p.updated.when], ['By', p.updated.by], ['Budget used', `${p.budget.used}%`]],
    };

    for (const ph of p.phases) {
      const sid = `XLS:Milestones:${pid}|${ph.name}`;
      facts.push({ source: sid, project: pid, ...phaseFact(ph) });
      index[sid] = {
        kind: 'excel', locator: `Milestones · ${pid} · ${ph.name}`,
        record: [['Phase', ph.name], ['Revised target', ph.revised], ['Forecast', ph.forecast], ['Progress', `${ph.ac}%`]],
      };
    }

    const stages = Object.entries(p.stage_progress);
    if (stages.length) {
      facts.push({
        source: `XLS:Stages:${pid}`, project: pid,
        stages_done_vs_plan_pct: Object.fromEntries(stages.map(([k, v]) => [k, { done: v[0], plan: v[1] }])),
      });
      index[`XLS:Stages:${pid}`] = { kind: 'excel', locator: `Stages · ${pid}`, record: stages.map(([k, v]) => [k, `${v[0]}% (plan ${v[1]}%)`]) };
    }

    if (p.reasons.length) {
      facts.push({ source: `XLS:Reasons:${pid}`, project: pid, delay_reasons: p.reasons });
      index[`XLS:Reasons:${pid}`] = { kind: 'excel', locator: `Delay Reasons · ${pid}`, record: p.reasons.map((r) => ['Reason', r]) };
    }

    const pen = p.penalty;
    facts.push({
      source: `CALC:penalty:${pid}`, project: pid, agreement: pen.agreement, estimated_penalty_exposure_cr: pen.exposure_cr,
      rules_charging: pen.charging, rules_one_week_from_charging: pen.near,
    });
    index[`CALC:penalty:${pid}`] = {
      kind: 'calc', locator: `Penalty calculation · ${pid}`,
      record: [
        ['Agreement', pen.agreement],
        ['Estimated exposure', `₹${pen.exposure_cr} Cr`],
        ...pen.charging.map((r) => [r.id, `${r.applies_to}: ${r.weeks_late} wks late, ₹${r.amount_cr} Cr`]),
      ],
    };
  }

  for (const f of dash.flags) {
    facts.push({ source: `CALC:flag:${f.id}`, project: f.proj, flag: f.type, severity: f.sev, title: f.title, detail: f.body, suggested_actions: f.suggest });
    index[`CALC:flag:${f.id}`] = { kind: 'calc', locator: `Flag · ${f.title}`, record: [['Detail', f.body]] };
  }
  return { facts, index };
}

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
        kind: 'word', ref: c.agreement, file: c.file,
        locator: c.clause && /^\d/.test(c.clause) ? `Clause ${c.clause}` : c.clause ? `Recital ${c.clause}` : c.section,
        excerpt: c.text,
      };
    }
  }
  return { picked, index };
}

// ------------------------------------------------------------------ answer
const escapeHtml = (s, quote = true) => {
  let t = String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  if (quote) t = t.replace(/"/g, '&quot;').replace(/'/g, '&#x27;');
  return t;
};

/** Escape everything, then allow <strong> back. Keeps the dashboard safe from stray markup. */
export const cleanHtml = (text) => escapeHtml(text, false).replace(/&lt;(\/?)strong&gt;/g, '<$1strong>');

function citation(sid, usedFor, index, workbook) {
  const info = index[sid];
  if (!info) return null;
  if (info.kind === 'word') {
    return { kind: 'word', ref: info.ref, name: info.file, locator: info.locator, used_for: usedFor, excerpt: info.excerpt.slice(0, 900) };
  }
  return {
    kind: info.kind,
    ref: info.kind === 'excel' ? 'workbook' : 'calc',
    name: info.kind === 'excel' ? workbook : 'Executive 360 calculations',
    locator: info.locator,
    used_for: usedFor,
    record: (info.record ?? []).map(([a, b]) => [String(a), String(b)]).slice(0, 8),
  };
}

export async function answer(question, dash, history = []) {
  question = String(question ?? '').trim().slice(0, 1000);
  if (!question) throw new Error('Empty question');
  const c = await getClient();
  const hist = Array.isArray(history) ? history.filter((h) => h && typeof h === 'object') : [];

  const { facts, index } = buildFacts(dash);
  const pids = mentionedProjects(`${question} ${hist.slice(-2).map((h) => h.q ?? '').join(' ')}`, dash.projects);
  const { picked: clauses, index: cindex } = await clauseContext(pids);
  Object.assign(index, cindex);

  const system = [
    { type: 'text', text: SYSTEM.replace('{ceo}', config.CEO_NAME).replace('{today}', dash.as_of).replace('{workbook}', dash.source) },
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
    resp = await c.messages.create({
      model: config.CLAUDE_MODEL,
      max_tokens: config.CLAUDE_MAX_TOKENS,
      system,
      messages,
      tools: [ANSWER_TOOL],
      tool_choice: { type: 'auto' },
    });
  } catch (e) {
    if (e instanceof AskUnavailable) throw e;
    // network, auth, rate limit, no credit…
    const detail = e?.error?.error?.message || e?.message || String(e);
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

  const cites = [];
  const seen = new Set();
  for (const s of out.sources ?? []) {
    const sid = s?.id ?? '';
    if (seen.has(sid)) continue;
    seen.add(sid);
    const cc = citation(sid, s.used_for ?? '', index, dash.source);
    if (cc) cites.push(cc);
  }
  // The model sometimes answers in plain text or cites IDs we do not know. The answer must still show which
  // files it was built from, so fall back to the data that was actually sent to it for this question.
  if (!cites.length) {
    const usedFor = 'Data the answer was based on';
    const ids = pids.length
      ? pids.slice(0, 3).flatMap((pid) => [
          `XLS:Projects:${pid}`,
          `CALC:penalty:${pid}`,
          ...Object.keys(index).filter((k) => k.startsWith('DOC:') && index[k].locator === 'Clause 9.1' && k.includes(`P${pid.slice(1).padStart(2, '0')}`)),
        ])
      : ['XLS:workbook', 'CALC:portfolio'];
    for (const sid of ids) {
      const cc = citation(sid, usedFor, index, dash.source);
      if (cc) cites.push(cc);
    }
  }
  // The chart follows THIS question. Projects from earlier turns only count for a follow-up that refers back
  // to them ("what about its budget?"), never for a question about the whole portfolio.
  const own = mentionedProjects(question, dash.projects);
  const refersBack = /\b(it|its|this|that|they|them|their|there)\b/i.test(question) && !/\b(projects|portfolio|all|each|every|across|which)\b/i.test(question);
  const chart = chooseChart(dash, { hint: out.chart, question, pids: own.length ? own : refersBack ? pids : [] });
  const usage = resp.usage ?? {};
  return {
    hero: escapeHtml(String(out.hero ?? '').trim().slice(0, 40)) || null,
    body: cleanHtml(out.body ?? ''),
    list: (out.list ?? []).slice(0, 8).map(cleanHtml),
    sources: cites,
    followups: (out.followups ?? []).slice(0, 3).map((x) => String(x).slice(0, 120)),
    chart,
    projects: pids,
    meta: { model: config.CLAUDE_MODEL, ms: Date.now() - t0, input_tokens: usage.input_tokens ?? null, output_tokens: usage.output_tokens ?? null },
  };
}
