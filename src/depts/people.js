// People: headcount, attrition, critical hiring, key resignations and engagement.
import { cell, contactsOf, day, daysUntil, fix, fmt, makeFlag, maxBy, minBy, mon, num, pct, pyRound, sum } from './common.js';

export const ID = 'people';
export const NAME = 'People';
export const AGENT = 'People Agent';
export const FILE = 'Executive_360_People.xlsx';
export const SCOPE = 'headcount, attrition, hiring, key resignations and employee engagement';
export const KEYWORDS = ['people', 'attrition', 'headcount', 'hiring', 'hire', 'open role', 'vacanc', 'resign', 'engagement', 'employee', 'staff',
  'workforce', 'talent', 'recruit', 'leaver', 'joiner', 'backfill', 'role', 'vacan'];
export const STRONG = ['people', 'attrition', 'headcount', 'hiring', 'resign', 'engagement']; // words that clearly mean this department; they count double when routing a question

const f0 = (x) => fix(x, 0);
const commas = (s) => s.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
const lc = (s) => String(s).toLowerCase();
const beforeComma = (s) => String(s).split(',')[0];
const age = (v) => (v >= 90 ? 'risk' : v >= 60 ? 'watch' : 'ok');

export function build(tabs, today, src) {
  const chro = contactsOf(tabs)['Chief People Officer'] ?? 'Chief People Officer';
  const depts = tabs.Headcount;
  for (const d of depts) {
    d._attr = (num(d['Leavers (last 12 months)']) / num(d.Headcount)) * 100;
    d._status = d._attr >= 20 ? 'risk' : d._attr >= 15 ? 'watch' : 'ok';
  }
  const heads = sum(depts, (d) => num(d.Headcount));
  const approved = sum(depts, (d) => num(d['Approved headcount']));
  const leavers = sum(depts, (d) => num(d['Leavers (last 12 months)']));
  const attrition = (leavers / heads) * 100;
  const engRows = tabs.Engagement;
  const eng = new Map(engRows.map((e) => [e.Department, e]));
  const engVals = [...eng.values()];
  const engAvg = sum(engVals, (e) => num(e['Engagement score (0-100)'])) / engVals.length;

  const roles = tabs['Key open roles'];
  for (const r of roles) r._age = -daysUntil(day(r.Opened), today);
  const critical = roles.filter((r) => r.Critical === 'Yes').sort((a, b) => b._age - a._age);
  const resignations = tabs.Resignations;
  for (const r of resignations) r._left = daysUntil(day(r['Last working day']), today);
  const monthly = tabs.Monthly;

  const flags = [];
  for (const d of depts) {
    if (d._status === 'ok') continue;
    const e = eng.get(d.Department);
    const leftN = f0(num(d['Leavers (last 12 months)']));
    flags.push(makeFlag(ID, 'attrition', d.Department, d._status, 'High attrition', `${d.Department} attrition ${pct(d._attr)}`,
      `${d.Department}: ${pct(d._attr)} of the team left in the last 12 months, against ${pct(attrition)} for the company`,
      `${leftN} people left a team of ${f0(num(d.Headcount))}.` +
        (e && e['Top concern'] ? ` Engagement is ${f0(num(e['Engagement score (0-100)']))} (was ${f0(num(e['Previous score']))}); top concern: ${lc(e['Top concern'])}.` : ''),
      {
        where: 'Attrition', impacts: [`${pct(d._attr)} attrition`, `${leftN} leavers`, `Head: ${d['Department head']}`],
        sources: [src.chip('Headcount', d, 'Headcount and leavers'), ...(e ? [src.chip('Engagement', e, 'Engagement score and top concern')] : [])],
        owner: d['Department head'], ownerRole: 'Department head',
        suggest: ['Ask what is driving exits; the engagement survey points to the top concern.',
          'Agree two or three changes with dates, such as shift pattern or pay correction for key roles.',
          'Ask for stay conversations with the top performers this month.'],
        agenda: `Why people are leaving ${d.Department} and what will change.`, ask: `Why is attrition high in ${d.Department}?`,
      }));
  }
  for (const r of critical) {
    if (r._age >= 60) {
      flags.push(makeFlag(ID, 'role', r.Role, r._age >= 90 ? 'risk' : 'watch', 'Critical role open', `${beforeComma(r.Role)} open ${r._age} days`,
        `${r.Role} has been vacant for ${r._age} days`,
        `Opened on ${fmt(day(r.Opened))}; currently at the ${lc(r.Stage)} stage. Recruiter: ${r.Recruiter}; hiring manager: ${r['Hiring manager']}.`,
        {
          where: 'Hiring', impacts: [`Open ${r._age} days`, `Stage: ${r.Stage}`, `Recruiter: ${r.Recruiter}`],
          sources: [src.chip('Key open roles', r, 'Date opened and stage')], owner: r.Recruiter, ownerRole: 'Recruiter',
          suggest: ['Ask what is blocking an offer: candidates, pay band or interview availability.',
            'Approve a search firm or a pay exception if the role is business-critical.', 'Name an interim person to cover the role.'],
          agenda: `Getting ${r.Role} filled.`, ask: `Why is the ${r.Role} role still open?`,
        }));
    }
  }
  for (const r of resignations) {
    if (r.Critical !== 'Yes' || r['Backfill status'] === 'Identified' || r._left > 30) continue;
    const none = r['Backfill status'] === 'None';
    flags.push(makeFlag(ID, 'exit', r.Employee, none ? 'risk' : 'watch', 'Key person leaving', `${beforeComma(r.Role)} leaves in ${r._left} days`,
      `${r.Employee} (${r.Role}) leaves in ${r._left} days` + (none ? ' and no replacement has been started' : '; replacement is still in progress'),
      `Last working day is ${fmt(day(r['Last working day']))}. Backfill status: ${lc(r['Backfill status'])}. Reason given: ${lc(r['Reason given'])}.`,
      {
        where: 'Resignations', impacts: [`${r._left} days left`, `Backfill: ${r['Backfill status']}`, `Manager: ${r.Manager}`],
        sources: [src.chip('Resignations', r, 'Last working day and backfill status')], owner: r.Manager, ownerRole: 'Manager',
        suggest: ['Decide today between a retention offer, an internal successor or an external search.',
          'Ask for a handover plan covering open bids and key contacts.', 'Speak to the person yourself if they are worth keeping.'],
        agenda: `Succession for ${r.Role}.`,
        autoReason: 'Not available for this flag: it concerns an individual employee, so it needs your decision.',
        approval: `Ask ${chro} to prepare retention and succession options for your review.`,
        ask: `What is the plan to replace ${r.Employee}?`,
      }));
  }

  const worst = maxBy(depts, (d) => d._attr);
  const lowest = minBy(engVals, (e) => num(e['Engagement score (0-100)']));
  const score = (e) => num(e['Engagement score (0-100)']);
  return {
    owner: `${chro} · Chief People Officer`,
    headline: `${worst.Department} attrition is ${pct(worst._attr)}; ${critical.length} critical roles are open, the oldest for ${critical[0]._age} days.`,
    kpis: [
      { label: 'Headcount', value: commas(f0(heads)), foot: `${f0(approved - heads)} below approved (${commas(f0(approved))})`, status: 'ok' },
      { label: 'Attrition, 12 months', value: pct(attrition), foot: `${f0(leavers)} leavers; highest ${worst.Department} ${pct(worst._attr)}`, status: worst._status },
      { label: 'Critical roles open', value: String(critical.length), foot: `Average ${f0(sum(critical, (r) => r._age) / critical.length)} days open`,
        status: critical.length && critical[0]._age >= 90 ? 'risk' : critical.length ? 'watch' : 'ok' },
      { label: 'Engagement', value: `${f0(engAvg)} / 100`, foot: `Lowest: ${lowest.Department}`, status: engAvg < 72 ? 'watch' : 'ok' },
    ],
    tile: { kind: 'pills' },
    sections: [
      { type: 'chart', title: 'Attrition by department, last 12 months', chart: { kind: 'hbar', unit: '%', rows: [...depts].sort((a, b) => b._attr - a._attr).map((d) => ({ label: d.Department, value: pyRound(d._attr, 1) })) } },
      { type: 'chart', title: 'Joiners and leavers by month', chart: { kind: 'columns', unit: 'count', labels: monthly.map((m) => mon(day(m.Month))), values: monthly.map((m) => num(m.Leavers)), compare: monthly.map((m) => num(m.Joiners)), compare_label: 'joiners (bars are leavers)' } },
      {
        type: 'table', title: 'Key open roles', columns: ['Role', 'Department', 'Critical', 'Open for', 'Stage', 'Recruiter'],
        rows: [...roles].sort((a, b) => b._age - a._age).map((r) => [r.Role, r.Department, r.Critical, cell(`${r._age} days`, age(r._age)), r.Stage, r.Recruiter]),
        source: src.chip('Key open roles', 'all roles', 'Open roles'),
      },
      {
        type: 'table', title: 'Resignations', columns: ['Employee', 'Role', 'Last working day', 'Critical', 'Backfill'],
        rows: [...resignations].sort((a, b) => a._left - b._left).map((r) => [r.Employee, r.Role, `${fmt(day(r['Last working day']))} (${r._left} days)`, r.Critical,
          cell(r['Backfill status'], { None: 'risk', 'In progress': 'watch' }[r['Backfill status']] ?? 'ok')]),
        source: src.chip('Resignations', 'all resignations', 'Resignations'),
      },
      {
        type: 'table', title: 'Engagement survey', columns: ['Department', 'Score', 'Previous', 'Top concern'],
        rows: [...engVals].sort((a, b) => score(a) - score(b)).map((e) => [e.Department, cell(f0(score(e)), score(e) < 60 ? 'risk' : score(e) < 68 ? 'watch' : 'ok'), f0(num(e['Previous score'])), e['Top concern'] || '']),
        source: src.chip('Engagement', 'all departments', 'Engagement survey'),
      },
    ],
    flags,
    asks: ['Why is attrition high in Logistics?', 'Which critical roles are open?', 'Show attrition by department as a chart'],
    calc: {
      headcount: heads, approved_headcount: approved, leavers_last_12_months: leavers, attrition_12_months_pct: pyRound(attrition, 1),
      attrition_by_department_pct: Object.fromEntries(depts.map((d) => [d.Department, pyRound(d._attr, 1)])),
      critical_roles_open: critical.map((r) => ({ role: r.Role, days_open: r._age, stage: r.Stage })),
      average_engagement_score: pyRound(engAvg),
      key_resignations: resignations.filter((r) => r.Critical === 'Yes').map((r) => ({ employee: r.Employee, role: r.Role, days_left: r._left, backfill: r['Backfill status'] })),
    },
  };
}
