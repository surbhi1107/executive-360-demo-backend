// The contacts directory: who can be emailed, their address and their manager (data/Executive_360_Contacts.xlsx).
import fs from 'node:fs';
import config from './config.js';
import { readWorkbook } from './data.js';

let cache = { key: null, value: {} };
const s = (v) => String(v ?? '').trim();

export async function directory() {
  if (!fs.existsSync(config.CONTACTS)) return {};
  const key = `${config.CONTACTS}|${fs.statSync(config.CONTACTS).mtimeMs}`;
  if (cache.key !== key) {
    const rows = (await readWorkbook(config.CONTACTS)).Contacts ?? [];
    const value = {};
    for (const r of rows) {
      value[s(r.Name).toLowerCase()] = { name: s(r.Name), role: r.Role || '', dept: r.Department || '', email: s(r.Email), manager: s(r.Manager) };
    }
    cache = { key, value };
  }
  return cache.value;
}

/** The contact with this name. Unknown names come back with an empty email and manager. */
export async function find(name) {
  return (await directory())[s(name).toLowerCase()] ?? { name, role: '', dept: '', email: '', manager: '' };
}

export async function managerOf(name) {
  const m = (await find(name)).manager;
  return m ? find(m) : null;
}
