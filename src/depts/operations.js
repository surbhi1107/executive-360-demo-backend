// Operations: plants, logistics, customer support and safety.
import { cell, contactsOf, day, daysUntil, fix, fmt, isoDay, makeFlag, minBy, num, pct, pyRound, signed, sum } from './common.js';

export const ID = 'operations';
export const NAME = 'Operations';
export const AGENT = 'Operations Agent';
export const FILE = 'Executive_360_Operations.xlsx';
export const SCOPE = 'plant utilisation and output, logistics and on-time delivery, customer support queues, and incidents';
export const KEYWORDS = ['operations', 'plant', 'utilisation', 'utilization', 'oee', 'downtime', 'logistics', 'delivery', 'on-time', 'shipment',
  'support', 'ticket', 'warranty', 'incident', 'safety', 'output', 'production', 'breakdown', 'factory'];
export const STRONG = ['operations', 'plant', 'utilisation', 'utilization', 'downtime', 'warranty', 'oee']; // words that clearly mean this department; they count double when routing a question

const f0 = (x) => fix(x, 0);
const gapStatus = (value, target) => {
  const gap = target - value;
  return gap >= 10 ? 'risk' : gap >= 5 ? 'watch' : 'ok';
};
const lc = (s) => String(s).toLowerCase();

export function build(tabs, today, src) {
  const people = contactsOf(tabs);
  const coo = people['Chief Operating Officer'] ?? 'COO';
  const { Plants: plants, Logistics: lanes, Support: queues } = tabs;
  const util = sum(plants, (p) => num(p['Utilisation %'])) / plants.length;
  const utilTarget = sum(plants, (p) => num(p['Target %'])) / plants.length;
  const shipped = sum(lanes, (l) => num(l.Shipments));
  const otd = ((shipped - sum(lanes, (l) => num(l.Delayed))) / shipped) * 100;
  const otdTarget = num(lanes[0]['Target %']);
  const sla = sum(queues, (q) => num(q['SLA met % (last 30 days)'])) / queues.length;
  const slaTarget = num(queues[0]['Target %']);
  const incidents = tabs.Incidents;
  for (const i of incidents) {
    i._date = day(i.Date);
    i._age = -daysUntil(i._date, today);
  }
  const safety30 = incidents.filter((i) => i.Type === 'Safety' && i._age <= 30);
  const weekly = tabs['Weekly output'];
  const lastWeek = weekly[weekly.length - 1];
  const outGap = (num(lastWeek['Output (tonnes)']) / num(lastWeek['Plan (tonnes)']) - 1) * 100;

  const flags = [];
  for (const p of plants) {
    const st = gapStatus(num(p['Utilisation %']), num(p['Target %']));
    if (st !== 'ok') {
      const down = num(p['Unplanned downtime (hrs, last 7 days)']);
      flags.push(makeFlag(ID, 'plant', p.Plant, st, 'Plant below target', `${p.Plant.split(/\s+/)[0]} at ${f0(num(p['Utilisation %']))}%`,
        `${p.Plant} is running at ${f0(num(p['Utilisation %']))}% against a target of ${f0(num(p['Target %']))}%`,
        `Unplanned downtime was ${f0(down)} hours in the last 7 days and OEE is ${f0(num(p['OEE %']))}%.` +
          (p.Note ? ` Note on file: ${p.Note}.` : '') + ` Company output last week was ${f0(Math.abs(outGap))}% ${outGap < 0 ? 'below' : 'above'} plan.`,
        {
          where: 'Plants', impacts: [`${signed(num(p['Utilisation %']) - num(p['Target %']), 0)} pts vs target`, `${f0(down)} hrs downtime`, `Manager: ${p.Manager}`],
          sources: [src.chip('Plants', p, 'Utilisation, downtime and note'), src.chip('Weekly output', lastWeek, 'Output against plan')],
          owner: p.Manager, ownerRole: 'Plant manager',
          suggest: ['Ask whether the spare part can be expedited or the work moved to another plant meanwhile.',
            'Check which customer orders are affected and warn those customers today.', 'Ask for a recovery plan for the lost output, including overtime cost.'],
          agenda: `${p.Plant}: restart date, affected orders and recovery plan.`,
          autoText: `Ask ${p.Manager} for a daily restart update and alert you if the date moves.`,
          autoDone: `Daily update requested from ${p.Manager} at {t}.`, ask: `What happened at ${p.Plant}?`,
        }));
    }
  }
  for (const l of lanes) {
    const v = num(l['On-time delivery % (last 30 days)']);
    const st = gapStatus(v, num(l['Target %']));
    if (st !== 'ok') {
      flags.push(makeFlag(ID, 'delivery', l.Lane, st, 'Deliveries late', `${l.Lane.split(/\s+/)[0]} deliveries ${f0(v)}%`,
        `${l.Lane}: on-time delivery is ${f0(v)}% against a target of ${f0(num(l['Target %']))}%`,
        `${f0(num(l.Delayed))} of ${f0(num(l.Shipments))} shipments were late in the last 30 days.` + (l.Note ? ` Note on file: ${l.Note}.` : ''),
        {
          where: 'Logistics', impacts: [`${f0(num(l.Delayed))} late shipments`, `Manager: ${l.Manager}`],
          sources: [src.chip('Logistics', l, 'On-time delivery and delayed shipments')], owner: l.Manager, ownerRole: 'Head of Logistics',
          suggest: ['Ask whether this is a one-off or needs a second transporter on the lane.', 'Check that affected customers were told before the delivery date.'],
          ask: `Why are deliveries late on the ${l.Lane} lane?`,
        }));
    }
  }
  for (const q of queues) {
    const v = num(q['SLA met % (last 30 days)']);
    const st = gapStatus(v, num(q['Target %']));
    if (st !== 'ok') {
      flags.push(makeFlag(ID, 'support', q.Queue, st, 'Support SLA missed', `${q.Queue} SLA ${f0(v)}%`,
        `${q.Queue}: only ${f0(v)}% answered within the agreed time, against a target of ${f0(num(q['Target %']))}%`,
        `${f0(num(q['Open tickets']))} tickets are open and the oldest has waited ${f0(num(q['Oldest open ticket (days)']))} days.` +
          (q.Note ? ` Note on file: ${q.Note}.` : ''),
        {
          where: 'Support', impacts: [`${f0(num(q['Open tickets']))} open`, `Oldest ${f0(num(q['Oldest open ticket (days)']))} days`, `Manager: ${q.Manager}`],
          sources: [src.chip('Support', q, 'Open tickets and SLA')], owner: q.Manager, ownerRole: 'Head of Service',
          suggest: ['Approve temporary assessors or overtime to clear the backlog.', 'Ask for the oldest ten tickets to be closed this week.',
            'Check which key customers are waiting; unresolved claims are hurting renewals.'],
          agenda: `Clearing the ${lc(q.Queue)} backlog.`, ask: `Why is the ${lc(q.Queue)} queue behind?`,
        }));
    }
  }
  for (const i of incidents) {
    if (i.Status === 'Open' && i.Type === 'Safety' && i._age >= 7) {
      flags.push(makeFlag(ID, 'incident', `${i.Site}-${isoDay(i._date)}`, 'watch', 'Safety incident open', `Safety incident open ${i._age} days`,
        `${i.Site}: safety incident still open after ${i._age} days`,
        `${i.Description} (${lc(i.Severity)} severity, reported ${fmt(i._date)}). No closure has been recorded.`,
        {
          where: 'Incidents', impacts: [`${i.Severity} severity`, `Open ${i._age} days`, `Owner: ${i.Owner}`],
          sources: [src.chip('Incidents', i, 'Incident details and status')], owner: i.Owner, ownerRole: 'Site manager',
          suggest: ['Ask for the investigation report and corrective actions this week.', 'Confirm the same risk has been checked at the other plants.'],
          ask: `What is the status of the safety incident at ${i.Site}?`,
        }));
    }
  }

  const worstPlant = minBy(plants, (p) => num(p['Utilisation %']) - num(p['Target %']));
  const worstQueue = minBy(queues, (q) => num(q['SLA met % (last 30 days)']) - num(q['Target %']));
  return {
    owner: `${coo} · COO`,
    headline: `${worstPlant.Plant} is at ${f0(num(worstPlant['Utilisation %']))}% utilisation; ${lc(worstQueue.Queue)} are missing their service target.`,
    kpis: [
      { label: 'Plant utilisation', value: pct(util, 0), foot: `Target ${f0(utilTarget)}%; lowest ${worstPlant.Plant.split(/\s+/)[0]} ${f0(num(worstPlant['Utilisation %']))}%`,
        status: gapStatus(num(worstPlant['Utilisation %']), num(worstPlant['Target %'])) },
      { label: 'On-time delivery', value: pct(otd), foot: `Target ${f0(otdTarget)}%; last 30 days`, status: otd < otdTarget ? 'watch' : 'ok' },
      { label: 'Support within SLA', value: pct(sla, 0), foot: `Target ${f0(slaTarget)}%; ${f0(sum(queues, (q) => num(q['Open tickets'])))} tickets open`,
        status: gapStatus(num(worstQueue['SLA met % (last 30 days)']), num(worstQueue['Target %'])) },
      { label: 'Safety incidents, 30 days', value: String(safety30.length), foot: `${safety30.filter((i) => i.Status === 'Open').length} still open`,
        status: safety30.some((i) => i.Status === 'Open') ? 'watch' : 'ok' },
    ],
    tile: {
      kind: 'rings',
      rings: [{ label: 'Plants', value: pyRound(util), target: pyRound(utilTarget) }, { label: 'Logistics', value: pyRound(otd), target: pyRound(otdTarget) },
        { label: 'Support', value: pyRound(sla), target: pyRound(slaTarget) }],
      nums: [['Lowest plant', `${worstPlant.Plant.split(/\s+/)[0]} ${f0(num(worstPlant['Utilisation %']))}%`], ['Safety incidents', String(safety30.length)]],
    },
    sections: [
      { type: 'chart', title: 'Plant utilisation against target', chart: { kind: 'hbar', unit: '%', rows: plants.map((p) => ({ label: p.Plant, value: num(p['Utilisation %']), compare: num(p['Target %']) })), compare_label: 'target' } },
      { type: 'chart', title: 'Weekly output against plan', chart: { kind: 'columns', unit: 'tonnes', labels: weekly.map((w) => fmt(day(w['Week ending']), false)), values: weekly.map((w) => num(w['Output (tonnes)'])), compare: weekly.map((w) => num(w['Plan (tonnes)'])), compare_label: 'plan', min: 2000 } },
      {
        type: 'table', title: 'Logistics, last 30 days', columns: ['Lane', 'On time', 'Target', 'Shipments', 'Late'],
        rows: lanes.map((l) => [l.Lane, cell(`${f0(num(l['On-time delivery % (last 30 days)']))}%`, gapStatus(num(l['On-time delivery % (last 30 days)']), num(l['Target %']))),
          `${f0(num(l['Target %']))}%`, `${f0(num(l.Shipments))}`, `${f0(num(l.Delayed))}`]),
        source: src.chip('Logistics', 'all lanes', 'On-time delivery'),
      },
      {
        type: 'table', title: 'Support queues', columns: ['Queue', 'Open', 'Within SLA', 'Target', 'Oldest ticket'],
        rows: queues.map((q) => [q.Queue, `${f0(num(q['Open tickets']))}`, cell(`${f0(num(q['SLA met % (last 30 days)']))}%`, gapStatus(num(q['SLA met % (last 30 days)']), num(q['Target %']))),
          `${f0(num(q['Target %']))}%`, `${f0(num(q['Oldest open ticket (days)']))} days`]),
        source: src.chip('Support', 'all queues', 'Support SLA'),
      },
      {
        type: 'table', title: 'Incidents', columns: ['Date', 'Site', 'Type', 'Severity', 'What happened', 'Status'],
        rows: incidents.map((i) => [fmt(i._date), i.Site, i.Type, i.Severity, i.Description,
          cell(i.Status, i.Status === 'Closed' ? 'ok' : i.Severity === 'High' ? 'risk' : 'watch')]),
        source: src.chip('Incidents', 'all incidents', 'Incident log'),
      },
    ],
    flags,
    asks: ['What happened at Hosur Assembly?', 'Which plants are below target?', 'Why are warranty claims behind?'],
    calc: {
      average_plant_utilisation_pct: pyRound(util, 1), average_utilisation_target_pct: pyRound(utilTarget, 1),
      on_time_delivery_pct_last_30_days: pyRound(otd, 1), on_time_delivery_target_pct: otdTarget,
      support_within_sla_pct: pyRound(sla, 1), support_sla_target_pct: slaTarget,
      safety_incidents_last_30_days: safety30.length, last_week_output_vs_plan_pct: pyRound(outGap, 1),
    },
  };
}
