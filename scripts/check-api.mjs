// Read-only smoke test: verifies SAI_API_KEY and lists computers. Starts no tasks.
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { SaiApi } = require('../src/sai-api.js');

const key = process.env.SAI_API_KEY;
if (!key) {
  console.error('Set SAI_API_KEY first.');
  process.exit(1);
}
const api = new SaiApi(key, process.env.SAI_API_URL);
const me = await api.auth();
console.log('auth ok, keys:', Object.keys(me).join(', '));
for (const m of await api.machines()) {
  console.log(`- ${m.name ?? '(unnamed)'} [${m.kind ?? '?'}] online=${m.online ?? m.status}`);
}
