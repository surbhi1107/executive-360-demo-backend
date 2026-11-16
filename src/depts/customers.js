// Customers: account health, renewals, complaints and retention.
import { cell, contactsOf, cr, day, daysUntil, fix, fmt, makeFlag, mon, num, pct, pyRound, sum } from './common.js';

export const ID = 'customers';
export const NAME = 'Customers';
export const AGENT = 'Customers Agent';
export const FILE = 'Executive_360_Customers.xlsx';
export const SCOPE = 'customer accounts, satisfaction, renewals, complaints and retention';
export const KEYWORDS = ['customer', 'retention', 'churn', 'complaint', 'renewal', 'renew', 'satisfaction', 'nps', 'account', 'client', 'lost customer'];
export const STRONG = ['customer', 'retention', 'churn', 'complaint', 'renewal']; // words that clearly mean this department; they count double when routing a question

const f0 = (x) => fix(x, 0);
const maxOr0 = (list) => (list.length ? Math.max(...list) : 0);
const CRIT = { Critical: 'risk', Major: 'watch' };
const CRIT_RANK = { Critical: 0, Major: 1 };
const HEALTH_WORD = { risk: 'At risk', watch: 'Watch', ok: 'Healthy' };
const HEALTH_RANK = { risk: 0, watch: 1, ok: 2 };

export function build(tabs, today, src) {
  const head = contactsOf(tabs)['Head of Customer Success'] ?? 'Head of Customer Success';
  const complaints = tabs.Complaints;
  for (const c of complaints) c._age = -daysUntil(day(c.Opened), today);
  const openC = complaints.filter((c) => c.Status === 'Open');
  const accounts = tabs.Accounts;
  for (const a of accounts) {
    const mine = openC.filter((c) => c.Customer === a.Customer);
    a._complaints = mine;
    a._oldest = maxOr0(mine.map((c) => c._age));
    a._critical = mine.filter((c) => c.Severity === 'Critical');
    a._renew_in = daysUntil(day(a['Contract renewal']), today);
    a._since_contact = -daysUntil(day(a['Last executive contact']), today);
    const score = num(a['Satisfaction (0-10)']);
    if (score <= 5 && (mine.length >= 2 || a._renew_in <= 90)) a._health = 'risk';
    else if (score <= 6 || mine.length >= 2 || a._since_contact > 60) a._health = 'watch';
    else a._health = 'ok';
  }
  const atRisk = accounts.filter((a) => a._health === 'risk');
  const renewals = accounts.filter((a) => a._renew_in >= 0 && a._renew_in <= 90).sort((a, b) => a._renew_in - b._renew_in);
  const scoreAvg = sum(accounts, (a) => num(a['Satisfaction (0-10)'])) / accounts.length;

  const ret = tabs.Retention;
  for (const r of ret) r._pct = ((num(r['Customers at start']) - num(r['Customers lost'])) / num(r['Customers at start'])) * 100;
  const lost12 = sum(ret, (r) => num(r['Customers lost']));
  const retention12 = (1 - lost12 / num(ret[0]['Customers at start'])) * 100;
  const lostRecent = sum(ret.slice(-2), (r) => num(r['Customers lost']));

  const flags = [];
  for (const a of [...atRisk].sort((x, y) => num(y['Annual revenue (Cr)']) - num(x['Annual revenue (Cr)']))) {
    const name = a.Customer;
    const rev = num(a['Annual revenue (Cr)']);
    // the oldest open complaint (first one wins a tie, as max() does)
    const worstC = a._complaints.length ? a._complaints.reduce((b, c) => (c._age > b._age ? c : b)) : null;
    const tail = a._critical.length
      ? `, including a critical one: ${String(a._critical[0].Summary).toLowerCase()}`
      : worstC ? `; the oldest has been open ${a._oldest} days` : '';
    flags.push(makeFlag(ID, 'account', name, 'risk', 'Account at risk', `${name} at risk`,
      `${name} (${cr(rev, 0)} a year) is at risk` + (a._renew_in <= 90 ? `, ${a._renew_in} days before renewal` : ''),
      `Satisfaction is ${f0(num(a['Satisfaction (0-10)']))} out of 10 and ${a._complaints.length} complaints are open${tail}. ` +
        `The contract renews on ${fmt(day(a['Contract renewal']))}. Last executive contact was ${a._since_contact} days ago.`,
      {
        where: 'Accounts', impacts: [`${cr(rev, 0)} a year`, `Renewal in ${a._renew_in} days`, `${a._complaints.length} open complaints`],
        sources: [src.chip('Accounts', a, 'Revenue, renewal date and satisfaction'),
          ...(worstC ? [src.chip('Complaints', (a._critical.length ? a._critical : [worstC])[0], 'Open complaint')] : [])],
        owner: a['Account manager'], ownerRole: 'Account manager',
        suggest: ["Call the customer's leadership yourself this week; it has been too long since an executive spoke to them.",
          'Get every open complaint a named owner and a closing date before the call.',
          'Agree a recovery plan with the account manager and review it weekly until renewal.'],
        agenda: `Recovery plan for ${name} before renewal.`,
        autoReason: 'Not available for this flag: it involves a key customer relationship, so it needs your decision.',
        approval: `Prepare a recovery plan and a meeting request to ${name}'s leadership for your review.`,
        ask: `Why is ${name} at risk?`,
      }));
  }
  for (const a of renewals) {
    if (a._health === 'watch' && a._renew_in <= 60) {
      const name = a.Customer;
      flags.push(makeFlag(ID, 'renewal', name, 'watch', 'Renewal needs attention', `${name} renews in ${a._renew_in} days`,
        `${name} (${cr(a['Annual revenue (Cr)'], 0)} a year) renews in ${a._renew_in} days with ${a._complaints.length} complaints open`,
        `Satisfaction is ${f0(num(a['Satisfaction (0-10)']))} out of 10. Renewal date is ${fmt(day(a['Contract renewal']))}. ` +
          `Last executive contact was ${a._since_contact} days ago.`,
        {
          where: 'Renewals', impacts: [`${cr(a['Annual revenue (Cr)'], 0)} a year`, `Renewal in ${a._renew_in} days`],
          sources: [src.chip('Accounts', a, 'Renewal date and satisfaction')], owner: a['Account manager'], ownerRole: 'Account manager',
          suggest: ['Close the open complaints before the renewal conversation.', 'Schedule an executive visit this month.'],
          ask: `Is the ${name} renewal safe?`,
        }));
    }
  }
  if (lostRecent >= 3) {
    const names = ret.slice(-2).filter((r) => r['Lost customers']).map((r) => r['Lost customers']).join('; ');
    flags.push(makeFlag(ID, 'churn', mon(day(ret[ret.length - 1].Month), true), 'watch', 'More customers leaving', `${f0(lostRecent)} customers lost in 2 months`,
      `${f0(lostRecent)} customers were lost in the last two months, against ${f0(lost12 - lostRecent)} in the ten months before`,
      `Lost: ${names}. Retention over the last 12 months is ${pct(retention12)}.`,
      {
        where: 'Retention', impacts: [`${f0(lostRecent)} lost in 2 months`, `12-month retention ${pct(retention12)}`],
        sources: [src.chip('Retention', ret[ret.length - 1], 'Customers lost in the latest month'), src.chip('Retention', ret[ret.length - 2], 'Customers lost in the previous month')],
        owner: head, ownerRole: 'Head of Customer Success',
        suggest: ['Ask for the reason each customer left and whether any can be won back.', 'Check whether price or service is the common cause.'],
        ask: 'Which customers did we lose recently and why?',
      }));
  }

  const top = atRisk[0];
  const revAtRisk = sum(atRisk, (a) => num(a['Annual revenue (Cr)']));
  const renewRev = cr(sum(renewals, (a) => num(a['Annual revenue (Cr)'])), 0);
  const headline = top
    ? `${top.Customer} (${cr(top['Annual revenue (Cr)'], 0)} a year) is at risk` + (top._renew_in <= 90 ? ` ${top._renew_in} days before renewal` : '') + `; ${openC.length} complaints are open.`
    : `No accounts at risk; ${openC.length} complaints are open.`;
  const retPcts = ret.map((r) => pyRound(r._pct, 1));
  return {
    owner: `${head} · Head of Customer Success`,
    headline,
    kpis: [
      { label: 'Retention, 12 months', value: pct(retention12), foot: `${f0(lost12)} customers lost; ${f0(lostRecent)} in the last 2 months`, status: lostRecent >= 3 ? 'watch' : 'ok' },
      { label: 'Satisfaction', value: `${fix(scoreAvg, 1)} / 10`, foot: `${accounts.filter((a) => num(a['Satisfaction (0-10)']) <= 5).length} accounts at 5 or below`, status: scoreAvg < 7.5 ? 'watch' : 'ok' },
      { label: 'Renewals in 90 days', value: renewRev, foot: `${renewals.length} accounts; ${renewals.filter((a) => a._health !== 'ok').length} need attention`,
        status: renewals.some((a) => a._health === 'risk') ? 'risk' : renewals.some((a) => a._health === 'watch') ? 'watch' : 'ok' },
      { label: 'Open complaints', value: String(openC.length), foot: `${openC.filter((c) => c.Severity === 'Critical').length} critical; oldest ${maxOr0(openC.map((c) => c._age))} days`,
        status: openC.some((c) => c.Severity === 'Critical') ? 'risk' : openC.length ? 'watch' : 'ok' },
    ],
    tile: { kind: 'bars', caption: 'Monthly retention, last 12 months', values: retPcts, min: 94, max: 100, nums: [['Renewals in 90 days', renewRev], ['Open complaints', String(openC.length)]] },
    sections: [
      {
        type: 'table', title: 'Accounts', columns: ['Customer', 'Revenue a year', 'Renewal', 'Satisfaction', 'Open complaints', 'Last executive contact', 'Health'],
        rows: [...accounts].sort((a, b) => HEALTH_RANK[a._health] - HEALTH_RANK[b._health] || num(b['Annual revenue (Cr)']) - num(a['Annual revenue (Cr)']))
          .map((a) => [a.Customer, cr(a['Annual revenue (Cr)'], 0), `${fmt(day(a['Contract renewal']))} (${a._renew_in} days)`, `${f0(num(a['Satisfaction (0-10)']))} / 10`,
            String(a._complaints.length), `${a._since_contact} days ago`, cell(HEALTH_WORD[a._health], a._health)]),
        source: src.chip('Accounts', 'all accounts', 'Account list'),
      },
      {
        type: 'table', title: 'Open complaints', columns: ['ID', 'Customer', 'Severity', 'Open for', 'Owner', 'Summary'],
        rows: [...openC].sort((a, b) => (CRIT_RANK[a.Severity] ?? 2) - (CRIT_RANK[b.Severity] ?? 2) || b._age - a._age)
          .map((c) => [c.ID, c.Customer, cell(c.Severity, CRIT[c.Severity] ?? 'ok'), `${c._age} days`, c.Owner, c.Summary]),
        source: src.chip('Complaints', 'all open complaints', 'Complaint log'),
      },
      { type: 'chart', title: 'Monthly retention', chart: { kind: 'columns', unit: '%', labels: ret.map((r) => mon(day(r.Month))), values: retPcts, min: 94 } },
    ],
    flags,
    asks: ['Which customers are at risk?', 'What renewals are coming up?', 'Show open complaints by customer as a chart'],
    calc: {
      retention_12_months_pct: pyRound(retention12, 1), customers_lost_12_months: lost12, customers_lost_last_2_months: lostRecent,
      average_satisfaction_out_of_10: pyRound(scoreAvg, 1), open_complaints: openC.length, revenue_at_risk_cr: revAtRisk,
      accounts: accounts.map((a) => ({
        customer: a.Customer, health: a._health, annual_revenue_cr: a['Annual revenue (Cr)'], days_to_renewal: a._renew_in,
        open_complaints: a._complaints.length, days_since_executive_contact: a._since_contact,
      })),
    },
  };
}
