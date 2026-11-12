/**
 * Admin 17.06 — a phone and desktop preview before publishing, behind a SIGNED link only staff can open.
 *
 *   previewLink(db, actor, { kind, id }, secret, now)        → { token, path, expiresAt }   (kind's permission)
 *   openPreview(db, actor, token, secret, locale, now)       → what to draw, and whether it changed since
 *
 * The link is /admin/cms/preview/<token>: inside the admin, so the admin gate demands a signed-in employee with a
 * content permission (and every admin response is no-store and noindex), and the loader checks the kind's own
 * permission again. The token (signToken, purpose "cms.preview", SESSION_SECRET) names WHAT and WHICH VERSION
 * (`updated_at`) — never the content itself — and expires after PREVIEW_TTL_MS. A link to a version that has changed
 * since opens the current draft and says so. Without SESSION_SECRET (32+ characters) no link can be signed: an honest
 * `preview_secret` error, never an unsigned link.
 *
 * What is drawn is the UNPUBLISHED side: a page's draft (blocks, title, SEO words), a banner's saved values, a pin's
 * waiting changes (else its values) with its product's card. The route draws it in two frames the width of a phone and
 * of a desktop window, with the storefront's own components.
 */
import { and, eq } from "drizzle-orm";
import type { L10n, Locale } from "~/lib/locales";
import type { ProductCardData } from "~/lib/dto";
import { can, type Actor } from "~/server/actor";
import { signToken, verifyToken } from "~/server/crypto.server";
import type { LocalizedBlocks } from "~/server/db/columns";
import type { Db } from "~/server/db/drizzle.server";
import { banners, homeSections, pages, type SeoMeta } from "~/server/db/schema";
import { forbidden, notFound } from "~/server/errors";
import { getCardsByIds } from "~/server/services/catalog/cards.server";
import { HERO_PIN_KIND, PREVIEW_KINDS, PREVIEW_TTL_MS, readPinConfig, storePathOfPage, type HeroPinConfig, type PreviewKind } from "./rules";
import { cmsError } from "./shared.server";
import type { PageDraft } from "./pages.server";

export const PREVIEW_PURPOSE = "cms.preview";
const MIN_SECRET = 32;

type Payload = { k: PreviewKind; id: string; v: number };

function assertKindPermission(actor: Actor, kind: PreviewKind): void {
  const allowed = kind === "banner" ? can(actor, "cms.banner.manage") : kind === "pin" ? can(actor, "cms.home.manage") : can(actor, "cms.page.manage") || can(actor, "cms.page.publish");
  if (!allowed) throw forbidden(kind === "banner" ? "cms.banner.manage" : kind === "pin" ? "cms.home.manage" : "cms.page.manage");
}

async function versionOf(db: Db, kind: PreviewKind, id: string): Promise<number | null> {
  if (kind === "banner") return (await db.select({ v: banners.updatedAt }).from(banners).where(eq(banners.id, id)).get())?.v ?? null;
  if (kind === "pin") return (await db.select({ v: homeSections.updatedAt }).from(homeSections).where(and(eq(homeSections.id, id), eq(homeSections.kind, HERO_PIN_KIND))).get())?.v ?? null;
  return (await db.select({ v: pages.updatedAt }).from(pages).where(eq(pages.slug, id)).get())?.v ?? null;
}

/** Signs a preview link to the current version of a banner, a page (by slug) or a pin. */
export async function previewLink(db: Db, actor: Actor, input: { kind: string; id: string }, secret: string | null | undefined, now: number): Promise<{ token: string; path: string; expiresAt: number }> {
  if (!(PREVIEW_KINDS as readonly string[]).includes(input.kind)) throw notFound("preview");
  const kind = input.kind as PreviewKind;
  assertKindPermission(actor, kind);
  if (!secret || secret.length < MIN_SECRET) throw cmsError("preview_secret", 503);
  const v = await versionOf(db, kind, input.id);
  if (v === null) throw notFound(kind);
  const expiresAt = now + PREVIEW_TTL_MS;
  const token = await signToken({ k: kind, id: input.id, v } satisfies Payload, secret, { purpose: PREVIEW_PURPOSE, expiresAt });
  return { token, path: `/admin/cms/preview/${token}`, expiresAt };
}

export type PreviewBanner = { placement: string; title: L10n; subtitle: L10n | null; ctaLabel: L10n | null; link: string | null; artKey: string | null; accent: string; status: string; startsAt: number | null; endsAt: number | null };
export type PreviewPage = { kind: string; slug: string; storePath: string; title: L10n; blocks: Partial<Record<Locale, unknown[]>>; description: L10n | null; noindex: boolean; draft: boolean };
export type PreviewPin = { config: HeroPinConfig; startsAt: number | null; endsAt: number | null; pending: boolean; card: ProductCardData | null };

export type PreviewData = {
  kind: PreviewKind;
  id: string;
  expiresAt: number;
  /** The version the link was made for is no longer the current one (the current one is drawn). */
  stale: boolean;
  banner: PreviewBanner | null;
  page: PreviewPage | null;
  pin: PreviewPin | null;
};

/** Opens a signed preview: forged, altered or expired links are refused (`preview_invalid`, 404). */
export async function openPreview(db: Db, actor: Actor, token: string, secret: string | null | undefined, locale: Locale, now: number): Promise<PreviewData> {
  if (!secret || secret.length < MIN_SECRET) throw cmsError("preview_secret", 503);
  let payload: (Payload & { exp?: number }) | null = null;
  try {
    payload = await verifyToken<Payload>(token, secret, { purpose: PREVIEW_PURPOSE, now });
  } catch {
    payload = null;
  }
  if (!payload || !(PREVIEW_KINDS as readonly string[]).includes(payload.k) || typeof payload.id !== "string" || typeof payload.v !== "number") throw cmsError("preview_invalid", 404);
  assertKindPermission(actor, payload.k);
  const expiresAt = expiryOf(token) ?? now;
  const base = { kind: payload.k, id: payload.id, expiresAt, banner: null, page: null, pin: null };
  if (payload.k === "banner") {
    const row = await db.select().from(banners).where(eq(banners.id, payload.id)).get();
    if (!row) throw notFound("banner");
    return { ...base, stale: row.updatedAt !== payload.v, banner: { placement: row.placement, title: row.title, subtitle: row.subtitle, ctaLabel: row.ctaLabel, link: row.link, artKey: row.artKey, accent: row.accent ?? "brand", status: row.status, startsAt: row.startsAt, endsAt: row.endsAt } };
  }
  if (payload.k === "pin") {
    const row = await db.select().from(homeSections).where(and(eq(homeSections.id, payload.id), eq(homeSections.kind, HERO_PIN_KIND))).get();
    if (!row) throw notFound("pin");
    const staged = row.draftConfig as (HeroPinConfig & { startsAt?: number; endsAt?: number }) | null;
    const config = readPinConfig(staged ?? row.config);
    if (!config) throw notFound("pin");
    const cards = await getCardsByIds(db, locale, [config.productId], { now });
    return { ...base, stale: row.updatedAt !== payload.v, pin: { config, startsAt: staged?.startsAt ?? row.startsAt, endsAt: staged?.endsAt ?? row.endsAt, pending: Boolean(staged), card: cards[0] ?? null } };
  }
  const row = await db.select().from(pages).where(eq(pages.slug, payload.id)).get();
  if (!row) throw notFound("page");
  const draft = (row.draft ?? null) as PageDraft | null;
  const body = (draft ?? row.body ?? { ar: [] }) as LocalizedBlocks;
  const seo = (row.seo ?? null) as SeoMeta | null;
  return {
    ...base,
    stale: row.updatedAt !== payload.v,
    page: {
      kind: row.kind,
      slug: row.slug,
      storePath: storePathOfPage(row.kind, row.slug),
      title: draft?.title ?? row.title,
      blocks: { ar: body.ar ?? [], ...(body.en ? { en: body.en } : {}), ...(body.ckb ? { ckb: body.ckb } : {}) },
      description: draft?.seo?.description ?? seo?.description ?? null,
      noindex: draft?.seo?.noindex ?? seo?.noindex ?? false,
      draft: Boolean(draft),
    },
  };
}

/** The expiry a token carries (its payload is signed, not secret). */
function expiryOf(token: string): number | null {
  try {
    const body = token.slice(0, token.indexOf("."));
    const json = JSON.parse(atob(body.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(body.length / 4) * 4, "="))) as { e?: unknown };
    return typeof json.e === "number" ? json.e : null;
  } catch {
    return null;
  }
}
