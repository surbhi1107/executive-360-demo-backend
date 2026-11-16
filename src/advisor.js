// AI writing that appears without the CEO asking:
//
//   1. The morning brief on the Home screen: what changed, the three things that matter most today and what to do about each.
//   2. Advice on a flag: when a flag is opened, the department's agent writes the explanation, the suggestions, the email draft
//      and the call agenda for that exact situation.
//
// The same rule as everywhere else applies: code decides WHAT is flagged and calculates every number (views.js, depts/).
// Claude only writes the words, from facts it is given, and cites its sources. Results are saved in the database, so the same
// brief or advice is not paid for twice. If Claude is not available, the dashboard falls back to the standard text written in code.
import crypto from 'node:crypto';
import config from './config.js';
import { isoDay } from './dates.js';
import { AskUnavailable, citation, cleanHtml, clauseContext, departmentFacts, failureDetail, getClient, overviewFacts, projectFacts } from './ask.js';
import { plainStory } from './links.js';
import * as store from './store.js';

const WRITER = `You write for {ceo}, the CEO, inside Executive 360°, the company's CEO dashboard. Today is {today}.
Use ONLY the FACTS{clauses} below; they come from the company's own files and from calculations done by the system.
- Plain English, short sentences, no jargon. Say what is happening, why it matters and what to do.
- Use only numbers and names that appear in the facts. Never invent a figure, a date, a person or a cause.
- Money is in ₹ crore, written like ₹3.8 Cr. Dates like 4 Dec 2026.
- Cite the source ID of every fact you use in "sources". Never put source IDs in the text.
- No HTML and no markdown.
- Reply only by calling the tool, exactly once.`;

const SOURCES_SCHEMA = {
  type: 'array',
  items: { type: 'object', properties: { id: { type: 'string' }, used_for: { type: 'string' } }, required: ['id', 'used_for'] },
};

export const BRIEF_TOOL = {
  name: 'brief',
  description: "The CEO's brief for the Home screen.",
  input_schema: {
    type: 'object',
    properties: {
      headline: { type: 'string', description: 'One sentence, at most 16 words: the single most important thing today.' },
      summary: { type: 'string', description: 'Two or three sentences on the overall state of the company and what changed since the last update.' },
      items: {
        type: 'array', description: 'Exactly three things that most need the CEO today, most important first. Each must be one of the flags in the facts.',
        items: {
          type: 'object',
          properties: {
            flag_id: { type: 'string', description: "The flag's id exactly as given in the facts (the part after 'CALC:flag:')." },
            title: { type: 'string', description: 'At most 10 words.' },
            why: { type: 'string', description: 'One or two sentences: what is happening and why it matters, with the key figure.' },
            suggestion: { type: 'string', description: 'One sentence: the action the CEO should take today and with whom.' },
          },
          required: ['flag_id', 'title', 'why', 'suggestion'],
        },
      },
      links: { type: 'string', description: 'Optional. One or two sentences if issues in different departments look connected (same site, customer or person). Empty if none.' },
      sources: SOURCES_SCHEMA,
    },
    required: ['headline', 'summary', 'items', 'sources'],
  },
};

export const ADVICE_TOOL = {
  name: 'advice',
  description: 'Advice on one flag, shown when the CEO opens it.',
  input_schema: {
    type: 'object',
    properties: {
      explanation: { type: 'string', description: 'Two or three sentences: what is happening, the likely cause if the facts state one, and why it matters now.' },
      suggestions: { type: 'array', items: { type: 'string' }, description: 'Exactly three specific actions for the CEO, each one sentence, most useful first.' },
      email_subject: { type: 'string' },
      email_body: {
        type: 'string',
        description: "A short email from the CEO to the owner named in the flag. Greeting with their first name, the facts in two or three sentences, a clear request with a deadline, signed with the CEO's name. Use line breaks between paragraphs. At most 110 words.",
      },
      call_agenda: { type: 'string', description: 'One line: what to cover on a 15-minute call with the owner.' },
      sources: SOURCES_SCHEMA,
    },
    required: ['explanation', 'suggestions', 'email_subject', 'email_body', 'call_agenda', 'sources'],
  },
};

export const REPLY_TOOL = {
  name: 'reply_summary',
  description: "Summary of a reply to the CEO's message.",
  input_schema: {
    type: 'object',
    properties: {
      summary: { type: 'string', description: 'One or two sentences: what the person said they will do, by when, and anything they need. Start with their first name. Use only what the reply says.' },
      stance: { type: 'string', enum: ['acting', 'needs help', 'disagrees', 'unclear'] },
      commitment_date: { type: 'string', description: 'The date they committed to, as written in the reply, or empty.' },
    },
    required: ['summary', 'stance'],
  },
};

export const LINKS_TOOL = {
  name: 'connected_issues',
  description: 'One short story for each group of connected flags.',
  input_schema: {
    type: 'object',
    properties: {
      stories: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            key: { type: 'string', description: "The group's key, copied exactly." },
            headline: { type: 'string', description: 'At most 12 words: the one problem behind these flags.' },
            story: { type: 'string', description: "Two or three sentences linking the flags across departments: what connects them and what it is costing. Say 'possibly' or 'may' for a cause the facts do not state outright." },
            owner: { type: 'string', description: 'The ONE person, named in the facts, best placed to own the whole problem.' },
            action: { type: 'string', description: 'One sentence: the single next step for the CEO.' },
          },
          required: ['key', 'headline', 'story', 'owner', 'action'],
        },
      },
    },
    required: ['stories'],
  },
};

/** One Claude call that must come back through the given tool. */
async function call(facts, clauses, task, tool, today, maxTokens = 1500) {
  const client = await getClient();
  const system = [
    { type: 'text', text: WRITER.replace('{ceo}', config.CEO_NAME).replace('{today}', today).replace('{clauses}', clauses.length ? ' and AGREEMENT CLAUSES' : '') },
    { type: 'text', text: `FACTS (JSON):\n${JSON.stringify(facts)}` },
  ];
  if (clauses.length) system.push({ type: 'text', text: `AGREEMENT CLAUSES (JSON):\n${JSON.stringify(clauses)}` });
  system[system.length - 1].cache_control = { type: 'ephemeral' };
  let resp;
  try {
    resp = await client.messages.create({ model: config.CLAUDE_MODEL, max_tokens: maxTokens, system, messages: [{ role: 'user', content: task }], tools: [tool], tool_choice: { type: 'auto' } });
  } catch (e) {
    if (e instanceof AskUnavailable) throw e;
    const detail = failureDetail(e);
    console.error(`Claude call failed: ${detail}`);
    throw new AskUnavailable(`The assistant could not be reached: ${detail}`);
  }
  const blocks = resp.content ?? [];
  const block = blocks.find((b) => b.type === 'tool_use' && b.name === tool.name);
  if (!block || !block.input || !Object.keys(block.input).length) {
    const text = blocks.map((b) => (b.type === 'text' ? b.text : '')).join(' ');
    console.warn(`${tool.name}: no tool call. stop_reason=${resp.stop_reason} text=${text.slice(0, 300)}`);
    throw new AskUnavailable('The assistant replied in an unexpected format.');
  }
  const out = { ...block.input };
  for (const [k, v] of Object.entries(out)) {
    // a list that arrives as JSON text is turned back into a list
    if (typeof v === 'string' && /^\s*[[{]/.test(v)) {
      try {
        out[k] = JSON.parse(v);
      } catch {
        /* leave it as text */
      }
    }
  }
  out._stop = resp.stop_reason ?? '';
  return out;
}

function cites(out, index) {
  const seen = new Set();
  const list = [];
  for (const s of out.sources ?? []) {
    if (!s || seen.has(s.id)) continue;
    seen.add(s.id);
    const c = citation(s.id ?? '', s.used_for ?? '', index);
    if (c) list.push(c);
  }
  return list.slice(0, 8);
}

/** Same JSON with keys in a fixed order, so that equal data always gives the same text. */
function stable(v) {
  if (Array.isArray(v)) return `[${v.map(stable).join(',')}]`;
  if (v && typeof v === 'object') return `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${stable(v[k])}`).join(',')}}`;
  return JSON.stringify(v) ?? 'null';
}
export const hashKey = (...parts) => crypto.createHash('sha256').update(stable(parts)).digest('hex').slice(0, 32);

// ------------------------------------------------------------------ closest match (difflib.get_close_matches)
function matchingBlocks(a, b, alo, ahi, blo, bhi) {
  let best = { i: alo, j: blo, k: 0 };
  let prev = new Array(bhi - blo + 1).fill(0);
  for (let i = alo; i < ahi; i++) {
    const cur = new Array(bhi - blo + 1).fill(0);
    for (let j = blo; j < bhi; j++) {
      if (a[i] === b[j]) {
        cur[j - blo + 1] = prev[j - blo] + 1;
        if (cur[j - blo + 1] > best.k) best = { i: i - cur[j - blo + 1] + 1, j: j - cur[j - blo + 1] + 1, k: cur[j - blo + 1] };
      }
    }
    prev = cur;
  }
  if (!best.k) return 0;
  return best.k + (best.i > alo && best.j > blo ? matchingBlocks(a, b, alo, best.i, blo, best.j) : 0)
    + (best.i + best.k < ahi && best.j + best.k < bhi ? matchingBlocks(a, b, best.i + best.k, ahi, best.j + best.k, bhi) : 0);
}
export const ratio = (a, b) => (a.length + b.length ? (2 * matchingBlocks(a, b, 0, a.length, 0, b.length)) / (a.length + b.length) : 1);
/** The single closest candidate with ratio >= cutoff, or null. */
export function closest(word, candidates, cutoff) {
  const scored = candidates.map((x) => [ratio(word, x), x]).filter(([r]) => r >= cutoff);
  scored.sort((p, q) => q[0] - p[0] || (q[1] > p[1] ? 1 : q[1] < p[1] ? -1 : 0));
  return scored.length ? scored[0][1] : null;
}

// ------------------------------------------------------------------ snapshot and "what changed"
/** The parts of the dashboard worth comparing from one day to the next. */
export function snapshot(depts) {
  return {
    depts: Object.fromEntries(depts.map((d) => [d.id, { name: d.name, status: d.status_word, kpis: Object.fromEntries(d.kpis.map((k) => [k.label, k.value])) }])),
    flags: Object.fromEntries(depts.flatMap((d) => d.flags).map((f) => [f.id, { title: f.title, sev: f.sev, dept: f.dept }])),
  };
}

/** Plain list of what is different now. Calculated by code, not by the AI. */
export function changesSince(prev, cur) {
  if (!prev) return { since: null, items: [] };
  const old = prev.data;
  const items = [];
  for (const [did, d] of Object.entries(cur.depts)) {
    const o = old.depts[did];
    if (!o) continue;
    if (o.status !== d.status) items.push({ kind: 'status', dept: did, text: `${d.name} moved from ${o.status} to ${d.status}` });
    for (const [label, value] of Object.entries(d.kpis)) {
      if (label in o.kpis && o.kpis[label] !== value) items.push({ kind: 'kpi', dept: did, text: `${d.name}: ${label.toLowerCase()} changed from ${o.kpis[label]} to ${value}` });
    }
  }
  for (const [fid, f] of Object.entries(cur.flags)) {
    if (!(fid in old.flags)) items.push({ kind: 'new', dept: f.dept, flag_id: fid, text: `New flag: ${f.title}` });
    else if (old.flags[fid].sev !== f.sev) items.push({ kind: 'sev', dept: f.dept, flag_id: fid, text: `${f.sev === 'risk' ? 'Worse' : 'Better'}: ${f.title}` });
  }
  for (const [fid, f] of Object.entries(old.flags)) {
    if (!(fid in cur.flags)) items.push({ kind: 'cleared', dept: f.dept, text: `Cleared: ${f.title}` });
  }
  return { since: prev.taken_at, items };
}

/** Save today's snapshot (if the data changed) and return [fingerprint, changes since the previous state]. */
export function recordAndCompare(dash, depts) {
  const snap = snapshot(depts);
  const fp = hashKey(snap);
  store.saveSnapshot(dash.as_of, fp, snap);
  return [fp, changesSince(store.previousSnapshot(fp), snap)];
}

// ------------------------------------------------------------------ 1. the brief
/** The most serious flags, taking one from each department before a second from any. */
export function topFlags(depts, n = 3) {
  const byDept = depts.map((d) => d.flags.filter((f) => f.sev === 'risk'));
  let picked = [];
  let i = 0;
  while (picked.length < n && byDept.some((l) => l.length > i)) {
    picked = picked.concat(byDept.filter((l) => l.length > i).map((l) => l[i]));
    i += 1;
  }
  if (picked.length < n) picked = picked.concat(depts.flatMap((d) => d.flags).filter((f) => f.sev === 'watch'));
  return picked.slice(0, n);
}

/** The brief written by code. Used when the AI is off or fails, so Home always has a brief. */
export function fallbackBrief(depts, changes) {
  const risk = depts.filter((d) => d.status === 'risk').map((d) => d.name);
  const watch = depts.filter((d) => d.status === 'watch').map((d) => d.name);
  const parts = [...(risk.length ? [`${risk.join(', ')} ${risk.length === 1 ? 'is' : 'are'} at risk`] : []), ...(watch.length ? [`${watch.join(', ')} to watch`] : [])];
  const top = topFlags(depts);
  return {
    ai: false,
    headline: top.length ? cleanHtml(top[0].title) : 'Nothing needs your attention today.',
    summary: (parts.length ? `${parts.join('; ')}.` : 'All departments are on track.') + (changes.items.length ? ` ${changes.items.length} things changed since the last update.` : ''),
    items: top.map((f) => ({ flag_id: f.id, dept: f.dept, sev: f.sev, title: cleanHtml(f.short), why: cleanHtml(`${f.title}.`), suggestion: cleanHtml(f.suggest[0]) })),
    links: '', sources: [],
  };
}

/** Find the real flag an item refers to: by id, else by the closest id or title. null if nothing fits. */
export function matchFlag(item, flags, allowed) {
  const raw = String(item.flag_id ?? '').trim().replace('CALC:flag:', '');
  if (raw in flags) return flags[raw];
  const lowered = allowed.map((a) => a.toLowerCase());
  const near = closest(raw.toLowerCase(), lowered, 0.75);
  if (near !== null) return flags[allowed.find((a) => a.toLowerCase() === near)];
  const titles = Object.fromEntries(allowed.map((a) => [flags[a].title.toLowerCase(), a]));
  const t = closest(String(item.title ?? '').toLowerCase(), Object.keys(titles), 0.6);
  return t !== null ? flags[titles[t]] : null;
}

export async function writeBrief(dash, depts, fingerprint, changes, refresh = false) {
  const key = `brief:${hashKey(fingerprint, config.CLAUDE_MODEL)}`;
  const hit = refresh ? null : store.cacheGet(key);
  if (hit) return hit;
  const { facts, index } = overviewFacts(depts);
  const flags = Object.fromEntries(depts.flatMap((d) => d.flags).map((f) => [f.id, f]));
  facts.push({ source: 'CALC:changes', changes_since_last_update: changes.items.map((c) => c.text).length ? changes.items.map((c) => c.text) : 'No earlier state to compare with.' });
  index['CALC:changes'] = { kind: 'calc', locator: 'What changed since the last update', record: changes.items.slice(0, 8).map((c) => ['Change', c.text]) };
  const allowed = facts.filter((f) => String(f.source ?? '').startsWith('CALC:flag:')).map((f) => f.source.replace('CALC:flag:', ''));
  const tool = structuredClone(BRIEF_TOOL); // tell Claude exactly which flag ids it may choose from
  tool.input_schema.properties.items.items.properties.flag_id.enum = allowed;
  const out = await call(
    facts, [],
    "Write today's brief. Choose the three flags that most need the CEO's own attention today, across departments. Prefer issues with money, customers or deadlines at stake. " +
      `Mention what changed if anything did. For each item, flag_id must be copied exactly from this list: ${allowed.join(', ')}`,
    tool, dash.as_of, Math.max(2500, config.CLAUDE_MAX_TOKENS));
  const items = [];
  const used = new Set();
  for (const it of (Array.isArray(out.items) ? out.items : []).filter((i) => i && typeof i === 'object' && !Array.isArray(i)).slice(0, 4)) {
    const f = matchFlag(it, flags, allowed);
    if (f && !used.has(f.id) && items.length < 3) { // only flags that really exist are shown
      used.add(f.id);
      items.push({ flag_id: f.id, dept: f.dept, sev: f.sev, title: cleanHtml(it.title ?? '').slice(0, 120), why: cleanHtml(it.why ?? '').slice(0, 400), suggestion: cleanHtml(it.suggestion ?? '').slice(0, 300) });
    }
  }
  if (!items.length) {
    console.warn(`Brief incomplete. stop_reason=${out._stop} keys=${Object.keys(out)} items=${JSON.stringify(out.items)?.slice(0, 400)}`);
    throw new AskUnavailable(`The brief came back incomplete${out._stop === 'max_tokens' ? ' (it was cut off).' : '.'}`);
  }
  if (!String(out.headline ?? '').trim()) out.headline = items[0].title;
  const brief = {
    ai: true, headline: cleanHtml(out.headline).slice(0, 200), summary: cleanHtml(out.summary ?? '').slice(0, 600), items,
    links: cleanHtml(out.links ?? '').slice(0, 400), sources: cites(out, index),
  };
  store.cachePut(key, 'brief', brief);
  return brief;
}

// ------------------------------------------------------------------ 2. advice on a flag
export async function writeAdvice(flag, dash, depts, refresh = false) {
  const key = `advice:${hashKey(flag.id, flag.title, flag.body, config.CLAUDE_MODEL)}`;
  const hit = refresh ? null : store.cacheGet(key);
  if (hit) return hit;
  const dept = depts.find((d) => d.id === flag.dept);
  let clauses = [];
  let facts;
  let index;
  if (flag.dept === 'projects') {
    ({ facts, index } = projectFacts(dash));
    facts = facts.filter((f) => f.project === flag.proj || f.source === `CALC:flag:${flag.id}`); // this project only
    const ctx = await clauseContext([flag.proj]);
    clauses = ctx.picked;
    Object.assign(index, ctx.index);
  } else {
    ({ facts, index } = departmentFacts(dept));
  }
  const owner = flag.email.to;
  const task = `Write advice for this flag: "${flag.title}" (source CALC:flag:${flag.id}). The owner to contact is ${owner} (${flag.call.who}). ` +
    `Address the email to ${owner} and sign it ${config.CEO_NAME}. Make the suggestions specific to this situation: name the people, amounts, dates and, for projects, ` +
    'the agreement clause that applies. Do not suggest anything the facts cannot support.';
  const out = await call(facts, clauses, task, ADVICE_TOOL, dash.as_of);
  const suggestions = (Array.isArray(out.suggestions) ? out.suggestions : []).map((s) => String(s).trim().slice(0, 300)).filter(Boolean).slice(0, 3);
  if (!suggestions.length || !String(out.email_body ?? '').trim()) throw new AskUnavailable('The advice came back incomplete.');
  const advice = {
    agent: dept.agent, explanation: String(out.explanation ?? '').trim().slice(0, 700), suggestions,
    email: { subject: String(out.email_subject ?? '').trim().slice(0, 160) || flag.email.subject, body: String(out.email_body).trim().slice(0, 1500) },
    agenda: String(out.call_agenda ?? '').trim().slice(0, 200) || flag.call.agenda, sources: cites(out, index),
  };
  store.cachePut(key, 'advice', advice);
  return advice;
}

// ------------------------------------------------------------------ 3. a reply, summarised
/** One or two sentences for the case timeline. Falls back to the start of the reply if Claude is unavailable. */
export async function summariseReply(text, c, today = isoDay(config.asOf())) {
  const flat = text.split(/\s+/).filter(Boolean).join(' ');
  const fallback = flat.slice(0, 280) + (flat.length > 280 ? '…' : '');
  let out;
  try {
    out = await call([{ source: 'CASE', issue_raised_with_them: c.title, person: c.owner }, { source: 'REPLY', reply_text: text.slice(0, 4000) }], [], 'Summarise this reply for the CEO.', REPLY_TOOL, today, 500);
  } catch (e) {
    if (e instanceof AskUnavailable) return fallback;
    throw e;
  }
  const summary = String(out.summary ?? '').trim();
  if (!summary) return fallback;
  const stance = out.stance;
  return summary.slice(0, 400) + (['needs help', 'disagrees', 'unclear'].includes(stance) ? ` (${stance})` : '');
}

// ------------------------------------------------------------------ 4. connected issues across departments
/** The groups from links.findLinks(), each with a story. Written by Claude once and saved; by code if Claude is off. */
export async function writeLinks(groups, flagsById, today, refresh = false) {
  const base = groups.map((g) => {
    const plain = plainStory(g, flagsById);
    return {
      key: g.key, kind_word: g.kind_word, entity: g.entity, depts: g.depts, dept_names: g.dept_names, flag_ids: g.flag_ids, sev: g.sev,
      ...Object.fromEntries(Object.entries(plain).map(([k, v]) => [k, ['headline', 'story', 'action'].includes(k) ? cleanHtml(v) : v])),
    };
  });
  if (!groups.length) return base;
  const key = `links:${hashKey(groups.map((g) => [g.key, g.flag_ids, g.flag_ids.map((i) => flagsById[i].title)]), config.CLAUDE_MODEL)}`;
  const hit = refresh ? null : store.cacheGet(key);
  if (hit) return hit.links;
  const facts = groups.map((g) => ({
    source: 'GROUP', key: g.key, what_they_share: `${g.kind_word}: ${g.entity}`,
    flags: g.flag_ids.map((i) => ({ department: flagsById[i].dept, title: flagsById[i].title, detail: flagsById[i].body, owner: flagsById[i].call.who })),
    other_rows_that_mention_it: g.evidence.map((e) => `${e.dept} · ${e.tab}: ${e.text}`),
  }));
  let out;
  try {
    out = await call(
      facts, [],
      'Write one story for each group. The flags in a group come from different departments but mention the same site, customer, topic or person. Explain the connection only as far as the facts support it.',
      LINKS_TOOL, today, 2000);
  } catch (e) {
    if (e instanceof AskUnavailable) return base;
    throw e;
  }
  const stories = Object.fromEntries((Array.isArray(out.stories) ? out.stories : []).filter((s) => s && typeof s === 'object').map((s) => [String(s.key ?? ''), s]));
  const ids = groups.flatMap((g) => g.flag_ids);
  const people = new Set([...ids.map((i) => flagsById[i].email.to), ...ids.map((i) => flagsById[i].call.who.split(' · ')[0])]);
  for (const b of base) {
    const s = stories[b.key];
    if (s && String(s.story ?? '').trim()) {
      const owner = String(s.owner ?? '').trim();
      Object.assign(b, {
        ai: true, headline: cleanHtml(String(s.headline ?? '')).slice(0, 140) || b.headline, story: cleanHtml(String(s.story)).slice(0, 600),
        owner: people.has(owner) ? owner : b.owner, // never a person who is not in the facts
        action: cleanHtml(String(s.action ?? '')).slice(0, 300) || b.action,
      });
    }
  }
  if (base.some((b) => b.ai)) store.cachePut(key, 'links', { links: base });
  return base;
}
