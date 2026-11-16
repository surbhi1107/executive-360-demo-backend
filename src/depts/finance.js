// Finance: revenue and margin, cash, receivables, spending against budget.
import { cell, contactsOf, cr, day, daysUntil, fix, fmt, makeFlag, mon, num, pct, pyRound, signed, sum } from './common.js';

export const ID = 'finance';
export const NAME = 'Finance';
export const AGENT = 'Finance Agent';
export const FILE = 'Executive_360_Finance.xlsx';
export const SCOPE = 'revenue, margin, costs, cash, receivables and spending against budget';
export const KEYWORDS = ['revenue', 'margin', 'ebitda', 'profit', 'cash', 'receivable', 'overdue', 'invoice', 'collection', 'budget',
  'spend', 'cost', 'p&l', 'finance', 'borrowing', 'debt', 'expense', 'owe', 'money', 'payment'];
export const STRONG = ['revenue', 'margin', 'ebitda', 'cash', 'receivable', 'budget', 'finance']; // words that clearly mean this department; they count double when routing a question

const f0 = (x) => fix(x, 0);
const f1 = (x) => fix(x, 1);
const minus = (s) => s.replace('-', '−');

export function build(tabs, today, src) {
  const people = contactsOf(tabs);
  const cfo = people['Chief Financial Officer'] ?? 'CFO';
  const pl = tabs['Monthly P&L'];
  for (const r of pl) {
    r._m = day(r.Month);
    r._rev = num(r['Revenue (Cr)']);
    r._plan = num(r['Revenue plan (Cr)']);
    r._ebitda = r._rev - num(r['Cost of goods sold (Cr)']) - num(r['Operating expenses (Cr)']);
    r._margin = (r._ebitda / r._rev) * 100;
  }
  const last = pl[pl.length - 1];
  const prev3 = pl.slice(-4, -1);
  const fyYear = last._m.getUTCMonth() + 1 >= 4 ? last._m.getUTCFullYear() : last._m.getUTCFullYear() - 1;
  const fyStart = new Date(Date.UTC(fyYear, 3, 1));
  const fy = pl.filter((r) => r._m >= fyStart);
  const revYtd = sum(fy, (r) => r._rev);
  const planYtd = sum(fy, (r) => r._plan);
  const prevMargin = sum(prev3, (r) => r._margin) / prev3.length;
  const marginChange = last._margin - prevMargin;

  const cash = tabs.Cash;
  const cashNow = num(cash[cash.length - 1]['Closing cash (Cr)']);
  const cashPrev = num(cash[cash.length - 2]['Closing cash (Cr)']);

  const openInv = tabs.Receivables.filter((r) => r.Status === 'Open');
  for (const r of openInv) r._overdue = Math.max(0, -daysUntil(day(r['Due date']), today));
  const overdue = openInv.filter((r) => r._overdue > 0).sort((a, b) => b._overdue - a._overdue);
  const overdueTotal = sum(overdue, (r) => num(r['Amount (Cr)']));

  const budget = tabs['Budget vs Actual'];
  for (const r of budget) r._var = (num(r['Actual FY to date (Cr)']) / num(r['Budget FY to date (Cr)']) - 1) * 100;

  const flags = [];
  // 1. Margin dip
  if (marginChange <= -2) {
    const note = last.Note ? ` Reason recorded: ${String(last.Note).toLowerCase()}.` : '';
    flags.push(makeFlag(ID, 'margin', mon(last._m, true), marginChange <= -3 ? 'risk' : 'watch', 'Margin dip', `Margin ${pct(last._margin)}`,
      `EBITDA margin fell to ${pct(last._margin)} in ${mon(last._m)}, from ${pct(prevMargin)} over the previous three months`,
      `${mon(last._m, true)} revenue was ${cr(last._rev)} and EBITDA ${cr(last._ebitda)}, a margin of ${pct(last._margin)}. ` +
        `The average of the previous three months was ${pct(prevMargin)}.${note}`,
      {
        where: 'Profit and loss', impacts: [minus(`${signed(marginChange, 1)} pts`), `EBITDA ${cr(last._ebitda)}`],
        sources: [src.chip('Monthly P&L', last, 'Latest month revenue and costs')], owner: cfo, ownerRole: 'CFO',
        suggest: ['Ask which contracts absorbed the cost increase and whether price-variation clauses can be invoked.',
          'Check whether steel and freight can be re-quoted or hedged for the next quarter.',
          'Review pricing on bids going out this month so new contracts carry the higher costs.'],
        agenda: 'October margin: causes and recovery actions.', approval: `Ask ${cfo} for a margin recovery note for the next board pack.`,
        ask: 'Why did margin fall last month?',
      }));
  }
  // 2. Revenue behind plan in the latest month
  const gap = (last._rev / last._plan - 1) * 100;
  if (gap <= -5) {
    flags.push(makeFlag(ID, 'revenue', mon(last._m, true), 'watch', 'Revenue behind plan', `Revenue ${f0(gap)}% vs plan`,
      `${mon(last._m)} revenue was ${cr(last._rev)}, ${f1(Math.abs(gap))}% below the plan of ${cr(last._plan)}`,
      `Revenue for the financial year to date is ${cr(revYtd)} against a plan of ${cr(planYtd)} (${f1((revYtd / planYtd) * 100)}% of plan).`,
      {
        where: 'Profit and loss', impacts: [`${cr(last._rev - last._plan)} vs plan`, `Year to date ${f0((revYtd / planYtd) * 100)}% of plan`],
        sources: [src.chip('Monthly P&L', last, 'Revenue and plan')], owner: cfo, ownerRole: 'CFO',
        suggest: ['Ask which projects or orders slipped out of the month and when they will be billed.', 'Confirm the forecast for the rest of the quarter.'],
        ask: 'Why was revenue below plan last month?',
      }));
  }
  // 3. Overdue receivables (one flag for each invoice more than 45 days late; 60 days or more is a risk)
  for (const r of overdue) {
    if (r._overdue >= 45) {
      const owner = r['Collections owner'];
      flags.push(makeFlag(ID, 'overdue', r.Invoice, r._overdue >= 60 ? 'risk' : 'watch', 'Overdue receivable', `${r.Customer} ${cr(r['Amount (Cr)'])} overdue`,
        `${r.Customer} owes ${cr(r['Amount (Cr)'])}, now ${r._overdue} days overdue`,
        `Invoice ${r.Invoice} for ${cr(r['Amount (Cr)'])} was due on ${fmt(day(r['Due date']))}. ` +
          (r.Note ? `Note on file: ${r.Note}. ` : '') + `Total overdue across all customers is ${cr(overdueTotal)}.`,
        {
          where: 'Receivables', impacts: [`${cr(r['Amount (Cr)'])}`, `${r._overdue} days overdue`, `Owner: ${owner}`],
          sources: [src.chip('Receivables', r, 'Invoice amount, due date and note')], owner, ownerRole: 'Collections',
          suggest: ["Call the customer's finance head directly; this is past the point where reminders work.",
            'Resolve whatever is blocking payment (certification, dispute) with a named owner and date.',
            'Consider holding further dispatches or invoking the interest clause if there is no commitment.'],
          agenda: `Plan to collect ${r.Invoice} from ${r.Customer}.`,
          autoReason: 'Not available for this flag: it involves money and a customer, so it needs your decision.',
          approval: `Prepare a formal payment reminder to ${r.Customer} for your review before it is sent.`,
          ask: `What is blocking payment from ${r.Customer}?`,
        }));
    }
  }
  // 4. Departments spending above budget
  for (const r of budget) {
    if (r._var >= 10) {
      const owner = r['Budget owner'];
      flags.push(makeFlag(ID, 'overspend', r.Department, r._var >= 15 ? 'risk' : 'watch', 'Over budget', `${r.Department} +${f0(r._var)}%`,
        `${r.Department} has spent ${f0(r._var)}% more than its budget so far this year`,
        `Actual ${cr(r['Actual FY to date (Cr)'])} against a budget of ${cr(r['Budget FY to date (Cr)'])}.` +
          (r.Note ? ` Reason recorded: ${String(r.Note).toLowerCase()}.` : ''),
        {
          where: 'Budget', impacts: [`+${cr(num(r['Actual FY to date (Cr)']) - num(r['Budget FY to date (Cr)']))}`, `Owner: ${owner}`],
          sources: [src.chip('Budget vs Actual', r, 'Budget and actual spend')], owner, ownerRole: 'Budget owner',
          suggest: ['Ask for a forecast to year end and what will be cut to get back to budget.', 'Decide whether the overspend is one-off or needs a budget revision.'],
          approval: `Ask ${owner} for a year-end spend forecast.`, ask: `Why is ${r.Department} over budget?`,
        }));
    }
  }
  // 5. Cash fell sharply in the month
  const cashChange = cashNow - cashPrev;
  if (cashChange / cashPrev <= -0.05) {
    const lastCash = cash[cash.length - 1];
    flags.push(makeFlag(ID, 'cash', mon(day(lastCash.Month), true), 'watch', 'Cash down', `Cash down ${cr(Math.abs(cashChange))}`,
      `Cash fell by ${cr(Math.abs(cashChange))} in ${mon(day(lastCash.Month))} to ${cr(cashNow)}`,
      `Closing cash was ${cr(cashNow)}, down from ${cr(cashPrev)}.` + (lastCash.Note ? ` Reason recorded: ${lastCash.Note}.` : ''),
      {
        where: 'Cash', impacts: [`${cr(cashChange)} in the month`, `Overdue receivables ${cr(overdueTotal)}`],
        sources: [src.chip('Cash', lastCash, 'Closing cash')], owner: cfo, ownerRole: 'CFO',
        suggest: ['Ask for a 13-week cash forecast.', 'Prioritise collection of the largest overdue invoices.'],
        ask: 'Why did cash fall last month?',
      }));
  }

  const months = pl.map((r) => mon(r._m));
  const lastCashMonth = day(cash[cash.length - 1].Month);
  const openSorted = [...openInv].sort((a, b) => b._overdue - a._overdue);
  return {
    owner: `${cfo} · CFO`,
    headline: `Margin fell to ${pct(last._margin)} in ${mon(last._m)}; ${cr(overdueTotal)} of receivables are overdue.`,
    kpis: [
      { label: 'Revenue, year to date', value: cr(revYtd, 0), foot: `${f0((revYtd / planYtd) * 100)}% of plan (${cr(planYtd, 0)})`, status: revYtd >= planYtd * 0.98 ? 'ok' : 'watch' },
      { label: `EBITDA margin, ${mon(last._m)}`, value: pct(last._margin), foot: minus(`${signed(marginChange, 1)} pts vs previous 3 months`),
        status: marginChange <= -3 ? 'risk' : marginChange <= -2 ? 'watch' : 'ok' },
      { label: 'Cash', value: cr(cashNow, 0), foot: `${cr(cashChange, 0)} in ${mon(lastCashMonth)}`, status: cashChange / cashPrev <= -0.05 ? 'watch' : 'ok' },
      { label: 'Overdue receivables', value: cr(overdueTotal), foot: overdue.length ? `${overdue.length} invoices; oldest ${overdue[0]._overdue} days` : 'None',
        status: overdue.some((r) => r._overdue >= 60) ? 'risk' : overdue.length ? 'watch' : 'ok' },
    ],
    tile: { kind: 'line', caption: 'Revenue, last 12 months', values: pl.map((r) => r._rev) },
    sections: [
      { type: 'chart', title: 'Revenue against plan', chart: { kind: 'columns', unit: '₹ Cr', labels: months, values: pl.map((r) => r._rev), compare: pl.map((r) => r._plan), compare_label: 'plan' } },
      { type: 'chart', title: 'EBITDA margin', chart: { kind: 'line', unit: '%', labels: months, values: pl.map((r) => pyRound(r._margin, 1)) } },
      {
        type: 'table', title: 'Open receivables', columns: ['Invoice', 'Customer', 'Amount', 'Due', 'Overdue', 'Owner'],
        rows: openSorted.map((r) => [r.Invoice, r.Customer, cr(r['Amount (Cr)']), fmt(day(r['Due date'])),
          r._overdue
            ? cell(`${r._overdue} days`, r._overdue >= 60 ? 'risk' : r._overdue >= 45 ? 'watch' : null, r._overdue >= 45 ? null : 'late')
            : cell('Not due', 'ok'),
          r['Collections owner']]),
        source: src.chip('Receivables', 'all open invoices', 'Open invoices'),
      },
      {
        type: 'table', title: 'Spending against budget, year to date', columns: ['Department', 'Budget', 'Actual', 'Variance', 'Owner'],
        rows: [...budget].sort((a, b) => b._var - a._var).map((r) => [r.Department, cr(r['Budget FY to date (Cr)']), cr(r['Actual FY to date (Cr)']),
          cell(`${signed(r._var, 0)}%`, r._var >= 15 ? 'risk' : r._var >= 10 ? 'watch' : 'ok'), r['Budget owner']]),
        source: src.chip('Budget vs Actual', 'all departments', 'Budget and actual'),
      },
    ],
    flags,
    asks: ['Why did margin fall last month?', 'Who owes us money and how late is it?', 'Which departments are over budget?'],
    calc: {
      revenue_year_to_date_cr: revYtd, revenue_plan_year_to_date_cr: planYtd, latest_month: mon(last._m, true),
      latest_month_ebitda_margin_pct: pyRound(last._margin, 1), previous_3_month_avg_margin_pct: pyRound(prevMargin, 1),
      monthly_ebitda_margin_pct: Object.fromEntries(pl.map((r) => [mon(r._m, true), pyRound(r._margin, 1)])),
      cash_cr: cashNow, cash_change_in_month_cr: cashChange, open_receivables_cr: pyRound(sum(openInv, (r) => num(r['Amount (Cr)'])), 1),
      overdue_receivables_cr: pyRound(overdueTotal, 1),
      overdue_invoices: overdue.map((r) => ({ invoice: r.Invoice, customer: r.Customer, amount_cr: r['Amount (Cr)'], days_overdue: r._overdue })),
      budget_variance_pct: Object.fromEntries(budget.map((r) => [r.Department, pyRound(r._var, 1)])),
    },
  };
}
