/**
 * What the storefront shell needs from the server (client-safe types only). Built by ./data.server.ts, returned by
 * the storefront layout's loader as `shell`, read by <ShellFrame>.
 */
import type { NavTaxonomy } from "~/server/services/catalog/types";
import type { ContactChannels } from "~/ui/ContactCard";

export type { NavCategory, NavLink, NavPlatform, NavTaxonomy } from "~/server/services/catalog/types";

/** Which payment methods the store has switched on (settings `payments.*`): the footer lists exactly these. */
export type ShellPayments = { cod: boolean; wallet: boolean; card: boolean; zaincash: boolean };

/** A way to reach the store, ready to render: visible text and the link. */
export type ShellContactLink = { kind: "phone" | "whatsapp" | "email" | "instagram" | "facebook" | "tiktok" | "telegram" | "map"; label: string; href: string };

/**
 * Store contact details from settings `store.contact` — only what the owner filled in (nothing is invented).
 * `channels` is the same data in the kit's <ContactCard> shape (WhatsApp, phone, address, maps, hours in words); null
 * when none of those is configured, so the card renders nothing.
 */
export type ShellContact = { links: ShellContactLink[]; address: string | null; hours: string | null; channels: ContactChannels | null };

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

/**
 * The three shells (Design System v2 §5.1, §5.8):
 *   store     the demo strip and the 56px header below 1024 (108px = 64 + 44 from 1024), the floating tab bar below
 *             1024, the full footer. Every page that declares nothing.
 *   checkout  ONE bar, 56px (64 from 1024): back to the cart · the mascot · the step rail · «طلب تجريبي» · help. No
 *             strip, no search, no menus, no tab bar; the one-line footer. `/checkout` gets it even before its handle
 *             says so (./chrome shellChrome).
 *   task      task flows (trade-in, repair, the assistant): the store header, no tab bar (the page's <TaskBar>
 *             instead), the one-line footer.
 */
export type ShellChromeKind = "store" | "checkout" | "task";

/** A route's wishes for the shell, from its `handle` (read on the server too, so SSR is right). */
export type ShellHandle = {
  shell?: {
    /** The shell this page lives in (above). Default "store". */
    chrome?: Exclude<ShellChromeKind, "store">;
    /**
     * false: the page shows its own bottom task bar (buy bar, cart bar) through <TaskBar> from ./TabBar. The tab bar
     * gives way to it by itself (CSS: never two bars at one edge) — and comes back when the page draws no task bar
     * (an empty cart). Below 1024px the header becomes the task header once the page scrolls: back · the page's <h1>
     * · the cart with its count (§5.2). Ignored while the storefront's error page is shown.
     */
    tabBar?: boolean;
    /**
     * Where the task header's back key leads when the shopper opened the page directly (no earlier page of this site
     * in the tab): a locale-less path such as "/cart". Default: the page's section (./chrome backFallback). With
     * history, back is always real history Back.
     */
    back?: string;
    /**
     * What the offline banner says on this page (v2 §4.23): "form" — «ما كتبته باقٍ في الصفحة؛ أرسله عند عودة
     * الاتصال.» — on a page the shopper fills in; "store" — «سلتك محفوظة على هذا الجهاز.». Default: "form" in checkout,
     * task flows and under /account (sign-in, sign-up, the account's forms), "store" everywhere else. A store page
     * built around a form (e.g. /track) declares "form".
     */
    offline?: "form" | "store";
  };
};
