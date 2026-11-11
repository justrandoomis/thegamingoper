/**
 * What the storefront shell needs from the server (client-safe types only). Built by ./data.server.ts, returned by
 * the storefront layout's loader as `shell`, read by <ShellFrame>.
 */
import type { NavTaxonomy } from "~/server/services/catalog/types";

export type { NavCategory, NavLink, NavPlatform, NavTaxonomy } from "~/server/services/catalog/types";

/** Which payment methods the store has switched on (settings `payments.*`): the footer lists exactly these. */
export type ShellPayments = { cod: boolean; wallet: boolean; card: boolean; zaincash: boolean };

/** A way to reach the store, ready to render: visible text and the link. */
export type ShellContactLink = { kind: "phone" | "whatsapp" | "email" | "instagram" | "facebook" | "tiktok" | "telegram" | "map"; label: string; href: string };

/** Store contact details from settings `store.contact` — only what the owner filled in (nothing is invented). */
export type ShellContact = { links: ShellContactLink[]; address: string | null; hours: string | null };

export type ShellData = {
  nav: NavTaxonomy;
  /** The flat delivery fee (settings `shipping.flat_fee_iqd`), integer IQD. */
  deliveryFeeIqd: number;
  payments: ShellPayments;
  contact: ShellContact;
  /** PUBLIC_ORIGIN (e.g. "https://tamtamgames.com") — canonical and hreflang URLs are built on it. */
  publicOrigin: string;
  /** The year for the © line, from the request time (so server and client agree). */
  year: number;
};

/** A route's wishes for the shell, from its `handle` (read on the server too, so SSR is right). */
export type ShellHandle = {
  shell?: {
    /**
     * false: the page shows its own bottom task bar (buy bar, checkout bar) through <TaskBar> from ./TabBar, so the
     * tab bar gives way (DESIGN.md §8 sticky rule: never two bars at the same edge). Below 1200px the header then
     * becomes the task header once the page scrolls: back · the page's <h1> · the cart with its count (§9.2).
     * Ignored while the storefront's error page is shown (the page and its task bar are not on screen).
     */
    tabBar?: boolean;
    /**
     * Where the task header's back key leads when the shopper opened the page directly (no earlier page of this site
     * in the tab): a locale-less path such as "/cart". Default: the page's section (./chrome backFallback). With
     * history, back is always real history Back.
     */
    back?: string;
  };
};
