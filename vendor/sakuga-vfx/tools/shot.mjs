// node tools/shot.mjs URL OUTPREFIX W H SCALE [t1,t2,...]
// Film pages (?film=name) are stepped to each time and photographed; other pages wait and are captured once, full height.
// Env: CHROME (default chromium), JS (run in the page before the capture), WAIT (ms after JS, default 1500), MOBILE=1.
import { spawn } from 'node:child_process';
import { rmSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
const [URL_, OUT, W = '1080', H = '1080', SCALE = '1', TIMES = ''] = process.argv.slice(2);
const PORT = 9400 + Math.floor(Math.random() * 400);
const PROFILE = mkdtempSync(join(tmpdir(), 'ld-'));
const chrome = spawn(process.env.CHROME || 'chromium', [
  '--headless=new', `--remote-debugging-port=${PORT}`, `--user-data-dir=${PROFILE}`,
  '--no-first-run', '--hide-scrollbars', '--force-color-profile=srgb', `--window-size=${W},${H}`, 'about:blank',
], { stdio: 'ignore' });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let targets;
for (let i = 0; i < 50; i++) { try { targets = await (await fetch(`http://127.0.0.1:${PORT}/json`)).json(); if (targets.length) break; } catch {} await sleep(200); }
const ws = new WebSocket(targets.find((t) => t.type === 'page').webSocketDebuggerUrl);
await new Promise((r) => ws.addEventListener('open', r, { once: true }));
let id = 0; const pending = new Map(); const logs = [];
ws.addEventListener('message', (e) => {
  const m = JSON.parse(e.data);
  if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
  if (m.method === 'Runtime.exceptionThrown') logs.push('EXC ' + (m.params.exceptionDetails.exception?.description || m.params.exceptionDetails.text));
  if (m.method === 'Runtime.consoleAPICalled') logs.push('LOG ' + m.params.args.map((a) => a.value ?? a.description).join(' '));
});
const send = (method, params = {}) => new Promise((res, rej) => { const i = ++id; pending.set(i, (m) => (m.error ? rej(new Error(`${method}: ${m.error.message}`)) : res(m.result))); ws.send(JSON.stringify({ id: i, method, params })); });
const evaluate = async (expr) => { const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true }); if (r.exceptionDetails) logs.push('EVAL ' + (r.exceptionDetails.exception?.description || r.exceptionDetails.text)); return r.result.value; };
await send('Runtime.enable');
await send('Emulation.setDeviceMetricsOverride', { width: +W, height: +H, deviceScaleFactor: +SCALE, mobile: !!process.env.MOBILE });
await send('Page.enable');
await send('Page.navigate', { url: URL_ });
await sleep(900);
const snap = async (name, full) => {
  let clip;
  if (full) { const h = await evaluate('document.documentElement.scrollHeight'); clip = { x: 0, y: 0, width: +W, height: h, scale: 1 }; }
  const { data } = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: !!full, ...(clip ? { clip } : {}) });
  writeFileSync(name, Buffer.from(data, 'base64'));
};
if (TIMES) {
  let t = 0;
  for (const target of TIMES.split(',').map(Number)) {
    while (t < target) t = await evaluate('window.__film.step(30)');
    await snap(`${OUT}-${String(target).replace('.', '_')}.png`);
  }
} else {
  if (process.env.JS) { await evaluate(process.env.JS); await sleep(+(process.env.WAIT || 1500)); }
  await snap(`${OUT}.png`, true);
}
if (logs.length) console.log(logs.join('\n'));
console.log('ok', await evaluate('document.documentElement.scrollWidth'), 'x', await evaluate('document.documentElement.scrollHeight'));
ws.close(); chrome.kill(); await new Promise((r) => setTimeout(r, 300)); try { rmSync(PROFILE, { recursive: true, force: true }); } catch {}
