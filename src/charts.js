// Builds the charts shown under Ask answers.
//
// Every number comes from the dashboard that code already calculated (the same figures the answer is based
// on). The assistant only chooses WHICH chart fits the question; it never supplies a value. Each chart also
// carries a table version of the same data.
//
// Chart types (the React app draws each one):
//   bars      ranked horizontal bars, one series
//   bullet    a bar with a marker for the target (progress against plan)
//   grouped   two bars per row (budget used against progress)
//   range     dates on a time axis (revised target to forecast)
//   segments  one whole split into parts (project health)
import { fmt } from './dates.js';
import { money } from './views.js';

export const CHART_KINDS = ['penalty', 'slip', 'progress', 'budget', 'timeline', 'health'];

const DAY = 864e5;
const day = (iso) => new Date(`${iso}T00:00:00Z`);
const weeksBetweenIso = (a, b) => Math.round((Date.parse(b) - Date.parse(a)) / DAY / 7) || 0;
const asOfText = (dash) => `As of ${fmt(day(dash.as_of))}`;
const plural = (n, w) => `${n} ${w}${n === 1 ? '' : 's'}`;

const WORKBOOK_NOTE = 'Source: project workbook';

// ------------------------------------------------------------------ portfolio charts
function penalty(dash, projects) {
  const rows = projects
    .filter((p) => p.penalty.exposure_cr > 0)
    .sort((a, b) => b.penalty.exposure_cr - a.penalty.exposure_cr)
    .map((p) => ({
      id: p.id,
      label: p.name,
      value: p.penalty.exposure_cr,
      detail: `${p.penalty.agreement} · ${plural(p.penalty.charging.length, 'rule')} charging`,
    }));
  if (rows.length < 2) return null;
  const total = rows.reduce((s, r) => s + r.value, 0);
  return {
    type: 'bars',
    id: 'penalty_by_project',
    title: 'Estimated penalty exposure by project',
    subtitle: `${money(Math.round(total * 1e4) / 1e4)} in total across ${rows.length} projects`,
    axis_caption: 'Estimated exposure, ₹ crore',
    value_name: 'Estimated exposure',
    unit: { prefix: '₹', suffix: ' Cr', decimals: 2 },
    axis_unit: { prefix: '', suffix: '' },
    rows,
    note: `Estimates based on forecast dates. ${asOfText(dash)}.`,
    table: {
      columns: ['Project', 'Agreement', 'Rules charging', 'Estimated exposure (₹ Cr)'],
      rows: rows.map((r) => {
        const p = projects.find((x) => x.id === r.id);
        return [r.label, p.penalty.agreement, p.penalty.charging.length, r.value];
      }),
    },
  };
}

function worstSlip(p) {
  let best = null;
  for (const ph of p.phases) {
    if (ph.ac >= 100) continue;
    const w = weeksBetweenIso(ph.revised, ph.forecast);
    if (w > 0 && (!best || w > best.weeks)) best = { weeks: w, phase: ph };
  }
  return best;
}

function slip(dash, projects) {
  const rows = projects
    .map((p) => ({ p, s: worstSlip(p) }))
    .filter((x) => x.s)
    .sort((a, b) => b.s.weeks - a.s.weeks)
    .slice(0, 10)
    .map(({ p, s }) => ({
      id: p.id,
      label: p.name,
      value: s.weeks,
      detail: `${s.phase.name}: target ${fmt(day(s.phase.revised))}, forecast ${fmt(day(s.phase.forecast))}`,
    }));
  if (rows.length < 2) return null;
  return {
    type: 'bars',
    id: 'slip_by_project',
    title: 'Forecast slip by project',
    subtitle: 'Weeks the latest open milestone is forecast after its revised target',
    unit: { prefix: '+', suffix: ' wks', decimals: 0 },
    axis_unit: { prefix: '', suffix: '' },
    axis_caption: 'Weeks after the revised target',
    value_name: 'Forecast slip',
    rows,
    note: `${WORKBOOK_NOTE}, Milestones tab. ${asOfText(dash)}.`,
    table: {
      columns: ['Project', 'Milestone', 'Revised target', 'Forecast', 'Slip (weeks)'],
      rows: rows.map((r) => {
        const p = projects.find((x) => x.id === r.id);
        const ph = worstSlip(p).phase;
        return [r.label, ph.name, fmt(day(ph.revised)), fmt(day(ph.forecast)), r.value];
      }),
    },
  };
}

function progress(dash, projects) {
  const rows = projects
    .map((p) => ({ id: p.id, label: p.name, value: p.ac, target: p.pl, gap: p.pl - p.ac }))
    .sort((a, b) => b.gap - a.gap)
    .map((r) => ({
      ...r,
      detail: r.gap > 0 ? `${r.gap} points behind plan` : r.gap < 0 ? `${-r.gap} points ahead of plan` : 'On plan',
    }));
  if (rows.length < 2) return null;
  return {
    type: 'bullet',
    id: 'progress_vs_plan',
    title: 'Progress against plan',
    subtitle: 'Percent complete today, with the planned percent marked · most behind first',
    unit: { prefix: '', suffix: '%', decimals: 0 },
    axis_unit: { prefix: '', suffix: '%' },
    axis_max: 100,
    rows,
    note: `${WORKBOOK_NOTE}, Projects tab. ${asOfText(dash)}.`,
    table: {
      columns: ['Project', 'Progress (%)', 'Plan (%)', 'Gap (points)'],
      rows: rows.map((r) => [r.label, r.value, r.target, r.gap]),
    },
  };
}

function budget(dash, projects) {
  const rows = projects
    .map((p) => ({ id: p.id, label: p.name, values: [p.ac, p.budget.used], gap: p.budget.used - p.ac, cr: p.budget.cr }))
    .sort((a, b) => b.gap - a.gap)
    .slice(0, 10)
    .map((r) => ({
      id: r.id,
      label: r.label,
      values: r.values,
      detail: `${r.gap >= 0 ? `${r.gap} points ahead of progress` : `${-r.gap} points behind progress`} · budget ${money(r.cr)}`,
      gap: r.gap,
    }));
  if (rows.length < 2) return null;
  return {
    type: 'grouped',
    id: 'budget_vs_progress',
    title: 'Budget used against progress',
    subtitle: 'Spending ahead of progress is a warning sign · biggest gap first',
    series: [{ key: 'progress', name: 'Progress' }, { key: 'budget', name: 'Budget used' }],
    unit: { prefix: '', suffix: '%', decimals: 0 },
    axis_unit: { prefix: '', suffix: '%' },
    axis_max: 100,
    rows,
    note: `${WORKBOOK_NOTE}, Projects and Project Updates tabs. ${asOfText(dash)}.`,
    table: {
      columns: ['Project', 'Progress (%)', 'Budget used (%)', 'Gap (points)', 'Budget (₹ Cr)'],
      rows: rows.map((r) => [r.label, r.values[0], r.values[1], r.gap, projects.find((p) => p.id === r.id).budget.cr]),
    },
  };
}

function health(dash, projects) {
  const defs = [
    ['risk', 'At risk'],
    ['watch', 'Watch'],
    ['ok', 'On track'],
  ];
  const parts = defs
    .map(([key, label]) => {
      const names = projects.filter((p) => p.health === key).map((p) => p.name);
      return { key, label, value: names.length, names };
    })
    .filter((p) => p.value > 0);
  if (!parts.length) return null;
  return {
    type: 'segments',
    id: 'project_health',
    title: 'Project health',
    subtitle: `${plural(projects.length, 'project')} in the portfolio`,
    parts,
    note: `${WORKBOOK_NOTE}, Projects tab (Health column). ${asOfText(dash)}.`,
    table: { columns: ['Health', 'Projects', 'Names'], rows: parts.map((p) => [p.label, p.value, p.names.join(', ')]) },
  };
}

// ------------------------------------------------------------------ one-project charts
function rules(dash, p) {
  const rows = p.penalty.charging.map((r) => ({
    id: r.id,
    label: `${r.id} · ${r.applies_to}`,
    value: r.amount_cr,
    detail: `${r.weeks_late} weeks late, ${r.chargeable_weeks} beyond the grace period`,
  }));
  if (rows.length < 2) return null;
  return {
    type: 'bars',
    id: 'penalty_rules',
    title: `${p.name}: penalty by rule`,
    subtitle: `${money(p.penalty.exposure_cr)} estimated exposure under ${p.penalty.agreement}`,
    axis_caption: 'Amount, ₹ crore',
    value_name: 'Estimated amount',
    unit: { prefix: '₹', suffix: ' Cr', decimals: 2 },
    axis_unit: { prefix: '', suffix: '' },
    rows,
    note: `Estimates based on forecast dates. ${asOfText(dash)}.`,
    table: {
      columns: ['Rule', 'Applies to', 'Weeks late', 'Chargeable weeks', 'Amount (₹ Cr)'],
      rows: p.penalty.charging.map((r) => [r.id, r.applies_to, r.weeks_late, r.chargeable_weeks, r.amount_cr]),
    },
  };
}

function timeline(dash, p) {
  const rows = p.phases.map((ph) => ({
    id: ph.name,
    label: ph.name,
    from: ph.revised,
    to: ph.forecast,
    slip_weeks: weeksBetweenIso(ph.revised, ph.forecast),
    progress: ph.ac,
    detail: ph.scope,
  }));
  if (!rows.length) return null;
  return {
    type: 'range',
    id: 'milestone_dates',
    title: `${p.name}: milestone dates`,
    subtitle: 'Revised target and current forecast for each phase',
    rows,
    today: dash.as_of,
    note: `${WORKBOOK_NOTE}, Milestones tab. ${asOfText(dash)}.`,
    table: {
      columns: ['Phase', 'Revised target', 'Forecast', 'Slip (weeks)', 'Progress (%)'],
      rows: rows.map((r) => [r.label, fmt(day(r.from)), fmt(day(r.to)), r.slip_weeks, r.progress]),
    },
  };
}

// ------------------------------------------------------------------ choosing
const DETECT = [
  ['penalty', /penalt|exposure|damages|liquidated|\bcap\b|\bsla\b/],
  ['budget', /budget|overrun|overspen|spend|cost/],
  ['health', /at[- ]risk|health|status|how many|\bred\b|amber/],
  ['progress', /progress|percent|% complete|ahead of plan|behind plan|\bplan\b|on track|complete/],
  ['slip', /late|delay|slip|behind|miss|schedule|milestone|forecast|week|deadline|handover|date/],
];

const detect = (q) => DETECT.find(([, re]) => re.test(q.toLowerCase()))?.[0] ?? null;

/**
 * Returns the chart for an answer, or null.
 *   hint  : { type, projects } chosen by the assistant (type "none" means no chart); optional
 *   pids  : projects named in the question
 */
export function chooseChart(dash, { hint, question = '', pids = [] } = {}) {
  let kind;
  if (hint && typeof hint.type === 'string') {
    if (hint.type === 'none') return null;
    kind = CHART_KINDS.includes(hint.type) ? hint.type : detect(question);
  } else {
    kind = detect(question);
  }
  if (!kind) return null;

  const known = new Set(dash.projects.map((p) => p.id));
  const hinted = Array.isArray(hint?.projects) ? hint.projects.filter((id) => known.has(id)) : [];
  const ids = hinted.length ? hinted : pids;
  const pick = ids.length ? dash.projects.filter((p) => ids.includes(p.id)) : dash.projects;

  // One project: show its own detail (penalty rules, or milestone dates).
  if (pick.length === 1) return kind === 'penalty' ? rules(dash, pick[0]) ?? timeline(dash, pick[0]) : timeline(dash, pick[0]);
  // Several or all projects: compare them. Never swap in a chart about other projects than the ones asked about.
  return { penalty, slip, progress, budget, health }[kind](dash, pick);
}
