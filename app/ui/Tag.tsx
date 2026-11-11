import type { ReactNode } from "react";
import { useRouteLoaderData } from "react-router";

import { Icon } from "~/art/Icon";
import { useFormat, useT } from "~/i18n/react";
import { cx } from "./cx";

/**
 * Badges, status and the state dot — Design System v2 §4.7. A badge is a 24px pill (12/600) stating ONE fact about an
 * object; one per card. Status is an 8px dot AND words, 13px (14 with `size="lg"`) — never colour alone.
 *
 *   <Tag kind="new" />                       ink fill           «جديد» (only within 30 days of release or listing)
 *   <Tag kind="soon" />                      control outline    calendar + «قريباً» (with the date in the action slot)
 *   <Tag kind="sale" />                      red tint           «تخفيض» (only with a real previous price)
 *   <Tag kind="grade">A+ · كالجديد</Tag>     1.5px ink outline  used units (GradeBadge builds the words)
 *   <Tag kind="out" />                       --niche-2          «نفد»
 *   <Tag kind="photo" />                     paper 90%          «صورة توضيحية» (bottom-start on a used unit's photo)
 *   <Tag kind="demo">{…}</Tag> · onColor     amber              see <DemoNote variant="tag"> for the words
 *   <Status tone="ok">متوفر</Status> · <StockStatus quantity={n} />
 *
 * 1.0 kinds keep working until stage 4: `used` and `refurbished` render the outlined grade look, `preorder` renders
 * «قريباً» (the store takes no pre-orders).
 */
export type TagKind = "new" | "soon" | "sale" | "grade" | "out" | "photo" | "demo" | "ok" | /* 1.0 */ "used" | "preorder" | "refurbished";

export type TagProps = {
  kind: TagKind;
  /** Replaces the default word for the kind. */
  children?: ReactNode;
  /** Appended after " · " — the grade of a used unit, for example. */
  detail?: ReactNode;
  /** On crimson (light theme): transparent with a white line and white words (the hero's demo tag). */
  onColor?: boolean;
  className?: string;
};

const KIND_CLASS: Record<TagKind, string> = {
  new: "tag--new",
  soon: "tag--soon",
  preorder: "tag--soon",
  sale: "tag--sale",
  grade: "tag--grade",
  used: "tag--grade",
  refurbished: "tag--grade",
  out: "tag--out",
  photo: "tag--photo",
  demo: "tag--demo",
  ok: "tag--ok",
};

/** Default words (ui:tag.*); `grade` and `demo` take their words from the caller. */
const KIND_WORD: Partial<Record<TagKind, string>> = {
  new: "tag.new",
  soon: "tag.soon",
  preorder: "tag.soon",
  sale: "tag.sale",
  used: "tag.used",
  refurbished: "tag.refurbished",
  out: "tag.out",
  photo: "tag.photo",
};

export function Tag({ kind, children, detail, onColor = false, className }: TagProps) {
  const t = useT("ui");
  const word = KIND_WORD[kind];
  const soon = kind === "soon" || kind === "preorder";
  return (
    <span className={cx("tag", KIND_CLASS[kind] ?? "tag--grade", onColor && "tag--on-color", className)} data-kind={kind}>
      {soon ? <Icon name="calendar-blank" size={14} /> : null}
      {children ?? (word ? t(word) : null)}
      {detail ? <> · {detail}</> : null}
    </span>
  );
}

/** ok · warn · info · bad (danger red) · out (sold out, ink-2) · soon (ink) · neutral (ink-2). */
export type StatusTone = "ok" | "warn" | "info" | "bad" | "out" | "soon" | "neutral";

/** An 8px dot and words, AA in both themes. Never colour alone. */
export function Status({ tone, size = "md", children, className }: { tone: StatusTone; size?: "md" | "lg"; children: ReactNode; className?: string }) {
  return <span className={cx("status", `status--${tone}`, size === "lg" && "status--lg", className)}>{children}</span>;
}

export type StockStatusProps = {
  /** Units that can be sold now. `null` = not tracked (shows nothing). */
  quantity: number | null;
  /** At or below this, say how many are left (real stock only: never in demo mode). Default 3. */
  lowAt?: number;
  /** Appended after " · " (e.g. the warranty), like the product page's "متوفر · ضمان سنة". */
  detail?: ReactNode;
  size?: "md" | "lg";
  className?: string;
};

type RootStore = { storeMode?: string };

/** «متوفر» (ok) · «بقي 2» (warn, real stock only — hidden in demo mode) · «نفد حالياً» (ink-2). */
export function StockStatus({ quantity, lowAt = 3, detail, size, className }: StockStatusProps) {
  const t = useT("ui");
  const f = useFormat();
  const root = useRouteLoaderData("root") as RootStore | undefined;
  if (quantity === null) return null;
  const demo = root?.storeMode === "demo";
  const low = !demo && quantity > 0 && quantity <= lowAt;
  const tone: StatusTone = quantity <= 0 ? "out" : low ? "warn" : "ok";
  const words = quantity <= 0 ? t("stock.outNow") : low ? t("stock.low", { count: f.number(quantity) }) : t("stock.in");
  return (
    <Status tone={tone} size={size} className={className}>
      {words}
      {detail ? <> · {detail}</> : null}
    </Status>
  );
}
