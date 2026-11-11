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

export function treat(image: RawImage, options?: { kind?: PhotoKind }): Treatment;
export function lab(r: number, g: number, b: number): [number, number, number];
export function hex(rgb: readonly number[]): string;
export function dominantColor(rgba: Uint8Array, mask: Uint8Array | null, ignore?: readonly number[]): string;
export const internals: Record<string, (...args: never[]) => unknown>;
