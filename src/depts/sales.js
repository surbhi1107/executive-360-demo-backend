// Sales: bookings against target, the pipeline, stalled and slipped deals.
import { cell, contactsOf, cr, day, daysUntil, fix, fmt, makeFlag, mon, num, pyRound, sum } from './common.js';

export const ID = 'sales';
export const NAME = 'Sales';
export const AGENT = 'Sales Agent';
export const FILE = 'Executive_360_Sales.xlsx';
export const SCOPE = 'bookings, sales targets, the deal pipeline, win rate and individual deals';
export const KEYWORDS = ['sales', 'pipeline', 'deal', 'booking', 'quota', 'target', 'win rate', 'order', 'lost', 'closing', 'prospect', 'tender', 'bid'];
export const STRONG = ['sales', 'pipeline', 'deal', 'booking', 'quota', 'win rate']; // words that clearly mean this department; they count double when routing a question
const OPEN = ['Qualified', 'Proposal', 'Negotiation'];
const STALL_DAYS = 14;

const f0 = (x) => fix(x, 0);

/** First and last day of the calendar quarter that contains `today`. */
export function quarterOf(today) {
  const y = today.getUTCFullYear();
  const m = Math.floor(today.getUTCMonth() / 3) * 3; // 0-based month of the quarter start
  const start = new Date(Date.UTC(y, m, 1));
  const end = new Date(Date.UTC(y, m + 3, 0));
  return [start, end];
}

export function build(tabs, today, src) {
  const head = contactsOf(tabs)['Head of Sales'] ?? 'Head of Sales';
  const [qStart, qEnd] = quarterOf(today);
  const elapsed = ((-daysUntil(qStart, today) + 1) / (daysUntil(qStart, qEnd) + 1)) * 100;
  const deals = tabs.Pipeline;
  for (const d of deals) {
    d._value = num(d['Value (Cr)']);
    d._close = day(d['Expected close']);
    d._last = day(d['Last activity']);
    d._idle = -daysUntil(d._last, today);
    d._in_q = qStart <= d._close && d._close <= qEnd;
  }
  const won = deals.filter((d) => d.Stage === 'Won' && d._in_q);
  const lost = deals.filter((d) => d.Stage === 'Lost' && d._in_q);
  const openDeals = deals.filter((d) => OPEN.includes(d.Stage));
  const openQ = openDeals.filter((d) => d._in_q);
  const wonTotal = sum(won, (d) => d._value);
  const weighted = sum(openQ, (d) => (d._value * num(d['Probability %'])) / 100);
  const forecast = wonTotal + weighted;
  const target = sum(tabs.Targets, (t) => num(t['Quarter target (Cr)']));
  const stalled = openDeals.filter((d) => ['Proposal', 'Negotiation'].includes(d.Stage) && d._idle >= STALL_DAYS).sort((a, b) => b._value - a._value);
  const slipped = openDeals.filter((d) => d._close < today);
  const winRate = won.length || lost.length ? (won.length / (won.length + lost.length)) * 100 : 0;

  const reps = [];
  for (const t of tabs.Targets) {
    const mine = won.filter((d) => d.Owner === t.Owner);
    const got = sum(mine, (d) => d._value);
    const share = (got / num(t['Quarter target (Cr)'])) * 100;
    reps.push({
      row: t, owner: t.Owner, region: t.Region, target: num(t['Quarter target (Cr)']), won: got, pct: share,
      open: sum(openQ.filter((d) => d.Owner === t.Owner), (d) => d._value),
      status: share < elapsed - 35 ? 'risk' : share < elapsed - 10 ? 'watch' : 'ok',
    });
  }

  const flags = [];
  const cover = (forecast / target) * 100;
  if (cover < 95) {
    flags.push(makeFlag(ID, 'forecast', fmt(qEnd), cover < 85 ? 'risk' : 'watch', 'Quarter behind target', `Forecast ${f0(cover)}% of target`,
      `This quarter is tracking to ${cr(forecast, 0)}, ${f0(cover)}% of the ${cr(target, 0)} target`,
      `${cr(wonTotal, 0)} is booked so far (${f0((wonTotal / target) * 100)}% of target) with ${f0(elapsed)}% of the quarter gone. ` +
        `Open deals due this quarter add ${cr(weighted, 0)} once weighted by their chance of closing.`,
      {
        where: 'Quarter', impacts: [`Gap ${cr(target - forecast, 0)}`, `Booked ${cr(wonTotal, 0)}`, `${f0(elapsed)}% of quarter gone`],
        sources: [src.chip('Pipeline', 'deals closing this quarter', 'Booked and weighted pipeline'), src.chip('Targets', 'all owners', 'Quarter targets')],
        owner: head, ownerRole: 'Head of Sales',
        suggest: ['Ask which three deals can realistically be pulled into this quarter and what each needs from you.',
          'Unblock the stalled deals first; they are the largest part of the gap.', 'Agree a weekly forecast call until quarter end.'],
        agenda: 'Closing the gap to the quarter target.', ask: 'Will we hit the quarter target?',
      }));
  }
  for (const d of stalled) {
    const big = d._value >= 50 && d._idle >= 30; // large and idle for a month: a risk, not just a watch
    flags.push(makeFlag(ID, 'stalled', d['Deal ID'], big ? 'risk' : 'watch', 'Deal stalled', `${d.Customer} ${cr(d._value, 0)} stalled`,
      `${d.Customer}: ${cr(d._value, 0)} deal has had no activity for ${d._idle} days`,
      `${d.Deal} (${d['Deal ID']}) is in ${String(d.Stage).toLowerCase()} and due to close on ${fmt(d._close)}. Last activity was ${fmt(d._last)}. ` +
        `Next step on file: ${d['Next step'] || 'none recorded'}.`,
      {
        where: 'Pipeline', impacts: [cr(d._value, 0), `${d._idle} days idle`, `Owner: ${d.Owner}`],
        sources: [src.chip('Pipeline', d, 'Deal value, stage and last activity')], owner: d.Owner, ownerRole: 'Deal owner',
        suggest: [`Ask ${d.Owner.split(/\s+/)[0]} what is blocking the next step and whether an executive call would help.`,
          "Offer to speak to the customer's decision-maker yourself.", 'Set a firm date for the next customer meeting.'],
        agenda: `What is blocking ${d['Deal ID']} and how you can help.`, ask: `What is the status of the ${d.Customer} deal?`,
      }));
  }
  for (const d of slipped) {
    if (stalled.includes(d)) continue; // already flagged as stalled; one flag per deal is enough
    flags.push(makeFlag(ID, 'slipped', d['Deal ID'], 'watch', 'Close date passed', `${d.Customer} close date passed`,
      `${d.Customer}: ${cr(d._value, 0)} deal passed its expected close date of ${fmt(d._close, false)}`,
      `${d.Deal} (${d['Deal ID']}) was expected to close on ${fmt(d._close)} and is still in ${String(d.Stage).toLowerCase()}. ` +
        `Next step on file: ${d['Next step'] || 'none recorded'}.`,
      {
        where: 'Pipeline', impacts: [cr(d._value, 0), `${-daysUntil(d._close, today)} days past close date`, `Owner: ${d.Owner}`],
        sources: [src.chip('Pipeline', d, 'Expected close date and next step')], owner: d.Owner, ownerRole: 'Deal owner',
        suggest: ['Ask for a realistic new close date and update the forecast.', 'Clear whatever the customer is waiting for.'],
        ask: `Why has the ${d.Customer} deal not closed?`,
      }));
  }
  for (const r of reps) {
    if (r.status === 'risk') {
      flags.push(makeFlag(ID, 'rep', r.owner, 'watch', 'Owner behind target', `${r.owner.split(/\s+/)[0]} at ${f0(r.pct)}% of target`,
        `${r.owner} (${r.region}) has booked ${cr(r.won, 0)} of a ${cr(r.target, 0)} target`,
        `That is ${f0(r.pct)}% of target with ${f0(elapsed)}% of the quarter gone. Open deals due this quarter: ${cr(r.open, 0)}.`,
        {
          where: 'Targets', impacts: [`${f0(r.pct)}% of target`, `Open pipeline ${cr(r.open, 0)}`],
          sources: [src.chip('Targets', r.row, 'Quarter target')], owner: head, ownerRole: 'Head of Sales',
          suggest: [`Ask ${head.split(/\s+/)[0]} for a deal-by-deal plan for the ${r.region} region.`, 'Check whether the region needs bid or pricing support.'],
          ask: `How is ${r.owner} doing against target?`,
        }));
    }
  }

  const monthly = tabs['Monthly bookings'];
  const months = monthly.map((r) => mon(day(r.Month)));
  const stageCell = (d) =>
    stalled.includes(d) ? cell(`${d._idle} days idle`, d._value >= 50 && d._idle >= 30 ? 'risk' : 'watch')
      : slipped.includes(d) ? cell('Close date passed', 'watch') : cell('Active', 'ok');
  return {
    owner: `${head} · Head of Sales`,
    headline: `The quarter is tracking to ${f0(cover)}% of target` +
      (stalled.length ? `; a ${cr(stalled[0]._value, 0)} deal has stalled for ${stalled[0]._idle} days.` : '.'),
    kpis: [
      { label: 'Booked this quarter', value: cr(wonTotal, 0), foot: `${f0((wonTotal / target) * 100)}% of ${cr(target, 0)} target; ${f0(elapsed)}% of quarter gone`,
        status: (wonTotal / target) * 100 < elapsed - 10 ? 'watch' : 'ok' },
      { label: 'Forecast for the quarter', value: cr(forecast, 0), foot: `${f0(cover)}% of target, deals weighted by chance`, status: cover < 85 ? 'risk' : cover < 95 ? 'watch' : 'ok' },
      { label: 'Win rate this quarter', value: `${f0(winRate)}%`, foot: `${won.length} won, ${lost.length} lost`, status: winRate >= 50 ? 'ok' : 'watch' },
      { label: 'Stalled deals', value: String(stalled.length),
        foot: stalled.length ? `${cr(sum(stalled, (d) => d._value), 0)} with no activity for ${STALL_DAYS}+ days` : 'None',
        status: stalled.some((d) => d._value >= 50 && d._idle >= 30) ? 'risk' : stalled.length ? 'watch' : 'ok' },
    ],
    tile: { kind: 'line', caption: 'Bookings, last 12 months', values: monthly.map((r) => num(r['Bookings (Cr)'])) },
    sections: [
      { type: 'chart', title: 'Bookings against target', chart: { kind: 'columns', unit: '₹ Cr', labels: months, values: monthly.map((r) => num(r['Bookings (Cr)'])), compare: monthly.map((r) => num(r['Target (Cr)'])), compare_label: 'target' } },
      {
        type: 'table', title: 'Against target, by owner', columns: ['Owner', 'Region', 'Target', 'Booked', 'Of target', 'Open this quarter'],
        rows: reps.map((r) => [r.owner, r.region, cr(r.target, 0), cr(r.won, 0), cell(`${f0(r.pct)}%`, r.status), cr(r.open, 0)]),
        source: src.chip('Targets', 'all owners', 'Quarter targets'),
      },
      {
        type: 'table', title: 'Open deals', columns: ['Deal', 'Customer', 'Value', 'Stage', 'Chance', 'Expected close', 'Owner', 'Status'],
        rows: [...openDeals].sort((a, b) => a._close - b._close).map((d) => [d['Deal ID'], d.Customer, cr(d._value, 0), d.Stage, `${f0(num(d['Probability %']))}%`, fmt(d._close), d.Owner, stageCell(d)]),
        source: src.chip('Pipeline', 'all open deals', 'Open deals'),
      },
    ],
    flags,
    asks: ['Will we hit the quarter target?', 'Which deals are stalled and why?', 'Show the pipeline by stage as a chart'],
    calc: {
      quarter: `${fmt(qStart)} to ${fmt(qEnd)}`, quarter_elapsed_pct: pyRound(elapsed), quarter_target_cr: target,
      booked_this_quarter_cr: wonTotal, weighted_open_pipeline_this_quarter_cr: pyRound(weighted, 1),
      forecast_for_quarter_cr: pyRound(forecast, 1), forecast_pct_of_target: pyRound(cover), win_rate_pct: pyRound(winRate),
      deals_won_this_quarter: won.length, deals_lost_this_quarter: lost.length,
      open_pipeline_by_stage_cr: Object.fromEntries(OPEN.map((s) => [s, sum(openDeals.filter((d) => d.Stage === s), (d) => d._value)])),
      stalled_deals: stalled.map((d) => ({ deal: d['Deal ID'], customer: d.Customer, value_cr: d._value, days_idle: d._idle })),
      by_owner: reps.map((r) => ({ owner: r.owner, region: r.region, target_cr: r.target, booked_cr: r.won, pct_of_target: pyRound(r.pct) })),
    },
  };
}
