// How the four traced parts are arranged in each <Logo> variant.
//
// Every variant is the same artwork at the same relative size; only positions differ. A layout is
// a viewBox size plus, per part, the translation applied to the part's lockup coordinates.
//
//   stacked   the lockup exactly as supplied: mascot above طمطم above TAM TAM above GAMES
//   full      the same four parts side by side — mascot on the left, the three text lines (in
//             their original arrangement) on the right. This arrangement was composed here for
//             wide spaces; it is NOT in the supplied artwork and needs the owner's approval.
//   wordmark  طمطم alone
//   mark      the mascot alone

const one = (value) => Number(value.toFixed(1));

/**
 * @param {Record<"mascot" | "wordmark" | "latin" | "games", { box: number[] }>} parts
 * @param {{ width: number, height: number }} lockup
 */
export function buildLayouts(parts, lockup) {
  const mascot = parts.mascot.box;
  const wordmark = parts.wordmark.box;
  const latin = parts.latin.box;
  const games = parts.games.box;

  const textLeft = Math.min(wordmark[0], latin[0], games[0]);
  const textRight = Math.max(wordmark[0] + wordmark[2], latin[0] + latin[2], games[0] + games[2]);
  const textTop = wordmark[1];
  const textBottom = games[1] + games[3];
  const textHeight = textBottom - textTop;

  // Mascot and text block are almost the same height in the original; centre the shorter one.
  const height = Math.max(mascot[3], textHeight);
  const gap = mascot[2] * 0.2;
  const textX = mascot[2] + gap - textLeft;
  const textY = (height - textHeight) / 2 - textTop;

  return {
    full: {
      width: one(mascot[2] + gap + (textRight - textLeft)),
      height: one(height),
      parts: [
        { part: "mascot", x: one(-mascot[0]), y: one((height - mascot[3]) / 2 - mascot[1]) },
        { part: "wordmark", x: one(textX), y: one(textY) },
        { part: "latin", x: one(textX), y: one(textY) },
        { part: "games", x: one(textX), y: one(textY) },
      ],
    },
    stacked: {
      width: lockup.width,
      height: lockup.height,
      parts: [
        { part: "mascot", x: 0, y: 0 },
        { part: "wordmark", x: 0, y: 0 },
        { part: "latin", x: 0, y: 0 },
        { part: "games", x: 0, y: 0 },
      ],
    },
    wordmark: {
      width: wordmark[2],
      height: wordmark[3],
      parts: [{ part: "wordmark", x: one(-wordmark[0]), y: one(-wordmark[1]) }],
    },
    mark: {
      width: mascot[2],
      height: mascot[3],
      parts: [{ part: "mascot", x: one(-mascot[0]), y: one(-mascot[1]) }],
    },
  };
}

/** Standalone SVG markup of one layout. `fill` may be any CSS colour, including currentColor. */
export function renderLayoutSvg(data, variant, { fill = "currentColor", title, padding = 0, background, extra = "" } = {}) {
  const layout = data.layouts[variant];
  const width = one(layout.width + padding * 2);
  const height = one(layout.height + padding * 2);
  const groups = layout.parts
    .map(({ part, x, y }) => `<g data-part="${part}" transform="translate(${one(x + padding)} ${one(y + padding)})"><path fill-rule="evenodd" d="${data.parts[part].d}"/></g>`)
    .join("");
  const label = title ? ` role="img" aria-label="${title}"` : "";
  const back = background ? `<rect width="100%" height="100%" fill="${background}"/>` : "";
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} ${height}" fill="${fill}"${label}>${title ? `<title>${title}</title>` : ""}${extra}${back}${groups}</svg>\n`;
}
