// Dev aid: print the latest turn's events for the most recent task (read-only).
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { SaiApi } = require('../src/sai-api.js');

const store = JSON.parse(fs.readFileSync(path.join(process.env.APPDATA, 'My Muse', 'store.json'), 'utf8'));
const task = store.tasks[0];
const api = new SaiApi(process.env.SAI_API_KEY, process.env.SAI_API_URL);
const page = await api.events(task.sessionId, undefined, 0);
console.log('task:', task.text, '| status:', page.status, '| keys:', Object.keys(page).join(','));
for (const e of page.events) {
  const s = JSON.stringify(e);
  if (/file|sai:\/\/|attach|artifact|url/i.test(s)) console.log(s.slice(0, 1200));
}
console.log('types:', [...new Set(page.events.map((e) => e.type))].join(', '));
