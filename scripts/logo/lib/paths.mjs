// SVG path data in and out, for scripts/logo/trace.mjs. A subpath is { start: [x, y], segments: [{ type: "C" | "L", points }] }
// with absolute coordinates.

export const NUMBER = /-?\d*\.?\d+(?:e[-+]?\d+)?/gi;

/**
 * Reads M / C / L / H / V / Z path data, absolute or relative: potrace's output ("M x y",
 * "C x1 y1, x2 y2, x y", "L x1 y1 x2 y2") and the compact relative form this script writes.
 * Returns subpaths with absolute coordinates and only C and L segments.
 */
export function parsePath(d) {
  const subpaths = [];
  let current = null;
  let x = 0;
  let y = 0;
  for (const [, command, body] of d.matchAll(/([MmCcLlHhVvZz])([^MmCcLlHhVvZz]*)/g)) {
    const n = (body.match(NUMBER) ?? []).map(Number);
    const relative = command !== command.toUpperCase();
    const ox = relative ? x : 0;
    const oy = relative ? y : 0;
    switch (command.toUpperCase()) {
      case "M":
        x = ox + n[0];
        y = oy + n[1];
        current = { start: [x, y], segments: [] };
        subpaths.push(current);
        break;
      case "C":
        for (let i = 0; i + 5 < n.length; i += 6) {
          const bx = relative ? x : 0;
          const by = relative ? y : 0;
          const points = [bx + n[i], by + n[i + 1], bx + n[i + 2], by + n[i + 3], bx + n[i + 4], by + n[i + 5]];
          current.segments.push({ type: "C", points });
          x = points[4];
          y = points[5];
        }
        break;
      case "L":
        for (let i = 0; i + 1 < n.length; i += 2) {
          x = (relative ? x : 0) + n[i];
          y = (relative ? y : 0) + n[i + 1];
          current.segments.push({ type: "L", points: [x, y] });
        }
        break;
      case "H":
        for (const value of n) {
          x = (relative ? x : 0) + value;
          current.segments.push({ type: "L", points: [x, y] });
        }
        break;
      case "V":
        for (const value of n) {
          y = (relative ? y : 0) + value;
          current.segments.push({ type: "L", points: [x, y] });
        }
        break;
      default: // Z
        [x, y] = current.start;
    }
  }
  return subpaths;
}

export function mapSubpaths(subpaths, fn) {
  return subpaths.map((sub) => ({
    start: fn(sub.start[0], sub.start[1]),
    segments: sub.segments.map((segment) => {
      const points = [];
      for (let i = 0; i < segment.points.length; i += 2) points.push(...fn(segment.points[i], segment.points[i + 1]));
      return { type: segment.type, points };
    }),
  }));
}

/** Polyline approximation of a subpath (for boxes). */
export function flatten(sub, steps = 12) {
  const points = [sub.start];
  let [px, py] = sub.start;
  for (const segment of sub.segments) {
    if (segment.type === "L") {
      [px, py] = segment.points;
      points.push([px, py]);
    } else {
      const [x1, y1, x2, y2, x, y] = segment.points;
      for (let s = 1; s <= steps; s++) {
        const t = s / steps;
        const u = 1 - t;
        points.push([u * u * u * px + 3 * u * u * t * x1 + 3 * u * t * t * x2 + t * t * t * x, u * u * u * py + 3 * u * u * t * y1 + 3 * u * t * t * y2 + t * t * t * y]);
      }
      px = x;
      py = y;
    }
  }
  return points;
}

export function boxOf(subpaths) {
  let x0 = Infinity;
  let y0 = Infinity;
  let x1 = -Infinity;
  let y1 = -Infinity;
  for (const sub of subpaths) {
    for (const [x, y] of flatten(sub)) {
      if (x < x0) x0 = x;
      if (y < y0) y0 = y;
      if (x > x1) x1 = x;
      if (y > y1) y1 = y;
    }
  }
  return [x0, y0, x1, y1];
}

/**
 * Compact path data: every subpath starts with an absolute M and continues with relative c / l /
 * h / v, closed by z. Each relative step is taken between ROUNDED absolute positions, so rounding
 * never accumulates along a contour.
 */
export function toPathData(subpaths, digits) {
  const scale = 10 ** digits;
  const snap = (v) => Math.round(v * scale) / scale;
  const text = (v) => {
    const fixed = v.toFixed(digits);
    const trimmed = fixed.includes(".") ? fixed.replace(/\.?0+$/, "") : fixed;
    return trimmed === "-0" ? "0" : trimmed.replace(/^(-?)0\./, "$1.");
  };
  // Numbers may follow each other without a space when the next one starts with a minus sign.
  const join = (numbers) => numbers.map(text).reduce((out, n) => out + (out && !n.startsWith("-") ? " " : "") + n, "");
  return subpaths
    .map((sub) => {
      let x = snap(sub.start[0]);
      let y = snap(sub.start[1]);
      let d = `M${join([x, y])}`;
      let previous = "";
      for (const segment of sub.segments) {
        const absolute = segment.points.map(snap);
        const endX = absolute[absolute.length - 2];
        const endY = absolute[absolute.length - 1];
        let command;
        let numbers;
        if (segment.type === "C") {
          command = "c";
          numbers = absolute.map((v, i) => v - (i % 2 === 0 ? x : y));
        } else if (endY === y && endX !== x) {
          command = "h";
          numbers = [endX - x];
        } else if (endX === x && endY !== y) {
          command = "v";
          numbers = [endY - y];
        } else {
          command = "l";
          numbers = [endX - x, endY - y];
        }
        const body = join(numbers);
        d += command === previous ? (body.startsWith("-") ? "" : " ") + body : command + body;
        previous = command;
        x = endX;
        y = endY;
      }
      return `${d}z`;
    })
    .join("");
}
