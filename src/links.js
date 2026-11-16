// Connected issues: flags in DIFFERENT departments that are about the same thing.
//
// Code finds the connections; it does not guess. A connection exists when flags from at least two departments mention the same
// site, customer, topic or person. Rows in other workbooks that mention it are added as supporting evidence. The AI then writes
// the story (advisor.writeLinks); if the AI is off, a plain description written here is shown instead.
import { SEV_RANK, show } from './depts/common.js';
import { isoDay } from './dates.js';

const SUFFIXES = new Set(['pvt', 'ltd', 'ltd.', 'corp', 'corporation', 'authority', 'co', 'co.', 'limited']);
const KIND_RANK = { site: 0, customer: 1, topic: 2, person: 3 };
const KIND_WORD = { site: 'Site', customer: 'Customer', topic: 'Topic', person: 'Person' };
const escapeRe = (t) => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const tabsOf = (depts, id) => depts.find((d) => d.id === id)?._tabs ?? {};

/** Python's str() for a cell value. */
const pyStr = (v) => (v instanceof Date ? (v.getUTCHours() || v.getUTCMinutes() || v.getUTCSeconds() ? `${isoDay(v)} ${show(v).slice(-5)}:00` : isoDay(v)) : String(v));

/** The names worth looking for: plant locations, customers, a few topics, and flag owners. */
export function entities(depts) {
  const out = [];
  const seen = new Set();
  const add = (kind, name, keyword) => {
    const key = String(keyword).toLowerCase();
    if (key.length >= 4 && !seen.has(key)) {
      seen.add(key);
      out.push({ kind, name, keyword: key });
    }
  };
  for (const p of tabsOf(depts, 'operations').Plants ?? []) add('site', `${p.Location} plant`, String(p.Location));
  for (const a of tabsOf(depts, 'customers').Accounts ?? []) {
    add('customer', a.Customer, String(a.Customer).split(/\s+/).filter((w) => w && !SUFFIXES.has(w.toLowerCase())).join(' '));
  }
  add('topic', 'Warranty claims', 'warranty');
  for (const h of tabsOf(depts, 'people').Headcount ?? []) {
    if (!['Operations', 'Projects'].includes(h.Department)) add('topic', `${h.Department} team`, String(h.Department)); // too general to be a useful link
  }
  for (const d of depts) for (const f of d.flags) add('person', f.email.to, f.email.to);
  return out;
}

const blob = (f) => [f.title, f.body, f.where ?? '', f.impacts.join(' '), f.email.to, f.call.who].join(' ').toLowerCase();

/** Groups of flags from two or more departments that share an entity, most serious first. */
export function findLinks(depts, limit = 4) {
  const flags = depts.flatMap((d) => d.flags);
  const blobs = Object.fromEntries(flags.map((f) => [f.id, blob(f)]));
  const names = Object.fromEntries(depts.map((d) => [d.id, d.name]));
  const order = Object.keys(names);
  const groups = [];
  for (const e of entities(depts)) {
    const word = new RegExp(`\\b${escapeRe(e.keyword)}\\b`);
    const hits = flags.filter((f) => word.test(blobs[f.id]) && !(e.kind === 'topic' && f.dept === 'projects'));
    const deptIds = [...new Set(hits.map((f) => f.dept))].sort((a, b) => order.indexOf(a) - order.indexOf(b));
    if (deptIds.length < 2) continue;
    const evidence = []; // rows elsewhere that mention it (not themselves flagged)
    for (const d of depts) {
      for (const [tab, rows] of Object.entries(d._tabs ?? {})) {
        if (tab === 'Contacts') continue;
        for (const r of rows) {
          const text = Object.entries(r).filter(([k, v]) => !k.startsWith('_') && typeof v === 'string').map(([, v]) => v).join(' ').toLowerCase();
          if (word.test(text)) {
            evidence.push({
              dept: d.id, tab, row: r._row,
              text: Object.entries(r).filter(([k, v]) => !k.startsWith('_') && v !== null && v !== undefined && v !== '').map(([k, v]) => `${k}: ${pyStr(v)}`).join('; ').slice(0, 260),
            });
          }
        }
      }
    }
    hits.sort((a, b) => SEV_RANK[a.sev] - SEV_RANK[b.sev] || deptIds.indexOf(a.dept) - deptIds.indexOf(b.dept));
    groups.push({
      key: `${e.kind}:${e.keyword}`, kind: e.kind, kind_word: KIND_WORD[e.kind], entity: e.name, depts: deptIds, dept_names: deptIds.map((i) => names[i]),
      flag_ids: hits.slice(0, 6).map((f) => f.id), sev: hits[0].sev, evidence: evidence.slice(0, 6),
    });
  }
  // sites, customers and topics first (they describe a problem); a shared person is the weakest kind of link
  groups.sort((a, b) => (a.kind === 'person') - (b.kind === 'person') || SEV_RANK[a.sev] - SEV_RANK[b.sev] || b.depts.length - a.depts.length
    || KIND_RANK[a.kind] - KIND_RANK[b.kind] || b.flag_ids.length - a.flag_ids.length);
  const kept = []; // drop a group whose flags are all inside one already kept
  for (const g of groups) {
    if (!kept.some((k) => g.flag_ids.every((i) => k.flag_ids.includes(i)))) kept.push(g);
  }
  return kept.slice(0, limit);
}

/** The connection described by code, used when the AI is off. */
export function plainStory(group, flagsById) {
  const flags = group.flag_ids.map((i) => flagsById[i]);
  const top = flags[0];
  const dn = group.dept_names;
  const joined = dn.length < 3 ? dn.join(' and ') : `${dn.slice(0, -1).join(', ')} and ${dn[dn.length - 1]}`;
  return {
    ai: false, headline: `${group.entity}: issues in ${joined}`,
    story: `${flags.length} open flags in ${group.depts.length} departments mention ${group.entity}. They may share a cause, so they are best handled together.`,
    owner: top.email.to, action: top.suggest[0],
  };
}
