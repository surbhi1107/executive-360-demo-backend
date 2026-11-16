// Turns the loaded data into what the dashboard shows: project cards, the portfolio summary and flags.
// Every number is calculated here in code. The assistant only explains these results.
import fs from 'node:fs';
import path from 'node:path';
import config from './config.js';
import { assessProject, loadRules, round4 } from './penalties.js';
import { daysBetween, dMonHhmm, dMonYearHhmm, fmt, floorDay, hhmm, isoDay, pad } from './dates.js';

const STATUS_WORD = { risk: 'At risk', watch: 'Watch', ok: 'On track' };
const SEV_ORDER = { risk: 0, watch: 1 };
const TYPE_ORDER = { missed: 0, sla: 1, forecast: 2, budget: 3, confirm: 4, internal: 5, stale: 6 };
const FLAG_LABEL = {
  sla: 'SLA / penalty risk', forecast: 'Will miss milestone', missed: 'Milestone missed', stale: 'Data not updated',
  budget: 'Budget running ahead', internal: 'Buffer being used', confirm: 'Progress not confirmed',
};
const CONFIRM_WORD = { confirmed: 'Confirmed', gap: 'Confirmed lower', stale: 'Confirmation out of date', none: 'Not confirmed', na: 'Not started' };

// ------------------------------------------------------------------ small helpers
export function money(v) {
  // toFixed rounds the exact binary value , so 0.145 shows as 0.14 and the figures match the original app exactly.
  const [whole, frac] = Math.abs(v).toFixed(2).split('.');
  const s = `${v < 0 ? '-' : ''}${whole.replace(/\B(?=(\d{3})+(?!\d))/g, ',')}.${frac}`;
  return `₹${s} Cr`.replace('.00 Cr', ' Cr');
}

/** Rounded weeks from a to b (negative if b is earlier). */
export const weeksBetween = (a, b) => Math.round(daysBetween(a, b) / 7) || 0;

function person(lead) {
  const s = String(lead ?? '');
  if (s.includes('(')) {
    const i = s.indexOf('(');
    return [s.slice(0, i).trim(), s.slice(i + 1).replace(/\)+$/, '').trim()];
  }
  return [s.trim(), 'Project lead'];
}

function relTime(ts, today) {
  if (!ts) return 'Never';
  const days = daysBetween(floorDay(ts), today);
  const t = hhmm(ts);
  if (days <= 0) return `Today, ${t}`;
  if (days === 1) return `Yesterday, ${t}`;
  return `${days} days ago`;
}

const xlSource = (sheet, locator, usedFor, record = []) => ({
  kind: 'excel',
  ref: 'workbook',
  name: path.basename(config.WORKBOOK),
  locator: `${sheet} · ${locator}`,
  used_for: usedFor,
  record,
});

function docSource(pen, locator, usedFor, excerpt = '') {
  const files = {};
  if (fs.existsSync(config.AGREEMENTS_DIR)) {
    for (const f of fs.readdirSync(config.AGREEMENTS_DIR)) if (/^E360-.*\.docx$/.test(f)) files[f.split('_')[0]] = f;
  }
  return { kind: 'word', ref: pen.agreement, name: files[pen.agreement] ?? `${pen.agreement}.docx`, locator, used_for: usedFor, excerpt };
}

/** Where a milestone stands on formal confirmation of its progress by the responsible department. */
export function confirmation(m, today) {
  const days = m.confirmed_on ? daysBetween(m.confirmed_on, today) : null;
  const gap = m.confirmed_pct !== null ? m.progress - m.confirmed_pct : null;
  let status;
  if (m.progress === 0 && m.confirmed_pct === null) status = 'na';
  else if (m.confirmed_pct === null) status = 'none';
  else if (gap >= config.CONFIRM_GAP) status = 'gap';
  else if (m.progress < 100 && days !== null && days > config.CONFIRM_DAYS) status = 'stale';
  else status = 'confirmed';
  return { pct: m.confirmed_pct, by: m.confirmed_by, on: m.confirmed_on ? isoDay(m.confirmed_on) : null, days, gap, status, word: CONFIRM_WORD[status] };
}

const milestoneRecord = (m) => [
  ['Phase', m.phase],
  ['Scope', m.scope],
  ['Internal target', fmt(m.internal)],
  ['Revised target', fmt(m.revised)],
  ['Forecast', fmt(m.forecast)],
  ['Progress', `${m.progress}%`],
  ['Status', STATUS_WORD[m.status]],
];

const maxDay = (list) => list.reduce((a, b) => (b > a ? b : a));
const plural = (n, word = '') => (n === 1 ? word : 's');

// ------------------------------------------------------------------ per-project figures
export function projectFigures(p, today, rules) {
  const pen = assessProject(p, rules);
  const whatIf = Object.fromEntries([2, 4, 8].map((w) => [w, assessProject(p, rules, 7 * w).exposure_cr]));
  const nxt = p.milestone(p.next_phase) ?? p.milestones[0] ?? null;
  const open = p.milestones.filter((m) => m.progress < 100);
  const finalContract = maxDay(p.milestones.map((m) => m.contract));
  const finalForecast = maxDay(p.milestones.map((m) => m.forecast));
  const daysSince = p.last_updated ? daysBetween(floorDay(p.last_updated), today) : null;
  return {
    penalty: pen,
    what_if: whatIf,
    next: nxt,
    open,
    next_slip: nxt ? Math.max(0, weeksBetween(nxt.revised, nxt.forecast)) : 0,
    next_missed: Boolean(nxt && nxt.revised < today && nxt.progress < 100),
    final_contract: finalContract,
    final_forecast: finalForecast,
    days_since_update: daysSince,
    stale: daysSince !== null && daysSince >= config.STALE_DAYS,
    budget_gap: p.budget_used - p.progress,
  };
}

export function projectView(p, f, today) {
  const pen = f.penalty;
  const nxt = f.next;
  const [name, role] = person(p.lead);
  const charging = pen.rules.filter((r) => r.amount_cr > 0);
  const idx = p.milestones.findIndex((m) => m.phase === p.next_phase);
  const focus = idx >= 0 ? idx + 1 : 1;
  const finalVar = weeksBetween(f.final_contract, f.final_forecast);
  return {
    id: p.id,
    name: p.name,
    type: p.sector,
    where: p.scale,
    client: p.client,
    internal: p.internal,
    pm: `${name} · ${role}`,
    health: p.health,
    stage: p.stage,
    pl: p.plan,
    ac: p.progress,
    next: { label: p.next_label, phase: nxt.phase, date: isoDay(nxt.revised), forecast: isoDay(nxt.forecast), slip_weeks: f.next_slip, missed: f.next_missed },
    updated: {
      rel: relTime(p.last_updated, today),
      when: p.last_updated ? dMonHhmm(p.last_updated).replace(/^0+/, '') : '',
      by: p.updated_by,
      stale: f.stale,
      days: f.days_since_update,
    },
    budget: { cr: p.budget_cr, used: p.budget_used, gap_points: f.budget_gap },
    final: { contract: isoDay(f.final_contract), forecast: isoDay(f.final_forecast), variance_weeks: finalVar },
    penalty: {
      exposure_cr: pen.exposure_cr,
      agreement: pen.agreement,
      aggregate_cap_cr: pen.aggregate_cap_cr,
      if_all_forecasts_slip_further: Object.fromEntries(Object.entries(f.what_if).map(([w, v]) => [`${w}_weeks`, v])),
      charging: charging.map((r) => ({
        id: r.id, applies_to: r.applies_to, weeks_late: r.weeks_late, chargeable_weeks: r.chargeable_weeks, amount_cr: r.amount_cr, source: r.source,
      })),
      near: pen.rules.filter((r) => r.weeks_until_charging === 1).map((r) => ({ id: r.id, applies_to: r.applies_to, rate_cr_per_week: r.rate_cr_per_week })),
    },
    kpis: [
      ['Progress', `${p.progress}%`, `${p.plan}% planned by today`],
      ['Next milestone', fmt(nxt.revised, false), `${p.next_label} · forecast ${fmt(nxt.forecast, false)}`],
      [
        'Penalty exposure',
        pen.exposure_cr ? money(pen.exposure_cr) : 'None',
        charging.length ? `${charging.length} rule${plural(charging.length)} charging · ${pen.agreement}` : `No rules charging · ${pen.agreement}`,
      ],
      ['Final handover', fmt(f.final_forecast), `Contract ${fmt(f.final_contract)}`],
    ],
    phases: p.milestones.map((m, i) => ({
      n: i + 1, name: m.phase, scope: m.scope, contract: isoDay(m.contract), revised: isoDay(m.revised), forecast: isoDay(m.forecast),
      internal: isoDay(m.internal), buffer_days_left: daysBetween(m.forecast, m.revised),
      status: m.status, ac: m.progress, confirmed: confirmation(m, today), start: isoDay(m.plan_start), end: isoDay(m.plan_end),
    })),
    stage_progress: Object.fromEntries(Object.entries(p.stages).map(([k, v]) => [k, [v.done, v.plan]])),
    focus,
    reasons: p.reasons.map((r) => `${fmt(r.date)}: ${r.reason} (${r.by})`),
    asks: [
      p.health !== 'ok' ? `Why is ${p.name} behind?` : `Is ${p.name} on track?`,
      `What is the penalty exposure on ${p.name}?`,
      `What happens if ${p.name} slips another month?`,
    ],
  };
}

// ------------------------------------------------------------------ flags
/** First item with the largest key (ties keep the earlier one). */
const maxBy = (list, key) => list.reduce((best, x) => (key(x) > key(best) ? x : best));

export function buildFlags(p, f, today) {
  const flags = [];
  const [name, role] = person(p.lead);
  const first = name.split(/\s+/)[0];
  const pen = f.penalty;
  const nxt = f.next;
  const ceo = config.CEO_NAME;
  const reasons = p.reasons.map((r) => r.reason).slice(-2);
  const cause = reasons.length ? ` Reported causes: ${reasons.join('; ').toLowerCase()}.` : '';
  const msSrc = (m, used) => xlSource('Milestones', `${p.id} · ${m.phase} (row ${m.row})`, used, milestoneRecord(m));

  // 1. Milestone missed
  if (f.next_missed) {
    const lateDays = daysBetween(nxt.revised, today);
    flags.push({
      id: `missed-${p.id}`, type: 'missed', sev: 'risk', proj: p.id,
      title: `${p.name}: ${p.next_label.toLowerCase()} milestone missed on ${fmt(nxt.revised, false)}`,
      body: `${nxt.phase} (${nxt.scope}) was due on ${fmt(nxt.revised)} and is ${nxt.progress}% complete. The team now expects it on ${fmt(nxt.forecast)}.${cause}`,
      impacts: [`${lateDays} days late`, `Forecast ${fmt(nxt.forecast, false)}`, `Owner: ${name}`],
      evidence: `Revised target ${fmt(nxt.revised)}; forecast ${fmt(nxt.forecast)}; ${nxt.progress}% complete.`,
      sources: [msSrc(nxt, 'The missed milestone and its forecast')],
      suggest: [
        `Ask ${name} for a recovery plan with dates this week.`,
        'Check whether the cause qualifies for an extension of time under the agreement, and notify within 14 days if so.',
        'Prepare the client or sponsor for the new date before they hear it elsewhere.',
      ],
      call: { who: `${name} · ${role}`, slot: 'Today, 17:00 · 15 min', agenda: `${nxt.phase} recovery plan and new date.` },
      email: {
        to: name,
        subject: `${p.name}: recovery plan for ${nxt.phase}`,
        body: `${first},\n\n${nxt.phase} on ${p.name} was due on ${fmt(nxt.revised)} and is now forecast for ${fmt(nxt.forecast)}.\n\nPlease send me a recovery plan by Wednesday with the actions, owners and the date you can commit to.\n\n${ceo}`,
      },
      auto: {
        allowed: true,
        text: `Ask ${name} for a daily status update until ${nxt.phase} is complete, and alert you if the forecast moves again.`,
        done: `Daily status check-in with ${name} set up at {t}. You will be alerted if the forecast moves.`,
      },
      approval: `Send a recovery-plan request to ${name}, copied to the project's client or sponsor contact.`,
    });
  }

  // 2. Will miss a milestone (forecast slip): the first open milestone that is late enough
  const late = f.open.filter((m) => weeksBetween(m.revised, m.forecast) >= config.SLIP_WEEKS && !(f.next_missed && m === nxt));
  if (late.length) {
    const m = late[0];
    const w = weeksBetween(m.revised, m.forecast);
    flags.push({
      id: `forecast-${p.id}`, type: 'forecast', sev: w >= 4 ? 'risk' : 'watch', proj: p.id,
      title: `${p.name}: ${m.phase} will miss its ${fmt(m.revised, false)} target by about ${w} weeks`,
      body: `${m.scope}: ${m.progress}% complete, forecast ${fmt(m.forecast)}.${cause}`,
      impacts: [`+${w} weeks`, `${m.progress}% complete`, ...(late.length > 1 ? [`${late.length - 1} more milestone${late.length > 2 ? 's' : ''} slipping`] : [])],
      evidence: `Revised target ${fmt(m.revised)}; forecast ${fmt(m.forecast)}.`,
      sources: [msSrc(m, 'Target and forecast for this milestone')],
      suggest: [
        `Ask ${name} what would bring ${m.phase} back to ${fmt(m.revised, false)}: extra crew, parallel work or re-sequencing.`,
        'Check whether any of the delay is caused by the client, authorities or weather and can be claimed as an extension of time.',
        'Agree a firm recovery date and track it weekly.',
      ],
      call: { who: `${name} · ${role}`, slot: 'Tomorrow, 10:00 · 20 min', agenda: `Options to recover ${m.phase}.` },
      email: {
        to: name,
        subject: `${p.name}: options to recover ${m.phase}`,
        body: `${first},\n\n${m.phase} is forecast for ${fmt(m.forecast)}, about ${w} weeks after its ${fmt(m.revised)} target.\n\nPlease bring me the options to recover the time, with cost and effect on the date for each, by Friday.\n\n${ceo}`,
      },
      auto: {
        allowed: true,
        text: `Ask ${name} for a weekly recovery update on ${m.phase} and alert you if the forecast slips further.`,
        done: `Weekly recovery update requested from ${name} at {t}.`,
      },
      approval: `Send the recovery-options request to ${name}.`,
    });
  }

  // 2b. Early warning: forecast is past the internal target but still inside the buffer (not late yet)
  const eating = f.open.filter(
    (m) => m.internal < m.forecast && weeksBetween(m.revised, m.forecast) < config.SLIP_WEEKS && !(f.next_missed && m === nxt),
  );
  if (eating.length) {
    const m = eating.reduce((a, b) => (daysBetween(b.forecast, b.revised) < daysBetween(a.forecast, a.revised) ? b : a));
    const left = daysBetween(m.forecast, m.revised);
    const used = daysBetween(m.internal, m.forecast);
    flags.push({
      id: `internal-${p.id}`, type: 'internal', sev: 'watch', proj: p.id,
      title: `${p.name}: ${m.phase} ${m.internal < today ? 'has missed' : 'will miss'} its internal target of ${fmt(m.internal, false)}; ` +
        (left > 0 ? `${left} days of buffer left` : 'the buffer is used up'),
      body: `${m.scope}: ${m.progress}% complete. Internal target ${fmt(m.internal)}, forecast ${fmt(m.forecast)}, committed date ${fmt(m.revised)}. ` +
        `The forecast is ${used} days past the internal target` + (left > 0 ? `, leaving ${left} days before the committed date.` : ' and has reached the committed date.'),
      impacts: [`${used} days of buffer used`, `${Math.max(left, 0)} days left`, `${m.progress}% complete`,
        ...(eating.length > 1 ? [`${eating.length - 1} more milestone${eating.length > 2 ? 's' : ''}`] : [])],
      evidence: `Internal target ${fmt(m.internal)}; forecast ${fmt(m.forecast)}; committed (revised) date ${fmt(m.revised)}.`,
      sources: [msSrc(m, 'Internal target, forecast and committed date')],
      suggest: [
        `Ask ${name} what is using up the buffer and whether it can be recovered.`,
        'Act now while it is cheap: no penalty applies until the committed date is passed.',
        'Check that the forecast is realistic, so the remaining buffer is real.',
      ],
      call: { who: `${name} · ${role}`, slot: 'Tomorrow, 10:30 · 15 min', agenda: `${m.phase}: protecting the remaining buffer.` },
      email: {
        to: name,
        subject: `${p.name}: ${m.phase} is using its buffer`,
        body: `${first},\n\n${m.phase} on ${p.name} is forecast for ${fmt(m.forecast)}, past our internal target of ${fmt(m.internal)}. ` +
          `We have ${Math.max(left, 0)} days left before the committed date of ${fmt(m.revised)}.\n\nPlease tell me what is using the buffer and what you will do to protect the committed date.\n\n${ceo}`,
      },
      auto: {
        allowed: true,
        text: `Ask ${name} for a weekly update on ${m.phase} and alert you if the remaining buffer falls below one week.`,
        done: `Weekly buffer check with ${name} set up at {t}.`,
      },
      approval: `Send the buffer question to ${name}.`,
    });
  }

  // 3. Penalty exposure, or penalties about to start
  const charging = pen.rules.filter((r) => r.amount_cr > 0);
  if (charging.length) {
    const worst = maxBy(charging, (r) => r.amount_cr);
    const tail = worst.source.split(', ').pop();
    flags.push({
      id: `sla-${p.id}`, type: 'sla', sev: 'risk', proj: p.id,
      title: `${p.name}: estimated penalty exposure of ${money(pen.exposure_cr)}`,
      body: 'At current forecasts, ' + charging.map((r) => `${r.id} (${r.applies_to}) is ${r.weeks_late} weeks late, ${r.chargeable_weeks} beyond grace: ${money(r.amount_cr)}`).join('; ') + '.',
      impacts: [`${money(pen.exposure_cr)} estimated`, `${charging.length} rule${charging.length > 1 ? 's' : ''} charging`, ...(charging.some((r) => r.at_cap) ? ['At cap'] : [])],
      evidence: `Rules in ${pen.agreement}, Article or Section 9. Exclusions: ${worst.exclusions || 'none stated'}`,
      sources: [
        docSource(pen, `${tail} · ${worst.id}`, 'Rate, grace period and cap', worst.rule_text),
        ...(worst.milestone_key ? [msSrc(p.milestone(worst.milestone_key.split('|')[1]), 'Due and forecast dates')] : []),
      ],
      suggest: [
        `Recover enough time on ${worst.applies_to.toLowerCase()} to get back inside the ${Math.trunc(worst.grace_weeks)}-week grace period.`,
        'If any delay was caused by the client, authorities or weather, file an extension-of-time notice within 14 days (Clause 8.2).',
        `Check the exclusions in the agreement: ${worst.exclusions || 'none stated'}`,
      ],
      call: { who: `${name} · ${role}`, slot: 'Today, 16:00 · 30 min', agenda: 'Penalty exposure, recovery options and possible extension-of-time claim.' },
      email: {
        to: name,
        subject: `${p.name}: penalty exposure ${money(pen.exposure_cr)}`,
        body: `${first},\n\nAt current forecasts ${p.name} carries an estimated ${money(pen.exposure_cr)} in delay damages under ${pen.agreement}.\n\nBy Wednesday, please send me (1) a recovery plan to get back inside the grace periods and (2) any delays we can claim as an extension of time.\n\n${ceo}`,
      },
      auto: { allowed: false, reason: 'Not available for this flag: it involves money and the client, so it needs your decision.' },
      approval: 'Prepare an extension-of-time notice and a recovery plan for your review before anything goes to the client.',
    });
  } else {
    const near = pen.rules.filter((r) => r.weeks_until_charging === 1);
    if (near.length) {
      const biggest = maxBy(near, (r) => r.rate_cr_per_week);
      const tail = biggest.source.split(', ').pop();
      flags.push({
        id: `sla-${p.id}`, type: 'sla', sev: 'watch', proj: p.id,
        title: `${p.name}: one more week of slip starts penalties`,
        body: 'These rules are at the edge of their grace period: ' + near.map((r) => `${r.id} (${r.applies_to}), ${money(r.rate_cr_per_week)} a week`).join('; ') + '.',
        impacts: [`Up to ${money(near.reduce((s, r) => s + r.rate_cr_per_week, 0))} a week`, `${near.length} rule${near.length > 1 ? 's' : ''}`],
        evidence: `Rules in ${pen.agreement}, Article or Section 9.`,
        sources: [docSource(pen, `${tail} · ${biggest.id}`, 'Grace period and rate', biggest.rule_text)],
        suggest: [
          `Protect the dates on ${near.slice(0, 2).map((r) => r.applies_to.toLowerCase()).join(', ')}: no further slip.`,
          'Ask for a weekly forecast check on these milestones until they are complete.',
        ],
        call: { who: `${name} · ${role}`, slot: 'Tomorrow, 9:30 · 15 min', agenda: 'Milestones at the edge of their grace period.' },
        email: {
          to: name,
          subject: `${p.name}: no further slip on milestones at the penalty threshold`,
          body: `${first},\n\nSome milestones on ${p.name} are one week from penalties starting under ${pen.agreement}. Please confirm the actions protecting their dates.\n\n${ceo}`,
        },
        auto: { allowed: true, text: "Check these milestones' forecasts every day and alert you the moment any of them moves.", done: 'Daily forecast watch set up at {t}.' },
        approval: `Send the date-protection request to ${name}.`,
      });
    }
  }

  // 4. Budget running ahead of progress
  if (f.budget_gap >= config.BUDGET_GAP_POINTS) {
    flags.push({
      id: `budget-${p.id}`, type: 'budget', sev: f.budget_gap >= 15 ? 'risk' : 'watch', proj: p.id,
      title: `${p.name}: ${p.budget_used}% of budget used at ${p.progress}% progress`,
      body: `Spending is ${f.budget_gap} points ahead of progress on a ${money(p.budget_cr)} budget. At this rate the project may overrun before completion.`,
      impacts: [`${f.budget_gap} points ahead`, `Budget ${money(p.budget_cr)}`],
      evidence: `Budget used ${p.budget_used}%; progress ${p.progress}%.`,
      sources: [
        xlSource('Project Updates', `${p.id} (row ${p.update_row})`, 'Budget used', [['Budget', money(p.budget_cr)], ['Budget used', `${p.budget_used}%`]]),
        xlSource('Projects', `${p.id} (row ${p.row})`, 'Progress', [['Progress', `${p.progress}%`], ['Plan', `${p.plan}%`]]),
      ],
      suggest: [
        'Ask for a cost-to-complete forecast with the main drivers of the overspend.',
        'Check for rework, change orders or variations not yet approved or recovered.',
        'Decide whether to release contingency or reduce scope.',
      ],
      call: { who: `${name} · ${role}`, slot: 'Tomorrow, 11:00 · 20 min', agenda: 'Cost to complete and overspend drivers.' },
      email: {
        to: name,
        subject: `${p.name}: cost-to-complete forecast`,
        body: `${first},\n\n${p.name} has used ${p.budget_used}% of its budget at ${p.progress}% progress. Please send me a cost-to-complete forecast and the main drivers by Friday.\n\n${ceo}`,
      },
      auto: {
        allowed: true,
        text: `Ask ${name} for a cost-to-complete forecast and add it to next week's review.`,
        done: `Cost-to-complete request sent to ${name} at {t}.`,
      },
      approval: `Send the cost-to-complete request to ${name}.`,
    });
  }

  // 3b. Reported progress that the responsible department has not confirmed (one flag per project, the worst case)
  const rank = { gap: 2, none: 1, stale: 0 };
  const unconfirmed = p.milestones.map((m) => [m, confirmation(m, today)]).filter(([, c]) => ['gap', 'none', 'stale'].includes(c.status));
  if (unconfirmed.length) {
    const key = ([, c]) => [rank[c.status], c.gap ?? 0, c.days ?? 0];
    const cmp = (a, b) => { const x = key(a), y = key(b); for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] - y[i]; return 0; };
    const [m, c] = unconfirmed.reduce((best, x) => (cmp(x, best) > 0 ? x : best));
    const at = c.by.indexOf(' · ');
    const deptName = at < 0 ? c.by : c.by.slice(0, at);
    const personName = at < 0 ? '' : c.by.slice(at + 3);
    const who = personName || name;
    let title, body, impacts;
    if (c.status === 'gap') {
      title = `${p.name}: ${m.phase} is reported ${m.progress}% complete but only ${c.pct}% is confirmed`;
      body = `${m.scope}: the project team reports ${m.progress}%. ${deptName} confirmed ${c.pct}% on ${fmt(m.confirmed_on)}, ` +
        `a difference of ${c.gap} points. Forecasts and penalties on this page use the reported figure.`;
      impacts = [`${c.gap} points unconfirmed`, `Confirmed ${c.pct}%`, `By: ${deptName}`];
    } else if (c.status === 'none') {
      title = `${p.name}: ${m.phase} progress of ${m.progress}% has not been confirmed by any department`;
      body = `${m.scope}: the project team reports ${m.progress}% but no department has confirmed it.`;
      impacts = [`Reported ${m.progress}%`, 'No confirmation'];
    } else {
      title = `${p.name}: ${m.phase} progress was last confirmed ${c.days} days ago`;
      body = `${m.scope}: ${deptName} last confirmed progress (${c.pct}%) on ${fmt(m.confirmed_on)}. ` +
        `The team now reports ${m.progress}%. Confirmation is expected at least every ${config.CONFIRM_DAYS} days.`;
      impacts = [`${c.days} days since confirmation`, `Confirmed ${c.pct}%`, `By: ${deptName}`];
    }
    flags.push({
      id: `confirm-${p.id}`, type: 'confirm', sev: (c.gap ?? 0) >= 2 * config.CONFIRM_GAP ? 'risk' : 'watch', proj: p.id,
      title, body,
      impacts: [...impacts, ...(unconfirmed.length > 1 ? [`${unconfirmed.length - 1} more milestone${unconfirmed.length > 2 ? 's' : ''}`] : [])],
      evidence: `Reported ${m.progress}%; confirmed ${c.pct !== null ? c.pct : 'nothing'}` + (m.confirmed_on ? ` by ${c.by} on ${fmt(m.confirmed_on)}.` : '.'),
      sources: [msSrc(m, 'Reported progress, confirmed progress, who confirmed and when')],
      suggest: [
        `Ask ${who} to inspect and confirm ${m.phase} this week.`,
        `Ask ${name} why the reported figure is ahead of what has been confirmed.`,
        'Until it is confirmed, treat the forecast date for this milestone with caution.',
      ],
      call: { who: `${who} · ${deptName || role}`, slot: 'Tomorrow, 11:30 · 15 min', agenda: `Confirming progress on ${p.name} ${m.phase}.` },
      email: {
        to: who,
        subject: `${p.name}: please confirm progress on ${m.phase}`,
        body: `${who.split(/\s+/)[0]},\n\n${body}\n\nPlease inspect and confirm the current progress by Wednesday, and tell me if you disagree with the reported figure.\n\n${ceo}`,
      },
      auto: {
        allowed: true,
        text: `Ask ${who} to confirm progress on ${m.phase} and remind them every two days until it is done.`,
        done: `Confirmation request sent to ${who} at {t}, with reminders every two days.`,
      },
      approval: `Send the confirmation request to ${who}.`,
    });
  }

  // 5. Schedule not updated
  if (f.stale) {
    const d = f.days_since_update;
    const lastDay = floorDay(p.last_updated);
    const updaterFirst = String(p.updated_by).split(/\s+/)[0];
    flags.push({
      id: `stale-${p.id}`, type: 'stale', sev: d >= 7 ? 'risk' : 'watch', proj: p.id,
      title: `${p.name}: schedule not updated for ${d} days`,
      body: `${p.updated_by} last updated the schedule on ${fmt(lastDay)} at ${hhmm(p.last_updated)}. The agreement requires a daily update, so progress and forecasts here may be out of date.`,
      impacts: [`${d} days old`, `Owner: ${p.updated_by}`],
      evidence: 'Agreement Clause 6.3 (or 6.2): the master schedule is updated every working day by 19:00.',
      sources: [xlSource('Project Updates', `${p.id} (row ${p.update_row})`, 'When the schedule was last updated', [['Last updated', dMonYearHhmm(p.last_updated)], ['Updated by', p.updated_by]])],
      suggest: [
        `Send ${p.updated_by} a reminder now and check again this evening.`,
        `Escalate to ${name} if it is still not updated tomorrow morning.`,
        'Agree a named backup for schedule updates.',
      ],
      call: { who: `${p.updated_by} · Schedule owner`, slot: 'Today, 15:30 · 10 min', agenda: 'What is blocking updates; agree a daily time and a backup.' },
      email: {
        to: p.updated_by,
        subject: `${p.name} schedule: please update today`,
        body: `Hi ${updaterFirst},\n\nThe ${p.name} schedule has not been updated since ${fmt(lastDay)}. Please bring it up to date by 18:00 today.\n\nIf something is blocking you, let me know.\n\nThanks,\n${ceo}`,
      },
      auto: {
        allowed: true,
        text: `Send ${p.updated_by} a reminder now, check the sheet this evening, and escalate to ${name} tomorrow at 9:00 if it is still not updated.`,
        done: `Reminder sent to ${p.updated_by} at {t}. Escalation to ${name} tomorrow at 9:00 if needed.`,
      },
      approval: `Send a reminder to ${p.updated_by}, with escalation to ${name} tomorrow if needed.`,
    });
  }
  return flags;
}

// ------------------------------------------------------------------ everything
const byNumber = (a, b) => parseInt(a.id.slice(1), 10) - parseInt(b.id.slice(1), 10);

export function buildDashboard(pf, today = config.asOf()) {
  const rules = loadRules();
  const projects = [];
  const flags = [];
  let totalPen = 0;
  let worst = [0, '', ''];
  let due30 = 0;
  let due30Missed = 0;
  for (const p of [...pf.projects.values()].sort(byNumber)) {
    const f = projectFigures(p, today, rules);
    projects.push(projectView(p, f, today));
    flags.push(...buildFlags(p, f, today));
    totalPen += f.penalty.exposure_cr;
    for (const m of f.open) {
      const w = weeksBetween(m.revised, m.forecast);
      if (w > worst[0]) worst = [w, p.name, m.phase];
      const dd = daysBetween(today, m.revised);
      if (dd >= 0 && dd <= 30) {
        due30 += 1;
        if (m.forecast > m.revised) due30Missed += 1;
      }
    }
  }
  flags.sort((a, b) => SEV_ORDER[a.sev] - SEV_ORDER[b.sev] || TYPE_ORDER[a.type] - TYPE_ORDER[b.type]);
  const names = Object.fromEntries(projects.map((p) => [p.id, p.name]));
  for (const fl of flags) {
    // the fields every department's flags carry
    Object.assign(fl, {
      dept: 'projects', where: names[fl.proj], label: FLAG_LABEL[fl.type],
      short: `${names[fl.proj]}: ${FLAG_LABEL[fl.type].toLowerCase()}`, ask: fl.title,
    });
  }
  const atRisk = projects.filter((p) => p.health === 'risk');
  const t = pf.loaded_at;
  return {
    as_of: isoDay(today),
    loaded_at: `${pad(t.getHours())}:${pad(t.getMinutes())}`,
    source: pf.source_name,
    summary: {
      projects: projects.length,
      at_risk: atRisk.length,
      at_risk_names: atRisk.map((p) => p.name),
      due_30: due30,
      due_30_missed: due30Missed,
      worst_slip: { weeks: worst[0], project: worst[1], phase: worst[2] },
      penalty_total_cr: round4(totalPen),
      penalty_projects: projects.filter((p) => p.penalty.exposure_cr > 0).map((p) => p.name),
    },
    projects,
    flags,
  };
}
