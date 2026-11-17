// Run locally:   npm start            (http://127.0.0.1:4000)
//                npm run dev          (restarts on file changes)
import config from './src/config.js';
import { createApp } from './src/app.js';

const app = createApp();
const server = app.listen(config.PORT, () => {
  console.log(`Executive 360 API listening on http://127.0.0.1:${config.PORT}`);
  console.log(`  workbook : ${config.WORKBOOK}`);
  console.log(`  assistant: ${config.ANTHROPIC_API_KEY ? 'on' : 'off (set ANTHROPIC_API_KEY in backend/.env)'}`);
});

// Look for email replies every few minutes and save them on their cases. Not used on Vercel (no always-on server).
if (config.REPLY_CHECK_MINUTES > 0 && config.MAIL_MODE !== 'off') {
  const check = () => app.checkReplies().catch((e) => console.error('[mail] reply check failed:', e.message));
  setInterval(check, config.REPLY_CHECK_MINUTES * 60 * 1000);
  setTimeout(check, 5000);
  console.log(`  replies  : checked every ${config.REPLY_CHECK_MINUTES} min`);
}

const stop = () => server.close(() => process.exit(0));
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
