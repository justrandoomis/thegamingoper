/**
 * What a store set holds (bundle_items): each component with its picture, quantity and — when its own page is live — a
 * quick look. A row is a link to the component's page; with script, a plain press opens the quick look instead, so
 * the shopper can read about one part of the set without leaving it (the sheet's «التفاصيل الكاملة» still leads to
 * the page). Modified clicks (new tab) keep the link's own behaviour. Rows are 64px wells on the product ground
 * (design v2 spec §4.13 "item lines with 64px wells").
 */
import { useState, type MouseEvent } from "react";

import { useFormat } from "~/i18n/react";
import { MotionLink } from "~/motion";
import type { BundleComponent } from "~/server/services/catalog/product-types";
import { BidiText } from "~/ui/BidiText";
import { Niche } from "~/ui/Niche";
import { ProductImage } from "~/ui/ProductCard";
import { useProductT } from "../i18n";
import { QuickPreview } from "../QuickPreview";
import { Section } from "./Details";
import { MixedText } from "./MixedText";

export function SetContents({ components, level = 2, className }: { components: readonly BundleComponent[]; level?: 2 | 3; className?: string }) {
  const t = useProductT();
  const f = useFormat();
  const [preview, setPreview] = useState<BundleComponent | null>(null);
  const [opened, setOpened] = useState<BundleComponent | null>(null);
  if (components.length === 0) return null;

  const open = (component: BundleComponent) => (event: MouseEvent<HTMLAnchorElement>) => {
    if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    event.preventDefault();
    setPreview(component);
    setOpened(component);
  };

  return (
    <Section title={t("set.title")} level={level} className={className}>
      <p className="type-sm text-ink-2">{t("set.note")}</p>
      <ul className="grid gap-3 sm:grid-cols-2">
        {components.map((component) => {
          const body = (
            <>
              <Niche as="span" size="sm" className="w-16 shrink-0">
                <ProductImage image={component.image} alt="" sizes="64px" />
              </Niche>
              <span className="grid min-w-0 gap-0.5">
                <span className="type-card text-ink">
                  <BidiText text={component.name} />
                </span>
                {component.variantTitle ? (
                  <span className="type-xs text-ink-2">
                    <MixedText text={component.variantTitle} />
                  </span>
                ) : null}
                <span className="type-xs text-ink-2">
                  <bdi className="nums">{t("set.qty", { n: f.number(component.qty) })}</bdi>
                </span>
              </span>
            </>
          );
          return (
            <li key={`${component.productId}:${component.variantTitle ?? ""}`}>
              {component.linkable ? (
                <MotionLink
                  to={`/p/${component.slug}`}
                  nav="fade"
                  className="flex min-h-11 items-center gap-3 rounded-sm"
                  data-press="soft"
                  aria-haspopup="dialog"
                  aria-label={t("preview.open", { name: component.name })}
                  onClick={open(component)}
                >
                  {body}
                </MotionLink>
              ) : (
                <div className="flex items-center gap-3">{body}</div>
              )}
            </li>
          );
        })}
      </ul>
      {/* Kept mounted after the first open, so it can close with its own motion. */}
      {opened ? <QuickPreview slug={opened.slug} name={opened.name} image={opened.image} open={preview !== null} onClose={() => setPreview(null)} /> : null}
    </Section>
  );
}
