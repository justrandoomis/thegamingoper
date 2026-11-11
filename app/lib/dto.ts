/**
 * View models shared by services, loaders and components (client-safe, types only).
 * Services return these already localized for the request's locale — components never
 * receive raw database rows, L10n objects, or protected fields (cost, margin, serials).
 */

export type ProductKind = "console" | "game" | "controller" | "headset" | "storage" | "accessory" | "digital" | "part" | "bundle";

/** How much of an item can be bought right now. Never expose exact stock numbers to shoppers. */
export type StockState = "in_stock" | "low_stock" | "out_of_stock" | "preorder";

export type CompatibilityStatus = "verified" | "partial" | "incompatible" | "unverified";

/**
 * An image reference: a catalogue photo from `~/art` (`artKey`, "<slug>--<n>": official product photography,
 * DESIGN.md §12) or an uploaded file served from /media/<mediaKey>.
 */
export type ImageRef = {
  artKey: string | null;
  mediaKey: string | null;
  alt: string;
  /**
   * False only when a person confirmed the picture shows this exact item. Catalogue photos of a model are
   * illustrations of a used unit; the UI labels illustrations where real photos matter (used devices).
   */
  isIllustration: boolean;
  width?: number;
  height?: number;
  /**
   * Set (by the catalogue read layer) for a catalogue photo that is NOT a cut-out, so the well can treat it until it
   * is re-cut (design v2 spec §7.5): `background` is the plain box the object was photographed on ("#ffffff" for
   * PS5 2020 and Switch Lite, "#111111" for the Razer BlackShark…), null when the picture fills its own frame;
   * `tone` is that box's (else the picture's) lightness — "light" boxes melt into the light ground (multiply), dark
   * ones are framed. Null / absent for cut-outs, box art, screenshots and uploaded files.
   */
  opaque?: { background: string | null; tone: "light" | "dark" } | null;
};

export type RatingSummary = { average: number; count: number };

/** Everything a product tile needs. `rating` is null until real, approved, verified-purchase reviews exist. */
export type ProductCardData = {
  id: string;
  slug: string;
  name: string;
  /** One short line under the name, e.g. "1TB · نسخة الأقراص". */
  subtitle: string | null;
  kind: ProductKind;
  platformSlug: string | null;
  platformName: string | null;
  /** Default variant — what "add to cart" adds when the product has a single variant. */
  variantId: string;
  hasVariants: boolean;
  priceIqd: number;
  /**
   * The previous price to strike: only one the store really charged (an applied price change set it), or a demo
   * value on a demo row (`compareAtDemo`). Null otherwise.
   */
  compareAtIqd: number | null;
  /**
   * True when `compareAtIqd` is a DEMO value (no applied price change backs it): strike it only under the demo marking
   * while the store is in demo mode, and never word it as a saving (design v2 spec §4.7, §11.8). Always set by the
   * catalogue read layer; optional only so hand-written fixtures keep compiling.
   */
  compareAtDemo?: boolean;
  /** A state, never a number. Demo rows never say "low_stock" (scarcity from placeholder stock is not information). */
  stock: StockState;
  /** One per card: "preorder" (coming soon) › "deal" (a shown previous price) › "new" (`isNew`); null otherwise and when sold out. */
  badge: "new" | "deal" | "preorder" | null;
  /**
   * Released, or really listed, within the last 30 days — the only «جديد» (design v2 spec §4.7). A demo row's listing
   * time is the seed's clock, so only its researched release date counts. Always set by the catalogue read layer.
   */
  isNew?: boolean;
  /** The card's platform line, localized: «جهاز PS5», «لعبة Switch 2», «يد تحكم · PS5», «سماعة · متعددة المنصات». */
  kindLabel?: string;
  /** Slugs of the active platforms the product is for (its own, else what its research names), menu order — the dots. */
  forPlatforms?: string[];
  /** Coming soon (`stock: "preorder"`): the release, epoch ms of 00:00 in Baghdad, while it is still ahead. Else null. */
  releaseAt?: number | null;
  image: ImageRef;
  rating: RatingSummary | null;
  isDemo: boolean;
};

export type UsedGrade = "A+" | "A" | "B" | "C";

export type UsedUnitCardData = {
  id: string;
  slug: string;
  name: string;
  subtitle: string | null;
  platformSlug: string | null;
  grade: UsedGrade;
  /** Null when it cannot be measured for this device. */
  batteryHealthPct: number | null;
  priceIqd: number;
  warrantyDays: number;
  image: ImageRef;
  /** False when every photo is an illustration (demo data) — the card says so. */
  hasRealPhotos: boolean;
  isDemo: boolean;
};

export type CartLineProblem = "out_of_stock" | "qty_reduced" | "unavailable" | "price_changed";

export type CartLine = {
  id: string;
  kind: "variant" | "used_unit";
  variantId: string | null;
  usedUnitId: string | null;
  /** Locale-less path to the item's page, e.g. "/p/nintendo-switch-2". */
  href: string;
  name: string;
  optionsLabel: string | null;
  unitPriceIqd: number;
  qty: number;
  /** Upper bound the stepper may reach (stock- and policy-limited); 1 for used units. */
  maxQty: number;
  lineTotalIqd: number;
  image: ImageRef;
  stock: StockState;
  problem: CartLineProblem | null;
};

export type CartView = {
  id: string | null;
  lines: CartLine[];
  /** Sum of quantities — the number on the cart badge. */
  count: number;
  subtotalIqd: number;
  discountIqd: number;
  coupon: { code: string; label: string } | null;
  /** Shipping is known once a governorate is chosen; the flat fee is shown as an estimate before that. */
  shippingIqd: number | null;
  totalIqd: number;
  /** True when any line has a problem that blocks checkout. */
  blocked: boolean;
};

/** A titled group of items with an honest explanation of why they are shown. */
export type Shelf<T> = {
  key: string;
  title: string;
  /** e.g. "متوافق مع Nintendo Switch 2" or "اقتراحات المتجر" — never "customers also bought" without real data. */
  reason: string | null;
  items: T[];
};

export type PlatformSummary = { id: string; slug: string; name: string; accent: string };

export type CategoryNode = { id: string; slug: string; name: string; kind: string; children: CategoryNode[] };

export type Paged<T> = { items: T[]; total: number; nextCursor: string | null };

/** Result shape for actions and fetchers. */
export type ActionOk<T = Record<string, never>> = { ok: true } & T;
export type ActionFail = { ok: false; code: string; message?: string; fields?: Record<string, string> };
export type ActionResult<T = Record<string, never>> = ActionOk<T> | ActionFail;

export type OrderStatus = "new" | "awaiting_payment" | "payment_review" | "confirmed" | "preparing" | "shipped" | "delivered" | "cancelled" | "returned";
export type PaymentStatus = "unpaid" | "cod_due" | "pending_verification" | "paid" | "rejected" | "partially_refunded" | "refunded";
export type PaymentMethod = "cod" | "wallet" | "bank_transfer" | "zaincash";
