#!/usr/bin/env node
// TamTam Games — icon sprite.
//
// Builds, from @phosphor-icons/core (MIT):
//   public/icons.svg            one SVG sprite: <symbol id="name"> per icon, drawn in currentColor
//   app/art/icons/names.ts      ICON_NAMES, the IconName union, the fill and RTL-mirroring lists
//
// Regular weight for everything; the "fill" weight additionally, under id "<name>-fill", for the
// icons listed in FILLED (active tab states, rating stars, status badges).
//
// Usage: npm run icons            (node scripts/icons.mjs)
//        node scripts/icons.mjs --check   exits 1 if the generated files are out of date
//
// To add an icon: put its exact Phosphor name (https://phosphoricons.com) in a group below and run
// the script. Names that do not exist stop the build, unless SUBSTITUTIONS maps them to one that does.

import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const ASSETS = path.join(ROOT, "node_modules/@phosphor-icons/core/assets");
const SPRITE = path.join(ROOT, "public/icons.svg");
const NAMES = path.join(ROOT, "app/art/icons/names.ts");

/** Curated set, grouped the way the design-system page shows it. */
const GROUPS = {
  navigation: [
    "house", "squares-four", "shopping-bag", "shopping-cart-simple", "heart", "user", "magnifying-glass", "bell", "list", "x",
    "dots-three", "dots-three-vertical", "caret-up", "caret-down", "caret-left", "caret-right", "caret-up-down",
    "arrow-up", "arrow-down", "arrow-left", "arrow-right", "arrow-u-up-left", "arrow-square-out",
  ],
  actions: [
    "plus", "minus", "check", "check-circle", "trash", "pencil-simple", "copy", "share-network", "upload-simple", "download-simple",
    "funnel", "sliders-horizontal", "sort-ascending", "arrows-clockwise", "arrow-counter-clockwise", "swap", "scales", "eye", "eye-slash",
    "sign-in", "sign-out", "lock", "key", "printer", "link", "floppy-disk", "paperclip", "paper-plane-tilt",
  ],
  status: [
    "warning", "warning-circle", "info", "question", "x-circle", "seal-check", "shield-check", "clock", "hourglass", "wifi-slash",
    "cloud-slash", "lightning", "fire", "sparkle", "star", "circle-notch", "trend-up", "trend-down",
  ],
  commerce: [
    "tag", "percent", "gift", "receipt", "credit-card", "wallet", "money", "bank", "truck", "package", "map-pin", "calendar-blank",
    "storefront", "barcode", "qr-code", "coins", "currency-dollar", "ticket", "hand-coins", "recycle", "certificate",
  ],
  devices: [
    "game-controller", "joystick", "headphones", "device-mobile", "desktop", "monitor", "hard-drives", "sd-card", "disc", "cpu",
    "battery-high", "battery-low", "plug", "usb",
  ],
  support: [
    "wrench", "toolbox", "first-aid-kit", "chat-circle", "phone", "whatsapp-logo", "envelope-simple", "robot", "lifebuoy", "book-open",
    "clipboard-text", "file-text", "image", "camera",
  ],
  admin: [
    "chart-bar", "chart-line", "users", "user-gear", "gear", "buildings", "factory", "flag", "stack", "table", "kanban",
    "bell-ringing", "database", "plugs-connected", "bug", "pulse",
  ],
  preferences: ["sun", "moon", "globe", "translate"],
};

/**
 * Requested names Phosphor does not have → the Phosphor icon used instead. The symbol keeps the
 * Phosphor name (the requested one is not an alias), so the sprite never claims an icon it lacks.
 *   sd-card → sim-card: Phosphor has no memory-card glyph; the SIM card (a card with a clipped
 *   corner and a contact pad) is the closest silhouette.
 */
const SUBSTITUTIONS = { "sd-card": "sim-card" };

/** Icons that also get the fill weight as "<name>-fill". */
const FILLED = [
  "house", "squares-four", "shopping-bag", "shopping-cart-simple", "heart", "user", // bottom-navigation tabs, active state
  "bell", "star", // unread notifications, rating stars
  "check-circle", "warning", "x-circle", "info", "seal-check", // status badges and toasts
];

/**
 * Icons flipped horizontally in right-to-left layouts: they show a direction of travel or of
 * reading, which runs the other way in Arabic and Kurdish (Sorani). Pictures of objects (a
 * magnifying glass, a phone), clockwise motion and charts are not flipped.
 * `question` is here because Arabic-script languages write the question mark mirrored (؟).
 */
const MIRRORED_IN_RTL = [
  "arrow-left", "arrow-right", "caret-left", "caret-right", "arrow-u-up-left", "arrow-square-out",
  "sign-in", "sign-out", "paper-plane-tilt", "sort-ascending", "truck", "question",
];

// ───────────────────────────────────────────── build

const check = process.argv.includes("--check");
const problems = [];
const substituted = [];

const resolve = (name) => {
  if (existsSync(path.join(ASSETS, "regular", `${name}.svg`))) return name;
  const replacement = SUBSTITUTIONS[name];
  if (replacement && existsSync(path.join(ASSETS, "regular", `${replacement}.svg`))) {
    substituted.push(`${name} → ${replacement}`);
    return replacement;
  }
  problems.push(`"${name}" is not a Phosphor icon name (and has no substitution)`);
  return null;
};

const groups = Object.fromEntries(Object.entries(GROUPS).map(([group, names]) => [group, names.map(resolve).filter(Boolean)]));
const regular = Object.values(groups).flat();
for (const name of new Set(regular)) if (regular.indexOf(name) !== regular.lastIndexOf(name)) problems.push(`"${name}" is listed twice`);
for (const name of FILLED) if (!regular.includes(name)) problems.push(`FILLED lists "${name}", which is not in a group`);
for (const name of MIRRORED_IN_RTL) if (!regular.includes(name)) problems.push(`MIRRORED_IN_RTL lists "${name}", which is not in a group`);

/** Reads one Phosphor asset and returns the markup inside its <svg>. */
async function shapes(weight, file) {
  const source = await readFile(path.join(ASSETS, weight, `${file}.svg`), "utf8");
  const match = /^<svg xmlns="http:\/\/www\.w3\.org\/2000\/svg" viewBox="0 0 256 256" fill="currentColor">(.*)<\/svg>\s*$/s.exec(source);
  if (!match) {
    problems.push(`${weight}/${file}.svg does not have the expected Phosphor wrapper`);
    return "";
  }
  if (/(?:fill|stroke)="(?!currentColor|none)/.test(match[1]) || /<(?:script|style|foreignObject|image|use)\b/i.test(match[1])) {
    problems.push(`${weight}/${file}.svg contains markup the sprite does not allow`);
    return "";
  }
  return match[1];
}

const symbols = [];
for (const name of regular) symbols.push({ id: name, body: await shapes("regular", name) });
for (const name of FILLED) {
  if (!existsSync(path.join(ASSETS, "fill", `${name}-fill.svg`))) {
    problems.push(`no fill weight for "${name}"`);
    continue;
  }
  symbols.push({ id: `${name}-fill`, body: await shapes("fill", `${name}-fill`) });
}

if (problems.length) {
  console.error(`icons: ${problems.length} problem(s)\n  ${problems.join("\n  ")}`);
  process.exit(1);
}

const sprite =
  `<svg xmlns="http://www.w3.org/2000/svg">` +
  `<!-- TamTam Games icon sprite. Generated by scripts/icons.mjs — do not edit. Icons: Phosphor Icons, MIT License, Copyright (c) 2023 Phosphor Icons, https://phosphoricons.com -->` +
  symbols.map(({ id, body }) => `<symbol id="${id}" viewBox="0 0 256 256" fill="currentColor">${body}</symbol>`).join("") +
  `</svg>\n`;
const revision = createHash("sha256").update(sprite).digest("hex").slice(0, 10);

const list = (names, indent = "  ") => names.map((name) => `${indent}${JSON.stringify(name)},`).join("\n");
const names = `// GENERATED by scripts/icons.mjs — do not edit by hand; run \`npm run icons\`.
// Source: @phosphor-icons/core (MIT). Add or remove icons in scripts/icons.mjs.

/** Every symbol in public/icons.svg. "<name>-fill" is the filled weight of "<name>". */
export const ICON_NAMES = [
${list(symbols.map((symbol) => symbol.id))}
] as const;

export type IconName = (typeof ICON_NAMES)[number];

/** Icons by purpose, regular weight only — for the design-system page and for finding the right one. */
export const ICON_GROUPS = {
${Object.entries(groups)
  .map(([group, members]) => `  ${group}: [${members.map((name) => JSON.stringify(name)).join(", ")}],`)
  .join("\n")}
} as const satisfies Record<string, readonly IconName[]>;

/** Icons that have a filled weight in the sprite ("<name>-fill"); see the \`filled\` prop of <Icon>. */
export const ICONS_WITH_FILL: ReadonlySet<IconName> = new Set<IconName>([
${list(FILLED)}
]);

/** Icons that <Icon> flips horizontally in right-to-left layouts (direction of travel or reading). */
export const ICONS_MIRRORED_IN_RTL: ReadonlySet<IconName> = new Set<IconName>([
${list(MIRRORED_IN_RTL)}
]);

/** Sprite address. The query changes whenever the sprite does, so an old cached copy is never used. */
export const ICON_SPRITE_HREF = "/icons.svg?r=${revision}";
`;

const current = async (file) => (existsSync(file) ? readFile(file, "utf8") : "");
if (check) {
  const stale = [];
  if ((await current(SPRITE)) !== sprite) stale.push("public/icons.svg");
  if ((await current(NAMES)) !== names) stale.push("app/art/icons/names.ts");
  if (stale.length) {
    console.error(`icons: out of date — run \`npm run icons\` (${stale.join(", ")})`);
    process.exit(1);
  }
  console.log(`icons: up to date (${symbols.length} symbols)`);
} else {
  await mkdir(path.dirname(SPRITE), { recursive: true });
  await mkdir(path.dirname(NAMES), { recursive: true });
  await writeFile(SPRITE, sprite);
  await writeFile(NAMES, names);
  console.log(`icons: ${regular.length} regular + ${FILLED.length} fill = ${symbols.length} symbols, ${Buffer.byteLength(sprite)} bytes → public/icons.svg (r=${revision})`);
  if (substituted.length) console.log(`icons: substituted ${substituted.join(", ")}`);
}
