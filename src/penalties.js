// Delay-damage (penalty) calculator.
//
// The rules come from data/rules.json: one entry per rule in each project's agreement (Article or
// Section 9), extracted once and checked by a person. Dates come from the Milestones tab.
//
// The four steps for every rule:
//   1. weeks late       = whole weeks from due date to forecast, never below 0
//   2. chargeable weeks = weeks late - excluded weeks - grace period, never below 0
//   3. amount           = chargeable weeks x rate, no more than the rule's cap
//   4. project total    = sum of its rules, no more than the overall cap (10% of contract value for
//                         external contracts, Clause 9.2)
// Amounts are in ₹ crore and are ESTIMATES based on forecast dates.
import fs from 'node:fs';
import config from './config.js';
import { daysBetween, isoDay } from './dates.js';
import { toDay } from './data.js';

export const round4 = (x) => Math.round((x + Number.EPSILON) * 1e4) / 1e4;

export function weeksLate(due, forecast) {
  return Math.max(0, Math.floor(daysBetween(due, forecast) / 7));
}

/** -> [chargeable weeks, amount in ₹ crore] */
export function ruleAmount(weeks, grace, rate, cap, excluded = 0) {
  const chargeable = Math.max(0, weeks - excluded - Math.trunc(grace));
  return [chargeable, round4(Math.min(cap, chargeable * rate))];
}

let rulesCache = { path: null, mtime: null, value: null };
export function loadRules(file = config.RULES) {
  const mtime = fs.statSync(file).mtimeMs;
  if (rulesCache.path !== file || rulesCache.mtime !== mtime) {
    rulesCache = { path: file, mtime, value: JSON.parse(fs.readFileSync(file, 'utf8')) };
  }
  return rulesCache.value;
}

const finalDates = (p) => [
  p.milestones.map((m) => m.contract).reduce((a, b) => (b > a ? b : a)),
  p.milestones.map((m) => m.forecast).reduce((a, b) => (b > a ? b : a)),
];

export function assessRule(rule, project) {
  const link = rule.link;
  const res = {
    id: rule.id,
    applies_to: rule.applies_to,
    source: rule.source,
    rule_text: rule.rule_text,
    exclusions: rule.exclusions || '',
    assessable: true,
    due: null,
    forecast: null,
    weeks_late: 0,
    grace_weeks: rule.grace_weeks,
    excluded_weeks: 0,
    chargeable_weeks: 0,
    rate_cr_per_week: rule.rate_cr_per_week,
    cap_cr: rule.cap_cr,
    amount_cr: 0,
    at_cap: false,
    weeks_until_charging: null,
    milestone_key: null,
    note: '',
  };
  let due, fc, excluded = 0;
  if (link.type === 'milestone') {
    const m = project.milestone(link.key.split('|')[1]);
    if (!m) {
      res.assessable = false;
      res.note = `Milestone ${link.key} not found in the workbook.`;
      return res;
    }
    ({ revised: due, forecast: fc, excluded_weeks: excluded } = m);
    res.milestone_key = m.key;
  } else if (link.type === 'final') {
    [due, fc] = finalDates(project);
  } else if (link.type === 'reference') {
    const m = project.milestone(link.forecast_from.split('|')[1]);
    due = toDay(link.due_date);
    fc = m.forecast;
    res.milestone_key = m.key;
    res.note = `Due date is the ${link.due_label.toLowerCase()} stated in the agreement.`;
  } else {
    res.assessable = false;
    res.note = link.reason || 'Not assessable yet.';
    return res;
  }

  res.due = isoDay(due);
  res.forecast = isoDay(fc);
  res.weeks_late = weeksLate(due, fc);
  res.excluded_weeks = excluded;
  [res.chargeable_weeks, res.amount_cr] = ruleAmount(res.weeks_late, rule.grace_weeks, rule.rate_cr_per_week, rule.cap_cr, excluded);
  res.at_cap = res.amount_cr >= rule.cap_cr && rule.cap_cr > 0;
  if (res.chargeable_weeks === 0) {
    const daysNeeded = 7 * (Math.trunc(rule.grace_weeks) + excluded + 1) - daysBetween(due, fc);
    res.weeks_until_charging = Math.max(1, Math.ceil(daysNeeded / 7));
  }
  return res;
}

export function assessProject(project, rules = loadRules()) {
  const info = rules.projects[project.id];
  if (!info) {
    return { project: project.id, agreement: '', contract_value_cr: 0, rules: [], total_before_cap_cr: 0, aggregate_cap_cr: null, exposure_cr: 0 };
  }
  const list = rules.rules.filter((r) => r.project === project.id).map((r) => assessRule(r, project));
  const total = round4(list.reduce((s, r) => s + r.amount_cr, 0));
  let aggregate = null;
  let exposure = total;
  if (info.aggregate_cap_pct) {
    aggregate = round4((info.contract_value_cr * info.aggregate_cap_pct) / 100);
    exposure = Math.min(total, aggregate);
  }
  return {
    project: project.id,
    agreement: info.agreement,
    contract_value_cr: info.contract_value_cr,
    rules: list,
    total_before_cap_cr: total,
    aggregate_cap_cr: aggregate,
    exposure_cr: exposure,
  };
}
