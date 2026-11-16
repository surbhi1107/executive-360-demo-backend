// Sends email and calendar invites from the CEO's Gmail, and reads the replies.
//
// Three modes, set by E360_MAIL_MODE in .env:
//   off   nothing is sent; actions are only recorded (the default, safe for demos)
//   test  every email goes to E360_TEST_INBOX (your own address) with a line saying who it was for
//   live  emails go to the real recipients from the contacts workbook
//
// Gmail is used through SMTP and IMAP with an "app password", so no Google Cloud project is needed:
//   1. Turn on 2-Step Verification for the Google account.
//   2. Create an app password at https://myaccount.google.com/apppasswords
//   3. Put GMAIL_ADDRESS and GMAIL_APP_PASSWORD in .env. Never commit .env.
//
// Every email carries a tag like [E360-12] in the subject. A reply keeps the tag, which is how the reply is matched to its case.
import crypto from 'node:crypto';
import config from './config.js';

const TOKEN_RE = /\[E360-(\d+)\]/;

export function status() {
  const mode = ['off', 'test', 'live'].includes(config.MAIL_MODE) ? config.MAIL_MODE : 'off';
  const ready = Boolean(config.GMAIL_ADDRESS && config.GMAIL_APP_PASSWORD);
  let note = {
    off: 'Email is off: actions are recorded but nothing is sent.',
    test: `Test mode: every email goes to ${config.TEST_INBOX || config.GMAIL_ADDRESS || 'your test inbox'}, not to the real person.`,
    live: 'Live: emails go to the real recipients.',
  }[mode];
  if (mode !== 'off' && !ready) note = 'Email is switched on but GMAIL_ADDRESS or GMAIL_APP_PASSWORD is missing in .env, so nothing is sent.';
  return { mode, ready: mode !== 'off' && ready, address: config.GMAIL_ADDRESS, note };
}

// ------------------------------------------------------------------ transport (replaceable in tests)
export class GmailTransport {
  /** `message` is a nodemailer message object. */
  async send(message) {
    const nodemailer = (await import('nodemailer')).default;
    const tx = nodemailer.createTransport({ host: 'smtp.gmail.com', port: 465, secure: true, auth: { user: config.GMAIL_ADDRESS, pass: config.GMAIL_APP_PASSWORD }, connectionTimeout: 30_000 });
    await tx.sendMail(message);
  }

  /** Raw messages (Buffers) in the inbox whose subject carries an E360 tag. */
  async fetch(since) {
    const { ImapFlow } = await import('imapflow');
    const client = new ImapFlow({ host: 'imap.gmail.com', port: 993, secure: true, auth: { user: config.GMAIL_ADDRESS, pass: config.GMAIL_APP_PASSWORD }, logger: false });
    await client.connect();
    const out = [];
    try {
      const lock = await client.getMailboxLock('INBOX', { readOnly: true });
      try {
        const ids = (await client.search({ since, subject: 'E360-' })) || [];
        for (const uid of ids.slice(-200)) {
          const m = await client.fetchOne(uid, { source: true }, { uid: false });
          if (m?.source) out.push(m.source);
        }
      } finally {
        lock.release();
      }
    } finally {
      await client.logout().catch(() => {});
    }
    return out;
  }
}

let transport = new GmailTransport();
export const setTransport = (t) => {
  transport = t;
};

// ------------------------------------------------------------------ sending
const utcStamp = (d) => d.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
const esc = (s) => String(s).replace(/\\/g, '\\\\').replace(/,/g, '\\,').replace(/;/g, '\;').replace(/\n/g, '\\n');

/** A calendar invite (.ics text) that Gmail and Outlook show with Accept / Decline buttons. */
export function invite(start, minutes, summary, description, attendee) {
  return [
    'BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//deepvox.ai//Executive 360//EN', 'METHOD:REQUEST', 'BEGIN:VEVENT',
    `UID:${crypto.randomUUID()}@executive360`, `DTSTAMP:${utcStamp(new Date())}`,
    `DTSTART:${utcStamp(start)}`, `DTEND:${utcStamp(new Date(start.getTime() + minutes * 60_000))}`,
    `SUMMARY:${esc(summary)}`, `DESCRIPTION:${esc(description)}`,
    `ORGANIZER;CN=${esc(config.CEO_NAME)}:mailto:${config.GMAIL_ADDRESS || 'ceo@example.com'}`,
    `ATTENDEE;RSVP=TRUE:mailto:${attendee}`, 'END:VEVENT', 'END:VCALENDAR', '',
  ].join('\r\n');
}

/** Send one email. Returns { sent, mode, delivered_to, note }; never throws. */
export async function send(toName, toEmail, subject, body, caseId, ics = null) {
  const st = status();
  const tag = `[E360-${caseId}]`;
  if (st.mode === 'off') return { sent: false, mode: 'off', delivered_to: '', note: 'recorded only; email sending is off' };
  if (!st.ready) return { sent: false, mode: st.mode, delivered_to: '', note: 'not sent: Gmail address or app password is missing in .env' };
  if (st.mode === 'live' && !toEmail) return { sent: false, mode: 'live', delivered_to: '', note: `not sent: no email address for ${toName} in the contacts workbook` };
  if (st.mode === 'live' && toEmail.endsWith('.example')) {
    return { sent: false, mode: 'live', delivered_to: '', note: `not sent: ${toEmail} is a sample address; put the real one in the contacts workbook` };
  }
  const actual = st.mode === 'live' ? toEmail : config.TEST_INBOX || config.GMAIL_ADDRESS;
  const banner = st.mode === 'test' ? `[TEST MODE: in live mode this would go to ${toName} <${toEmail || 'no address on file'}>]\n\n` : '';
  const message = {
    from: `${config.CEO_NAME} <${config.GMAIL_ADDRESS}>`,
    to: `${toName} <${actual}>`,
    subject: `${subject} ${tag}`,
    date: new Date(),
    messageId: `<${crypto.randomUUID()}@executive360>`,
    headers: { 'X-E360-Out': String(caseId) }, // marks our own outgoing mail, so it is never read back as a reply
    text: `${banner}${body}\n\n--\nSent with Executive 360° on behalf of ${config.CEO_NAME}. Reply to this email to respond; keep ${tag} in the subject.`,
  };
  if (ics) message.icalEvent = { method: 'REQUEST', filename: 'invite.ics', content: ics };
  try {
    await transport.send(message);
  } catch (e) { // wrong password, no network…
    console.error('Email not sent:', e?.message ?? e);
    return { sent: false, mode: st.mode, delivered_to: '', note: `not sent: ${e?.name ?? 'Error'}: ${String(e?.message ?? e).slice(0, 120)}` };
  }
  return { sent: true, mode: st.mode, delivered_to: actual, note: st.mode === 'test' ? `test mode: delivered to ${actual}` : `sent to ${actual}` };
}

// ------------------------------------------------------------------ reading replies
/** Keep the new text and drop the quoted original. */
export function newText(parsed) {
  let text = parsed.text || '';
  if (!parsed.text && parsed.html) text = String(parsed.html).replace(/<[^>]+>/g, ' ');
  const lines = [];
  for (const line of text.split(/\r?\n/)) {
    if (line.startsWith('>') || /^On .+wrote:\s*$/.test(line.trim()) || line.trim().startsWith('-----Original Message')) break;
    lines.push(line);
  }
  return lines.join('\n').replace(/\n{3,}/g, '\n\n').trim();
}

/** Replies that carry an E360 tag: [{ case_id, from, at, text, message_id }]. Empty if email is off. */
export async function fetchReplies(since) {
  if (!status().ready) return [];
  let raws;
  try {
    raws = await transport.fetch(since);
  } catch (e) {
    console.error('Could not read the mailbox:', e?.message ?? e);
    return [];
  }
  const { simpleParser } = await import('mailparser');
  const out = [];
  for (const raw of raws) {
    const msg = await simpleParser(raw);
    const m = TOKEN_RE.exec(String(msg.subject ?? ''));
    if (!m || msg.headers.get('x-e360-out')) continue; // not ours, or our own outgoing copy
    const at = msg.date instanceof Date && !Number.isNaN(msg.date.getTime()) ? msg.date : new Date();
    const from = msg.from?.value?.[0] ?? {};
    out.push({
      case_id: Number(m[1]), from: from.name || from.address || '', at, text: newText(msg).slice(0, 4000),
      message_id: String(msg.messageId ?? '').trim() || `${from.address}-${at.toISOString()}`,
    });
  }
  return out;
}
