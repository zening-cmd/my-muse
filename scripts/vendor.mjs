// Copies the Guacamole client into the renderer as a classic script (window.Guacamole).
// Run after `npm install`: npm run vendor
import fs from 'node:fs';
import path from 'node:path';

const src = path.resolve('node_modules/guacamole-common-js/dist/cjs/guacamole-common.min.js');
const out = path.resolve('src/renderer/vendor/guacamole-common.js');
const code = fs.readFileSync(src, 'utf8').replace(/module\.exports\s*=\s*Guacamole;?\s*$/, '');
fs.mkdirSync(path.dirname(out), { recursive: true });
fs.writeFileSync(out, `/* guacamole-common-js 1.5.0, Apache-2.0 */\n${code}\nwindow.Guacamole = Guacamole;\n`);
console.log('wrote', path.relative(process.cwd(), out));
