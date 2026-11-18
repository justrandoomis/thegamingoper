/**
 * Adds to each HTML page the manifests of the product photos it mentions, as
 * `<script>self.__TT_ART__=[…]</script>` at the end of the document (it runs before the app's module
 * scripts, which wait for the whole document). app/art/index.ts reads it in the browser, so hydration
 * draws the same pictures the server drew without the browser downloading every photo's manifest.
 *
 * Which photos: every photo of every product slug that appears anywhere in the page (picture URLs
 * "/products/<slug>/…", photo keys "<slug>--<n>" in the route data, links "/p/<slug>"). All photos of
 * such a product are sent, so `productPhotos(slug)` answers the same in the browser as on the server.
 * The blurred miniature is sent only for the photos actually drawn on the page.
 */
import { compactPhoto, isCompactable, type CompactPhoto } from "./compact";
import { getPhoto, parsePhotoKey, photoKeys, productPhotos } from "./index";

let slugIndex: Set<string> | null = null;
function slugs(): Set<string> {
  if (!slugIndex) {
    slugIndex = new Set();
    for (const key of photoKeys()) {
      const parsed = parsePhotoKey(key);
      if (parsed) slugIndex.add(parsed.slug);
    }
  }
  return slugIndex;
}

const TOKEN = /[a-z0-9]+(?:--?[a-z0-9]+)*/g;
const DRAWN = /\/products\/([a-z0-9-]+)\/(\d+)-\d+\./g;

/** Collects slugs and drawn photo keys from a piece of the page. */
function scan(text: string, found: Set<string>, drawn: Set<string>) {
  const known = slugs();
  for (const match of text.matchAll(TOKEN)) {
    for (const part of match[0].split("--")) {
      // "x-nintendo-switch-2" → also try "nintendo-switch-2", "switch-2", …
      let rest = part;
      while (rest) {
        if (known.has(rest)) found.add(rest);
        const dash = rest.indexOf("-");
        rest = dash < 0 ? "" : rest.slice(dash + 1);
      }
    }
  }
  for (const match of text.matchAll(DRAWN)) drawn.add(`${match[1]}--${match[2]}`);
}

export function artSeedScript(found: Set<string>, drawn: Set<string>, nonce: string | undefined): string {
  const entries: CompactPhoto[] = [];
  for (const slug of found) {
    for (const photo of productPhotos(slug)) {
      if (!isCompactable(photo)) continue;
      entries.push(compactPhoto(photo, drawn.has(photo.key)));
    }
  }
  // drawn keys whose slug was not caught (should not happen, but never lose a drawn picture)
  for (const key of drawn) {
    const parsed = parsePhotoKey(key);
    if (parsed && found.has(parsed.slug)) continue;
    const photo = getPhoto(key);
    if (photo && isCompactable(photo)) entries.push(compactPhoto(photo, true));
  }
  const json = safeJson(entries);
  return `<script${nonce ? ` nonce="${nonce}"` : ""}>self.__TT_ART__=${json}</script>`;
}

const UNSAFE = new RegExp("[" + String.fromCharCode(60, 0x2028, 0x2029) + "]", "g");
/** JSON that cannot close the script tag or break the line: "<", U+2028 and U+2029 become \uXXXX escapes. */
function safeJson(value: unknown): string {
  return JSON.stringify(value).replace(UNSAFE, (ch) => "\\" + "u" + ch.charCodeAt(0).toString(16).padStart(4, "0"));
}


/** Passes the HTML through unchanged and appends the photo seed at its end. */
export function withArtSeed(body: ReadableStream<Uint8Array>, nonce: string | undefined): ReadableStream<Uint8Array> {
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();
  const found = new Set<string>();
  const drawn = new Set<string>();
  let tail = "";
  const transform = new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) {
      controller.enqueue(chunk);
      const text = tail + decoder.decode(chunk, { stream: true });
      scan(text, found, drawn);
      // a token cut between two chunks is found again with the next one
      tail = text.slice(-160);
    },
    flush(controller) {
      const text = tail + decoder.decode();
      scan(text, found, drawn);
      controller.enqueue(encoder.encode(artSeedScript(found, drawn, nonce)));
    },
  });
  return body.pipeThrough(transform);
}
