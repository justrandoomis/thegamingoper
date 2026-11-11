#!/usr/bin/env node
/**
 * Contact sheets for the visual QA of product photos: every published photo of a catalogue group at
 * 720 px (its 720 WebP, or the largest it has), drawn the way <Art> draws it — transparent photos
 * as they are, opaque ones in a rounded frame (--r-md) filled with their recorded background — on
 * the page floor (--ground) of each theme, read from app/styles/tokens.css.
 *
 *   node scripts/products/contact-sheets.mjs                 every group
 *   node scripts/products/contact-sheets.mjs --group a,b     these groups
 *   node scripts/products/contact-sheets.mjs --only slug,…   these products (one sheet, "selection")
 *   node scripts/products/contact-sheets.mjs --keys k1,k2    these images (one sheet, "selection")
 *   options: --cell=360 (cell size) --columns=4 --rows=4 (rows per page)
 *
 * Writes .shots/catalog/<group>-light.png and -dark.png (the whole group), and the same cut into pages
 * of columns × rows cells, .shots/catalog/pages/<group>-<theme>-<nn>.png, small enough to inspect at
 * full size. Labels: key · kind · how it was treated (from .cache/product-images/_report.json) · size.
 */
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const OUT = path.join(ROOT, '.shots', 'catalog');
const PAGES = path.join(OUT, 'pages');

const flags = Object.fromEntries(process.argv.slice(2).map((arg) => {
  const [name, ...value] = arg.replace(/^--/, '').split('=');
  return [name, value.length ? value.join('=') : true];
}));
const list = (value) => (typeof value === 'string' ? value.split(',').map((s) => s.trim()).filter(Boolean) : null);
const CELL = Number(flags.cell) || 360;
const COLUMNS = Number(flags.columns) || 4;
const ROWS = Number(flags.rows) || 4;
const LABEL = 34;
const GAP = 8;

/** --ground of the light and the dark theme, as the storefront paints the floor. */
function floors() {
  const css = readFileSync(path.join(ROOT, 'app', 'styles', 'tokens.css'), 'utf8');
  // the rule block of the theme (not a mention in a comment): `[data-theme="x"] { … }`
  const ground = (theme) => {
    const block = new RegExp(`\\[data-theme="${theme}"\\]\\s*\\{([^}]*)\\}`).exec(css)?.[1] ?? '';
    const match = /--ground:\s*(#[0-9a-fA-F]{6})/.exec(block);
    if (!match) throw new Error(`no --ground in the ${theme} theme of tokens.css`);
    return match[1];
  };
  const radius = Number(/--r-md:\s*(\d+)px/.exec(css)?.[1] ?? 16);
  return { light: ground('light'), dark: ground('dark'), radius };
}

const escapeXml = (text) => String(text).replace(/[<>&"]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;' })[c]);

async function label(lines, width, theme) {
  const ink = theme === 'dark' ? '#f5f1ec' : '#1f2126';
  const text = lines.map((line, i) => `<text x="4" y="${13 + i * 15}" font-family="Segoe UI, Arial, sans-serif" font-size="12" fill="${ink}">${escapeXml(line)}</text>`).join('');
  return sharp(Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${LABEL}">${text}</svg>`)).png().toBuffer();
}

/** The photo as <Art> shows it, fitted into the cell. */
async function picture(manifest, box, radius) {
  const variant = manifest.variants.webp.find((v) => v.w >= 720) ?? manifest.variants.webp.at(-1);
  const file = path.join(ROOT, 'public', variant.src);
  const { data, info } = await sharp(file).resize({ width: box, height: box, fit: 'inside', kernel: 'lanczos3' }).ensureAlpha().png().toBuffer({ resolveWithObject: true });
  if (manifest.transparent) return { input: data, width: info.width, height: info.height };
  // an opaque photo: rounded frame, filled with its background (box art and screenshots fill their frame)
  const r = Math.round(radius * (info.width / Math.min(720, manifest.width)) * (720 / 480)); // --r-md at a ~480 px slot
  const fill = manifest.background ?? '#000000';
  const frame = `<svg xmlns="http://www.w3.org/2000/svg" width="${info.width}" height="${info.height}"><rect width="100%" height="100%" rx="${r}" fill="${fill}"/></svg>`;
  const mask = `<svg xmlns="http://www.w3.org/2000/svg" width="${info.width}" height="${info.height}"><rect width="100%" height="100%" rx="${r}" fill="#fff"/></svg>`;
  const input = await sharp(Buffer.from(frame)).composite([{ input: data }, { input: Buffer.from(mask), blend: 'dest-in' }]).png().toBuffer();
  return { input, width: info.width, height: info.height };
}

async function sheet(file, items, theme, floor, radius) {
  const width = COLUMNS * CELL + (COLUMNS + 1) * GAP;
  const rows = Math.ceil(items.length / COLUMNS);
  const height = Math.max(1, rows * (CELL + LABEL + GAP) + GAP);
  const layers = [];
  for (const [index, item] of items.entries()) {
    const left = GAP + (index % COLUMNS) * (CELL + GAP);
    const top = GAP + Math.floor(index / COLUMNS) * (CELL + LABEL + GAP);
    layers.push({ input: await label(item.label, CELL, theme), left, top });
    const img = await picture(item.manifest, CELL - 16, radius);
    layers.push({ input: img.input, left: left + Math.round((CELL - img.width) / 2), top: top + LABEL + Math.round((CELL - img.height) / 2) });
  }
  await sharp({ create: { width, height, channels: 4, background: floor } }).composite(layers).png({ compressionLevel: 6 }).toFile(file);
  return file;
}

async function main() {
  const { light, dark, radius } = floors();
  const catalog = path.join(ROOT, 'catalog', 'products');
  let report = {};
  try { report = JSON.parse(readFileSync(path.join(ROOT, '.cache', 'product-images', '_report.json'), 'utf8')); } catch { /* none yet */ }
  const groups = new Map();
  const onlySlugs = list(flags.only), onlyKeys = list(flags.keys), onlyGroups = list(flags.group);
  for (const file of readdirSync(catalog).filter((f) => f.endsWith('.json')).sort()) {
    const product = JSON.parse(readFileSync(path.join(catalog, file), 'utf8'));
    if (onlySlugs && !onlySlugs.includes(product.slug)) continue;
    if (onlyGroups && !onlyGroups.includes(product.group)) continue;
    const group = onlySlugs || onlyKeys ? 'selection' : product.group;
    for (const image of product.images ?? []) {
      if (onlyKeys && !onlyKeys.includes(image.key)) continue;
      const manifestFile = path.join(ROOT, 'app', 'art', 'photos', `${image.key}.json`);
      if (!existsSync(manifestFile)) { console.warn(`! ${image.key}: no manifest (not built)`); continue; }
      const manifest = JSON.parse(readFileSync(manifestFile, 'utf8'));
      const decided = report[image.key];
      const how = decided?.method ?? (manifest.transparent ? 'transparent' : 'opaque');
      const options = decided?.options && Object.keys(decided.options).length ? ` [${Object.keys(decided.options).join(',')}]` : '';
      const lines = [`${image.key}`, `${image.kind} · ${how}${options} · ${manifest.width}×${manifest.height}${manifest.share ? ' · share' : ''}`];
      groups.set(group, [...(groups.get(group) ?? []), { label: lines, manifest }]);
    }
  }
  await fs.mkdir(PAGES, { recursive: true });
  for (const [group, items] of groups) {
    for (const [theme, floor] of [['light', light], ['dark', dark]]) {
      await sheet(path.join(OUT, `${group}-${theme}.png`), items, theme, floor, radius);
      const per = COLUMNS * ROWS;
      for (let page = 0; page * per < items.length; page++) {
        await sheet(path.join(PAGES, `${group}-${theme}-${String(page + 1).padStart(2, '0')}.png`), items.slice(page * per, (page + 1) * per), theme, floor, radius);
      }
    }
    console.log(`${group}: ${items.length} photos → .shots/catalog/${group}-{light,dark}.png, ${Math.ceil(items.length / (COLUMNS * ROWS))} page(s) each`);
  }
}

main().catch((error) => {
  console.error(error?.stack || String(error));
  process.exit(1);
});
