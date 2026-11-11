// Image operations on Float32 planes (one value per pixel, row by row) for scripts/logo/trace.mjs.

export const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);

export function gaussianKernel(sigma) {
  const radius = Math.max(1, Math.ceil(sigma * 3));
  const kernel = new Float32Array(radius * 2 + 1);
  let sum = 0;
  for (let i = -radius; i <= radius; i++) sum += kernel[i + radius] = Math.exp(-(i * i) / (2 * sigma * sigma));
  for (let i = 0; i < kernel.length; i++) kernel[i] /= sum;
  return { kernel, radius };
}

/** Separable Gaussian blur. `edge: "zero"` treats outside as 0 (for normalised convolution), "clamp" repeats the border. */
export function blur(src, w, h, sigma, edge = "clamp") {
  const { kernel, radius } = gaussianKernel(sigma);
  const tmp = new Float32Array(w * h);
  const out = new Float32Array(w * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let acc = 0;
      for (let k = -radius; k <= radius; k++) {
        let xx = x + k;
        if (xx < 0 || xx >= w) {
          if (edge === "zero") continue;
          xx = xx < 0 ? 0 : w - 1;
        }
        acc += src[y * w + xx] * kernel[k + radius];
      }
      tmp[y * w + x] = acc;
    }
  }
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let acc = 0;
      for (let k = -radius; k <= radius; k++) {
        let yy = y + k;
        if (yy < 0 || yy >= h) {
          if (edge === "zero") continue;
          yy = yy < 0 ? 0 : h - 1;
        }
        acc += tmp[yy * w + x] * kernel[k + radius];
      }
      out[y * w + x] = acc;
    }
  }
  return out;
}

/** Square-neighbourhood dilation (mode "max") or erosion (mode "min") of a 0/1 mask. */
export function morph(mask, w, h, radius, mode) {
  const out = new Uint8Array(w * h);
  const want = mode === "max" ? 1 : 0;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let hit = false;
      for (let dy = -radius; dy <= radius && !hit; dy++) {
        for (let dx = -radius; dx <= radius; dx++) {
          const xx = Math.min(w - 1, Math.max(0, x + dx));
          const yy = Math.min(h - 1, Math.max(0, y + dy));
          if (mask[yy * w + xx] === want) {
            hit = true;
            break;
          }
        }
      }
      out[y * w + x] = hit ? want : 1 - want;
    }
  }
  return out;
}

/**
 * Value of `values` averaged over the pixels selected by `mask` near each pixel (normalised
 * convolution), widening the neighbourhood until enough selected pixels are in reach.
 */
export function localLevel(values, mask, w, h, fallback) {
  const out = new Float32Array(w * h).fill(Number.NaN);
  const weighted = new Float32Array(w * h);
  const weight = new Float32Array(w * h);
  for (let i = 0; i < w * h; i++) {
    weight[i] = mask[i];
    weighted[i] = mask[i] ? values[i] : 0;
  }
  for (const sigma of [1.5, 3, 6, 12, 24]) {
    const num = blur(weighted, w, h, sigma, "zero");
    const den = blur(weight, w, h, sigma, "zero");
    let missing = 0;
    for (let i = 0; i < w * h; i++) {
      if (!Number.isNaN(out[i])) continue;
      if (den[i] > 0.04) out[i] = num[i] / den[i];
      else missing++;
    }
    if (!missing) break;
  }
  for (let i = 0; i < w * h; i++) if (Number.isNaN(out[i])) out[i] = fallback;
  return out;
}

/** Catmull-Rom enlargement by an integer factor, sampled at output pixel centres. */
export function enlarge(src, w, h, factor) {
  const W = w * factor;
  const H = h * factor;
  const taps = new Array(factor);
  for (let phase = 0; phase < factor; phase++) {
    const position = (phase + 0.5) / factor - 0.5; // relative to the centre of source pixel i
    const base = Math.floor(position);
    const t = position - base;
    taps[phase] = {
      base,
      weights: [(-t * t * t + 2 * t * t - t) / 2, (3 * t * t * t - 5 * t * t + 2) / 2, (-3 * t * t * t + 4 * t * t + t) / 2, (t * t * t - t * t) / 2],
    };
  }
  const tmp = new Float32Array(W * h);
  for (let y = 0; y < h; y++) {
    for (let X = 0; X < W; X++) {
      const { base, weights } = taps[X % factor];
      const i = Math.floor(X / factor) + base;
      let acc = 0;
      for (let k = 0; k < 4; k++) acc += src[y * w + Math.min(w - 1, Math.max(0, i - 1 + k))] * weights[k];
      tmp[y * W + X] = acc;
    }
  }
  const out = new Float32Array(W * H);
  for (let Y = 0; Y < H; Y++) {
    const { base, weights } = taps[Y % factor];
    const j = Math.floor(Y / factor) + base;
    for (let X = 0; X < W; X++) {
      let acc = 0;
      for (let k = 0; k < 4; k++) acc += tmp[Math.min(h - 1, Math.max(0, j - 1 + k)) * W + X] * weights[k];
      out[Y * W + X] = acc;
    }
  }
  return { data: out, width: W, height: H };
}

/** Area-average a plane down by an integer factor. */
export function shrink(src, W, H, factor) {
  const w = W / factor;
  const h = H / factor;
  const out = new Float32Array(w * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let acc = 0;
      for (let dy = 0; dy < factor; dy++) for (let dx = 0; dx < factor; dx++) acc += src[(y * factor + dy) * W + x * factor + dx];
      out[y * w + x] = acc / (factor * factor);
    }
  }
  return out;
}

/**
 * Coverage-consistent refinement of the enlarged matte.
 *
 * Plain interpolation + threshold has two faults at this resolution: diagonal edges come out wavy
 * (the staircase of the source pixels shows through) and strokes thinner than about half a source
 * pixel — hair tips, the brow — are cut off. Blurring fixes the first and worsens the second.
 *
 * Instead the enlarged image `u` is evolved until it is (a) almost binary, (b) bounded by smooth
 * contours and (c) still averages to the measured ink coverage of the source pixels. That is an
 * Allen–Cahn phase field (curvature flow, which irons out the staircase) with a fidelity force
 * (which stops the flow from eating thin strokes or moving edges):
 *
 *     u ← u + dt · ( ε·∇²u − W′(u)/ε − F ),   W = u²(1−u)²
 *     r = (mean of u over a source pixel) − (measured coverage of that pixel)
 *     F = μ·blur(r)  +  ν·r·(1 + (r/τ)²)
 *
 * The first fidelity term holds coverage over a small neighbourhood and holds it firmly. Single
 * source pixels are not reliable to better than about 0.1 (bevel shading, noise), and forcing each
 * of them exactly re-creates the staircase — so the per-pixel term is weak for small disagreements
 * and only becomes strong when a pixel is badly missed, which is what happens when a thin stroke
 * is about to disappear.
 */
export function refine(start, coverage, w, h, factor, { iterations, interfaceWidth, fidelity, fidelityRadius, pixelFidelity, pixelTolerance }) {
  const W = w * factor;
  const H = h * factor;
  const dt = 0.1;
  let u = Float32Array.from(start, clamp01);
  let next = Float32Array.from(u);
  const residual = new Float32Array(w * h);
  const force = new Float32Array(w * h);
  const settled = new Uint8Array(w * h); // source pixels that are entirely ink or entirely background
  const quiet = new Uint8Array(w * h);
  const area = factor * factor;
  // The forces are defined at 8× enlargement; at other factors they are rescaled so that the same
  // continuous problem is solved (finer grid → each enlarged pixel carries a smaller share).
  const share = 8 / factor;
  for (let iteration = 0; iteration < iterations; iteration++) {
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        let sum = 0;
        let low = 1;
        let high = 0;
        for (let dy = 0; dy < factor; dy++) {
          const row = (y * factor + dy) * W + x * factor;
          for (let dx = 0; dx < factor; dx++) {
            const value = u[row + dx];
            sum += value;
            if (value < low) low = value;
            if (value > high) high = value;
          }
        }
        residual[y * w + x] = sum / area - coverage[y * w + x];
        settled[y * w + x] = high < 0.02 || low > 0.98 ? 1 : 0;
      }
    }
    const neighbourhood = fidelityRadius > 0 ? blur(residual, w, h, fidelityRadius) : residual;
    for (let i = 0; i < w * h; i++) {
      const r = residual[i];
      const ratio = r / pixelTolerance;
      const perPixel = Math.max(-2.5, Math.min(2.5, pixelFidelity * r * (1 + ratio * ratio)));
      force[i] = share * (fidelity * neighbourhood[i] + perPixel);
    }
    // Nothing moves deep inside the shapes or far outside them: source pixels whose whole 3 × 3
    // neighbourhood is settled, and whose own coverage is not badly off, are only copied.
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        let still = Math.abs(residual[y * w + x]) < 0.25 ? 1 : 0;
        for (let yy = Math.max(0, y - 1); yy <= Math.min(h - 1, y + 1) && still; yy++) {
          for (let xx = Math.max(0, x - 1); xx <= Math.min(w - 1, x + 1); xx++) {
            if (!settled[yy * w + xx]) {
              still = 0;
              break;
            }
          }
        }
        quiet[y * w + x] = still;
      }
    }
    for (let Y = 0; Y < H; Y++) {
      const row = Y * W;
      const up = (Y > 0 ? Y - 1 : 0) * W;
      const down = (Y < H - 1 ? Y + 1 : H - 1) * W;
      const block = Math.floor(Y / factor) * w;
      for (let x = 0; x < w; x++) {
        const first = x * factor;
        const last = first + factor;
        if (quiet[block + x]) {
          for (let X = first; X < last; X++) next[row + X] = u[row + X];
          continue;
        }
        const push = force[block + x];
        for (let X = first; X < last; X++) {
          const value = u[row + X];
          const laplacian = u[row + (X > 0 ? X - 1 : 0)] + u[row + (X < W - 1 ? X + 1 : W - 1)] + u[up + X] + u[down + X] - 4 * value;
          const well = 2 * value * (1 - value) * (1 - 2 * value);
          const moved = value + dt * (interfaceWidth * laplacian - well / interfaceWidth - push);
          next[row + X] = moved < 0 ? 0 : moved > 1 ? 1 : moved;
        }
      }
    }
    [u, next] = [next, u];
  }
  return u;
}

/**
 * Drops ink islands smaller than `minIsland` pixels and fills enclosed holes smaller than
 * `minHole` pixels (4-connected components of a 0/1 mask). Returns what it changed.
 */
export function removeSpecks(mask, W, H, minIsland, minHole) {
  const seen = new Uint8Array(W * H);
  const stack = new Int32Array(W * H);
  const changed = { islands: 0, holes: 0 };
  for (let start = 0; start < W * H; start++) {
    if (seen[start]) continue;
    const kind = mask[start];
    let size = 0;
    let top = 0;
    let touchesBorder = false;
    stack[top++] = start;
    seen[start] = 1;
    while (top > size) {
      const i = stack[size++];
      const x = i % W;
      const y = (i - x) / W;
      if (x === 0 || y === 0 || x === W - 1 || y === H - 1) touchesBorder = true;
      if (x > 0 && !seen[i - 1] && mask[i - 1] === kind) {
        seen[i - 1] = 1;
        stack[top++] = i - 1;
      }
      if (x < W - 1 && !seen[i + 1] && mask[i + 1] === kind) {
        seen[i + 1] = 1;
        stack[top++] = i + 1;
      }
      if (y > 0 && !seen[i - W] && mask[i - W] === kind) {
        seen[i - W] = 1;
        stack[top++] = i - W;
      }
      if (y < H - 1 && !seen[i + W] && mask[i + W] === kind) {
        seen[i + W] = 1;
        stack[top++] = i + W;
      }
    }
    // `stack[0 … size)` now lists the component.
    const flip = kind === 1 ? size < minIsland : !touchesBorder && size < minHole;
    if (flip) {
      for (let k = 0; k < size; k++) mask[stack[k]] = 1 - kind;
      if (kind === 1) changed.islands++;
      else changed.holes++;
    }
  }
  return changed;
}
