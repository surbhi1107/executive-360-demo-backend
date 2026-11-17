// Gmail send and read. E360_MAIL_MODE in .env: off (record only) | test (all mail to your own inbox) | live (real people).
// Needs GMAIL_ADDRESS and a Google app password in GMAIL_APP_PASSWORD. Each email has a tag like [E360-12] in the
// subject; replies keep it, which is how a reply is matched to its case.
import crypto from 'node:crypto';
import config from './config.js';

export function status() {
  const mode = ['test', 'live'].includes(config.MAIL_MODE) ? config.MAIL_MODE : 'off';
  const ready = mode !== 'off' && Boolean(config.GMAIL_ADDRESS && config.GMAIL_APP_PASSWORD);
  let note = 'Email is off: actions are recorded but nothing is sent.';
  if (mode === 'test') note = `Test mode: every email goes to ${config.TEST_INBOX || config.GMAIL_ADDRESS}, not to the real person.`;
  if (mode === 'live') note = 'Live: emails go to the real recipients.';
  if (mode !== 'off' && !ready) note = 'Email is on but GMAIL_ADDRESS or GMAIL_APP_PASSWORD is missing in .env, so nothing is sent.';
  return { mode, ready, address: config.GMAIL_ADDRESS, note };
}

// Kept as one object so the tests can swap in a fake.
// Same as the Echoleads mail service: do not stop on a self-signed certificate (office proxy, antivirus).
const tls = { rejectUnauthorized: false };

let transport = {
  async send(message) {
    const nodemailer = (await import('nodemailer')).default;
    const auth = { user: config.GMAIL_ADDRESS, pass: config.GMAIL_APP_PASSWORD };
    await nodemailer.createTransport({ host: 'smtp.gmail.com', port: 465, secure: true, auth, tls }).sendMail(message);
  },
  async fetch(since) {
    const { ImapFlow } = await import('imapflow');
    const auth = { user: config.GMAIL_ADDRESS, pass: config.GMAIL_APP_PASSWORD };
    const client = new ImapFlow({ host: 'imap.gmail.com', port: 993, secure: true, auth, tls, logger: false });
    const emails = [];
    await client.connect();
    const lock = await client.getMailboxLock('INBOX', { readOnly: true });
    try {
      for (const id of ((await client.search({ since, subject: 'E360-' })) || []).slice(-200)) {
        const m = await client.fetchOne(id, { source: true });
        if (m && m.source) emails.push(m.source);
      }
    } finally {
      lock.release();
      await client.logout().catch(() => {});
    }
    return emails;
  },
};
export const setTransport = (t) => { transport = t; };

/** Calendar invite (.ics text) with Accept / Decline buttons in Gmail and Outlook. */
export function invite(start, minutes, summary, description, attendee) {
  const time = (d) => d.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
  const text = (s) => String(s).replace(/\\/g, '\\\\').replace(/,/g, '\\,').replace(/;/g, '\\;').replace(/\n/g, '\\n');
  return [
    'BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//deepvox.ai//Executive 360//EN', 'METHOD:REQUEST', 'BEGIN:VEVENT',
    `UID:${crypto.randomUUID()}@executive360`,
    `DTSTAMP:${time(new Date())}`,
    `DTSTART:${time(start)}`,
    `DTEND:${time(new Date(start.getTime() + minutes * 60000))}`,
    `SUMMARY:${text(summary)}`,
    `DESCRIPTION:${text(description)}`,
    `ORGANIZER;CN=${text(config.CEO_NAME)}:mailto:${config.GMAIL_ADDRESS || 'ceo@example.com'}`,
    `ATTENDEE;RSVP=TRUE:mailto:${attendee}`,
    'END:VEVENT', 'END:VCALENDAR', '',
  ].join('\r\n');
}

/** Send one email. Never throws. Returns { sent, mode, delivered_to, note }. */
export async function send(toName, toEmail, subject, body, caseId, ics = null) {
  const { mode, ready } = status();
  const fail = (note) => {
    console.log(`[mail] NOT SENT (case ${caseId}, mode ${mode}): ${note}`);
    return { sent: false, mode, delivered_to: '', note };
  };

  if (mode === 'off') return fail('recorded only; email sending is off');
  if (!ready) return fail('not sent: Gmail address or app password is missing in .env');
  if (mode === 'live' && !toEmail) return fail(`not sent: no email address for ${toName} in the contacts workbook`);
  if (mode === 'live' && toEmail.endsWith('.example')) return fail(`not sent: ${toEmail} is a sample address; put the real one in the contacts workbook`);

  const to = mode === 'live' ? toEmail : config.TEST_INBOX || config.GMAIL_ADDRESS;
  const tag = `[E360-${caseId}]`;
  const testLine = mode === 'test' ? `[TEST MODE: in live mode this would go to ${toName} <${toEmail || 'no address on file'}>]\n\n` : '';
  const message = {
    from: `${config.CEO_NAME} <${config.GMAIL_ADDRESS}>`,
    to: `${toName} <${to}>`,
    subject: `${subject} ${tag}`,
    text: `${testLine}${body}\n\n--\nSent with Executive 360° on behalf of ${config.CEO_NAME}. Reply to this email to respond; keep ${tag} in the subject.`,
    headers: { 'X-E360-Out': String(caseId) }, // so our own outgoing mail is never read back as a reply
  };
  if (ics) message.icalEvent = { method: 'REQUEST', filename: 'invite.ics', content: ics };

  console.log(`[mail] sending case ${caseId} (${mode}) from ${config.GMAIL_ADDRESS} to ${to}${ics ? ' with calendar invite' : ''}: "${message.subject}"`);
  try {
    await transport.send(message);
  } catch (e) {
    console.error(`[mail] ERROR sending case ${caseId}: ${e.code || ''} ${e.message}`);
    if (e.responseCode === 535 || e.code === 'EAUTH') console.error('[mail] Gmail rejected the login. Use a Google app password (not your normal password) and check GMAIL_ADDRESS.');
    return fail(`not sent: ${String(e.message).slice(0, 120)}`);
  }
  console.log(`[mail] SENT case ${caseId} to ${to}`);
  return { sent: true, mode, delivered_to: to, note: mode === 'test' ? `test mode: delivered to ${to}` : `sent to ${to}` };
}

/** A reply's new text, without the quoted original underneath. */
function newText(parsed) {
  const text = parsed.text || String(parsed.html || '').replace(/<[^>]+>/g, ' ');
  const lines = text.split(/\r?\n/);
  const end = lines.findIndex((l) => l.startsWith('>') || /^On .+wrote:$/.test(l.trim()) || l.trim().startsWith('-----Original Message'));
  return (end < 0 ? lines : lines.slice(0, end)).join('\n').replace(/\n{3,}/g, '\n\n').trim();
}

/** Replies to our emails: [{ case_id, from, at, text, message_id }]. Empty if email is off or Gmail fails. */
export async function fetchReplies(since) {
  if (!status().ready) return [];
  let raw;
  try {
    raw = await transport.fetch(since);
    console.log(`[mail] checked inbox: ${raw.length} message(s) with an E360 tag`);
  } catch (e) {
    console.error(`[mail] ERROR reading inbox: ${e.code || ''} ${e.message}`);
    if (/auth|credentials|invalid/i.test(e.message)) console.error('[mail] Check the app password, and that IMAP is on in Gmail settings (Forwarding and POP/IMAP).');
    return [];
  }
  const { simpleParser } = await import('mailparser');
  const replies = [];
  for (const source of raw) {
    const msg = await simpleParser(source);
    const tag = /\[E360-(\d+)\]/.exec(String(msg.subject || ''));
    if (!tag || msg.headers.get('x-e360-out')) continue;
    const sender = msg.from?.value?.[0] || {};
    const at = msg.date instanceof Date && !Number.isNaN(msg.date.getTime()) ? msg.date : new Date();
    replies.push({
      case_id: Number(tag[1]),
      from: sender.name || sender.address || '',
      at,
      text: newText(msg).slice(0, 4000),
      message_id: String(msg.messageId || '').trim() || `${sender.address}-${at.toISOString()}`,
    });
  }
  console.log(`[mail] ${replies.length} reply(ies) matched to cases`);
  return replies;
}
