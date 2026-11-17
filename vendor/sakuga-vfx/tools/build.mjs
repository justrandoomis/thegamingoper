// Stamp core.js into every component file, and the toggle's frames into toggle.js, so each file works on its own.
//   node tools/build.mjs          (run it after editing core.js or toggle/frames.webp)
//   node tools/build.mjs --check  (exits 1 if any file is out of date, and changes nothing)
import { readFileSync, writeFileSync, copyFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
export const NAMES = ['button', 'toggle', 'slider', 'checkbox', 'radio', 'input', 'tabs', 'progress', 'rating', 'toast', 'tooltip'];
const check = process.argv.includes('--check');
const core = readFileSync(join(root, 'core.js'), 'utf8').trim();
const sheet = 'data:image/webp;base64,' + readFileSync(join(root, 'toggle/frames.webp')).toString('base64');
const between = (src, name, body, file) => {
  const re = new RegExp(`(// >>> ${name}[^\\n]*\\n)[\\s\\S]*?(// <<< ${name})`);
  if (!re.test(src)) throw new Error(`${file}: no ${name} markers`);
  return src.replace(re, (_, a, b) => a + body + '\n' + b);
};
let stale = 0;
for (const n of NAMES) {
  const file = join(root, n, n + '.js'), was = readFileSync(file, 'utf8');
  let src = between(was, 'sakuga core', core, file);
  if (n === 'toggle') src = between(src, 'frames', `const SHEET = '${sheet}';`, file);
  if (src !== was) { stale++; if (!check) writeFileSync(file, src); console.log(`${check ? 'stale' : 'wrote'} ${n}/${n}.js`); }
}
if (!check) copyFileSync(join(root, 'core.js'), join(root, 'skills/sakuga-vfx/core.js'));
if (check && stale) process.exit(1);
