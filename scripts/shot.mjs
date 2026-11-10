#!/usr/bin/env node
// Headless screenshot helper. Usage:
//   node shot.mjs <url|file.html> <out.png> [width=390] [height=844] [flags]
// Flags: --full (full page) --dark --reduced-motion --dpr=2 --wait=500 --scroll=<y px>
//        --selector=<css> (shoot one element) --click=<css> (click before shooting)
//        --cookie=name=value (repeatable via comma) --lang=<accept-language>
import puppeteer from 'puppeteer-core';
import { existsSync } from 'node:fs';
import path from 'node:path';
const argv = process.argv.slice(2);
const flags = {};
const pos = [];
for (const a of argv) {
  if (a.startsWith('--')) { const i = a.indexOf('='); if (i < 0) flags[a.slice(2)] = true; else flags[a.slice(2, i)] = a.slice(i + 1); }
  else pos.push(a);
}
const [url, out = 'shot.png', w = '390', h = '844'] = pos;
if (!url) { console.error('usage: node shot.mjs <url|file.html> <out.png> [width] [height] [--full] [--dark] [--reduced-motion] [--dpr=2] [--wait=500] [--scroll=y] [--selector=css] [--click=css] [--cookie=a=b,c=d]'); process.exit(2); }
const candidates = [process.env.CHROME_PATH,
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
  (process.env.LOCALAPPDATA || '') + '/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Microsoft/Edge/Application/msedge.exe'].filter(Boolean);
const executablePath = candidates.find(p => existsSync(p));
if (!executablePath) { console.error('No Chrome/Edge found; set CHROME_PATH'); process.exit(3); }
const browser = await puppeteer.launch({ executablePath, headless: true, args: ['--no-first-run', '--hide-scrollbars', '--force-color-profile=srgb', '--disable-extensions'] });
try {
  const page = await browser.newPage();
  const width = +w, height = +h;
  await page.setViewport({ width, height, deviceScaleFactor: +(flags.dpr ?? 2), isMobile: width < 768, hasTouch: width < 768 });
  const media = [];
  media.push({ name: 'prefers-color-scheme', value: flags.dark ? 'dark' : 'light' });
  if (flags['reduced-motion']) media.push({ name: 'prefers-reduced-motion', value: 'reduce' });
  await page.emulateMediaFeatures(media);
  const errors = [];
  page.on('pageerror', e => errors.push('pageerror: ' + String(e.message).slice(0, 300)));
  page.on('console', m => { if (m.type() === 'error') errors.push('console.error: ' + m.text().slice(0, 300)); });
  page.on('requestfailed', r => errors.push('requestfailed: ' + r.url().slice(0, 160)));
  const target = /^(https?|file):/.test(url) ? url : 'file:///' + path.resolve(url).split(path.sep).join('/');
  if (flags.cookie && /^https?:/.test(target)) {
    const u = new URL(target);
    for (const kv of String(flags.cookie).split(',')) { const i = kv.indexOf('='); await page.setCookie({ name: kv.slice(0, i), value: kv.slice(i + 1), domain: u.hostname, path: '/' }); }
  }
  if (flags.lang) await page.setExtraHTTPHeaders({ 'Accept-Language': String(flags.lang) });
  const resp = await page.goto(target, { waitUntil: 'networkidle2', timeout: 60000 });
  await page.evaluate(() => document.fonts && document.fonts.ready);
  await new Promise(r => setTimeout(r, +(flags.wait ?? 500)));
  if (flags.click) { await page.click(String(flags.click)); await new Promise(r => setTimeout(r, 700)); }
  if (flags.scroll) { await page.evaluate(y => window.scrollTo(0, y), +flags.scroll); await new Promise(r => setTimeout(r, 400)); }
  const metrics = await page.evaluate(() => ({ scrollWidth: document.documentElement.scrollWidth, innerWidth: window.innerWidth, pageHeight: document.documentElement.scrollHeight, dir: document.documentElement.dir, lang: document.documentElement.lang, title: document.title }));
  if (flags.selector) { const el = await page.$(String(flags.selector)); if (!el) throw new Error('selector not found: ' + flags.selector); await el.screenshot({ path: out }); }
  else await page.screenshot({ path: out, fullPage: !!flags.full });
  console.log(JSON.stringify({ out, status: resp ? resp.status() : null, horizontalOverflow: metrics.scrollWidth > metrics.innerWidth + 1, ...metrics, errors: errors.slice(0, 12) }));
} finally { await browser.close(); }
