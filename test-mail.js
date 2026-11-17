// Run:  node test-mail.js   (sends one test email using the settings in .env and prints the full result)
import 'dotenv/config';
import nodemailer from 'nodemailer';

const user = process.env.GMAIL_ADDRESS;
const pass = (process.env.GMAIL_APP_PASSWORD || '').replace(/\s/g, '');
const to = process.env.E360_TEST_INBOX || user;
console.log('From:', user, '| To:', to, '| App password length:', pass.length, '(Gmail app passwords are 16)');

const tx = nodemailer.createTransport({
  host: 'smtp.gmail.com', port: 465, secure: true,
  auth: { user, pass }, tls: { rejectUnauthorized: false },
});

try {
  await tx.verify();
  console.log('1. Login to Gmail: OK');
  const r = await tx.sendMail({ from: user, to, subject: 'Executive 360 test email', text: 'It works.' });
  console.log('2. Email sent:', r.response);
} catch (e) {
  console.error('FAILED:', e.code, '-', e.message);
  if (e.response) console.error('Gmail said:', e.response);
}
