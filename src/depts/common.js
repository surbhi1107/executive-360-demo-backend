// Helpers shared by every department module: formatting, source chips and the flag builder.
import config from '../config.js';
import { MONTHS, dMonYearHhmm, fmt as fmtDay, isoDay } from '../dates.js';
import { toDay } from '../data.js';

export const STATUS_WORD = { risk: 'At risk', watch: 'Watch', ok: 'On track' };
export const SEV_RANK = { risk: 0, watch: 1, ok: 2 };

// ------------------------------------------------------------------ numbers formatted exactly as the original app did
const blank = (v) => v === null || v === undefined || v === '';

/** Fixed decimals, rounding an exact tie to the even digit (as Python does: 2.5 -> "2", 0.125 -> "0.12"). */
export function fix(x, digits = 0) {
  const v = Number(x);
  const neg = v < 0 || Object.is(v, -0);
  const a = Math.abs(v);
  let out = a.toFixed(digits);
  const exact = a.toFixed(Math.min(100, digits + 60)); // the exact decimal value of the double
  const rest = exact.slice(exact.length - 60);
  if (/^50*$/.test(rest)) {
    const down = exact.slice(0, exact.length - 60).replace(/\.$/, '');
    if (Number(down.slice(-1)) % 2 === 0) out = down; // tie: keep the even digit
  }
  return (neg ? '-' : '') + out;
}
/** Python's round(x, digits) as a number. */
export const pyRound = (x, digits = 0) => Number(fix(x, digits));
/** "+3.2" / "-0.4" (always with a sign) */
export const signed = (x, digits = 1) => {
  const s = fix(x, digits);
  return s.startsWith('-') ? s : '+' + s;
};
const commas = (s) => s.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
/** Python's "{:g}" */
export function gfmt(v) {
  if (!Number.isFinite(v)) return String(v);
  if (v === 0) return '0';
  const exp = Math.floor(Math.log10(Math.abs(v)));
  if (exp < -4 || exp >= 6) {
    const m = Number(v.toPrecision(6)).toExponential().replace(/\.?0+e/, 'e');
    const [a, b] = m.split('e');
    return `${a}e${b[0] === '-' ? '-' : '+'}${b.replace(/^[+-]/, '').padStart(2, '0')}`;
  }
  return String(Number(v.toPrecision(6)));
}

export const num = (v) => Number(v || 0);

/** ₹ crore, e.g. ₹14.2 Cr or ₹877 Cr. */
export function cr(v, digits = 1) {
  const r = pyRound(v, digits);
  let text = commas(fix(Math.abs(r), digits));
  if (digits) text = text.replace(/0+$/, '').replace(/\.$/, '');
  return `${r < 0 ? '−' : ''}₹${text} Cr`;
}
export function pct(v, digits = 1) {
  return `${fix(pyRound(v, digits), digits)}%`.replace('.0%', '%');
}
export const fmt = (d, year = true) => (d ? fmtDay(d, year) : '');
export const mon = (d, year = false) => (year ? `${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}` : MONTHS[d.getUTCMonth()]);
export const first = (name) => String(name).split(/\s+/)[0];
export const slug = (text) => String(text).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
export const worst = (flags) => flags.reduce((w, f) => (SEV_RANK[f.sev] < SEV_RANK[w] ? f.sev : w), 'ok');
export const day = (v) => (blank(v) ? null : toDay(v));
export const daysUntil = (d, today) => Math.round((d.getTime() - today.getTime()) / 86_400_000);
export const minBy = (list, key) => list.reduce((b, x) => (key(x) < key(b) ? x : b));
export const maxBy = (list, key) => list.reduce((b, x) => (key(x) > key(b) ? x : b));
export const sum = (list, f = (x) => x) => list.reduce((s, x) => s + f(x), 0);

/** {role: name} from a workbook's Contacts tab */
export function contactsOf(tabs) {
  return Object.fromEntries((tabs.Contacts ?? []).map((r) => [r.Role, r.Name]));
}

/** A table cell. status shows a coloured dot (ok/watch/risk); tone colours the text (late/ok). */
export function cell(text, status = null, tone = null) {
  if (status) return { v: String(text), s: status };
  if (tone) return { v: String(text), tone };
  return text;
}

// ------------------------------------------------------------------ source chips
export function show(v) {
  if (v instanceof Date) return v.getUTCHours() === 0 && v.getUTCMinutes() === 0 ? fmt(day(v)) : dMonYearHhmm(v);
  if (typeof v === 'number' && !Number.isInteger(v)) return gfmt(v);
  return String(v);
}

/** Builds the 'source chip' for a row of this department's workbook. */
export class Source {
  constructor(dept, fileName) {
    this.dept = dept;
    this.name = fileName;
    this.ref = `wb:${dept}`;
  }

  /** (tab, row or description, used_for, cols?) */
  chip(tab, row, usedFor, cols = null) {
    let locator;
    let record = [];
    if (row && typeof row === 'object') {
      locator = `${tab} · row ${row._row}`;
      const keys = cols ?? Object.keys(row).filter((k) => !k.startsWith('_')).slice(0, 7);
      record = keys.filter((k) => !blank(row[k])).map((k) => [k, show(row[k])]);
    } else {
      locator = `${tab} · ${row}`;
    }
    return { kind: 'excel', ref: this.ref, name: this.name, locator, used_for: usedFor, record };
  }
}

/** One flag in the shape the dashboard expects, with ready-made Call, Email, Automatic and Approval actions. */
export function makeFlag(dept, kind, key, sev, label, short, title, body, o) {
  const { where, impacts, sources, suggest, owner, ownerRole } = o;
  const ceo = config.CEO_NAME;
  const auto = o.autoReason
    ? { allowed: false, reason: o.autoReason }
    : {
        allowed: true,
        text: o.autoText ?? `Ask ${owner} for a weekly update on this and alert you if it gets worse.`,
        done: o.autoDone ?? `Weekly update requested from ${owner} at {t}. You will be alerted if it gets worse.`,
      };
  return {
    id: `${dept}-${kind}-${slug(key)}`, type: `${dept}-${kind}`, dept, proj: null, sev,
    label, short, where, title, body, impacts,
    evidence: o.evidence ?? '', sources, suggest, ask: o.ask ?? title,
    call: {
      who: `${owner} · ${ownerRole}`,
      slot: sev === 'risk' ? 'Today, 17:00 · 15 min' : 'Tomorrow, 10:00 · 15 min',
      agenda: o.agenda || title,
    },
    email: {
      to: owner,
      subject: o.emailSubject ?? title,
      external: Boolean(o.external),
      body: `${first(owner)},\n\n${body}\n\n${o.emailAsk ?? 'Please send me your plan, with owners and dates, by Wednesday.'}\n\n${ceo}`,
    },
    auto,
    approval: o.approval ?? `Send the request for a plan to ${owner}.`,
  };
}

export { isoDay };
