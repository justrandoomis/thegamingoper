/**
 * Delivery, warranty and returns in plain sentences (DESIGN.md §8.4 "warranty and returns", §11 copy voice).
 *
 *   · Delivery: the time is confirmed by phone — never a promised day (brief §4). The fee itself sits beside the price.
 *   · Warranty: the STORE's warranty only when the owner has set one (products.warranty_months); until then the page
 *     says the terms are not published and to ask. The manufacturer's terms (from the researched specs) are shown as
 *     the maker's — never as a TamTam promise (docs/STATUS.md open item 15).
 *   · Returns: the window from settings (`returns.window_days`) and a link to the returns policy.
 */
import { useId, type ReactNode } from "react";

import { Icon, type IconName } from "~/art/Icon";
import { LocaleLink, useFormat } from "~/i18n/react";
import { cx } from "~/ui/cx";
import { TextLink } from "~/ui/TextLink";
import { useProductT } from "../i18n";

export type FactsProps = {
  makerWarranty: string | null;
  storeWarrantyMonths: number | null;
  returnsWindowDays: number;
  /** Show the policy links (the page); the preview sheet keeps it short. */
  links?: boolean;
  headingLevel?: 2 | 3;
  className?: string;
};

export function Facts({ makerWarranty, storeWarrantyMonths, returnsWindowDays, links = true, headingLevel = 2, className }: FactsProps) {
  const t = useProductT();
  const f = useFormat();
  const Heading = `h${headingLevel}` as const;
  const titleId = useId();
  return (
    <section className={cx("grid gap-1", className)} aria-labelledby={titleId}>
      <Heading id={titleId} className="type-sub text-ink">
        {t("facts.title")}
      </Heading>
      <ul className="grid">
        <Row icon="truck">{t("facts.deliveryTime")}</Row>
        <Row icon="shield-check">
          <span className="grid gap-1">
            <span>
              {storeWarrantyMonths
                ? t("facts.storeWarranty", {
                    count: storeWarrantyMonths,
                    n: f.number(storeWarrantyMonths),
                  })
                : t("facts.storeWarrantyPending")}
            </span>
            {makerWarranty ? (
              <span className="text-ink-2">
                {t("facts.makerWarranty", { terms: makerWarranty })} {t("facts.makerWarrantyNote")}
              </span>
            ) : null}
            {links ? (
              <TextLink as={LocaleLink} to="/policies/warranty" className="justify-self-start">
                {t("facts.warrantyPolicy")}
              </TextLink>
            ) : null}
          </span>
        </Row>
        <Row icon="arrow-counter-clockwise">
          <span className="grid gap-1">
            <span>
              {returnsWindowDays > 0
                ? t("facts.returns", {
                    count: returnsWindowDays,
                    n: f.number(returnsWindowDays),
                  })
                : t("facts.returnsNone")}
            </span>
            {links ? (
              <TextLink as={LocaleLink} to="/policies/returns" className="justify-self-start">
                {t("facts.returnsPolicy")}
              </TextLink>
            ) : null}
          </span>
        </Row>
      </ul>
    </section>
  );
}

function Row({ icon, children }: { icon: IconName; children: ReactNode }) {
  return (
    <li className="flex items-start gap-3 border-b border-line py-3 type-body text-ink last:border-b-0">
      <Icon name={icon} size={20} className="mt-0.5 shrink-0 text-ink-2" />
      <span className="min-w-0">{children}</span>
    </li>
  );
}
