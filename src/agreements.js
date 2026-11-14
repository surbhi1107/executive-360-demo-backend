// Reads the project agreements (.docx) into clauses, so the assistant can quote and cite them.
//
// Each clause is { id, project, agreement, file, section, clause, text }.
// "clause" is the number such as "9.1"; tables (damages, milestones, payments) are attached as text
// to the clause or section they follow.
//
// A .docx is a zip of XML files. We read word/document.xml directly so paragraphs and tables stay in
// the order they appear, and word/styles.xml to know which paragraphs are headings.
import fs from 'node:fs';
import path from 'node:path';
import JSZip from 'jszip';
import { XMLParser } from 'fast-xml-parser';
import config from './config.js';

const CLAUSE_RE = /^(\d+\.\d+|[A-C]\.)\s+([\s\S]*)/;
const REF_RE = /^(E360-(?:CA|IDA)-P(\d+))/;

const parser = new XMLParser({
  preserveOrder: true,
  ignoreAttributes: false,
  attributeNamePrefix: '@_',
  trimValues: false,
  parseTagValue: false,
  parseAttributeValue: false,
  processEntities: true,
});

// ---- tiny helpers over fast-xml-parser's ordered output: [{ 'w:p': [children], ':@': { '@_w:val': 'x' } }, ...]
const tagOf = (node) => Object.keys(node).find((k) => k !== ':@');
const kids = (node) => node[tagOf(node)] ?? [];
const attr = (node, name) => node[':@']?.[`@_${name}`];
const childrenNamed = (node, name) => kids(node).filter((c) => tagOf(c) === name);
const textOf = (nodes) => nodes.map((n) => (tagOf(n) === '#text' ? String(n['#text'] ?? '') : '')).join('');

/** Text of one run, the way Word shows it: w:t text, tabs and line breaks. */
function runText(run) {
  let out = '';
  for (const c of kids(run)) {
    switch (tagOf(c)) {
      case 'w:t': out += textOf(kids(c)); break;
      case 'w:tab': case 'w:ptab': out += '\t'; break;
      case 'w:br': case 'w:cr': out += attr(c, 'w:type') && attr(c, 'w:type') !== 'textWrapping' ? '' : '\n'; break;
      case 'w:noBreakHyphen': out += '-'; break;
      default: break;
    }
  }
  return out;
}

function paragraphText(p) {
  let out = '';
  for (const c of kids(p)) {
    const t = tagOf(c);
    if (t === 'w:r') out += runText(c);
    else if (t === 'w:hyperlink') for (const r of childrenNamed(c, 'w:r')) out += runText(r);
  }
  return out;
}

function styleNameOf(p, styles) {
  const pPr = childrenNamed(p, 'w:pPr')[0];
  const pStyle = pPr && childrenNamed(pPr, 'w:pStyle')[0];
  const id = pStyle && attr(pStyle, 'w:val');
  return (id && styles.get(id)) || '';
}

/** One table as text: cells joined by " | ", one line per row, whitespace tidied. */
function tableText(tbl) {
  return childrenNamed(tbl, 'w:tr')
    .map((tr) =>
      childrenNamed(tr, 'w:tc')
        .map((tc) => childrenNamed(tc, 'w:p').map(paragraphText).join('\n').split(/\s+/).filter(Boolean).join(' '))
        .join(' | '),
    )
    .join('\n');
}

/** styleId -> style name as Word shows it ("heading 2" -> "Heading 2"). */
function readStyles(xml) {
  const map = new Map();
  const root = parser.parse(xml).find((n) => tagOf(n) === 'w:styles');
  for (const s of childrenNamed(root ?? {}, 'w:style')) {
    const name = childrenNamed(s, 'w:name')[0];
    const val = name && attr(name, 'w:val');
    if (val) map.set(attr(s, 'w:styleId'), /^heading \d$/i.test(val) ? val[0].toUpperCase() + val.slice(1).toLowerCase() : val);
  }
  return map;
}

export async function parseAgreement(file) {
  const base = path.basename(file);
  const m = REF_RE.exec(base);
  if (!m) return [];
  const ref = m[1];
  const project = `P${parseInt(m[2], 10)}`;

  const zip = await JSZip.loadAsync(fs.readFileSync(file));
  const styles = zip.file('word/styles.xml') ? readStyles(await zip.file('word/styles.xml').async('string')) : new Map();
  const doc = parser.parse(await zip.file('word/document.xml').async('string')).find((n) => tagOf(n) === 'w:document');
  const body = childrenNamed(doc, 'w:body')[0];

  const clauses = [];
  const usedIds = new Set();
  let section = 'Key facts';
  let current = null;

  const start = (clauseNo, text, sec = section) => {
    const baseId = `${ref}:${clauseNo || sec}`;
    let id = baseId;
    let n = 2;
    while (usedIds.has(id)) id = `${baseId} (${n++})`;
    usedIds.add(id);
    current = { id, project, agreement: ref, file: base, section: sec, clause: clauseNo, text: text.trim() };
    clauses.push(current);
  };

  start(null, '');
  for (const block of kids(body)) {
    const tag = tagOf(block);
    if (tag === 'w:tbl') {
      if (current === null || ['A', 'B', 'C'].includes(current.clause)) start(null, '', 'Key facts');
      current.text += (current.text ? '\n' : '') + tableText(block);
      continue;
    }
    if (tag !== 'w:p') continue;
    const text = paragraphText(block).trim();
    if (!text) continue;
    const style = styleNameOf(block, styles);
    if (style.startsWith('Heading 1')) continue;
    if (style.startsWith('Heading 2')) {
      section = text;
      start(null, '');
      continue;
    }
    const cm = CLAUSE_RE.exec(text);
    if (cm) start(cm[1].replace(/\.+$/, ''), cm[2]);
    else if (current !== null) current.text += (current.text ? '\n' : '') + text;
  }
  return clauses.filter((c) => c.text);
}

export function agreementFiles() {
  const dir = config.AGREEMENTS_DIR;
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((f) => /^E360-.*\.docx$/.test(f))
    .sort()
    .map((f) => path.join(dir, f));
}

let cache = { stamp: null, value: null };

/** Clauses for every project, keyed by project ID. Re-reads only if a file changes. */
export async function allClauses() {
  const files = agreementFiles();
  const stamp = files.map((f) => `${f}:${fs.statSync(f).mtimeMs}`).join('|');
  if (cache.stamp === stamp && cache.value) return cache.value;
  const out = {};
  for (const f of files) {
    for (const c of await parseAgreement(f)) (out[c.project] ??= []).push(c);
  }
  cache = { stamp, value: out };
  return out;
}
