/**
 * Server side of the storefront shell: everything the header, menus and footer show, read once per document request
 * (and again only when the language changes — see the layout's shouldRevalidate).
 *
 *   const shell = await loadStorefrontShell(ctx);      // in app/routes/storefront/_layout.tsx
 *
 * Cost: getNavTaxonomy() is served from a per-isolate snapshot (one small fingerprint query at most every 30 s),
 * and the settings are ONE indexed query; both run in parallel. Nothing here writes.
 *
 * Privacy: of the payment settings only the on/off switches leave the server (no account numbers — the checkout shows
 * those); of `store.contact` only what the owner filled in.
 */
import { env } from "cloudflare:workers";
import { pick, type Locale } from "~/lib/locales";
import { formatIraqPhone, normalizeIraqPhone } from "~/lib/phone";
import type { RequestCtx } from "~/server/context.server";
import { getDb } from "~/server/db.server";
import type { Db } from "~/server/db/drizzle.server";
import { getSettings, settingDefault, type SettingValue } from "~/server/settings.server";
import { getNavTaxonomy } from "~/server/services/catalog/taxonomy.server";
import type { ShellContact, ShellContactLink, ShellData } from "./types";

const SHELL_SETTINGS = ["shipping.flat_fee_iqd", "payments.cod", "payments.wallet", "payments.bank_transfer", "payments.zaincash", "store.contact"] as const;

type ContactSetting = SettingValue<"store.contact">;

/** The shell's data for this request. Database failures are thrown (the layout turns them into a 503 page). */
export async function loadStorefrontShell(ctx: RequestCtx): Promise<ShellData> {
  return loadStorefrontShellFrom(getDb(), ctx);
}

/** Same, with the database passed in. */
export async function loadStorefrontShellFrom(db: Db, ctx: Pick<RequestCtx, "locale" | "now" | "origin">): Promise<ShellData> {
  const [nav, settings] = await Promise.all([getNavTaxonomy(db, ctx.locale, { now: ctx.now }), getSettings(db, SHELL_SETTINGS)]);
  return {
    nav,
    deliveryFeeIqd: settings["shipping.flat_fee_iqd"],
    payments: {
      cod: settings["payments.cod"].enabled,
      wallet: settings["payments.wallet"].enabled,
      card: settings["payments.bank_transfer"].enabled,
      zaincash: settings["payments.zaincash"].enabled,
    },
    contact: contactOf(settings["store.contact"], ctx.locale),
    publicOrigin: publicOrigin(ctx.origin),
    year: new Date(ctx.now).getUTCFullYear(),
  };
}

/**
 * A shell with nothing from the database: no platforms or categories in the menus, the default fee and payment
 * switches. Only for development without a migrated database (the root loader degrades the same way there).
 */
export function emptyStorefrontShell(ctx: Pick<RequestCtx, "now" | "origin">): ShellData {
  return {
    nav: { platforms: [], categories: [], usedCount: 0, builtAt: ctx.now },
    deliveryFeeIqd: settingDefault("shipping.flat_fee_iqd"),
    payments: {
      cod: settingDefault("payments.cod").enabled,
      wallet: settingDefault("payments.wallet").enabled,
      card: settingDefault("payments.bank_transfer").enabled,
      zaincash: settingDefault("payments.zaincash").enabled,
    },
    contact: { links: [], address: null, hours: null, channels: null },
    publicOrigin: publicOrigin(ctx.origin),
    year: new Date(ctx.now).getUTCFullYear(),
  };
}

/** PUBLIC_ORIGIN from the deploy configuration (wrangler vars / .dev.vars); the request's origin when it is unset. */
function publicOrigin(requestOrigin: string): string {
  const configured = (env as { PUBLIC_ORIGIN?: unknown }).PUBLIC_ORIGIN;
  if (typeof configured === "string") {
    try {
      const url = new URL(configured);
      if (url.protocol === "https:" || url.protocol === "http:") return url.origin;
    } catch {
      // not a URL: fall through
    }
  }
  return requestOrigin;
}

function contactOf(contact: ContactSetting, locale: Locale): ShellContact {
  const links: ShellContactLink[] = [];
  const phone = contact.phone ? normalizeIraqPhone(contact.phone) : null;
  if (phone) links.push({ kind: "phone", label: formatIraqPhone(phone), href: `tel:${phone}` });
  const whatsapp = contact.whatsapp ? normalizeIraqPhone(contact.whatsapp) : null;
  if (whatsapp) links.push({ kind: "whatsapp", label: formatIraqPhone(whatsapp), href: `https://wa.me/${whatsapp.slice(1)}` });
  if (contact.email) links.push({ kind: "email", label: contact.email, href: `mailto:${contact.email}` });
  for (const kind of ["instagram", "facebook", "tiktok", "telegram"] as const) {
    const url = contact[kind];
    if (url) links.push({ kind, label: hostLabel(url), href: url });
  }
  if (contact.map_url) links.push({ kind: "map", label: hostLabel(contact.map_url), href: contact.map_url });
  const address = contact.address ? pick(contact.address, locale) || null : null;
  const hours = contact.hours ? pick(contact.hours, locale) || null : null;
  // the kit's <ContactCard>: WhatsApp as international digits, the phone in E.164, the hours in the owner's words (no
  // schedule is stored, so no open/closed state is computed)
  const channels =
    phone || whatsapp || address || hours
      ? { whatsapp: whatsapp ? whatsapp.slice(1) : null, phone, address, mapsUrl: contact.map_url ?? null, hours: null, hoursText: hours, replyTime: null }
      : null;
  return { links, address, hours, channels };
}

/** "https://www.instagram.com/tamtam.games/" → "instagram.com/tamtam.games" */
function hostLabel(url: string): string {
  try {
    const parsed = new URL(url);
    return `${parsed.hostname.replace(/^www\./, "")}${parsed.pathname.replace(/\/+$/, "")}`;
  } catch {
    return url;
  }
}
