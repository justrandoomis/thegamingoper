/**
 * Knowledge articles are stored as block arrays (ARCHITECTURE §6: never HTML or Markdown) and edited as lines — the
 * same line format as the settings module's policies (admin 22, policy-text.ts: `## heading`, `- item`, `1. item`,
 * `> step | text`, `[info|warning|danger] title | text`, `| table |`), plus one line for the catalogue's product
 * photos, which help-centre guides use:
 *
 *   [photo] ps5-slim--1 | PS5 Slim from the front          → { type: "art", name: "ps5-slim--1", alt: "…" }
 *
 * Pure and client-safe (the editor previews with it); the server checks the photo keys against the catalogue.
 */
import { blocksToText, textToBlocks, type PolicyBlock } from "~/server/services/admin/settings/policy-text";

export type ArticleBlock = PolicyBlock | { type: "art"; name: string; alt: string };

const PHOTO = /^\[photo\]\s*([a-z0-9][a-z0-9-]*--\d{1,3})\s*(?:\|\s*(.*))?$/i;
const ART_KEY = /^[a-z0-9][a-z0-9-]*--\d{1,3}$/;
const clean = (text: string) => text.replace(/[\u0000-\u001f\u007f‪-‮⁦-⁩​⁠﻿]/g, "").trim().slice(0, 300);

/** Lines → blocks: photo lines become art blocks in place, everything else follows the policy format. */
export function textToArticleBlocks(text: string): ArticleBlock[] {
  const out: ArticleBlock[] = [];
  let chunk: string[] = [];
  const flush = () => {
    if (chunk.length) out.push(...textToBlocks(chunk.join("\n")));
    chunk = [];
  };
  for (const line of text.replace(/\r\n?/g, "\n").split("\n")) {
    const match = PHOTO.exec(line.trim());
    if (match) {
      flush();
      out.push({ type: "art", name: match[1].toLowerCase(), alt: clean(match[2] ?? "") });
    } else chunk.push(line);
  }
  flush();
  return out.slice(0, 200);
}

/** Blocks → lines (art blocks as photo lines, so editing keeps them). */
export function articleBlocksToText(blocks: readonly unknown[]): string {
  const parts: string[] = [];
  let run: unknown[] = [];
  const flush = () => {
    if (run.length) parts.push(blocksToText(run));
    run = [];
  };
  for (const block of blocks) {
    const art = block as { type?: unknown; name?: unknown; alt?: unknown } | null;
    if (art && art.type === "art" && typeof art.name === "string" && ART_KEY.test(art.name)) {
      flush();
      parts.push(`[photo] ${art.name}${typeof art.alt === "string" && art.alt ? ` | ${art.alt}` : ""}`);
    } else run.push(block);
  }
  flush();
  return parts.filter((part) => part !== "").join("\n");
}

/** The photo keys an article uses (for the server's catalogue check). */
export const photoKeysOf = (blocks: readonly ArticleBlock[]): string[] => blocks.filter((block): block is Extract<ArticleBlock, { type: "art" }> => block.type === "art").map((block) => block.name);
