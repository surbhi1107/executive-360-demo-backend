// Vercel entry point: Vercel runs this file as a serverless function instead of `node server.js`.
// An Express app is a (req, res) handler, so it can be exported as it is.
import { createApp } from '../src/app.js';

export default createApp();
