// Imported first by every test file: freezes the date at the one the sample data describes and uses a
// throw-away database, so tests need no API key, no internet and leave nothing behind.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.E360_AS_OF = '2026-11-14';
process.env.E360_DB = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'e360-test-')), 'test.db');
process.env.ANTHROPIC_API_KEY = '';
delete process.env.E360_USER;
delete process.env.E360_PASSWORD;
