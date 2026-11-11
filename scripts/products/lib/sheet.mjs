/**
 * Review sheets for product photos: one row per picture, built from the published 720 px PNG.
 *
 *   [light stage] [dark stage] [left edge ×3, dark] [bottom edge ×3, dark] [left edge ×3, light]
 *
 * The stages use the storefront's tokens (app/styles/tokens.css: --stage light #e9e2dc, dark #34363f).
 * Opaque pictures are drawn the way <Art> draws them: in a rounded frame filled with their recorded
 * background; their zoom cells show the 240 px and 120 px sizes instead.
 */
import sharp from 'sharp';

const LIGHT = '#e9e2dc';
const DARK = '#34363f';
const CELL = 300;
const LABEL = 24;
const ZOOM = 3;
const COLUMNS = 5;

const escapeXml = (text) => String(text).replace(/[<>&"]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;' })[c]);

const panel = (width, height, background) => sharp({ create: { width, height, channels: 4, background } }).png().toBuffer();

function label(text, width) {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${LABEL}"><rect width="100%" height="100%" fill="#ffffff"/>` +
    `<text x="8" y="16" font-family="Segoe UI, Arial, sans-serif" font-size="13" fill="#111111">${escapeXml(text)}</text></svg>`;
  return sharp(Buffer.from(svg)).png().toBuffer();
}

/** The picture fitted into a box; opaque ones get the rounded frame <Art> gives them. */
async function fitted(file, box, picture) {
  const { data, info } = await sharp(file).resize({ width: box, height: box, fit: 'inside' }).ensureAlpha().png().toBuffer({ resolveWithObject: true });
  if (picture.transparent) return { input: data, width: info.width, height: info.height };
  const radius = Math.max(4, Math.round(Math.min(info.width, info.height) * 0.06));
  const mask = Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${info.width}" height="${info.height}"><rect width="${info.width}" height="${info.height}" rx="${radius}" fill="#fff"/></svg>`);
  const framed = await sharp(data).composite([{ input: mask, blend: 'dest-in' }]).png().toBuffer();
  return { input: framed, width: info.width, height: info.height };
}

/** A ZOOM× nearest-neighbour crop around a point on the object's outline. */
async function zoom(file, where) {
  const { data, info } = await sharp(file).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const { width: w, height: h } = info;
  let minX = w, minY = h, maxX = -1, maxY = -1;
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    if (data[(y * w + x) * 4 + 3] < 128) continue;
    if (x < minX) minX = x; if (x > maxX) maxX = x; if (y < minY) minY = y; if (y > maxY) maxY = y;
  }
  if (maxX < 0) return null;
  let cx, cy;
  if (where === 'left') {
    cy = Math.round((minY + maxY) / 2);
    cx = minX;
    for (let x = 0; x < w; x++) if (data[(cy * w + x) * 4 + 3] >= 128) { cx = x; break; }
  } else {
    cx = Math.round((minX + maxX) / 2);
    cy = maxY;
    for (let y = h - 1; y >= 0; y--) if (data[(y * w + cx) * 4 + 3] >= 128) { cy = y; break; }
  }
  const size = Math.floor(CELL / ZOOM);
  const left = Math.max(0, Math.min(w - size, cx - size / 2)), top = Math.max(0, Math.min(h - size, cy - size / 2));
  const cropW = Math.min(size, w), cropH = Math.min(size, h);
  const buffer = await sharp(data, { raw: { width: w, height: h, channels: 4 } })
    .extract({ left: Math.round(left), top: Math.round(top), width: cropW, height: cropH })
    .resize({ width: cropW * ZOOM, height: cropH * ZOOM, kernel: 'nearest' })
    .png().toBuffer();
  return { input: buffer, width: cropW * ZOOM, height: cropH * ZOOM };
}

/**
 * @param {string} file  where to write the sheet (PNG)
 * @param {{ label: string, file: string, transparent: boolean, background: string | null }[]} rows
 */
export async function writeSheet(file, rows) {
  const width = CELL * COLUMNS;
  const rowHeight = LABEL + CELL;
  const layers = [];
  const place = (img, left, top) => layers.push({ input: img.input, left: Math.round(left + (CELL - img.width) / 2), top: Math.round(top + (CELL - img.height) / 2) });
  for (const [index, row] of rows.entries()) {
    const top = index * rowHeight;
    layers.push({ input: await label(row.label, width), left: 0, top });
    const y = top + LABEL;
    const backgrounds = [LIGHT, DARK, DARK, DARK, LIGHT];
    for (const [column, background] of backgrounds.entries()) layers.push({ input: await panel(CELL, CELL, background), left: column * CELL, top: y });
    const big = await fitted(row.file, CELL - 36, row);
    place(big, 0, y);
    place(big, CELL, y);
    if (row.transparent) {
      for (const [column, where] of [[2, 'left'], [3, 'bottom'], [4, 'left']]) {
        const crop = await zoom(row.file, where);
        if (crop) place(crop, column * CELL, y);
      }
    } else {
      place(await fitted(row.file, 240, row), 2 * CELL, y);
      place(await fitted(row.file, 120, row), 3 * CELL, y);
      place(await fitted(row.file, 120, row), 4 * CELL, y);
    }
  }
  await sharp({ create: { width, height: Math.max(1, rows.length * rowHeight), channels: 4, background: '#ffffff' } })
    .composite(layers)
    .png({ compressionLevel: 6 })
    .toFile(file);
  return file;
}
