// Date helpers. A "day" is a Date at 00:00 UTC, so day arithmetic never depends on the server's time zone.
// Excel date-times are "naive" wall-clock values; ExcelJS returns them as UTC, so we read them with UTC getters.

export const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const DAY_MS = 86_400_000;

export const pad = (n) => String(n).padStart(2, '0');

export const utcDay = (y, m, d) => new Date(Date.UTC(y, m - 1, d));

/** Today's calendar date in the server's local time zone, as a UTC-midnight day. */
export function todayLocal() {
  const n = new Date();
  return utcDay(n.getFullYear(), n.getMonth() + 1, n.getDate());
}

/** The calendar day of a naive (UTC-read) date-time. */
export const floorDay = (d) => (d ? new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate())) : null);

/** Whole days from a to b (both days). */
export const daysBetween = (a, b) => Math.round((b.getTime() - a.getTime()) / DAY_MS);

/** A day moved by n days. */
export const addDays = (d, n) => new Date(d.getTime() + n * DAY_MS);

export const isoDay = (d) => d.toISOString().slice(0, 10);

/** 4 Dec 2026, or 4 Dec */
export function fmt(d, year = true) {
  if (!d) return '';
  return `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]}` + (year ? ` ${d.getUTCFullYear()}` : '');
}

/** Naive date-time formatting (Excel values). */
export const hhmm = (d) => `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}`;
export const dMonHhmm = (d) => `${pad(d.getUTCDate())} ${MONTHS[d.getUTCMonth()]}, ${hhmm(d)}`;
export const dMonYearHhmm = (d) => `${pad(d.getUTCDate())} ${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}, ${hhmm(d)}`;

/** Local-time formatting (file modified times, "now"). */
export const localHhmm = (d = new Date()) => `${pad(d.getHours())}:${pad(d.getMinutes())}`;
export const localDMonYear = (d) => `${pad(d.getDate())} ${MONTHS[d.getMonth()]} ${d.getFullYear()}`;
export const localDMonYearHhmm = (d) => `${localDMonYear(d)}, ${localHhmm(d)}`;
export const localIsoSeconds = (d = new Date()) =>
  `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
