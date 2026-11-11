import type { ComponentType, ReactNode } from "react";

import { useLocale } from "~/i18n/react";
import type { Locale } from "~/lib/locales";
import { cx } from "~/ui/cx";

/**
 * Building blocks for /design-system section files.
 *
 * Add a section without touching the page: create `design-system/sections/<name>.tsx` that exports
 *
 *   export const section: DsSectionMeta = { id: "cards", order: 20, title: { ar: "البطاقات", en: "Cards", ckb: "کارتەکان" } };
 *   export default function Cards() {
 *     const c = useCopy(COPY);                       // COPY = defineCopy({ ar: {…}, en: {…}, ckb: {…} })
 *     return <DsBlock title={c.title} note={c.note}><SpecimenGrid><Specimen label='kind="new"'>…</Specimen></SpecimenGrid></DsBlock>;
 *   }
 *
 * The page discovers it with import.meta.glob and orders sections by `order` (core = 0). Section copy is
 * reference-page text, kept next to the specimens in all three languages; product names and prices on the page are
 * examples (the page says so) — never present them as the shop's real data.
 */
export type DsSectionMeta = {
  /** Anchor id, unique across sections. */
  id: string;
  /** Sort key. The core section is 0; leave gaps (10, 20, …). */
  order: number;
  title: Record<Locale, string>;
  /** Who maintains it — shown under the heading. */
  owner?: string;
};

export type DsSectionModule = { default: ComponentType; section: DsSectionMeta };

/** Section copy in all three languages; TypeScript checks that the keys are identical. */
export function defineCopy<T extends Record<string, string>>(copy: { ar: T; en: { [K in keyof T]: string }; ckb: { [K in keyof T]: string } }) {
  return copy as Record<Locale, T>;
}

export function useCopy<T>(copy: Record<Locale, T>): T {
  return copy[useLocale()];
}

/** A titled block of specimens inside a section. */
export function DsBlock({ id, title, note, children, className }: { id?: string; title: ReactNode; note?: ReactNode; children: ReactNode; className?: string }) {
  return (
    <section className={cx("ds-block", className)} id={id} aria-label={typeof title === "string" ? title : undefined}>
      <h3 className="ds-h3">{title}</h3>
      {note ? <p className="ds-note">{note}</p> : null}
      {children}
    </section>
  );
}

export function SpecimenGrid({ children, wide = false, className }: { children: ReactNode; wide?: boolean; className?: string }) {
  return <div className={cx("ds-grid", wide && "ds-grid--wide", className)}>{children}</div>;
}

/** One specimen: the thing itself, with its API spelled out underneath (language-neutral code). */
export function Specimen({ label, children, wide = false, className }: { label?: string; children: ReactNode; wide?: boolean; className?: string }) {
  return (
    <figure className={cx("ds-spec", wide && "ds-spec--wide", className)}>
      <div className="ds-spec__body">{children}</div>
      {label ? (
        <figcaption className="ds-spec__label">
          <code dir="ltr">{label}</code>
        </figcaption>
      ) : null}
    </figure>
  );
}

export function SpecimenRow({ children, className }: { children: ReactNode; className?: string }) {
  return <div className={cx("ds-row", className)}>{children}</div>;
}
