declare module "virtual:tt-art-lite" {
  /**
   * Every photo manifest in short form (app/art/compact.ts CompactPhoto), without blurred miniatures
   * (vite.config.ts → artLitePlugin).
   */
  const photos: {
    k: string;
    v?: string;
    w: number;
    h: number;
    a: number;
    t: 0 | 1;
    b: string | null;
    c: string;
    d: string;
    p: string;
    x: [number, string][];
    y: [number, string][];
    s?: [number, number, string, string];
  }[];
  export default photos;
}
