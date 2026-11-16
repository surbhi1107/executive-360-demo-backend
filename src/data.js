// Reads the project data workbook into plain objects.
//
// Only the input columns are read (never Excel formula results), so the numbers do not depend on
// Excel having recalculated. Every derived figure is calculated in code (see penalties.js and views.js).
//
// To switch to Google Sheets later, write a function that returns the same `tabs` object
// (tab name -> array of rows keyed by header) and pass it to buildPortfolio().
import fs from 'node:fs';
import path from 'node:path';
import JSZip from 'jszip';
import { XMLParser } from 'fast-xml-parser';
import config from './config.js';
import { MONTHS, utcDay, addDays } from './dates.js';

export const STAGE_KEYS = {
  'Survey and feasibility': 'survey',
  'Design and engineering': 'design',
  'Approvals and permits': 'approvals',
  'Procurement and supply': 'procurement',
  'Civil and site works': 'civil',
  Installation: 'installation',
  'Testing and commissioning': 'testing',
  'Certification and handover': 'handover',
};
export const STATUS_KEYS = { 'At risk': 'risk', Watch: 'watch', 'On track': 'ok' };

const int = (v) => Math.trunc(Number(v) || 0);
const blank = (v) => v === null || v === undefined || v === '';

// ------------------------------------------------------------------ dates
/** Parse an Excel date / date-time or a date string. Returns a naive Date (read with UTC getters) or null. */
export function toDate(v) {
  if (blank(v)) return null;
  if (v instanceof Date) return v;
  const s = String(v).trim();
  let m;
  if ((m = /^(\d{1,2}) ([A-Za-z]{3}) (\d{4}), (\d{1,2}):(\d{2})$/.exec(s))) return mk(m[3], m[2], m[1], m[4], m[5]);
  if ((m = /^(\d{1,2}) ([A-Za-z]{3}) (\d{4})$/.exec(s))) return mk(m[3], m[2], m[1]);
  if ((m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s))) return new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]));
  if ((m = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(s))) return new Date(Date.UTC(+m[3], +m[2] - 1, +m[1]));
  throw new Error(`Not a date: ${JSON.stringify(v)}`);
}
function mk(year, mon, day, h = 0, min = 0) {
  const i = MONTHS.findIndex((x) => x.toLowerCase() === mon.toLowerCase());
  if (i < 0) throw new Error(`Not a month: ${mon}`);
  return new Date(Date.UTC(+year, i, +day, +h, +min));
}
/** Calendar day (UTC midnight) of a value, or null. */
export function toDay(v) {
  const d = toDate(v);
  return d ? utcDay(d.getUTCFullYear(), d.getUTCMonth() + 1, d.getUTCDate()) : null;
}

// ------------------------------------------------------------------ reading an .xlsx
// An .xlsx is a zip of XML files. We read the cell values (and the stored result of formulas) directly,
// so there is no dependency on Excel-specific libraries and no dependence on the order of parts in the zip.
const xml = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '@_',
  parseTagValue: false,
  trimValues: false,
  htmlEntities: true, // so that numeric references such as &#183; (a middle dot) become the character
  isArray: (name) => ['sheet', 'Relationship', 'si', 'r', 'row', 'c', 'xf', 'numFmt'].includes(name),
});

const textOfSi = (si) => {
  const t = (x) => (typeof x === 'object' && x !== null ? x['#text'] ?? '' : x ?? '');
  if (si.t !== undefined) return String(t(si.t));
  return (si.r ?? []).map((r) => String(t(r.t))).join(''); // rich text: join the runs (phonetic runs are ignored)
};

const BUILTIN_DATE_FORMATS = new Set([14, 15, 16, 17, 18, 19, 20, 21, 22, 45, 46, 47]);
const looksLikeDate = (code) => /[dmyhs]/i.test(String(code).replace(/"[^"]*"|\[[^\]]*\]|\\.|_.|\*./g, ''));

/** Which cell styles (by index) are dates, from xl/styles.xml. */
function dateStyles(stylesXml) {
  if (!stylesXml) return new Set();
  const st = xml.parse(stylesXml).styleSheet ?? {};
  const custom = new Map((st.numFmts?.numFmt ?? []).map((n) => [Number(n['@_numFmtId']), n['@_formatCode']]));
  const out = new Set();
  (st.cellXfs?.xf ?? []).forEach((x, i) => {
    const id = Number(x['@_numFmtId'] ?? 0);
    if (BUILTIN_DATE_FORMATS.has(id) || (custom.has(id) && looksLikeDate(custom.get(id)))) out.add(i);
  });
  return out;
}

/** Excel serial number -> naive Date (read with UTC getters). Rounded to the second to drop float noise. */
const fromSerial = (n) => new Date(Math.round(((n - 25569) * 86_400_000) / 1000) * 1000);

const colIndex = (ref) => {
  let n = 0;
  for (const ch of /^[A-Z]+/i.exec(ref)[0].toUpperCase()) n = n * 26 + ch.charCodeAt(0) - 64;
  return n - 1;
};

/** Tab name -> path of its XML file inside the zip. */
async function sheetFiles(zip) {
  const wb = xml.parse(await zip.file('xl/workbook.xml').async('string')).workbook;
  const rels = xml.parse(await zip.file('xl/_rels/workbook.xml.rels').async('string')).Relationships.Relationship;
  const target = new Map(rels.map((r) => [r['@_Id'], r['@_Target']]));
  return wb.sheets.sheet.map((s) => {
    const t = target.get(s['@_r:id']) ?? '';
    return { name: s['@_name'], path: t.startsWith('/') ? t.slice(1) : `xl/${t}` };
  });
}

function cellValue(c, shared, dates) {
  const type = c['@_t'];
  if (type === 'inlineStr') return textOfSi(c.is ?? {});
  const raw = c.v === undefined ? '' : String(typeof c.v === 'object' ? c.v['#text'] ?? '' : c.v);
  if (raw === '') return null;
  if (type === 's') return shared[Number(raw)] ?? null;
  if (type === 'str') return raw;
  if (type === 'b') return raw === '1';
  if (type === 'e') return null; // error value
  if (type === 'd') return new Date(raw);
  const n = Number(raw);
  if (Number.isNaN(n)) return raw;
  return dates.has(Number(c['@_s'] ?? 0)) ? fromSerial(n) : n;
}

/** Return { tab name: [ { header: value, _row: n }, ... ] } for every tab. */
export async function readWorkbook(file) {
  const zip = await JSZip.loadAsync(fs.readFileSync(file));
  const read = async (name) => (zip.file(name) ? zip.file(name).async('string') : null);
  const sst = await read('xl/sharedStrings.xml');
  const shared = sst ? (xml.parse(sst).sst?.si ?? []).map(textOfSi) : [];
  const dates = dateStyles(await read('xl/styles.xml'));

  const out = {};
  for (const sheet of await sheetFiles(zip)) {
    const doc = xml.parse(await read(sheet.path));
    const rows = doc.worksheet?.sheetData?.row ?? [];
    let header = null;
    const items = [];
    for (const row of rows) {
      const values = [];
      (row.c ?? []).forEach((c, k) => {
        values[c['@_r'] ? colIndex(c['@_r']) : k] = cellValue(c, shared, dates);
      });
      if (header === null) {
        header = Array.from(values, (h) => (h === null || h === undefined ? '' : String(h).trim()));
        continue;
      }
      if (blank(values[0])) continue;
      const item = {};
      header.forEach((h, j) => {
        if (h) item[h] = values[j] ?? null;
      });
      item._row = Number(row['@_r']);
      items.push(item);
    }
    if (header !== null) out[sheet.name] = items;
  }
  return out;
}

export function buildPortfolio(tabs, sourceName) {
  for (const need of ['Projects', 'Milestones']) {
    if (!tabs[need]) throw new Error(`The workbook has no "${need}" tab.`);
  }
  const projects = new Map();
  for (const r of tabs.Projects) {
    projects.set(r.ID, {
      id: r.ID,
      name: r.Project,
      sector: r.Sector,
      scale: r['Location / Scale'],
      client: r.Client,
      lead: r.Lead,
      stage: STAGE_KEYS[r.Stage] ?? 'design',
      next_label: r['Next milestone'],
      next_phase: r['Milestone phase'],
      progress: int(r['Progress %']),
      plan: int(r['Plan %']),
      health: STATUS_KEYS[r.Health] ?? 'watch',
      row: r._row,
      last_updated: null,
      updated_by: '',
      budget_cr: 0,
      budget_used: 0,
      update_row: 0,
      milestones: [],
      stages: {},
      reasons: [],
      internal: String(r.Client ?? '').toLowerCase().startsWith('internal'),
    });
  }
  const milestoneOf = (p) => (phase) => p.milestones.find((m) => m.phase === phase) ?? null;

  for (const r of tabs['Project Updates'] ?? []) {
    const p = projects.get(r.ID);
    if (!p) continue;
    p.last_updated = toDate(r['Schedule last updated']);
    p.updated_by = r['Updated by'];
    p.budget_cr = Number(r['Budget (Cr)'] || 0);
    p.budget_used = int(r['Budget used %']);
    p.update_row = r._row;
  }

  for (const r of tabs.Milestones) {
    const p = projects.get(r['Project ID']);
    if (!p) continue;
    p.milestones.push({
      project: p.id,
      phase: r.Phase,
      scope: r.Scope,
      progress: int(r['Progress %']),
      plan_start: toDay(r['Plan start']),
      plan_end: toDay(r['Plan end']),
      contract: toDay(r.Contract),
      revised: toDay(r.Revised),
      forecast: toDay(r.Forecast),
      // internal target: earlier than the revised target, to leave a buffer
      internal: toDay(r['Internal target']) ?? addDays(toDay(r.Revised), -7 * config.BUFFER_WEEKS),
      // progress formally confirmed by the responsible department
      confirmed_pct: blank(r['Confirmed %']) ? null : int(r['Confirmed %']),
      confirmed_by: String(r['Confirmed by'] ?? ''),
      confirmed_on: toDay(r['Confirmed on']),
      status: STATUS_KEYS[r.Status] ?? 'watch',
      excluded_weeks: int(r['Excluded weeks']), // optional column: certified weather / authority delay
      row: r._row,
      key: `${p.id}|${r.Phase}`,
    });
  }

  for (const r of tabs.Stages ?? []) {
    const p = projects.get(r['Project ID']);
    if (p && r.Stage in STAGE_KEYS) {
      p.stages[STAGE_KEYS[r.Stage]] = {
        done: int(r['Done %']),
        plan: int(r['Plan %']),
        focus: String(r['Focus stage'] ?? '').toLowerCase() === 'yes',
      };
    }
  }

  for (const r of tabs['Delay Reasons'] ?? []) {
    const p = projects.get(r['Project ID']);
    if (p) p.reasons.push({ reason: r.Reason, by: r['Reported by'], date: toDay(r.Date), row: r._row });
  }

  for (const p of projects.values()) p.milestone = milestoneOf(p);
  return { projects, loaded_at: new Date(), source_name: sourceName };
}

// ------------------------------------------------------------------ cache
const cache = { portfolio: null, at: 0, mtime: null, loading: null };

/** Load the workbook, reusing the last copy for CACHE_SECONDS unless the file changed. */
export async function getPortfolio(force = false) {
  const file = config.WORKBOOK;
  const mtime = fs.statSync(file).mtimeMs;
  const fresh = Date.now() - cache.at < config.CACHE_SECONDS * 1000 && cache.mtime === mtime;
  if (!force && fresh && cache.portfolio) return cache.portfolio;
  if (!force && cache.loading) return cache.loading;
  const job = readWorkbook(file)
    .then((tabs) => buildPortfolio(tabs, path.basename(file)))
    .then((portfolio) => {
      Object.assign(cache, { portfolio, at: Date.now(), mtime });
      return portfolio;
    })
    .finally(() => {
      if (cache.loading === job) cache.loading = null;
    });
  cache.loading = job;
  return job;
}
