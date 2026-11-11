/** Types for cutout.mjs (the background treatment of product photos), for the TypeScript tests. */

export type PhotoKind = "hero" | "angle" | "detail" | "in-box" | "box-art" | "screenshot";

export const PHOTO_KINDS: readonly PhotoKind[];
/** Padding around a trimmed object, as a share of its longer side, on every side. */
export const PAD: number;
export const TREATMENT_VERSION: number;

/** 8-bit sRGB RGBA, straight alpha, row by row. */
export interface RawImage {
  data: Uint8Array;
  width: number;
  height: number;
}

export interface Treatment extends RawImage {
  /** true: background removed (or never there); the RGBA carries the alpha. false: every pixel is opaque. */
  transparent: boolean;
  /** "#rrggbb" of the background an opaque photo kept; null when transparent or not a plain background. */
  background: string | null;
  dominant: string;
  /**
   * alpha: the source was transparent · cutout: background removed · opaque: kept its plain
   * background (trimmed) · untouched: left as it is (box art, screenshots, busy backgrounds).
   */
  method: "alpha" | "cutout" | "opaque" | "untouched";
  /** Why a photo was not cut out; null when it was, or when nothing was attempted by design. */
  reason: string | null;
  stats: Record<string, number | string | boolean | null>;
}

/** Per-image options (scripts/products/image-options.json); absent = the default rules. */
export interface TreatOptions {
  kind?: PhotoKind;
  /** false: never cut out — the photo stays opaque, trimmed on its own background. */
  cutout?: boolean;
  /** true: closed windows of pure background colour (inside a headband arch) are cut out too. */
  holes?: boolean;
  /** Padding around a trimmed object, as a share of its longer side (default PAD). */
  pad?: number;
  /** false: an opaque photo keeps its whole frame. */
  trim?: boolean;
  /** true: the object touches the frame of a plain canvas — extend the canvas first, then cut out. */
  extend?: boolean;
  /** true: a transparent source loses its baked shadow / glow and stray specks (the stage draws its own). */
  clean?: boolean;
}

export function treat(image: RawImage, options?: TreatOptions): Treatment;
export function lab(r: number, g: number, b: number): [number, number, number];
export function hex(rgb: readonly number[]): string;
export function dominantColor(rgba: Uint8Array, mask: Uint8Array | null, ignore?: readonly number[]): string;
export const internals: Record<string, (...args: never[]) => unknown>;
