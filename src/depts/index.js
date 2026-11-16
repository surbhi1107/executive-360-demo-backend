// The six departments on the Command Dashboard.
//
// Finance, Sales, Operations, Customers and People each have one module in this folder and one workbook in
// data/departments/. Each module has a build() function that turns the workbook into: a headline, four KPI tiles,
// a small chart for the home screen, charts and tables for the department page, flags, and calculated figures for its AI agent.
// Projects is the sixth department. It has its own, richer data (see data.js, penalties.js, views.js).
//
// To add a department: copy one module, give it a new ID, NAME, AGENT, FILE, SCOPE and KEYWORDS, write its build(), and add it to MODULES.
import fs from 'node:fs';
import path from 'node:path';
import config from '../config.js';
import { readWorkbook } from '../data.js';
import { dMonYearHhmm } from '../dates.js';
import * as customers from './customers.js';
import * as finance from './finance.js';
import * as operations from './operations.js';
import * as people from './people.js';
import * as sales from './sales.js';
import { SEV_RANK, STATUS_WORD, Source, cr, worst } from './common.js';

export const MODULES = [finance, sales, operations, customers, people];
export const BY_ID = Object.fromEntries(MODULES.map((m) => [m.ID, m]));

export const PROJECTS = {
  id: 'projects', name: 'Projects', agent: 'Projects Agent',
  scope: 'project schedules, milestones, delays, budgets, agreements and delay penalties',
  keywords: ['project', 'milestone', 'penalt', 'phase', 'schedule', 'agreement', 'contract', 'handover', 'exposure', 'slip', 'clause', 'liquidated', 'gantt'],
  strong: ['project', 'milestone', 'penalt'],
};
export const OVERVIEW = { id: 'overview', name: 'All departments', agent: 'Executive 360°', scope: 'the whole company: a summary of every department' };

const cache = { key: null, value: null };
const fileOf = (m) => path.join(config.DEPT_DIR, m.FILE);
const localStamp = (ms) => dMonYearHhmm(new Date(ms - new Date(ms).getTimezoneOffset() * 60_000));

async function buildOne(mod, today) {
  const file = fileOf(mod);
  const tabs = await readWorkbook(file);
  const d = mod.build(tabs, today, new Source(mod.ID, mod.FILE));
  d.flags.sort((a, b) => SEV_RANK[a.sev] - SEV_RANK[b.sev]); // stable, like Python's sorted()
  Object.assign(d, {
    id: mod.ID, name: mod.NAME, agent: mod.AGENT, scope: mod.SCOPE, status: worst(d.flags),
    source: { ref: `wb:${mod.ID}`, name: mod.FILE, modified: localStamp(fs.statSync(file).mtimeMs) },
    _tabs: tabs,
  });
  d.status_word = STATUS_WORD[d.status];
  d.tile.nums ??= d.kpis.slice(0, 2).map((k) => [k.label, k.value]); // two figures under the small chart
  if (d.tile.kind === 'pills') {
    d.tile.pills = d.flags.slice(0, 3).map((f) => ({ t: f.short, s: f.sev }));
    if (!d.tile.pills.length) d.tile.pills = [{ t: 'Nothing needs attention', s: 'ok' }];
  }
  return d;
}

/** The five workbook-based departments. Re-read only when a workbook or the date changes. */
export async function getDepartments(today = null, force = false) {
  today ??= config.asOf();
  const key = `${today.getTime()}|${MODULES.map((m) => fs.statSync(fileOf(m)).mtimeMs).join(',')}`;
  if (force || cache.key !== key) {
    const value = [];
    for (const m of MODULES) value.push(await buildOne(m, today));
    cache.value = value;
    cache.key = key;
  }
  return cache.value;
}

/** Projects, presented in the same shape as the other departments. */
export function projectsDepartment(dash) {
  const s = dash.summary;
  const n = s.projects;
  const atRisk = dash.projects.filter((p) => p.health === 'risk');
  const watch = dash.projects.filter((p) => p.health === 'watch');
  const status = atRisk.length ? 'risk' : watch.length ? 'watch' : 'ok';
  const slip = s.worst_slip;
  const pills = [...atRisk, ...watch].slice(0, 3).map((p) => ({ t: p.name, s: p.health }));
  return {
    id: PROJECTS.id, name: PROJECTS.name, agent: PROJECTS.agent, scope: PROJECTS.scope,
    owner: 'Project leads', status, status_word: STATUS_WORD[status],
    headline: `${s.at_risk} of ${n} projects are at risk; estimated penalty exposure is ${cr(s.penalty_total_cr)}.`,
    kpis: [
      { label: 'Projects at risk', value: `${s.at_risk} of ${n}`, foot: s.at_risk_names.join(', ') || 'None', status },
      { label: 'Milestones in next 30 days', value: String(s.due_30), foot: s.due_30_missed ? `${s.due_30_missed} forecast to be missed` : 'All forecast on time', status: s.due_30_missed ? 'watch' : 'ok' },
      { label: 'Worst forecast slip', value: slip.weeks ? `+${slip.weeks} wks` : 'None', foot: slip.weeks ? `${slip.project} · ${slip.phase}` : '', status: slip.weeks >= 8 ? 'risk' : slip.weeks ? 'watch' : 'ok' },
      { label: 'Estimated penalty exposure', value: s.penalty_total_cr ? cr(s.penalty_total_cr) : 'None',
        foot: s.penalty_total_cr ? `${s.penalty_projects.length} projects, at current forecasts` : 'No rules charging', status: s.penalty_total_cr ? 'risk' : 'ok' },
    ],
    tile: {
      kind: 'pills', pills: pills.length ? pills : [{ t: 'All on track', s: 'ok' }],
      nums: [['Projects at risk', `${s.at_risk} of ${n}`], ['Penalty exposure', s.penalty_total_cr ? cr(s.penalty_total_cr) : 'None']],
    },
    sections: [], flags: dash.flags,
    asks: ['Which projects will miss their next milestone?', 'What is our total penalty exposure?', 'Show penalty exposure by project as a chart'],
    source: { ref: 'workbook', name: dash.source, modified: '' },
    calc: s,
  };
}

/** Every department in the order the dashboard shows them. */
export async function allDepartments(dash, today = null, force = false) {
  return [...(await getDepartments(today, force)), projectsDepartment(dash)];
}

/** The department without its private working data (keys starting with an underscore). */
export const publicDept = (dept) => Object.fromEntries(Object.entries(dept).filter(([k]) => !k.startsWith('_')));
