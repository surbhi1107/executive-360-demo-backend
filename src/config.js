// All settings in one place. Values come from environment variables (or a backend/.env file).
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';
import { utcDay, todayLocal } from './dates.js';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
dotenv.config({ path: path.join(ROOT, '.env'), quiet: true });

const str = (name, def = '') => (process.env[name] ?? '').trim() || def;
const int = (name, def) => {
  const n = parseInt(process.env[name] ?? '', 10);
  return Number.isFinite(n) ? n : def;
};
const filePath = (name, def) => {
  let v = (process.env[name] ?? '').trim() || def;
  if (v === '~' || v.startsWith('~/')) v = path.join(os.homedir(), v.slice(1));
  return path.resolve(v);
};

const DATA_DIR = filePath('E360_DATA_DIR', path.join(ROOT, 'data'));

const config = {
  ROOT,
  DATA_DIR,
  WORKBOOK: filePath('E360_WORKBOOK', path.join(DATA_DIR, 'Executive_360_Project_Data_clean.xlsx')),
  AGREEMENTS_DIR: filePath('E360_AGREEMENTS_DIR', path.join(DATA_DIR, 'agreements')),
  RULES: filePath('E360_RULES', path.join(DATA_DIR, 'rules.json')),
  // Finance, Sales, Operations, Customers and People workbooks
  DEPT_DIR: filePath('E360_DEPT_DIR', path.join(DATA_DIR, 'departments')),
  // Who can be emailed, and their manager (for escalation)
  CONTACTS: filePath('E360_CONTACTS', path.join(DATA_DIR, 'Executive_360_Contacts.xlsx')),
  // On Vercel only /tmp is writable (and it is not kept between cold starts), so the database lives there.
  DB_PATH: filePath('E360_DB', process.env.VERCEL ? path.join(os.tmpdir(), 'executive360.db') : path.join(ROOT, 'instance', 'executive360.db')),
  // Built React app (frontend/dist). Express serves it when it exists.
  FRONTEND_DIST: filePath('E360_FRONTEND_DIST', path.join(ROOT, '..', 'frontend', 'dist')),

  // Leave empty to use today's date. Set to 2026-11-14 to freeze the demo at the date the sample data describes.
  AS_OF: str('E360_AS_OF'),

  // How long loaded data is reused before the workbook is read again (seconds).
  CACHE_SECONDS: int('E360_CACHE_SECONDS', 300),

  // Flag thresholds
  STALE_DAYS: int('E360_STALE_DAYS', 3), // Clause 6.3: three working days
  BUFFER_WEEKS: int('E360_BUFFER_WEEKS', 2), // internal target = revised target minus this buffer
  CONFIRM_DAYS: int('E360_CONFIRM_DAYS', 7), // progress should be confirmed by its department this often
  CONFIRM_GAP: int('E360_CONFIRM_GAP', 10), // reported % minus confirmed %: this many points or more is flagged
  SLIP_WEEKS: int('E360_SLIP_WEEKS', 2), // forecast this many weeks late or more
  BUDGET_GAP_POINTS: int('E360_BUDGET_GAP', 10), // budget used % minus progress %

  // Claude
  ANTHROPIC_API_KEY: str('ANTHROPIC_API_KEY'),
  CLAUDE_MODEL: str('CLAUDE_MODEL', 'claude-sonnet-5-5'),
  // Room for the answer. A very long answer (a table of every milestone) can be cut off at this limit;
  // the dashboard then asks the user to narrow the question.
  CLAUDE_MAX_TOKENS: int('CLAUDE_MAX_TOKENS', 2500),

  // Email (see mailer.js). off = record only; test = everything goes to your own inbox; live = real recipients.
  MAIL_MODE: str('E360_MAIL_MODE', 'off').toLowerCase(),
  GMAIL_ADDRESS: str('GMAIL_ADDRESS'),
  GMAIL_APP_PASSWORD: (process.env.GMAIL_APP_PASSWORD ?? '').replace(/\s/g, ''),
  TEST_INBOX: str('E360_TEST_INBOX'),

  // The person using the dashboard (used in email drafts)
  CEO_NAME: process.env.E360_CEO_NAME || 'Anita Rao',

  PORT: int('PORT', 4000),

  // Web address of the React app when it is hosted separately (for example on Vercel). Empty = allow any.
  CORS_ORIGIN: str('E360_CORS_ORIGIN'),

  // The date everything is measured against.
  asOf() {
    if (this.AS_OF) {
      const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(this.AS_OF);
      if (!m) throw new Error(`E360_AS_OF must look like 2026-11-14, got "${this.AS_OF}"`);
      return utcDay(+m[1], +m[2], +m[3]);
    }
    return todayLocal();
  },
};

export default config;
