/**
 * Pieces shared by the trade-in wizard and its tracking page (DESIGN.md §9.21):
 *   <EstimatePanel>   the indicative RANGE in price type under "سعر تقديري", the outlined "بانتظار الفحص" tag, the
 *                     expiry, and "هذا سعر تقديري. السعر النهائي بعد فحص الجهاز." — or, without a figure, why the
 *                     price comes after the inspection. Never a commit key: an estimate is not an offer.
 *   <AnswerList>      the shopper's description, question by question (with edit links in the wizard).
 *   <DeviceSummary>   the device being traded in: its catalogue photo in a niche, the name, an optional link.
 */
import type { ReactNode } from "react";

import { useFormat, useT, LocaleLink } from "~/i18n/react";
import type { ImageRef, UsedGrade } from "~/lib/dto";
import type { TradeInAnswers, TradeInQuestion } from "~/server/services/tradein.server";
import { cx } from "~/ui/cx";
import { gradeKey } from "~/ui/GradeBadge";
import { Niche } from "~/ui/Niche";
import { Price } from "~/ui/Price";
import { fillNodes, iqdText } from "~/ui/PriceTag";
import { BidiText, ProductImage } from "~/ui/ProductCard";
import { Tag } from "~/ui/Tag";
import { TextLink } from "~/ui/TextLink";
import { VisuallyHidden } from "~/ui/VisuallyHidden";
import { useUsedT } from "../i18n";

/**
 * Workaround for a kit rule (app/styles/components.css): `.choice__input:indeterminate + .choice__box` paints a CHECKBOX's
 * mixed state, but a radio group with nothing chosen is `:indeterminate` too (HTML spec), so every unanswered option
 * looked chosen. Put this on a FieldGroup of radios until the rule is limited to checkboxes (reported to the design
 * system). Attribute-free selectors only: Tailwind keeps them as written.
 */
export const RADIO_GROUP_FIX = "[&_.choice--radio>input:indeterminate+span]:border-line-strong [&_.choice--radio>input:indeterminate+span]:bg-paper";

/** Left-to-right isolate and its end: grade letters and amounts keep their order inside Arabic and Sorani. */
const LRI = String.fromCharCode(0x2066);
const PDI = String.fromCharCode(0x2069);

const ACCESSORY_KEYS = new Set(["controller", "power_cable", "hdmi_cable", "dock", "joy_con", "charger", "case"]);

/** Words for an accessory key of a price guide ("missing_controller" → "controller" → "يد التحكم"). */
export function useAccessoryLabel(): (key: string) => string {
  const t = useUsedT();
  return (key) => t(`tradein.accessories.${ACCESSORY_KEYS.has(key) ? key : "extra"}`);
}

export type EstimatePanelProps = {
  range: { minIqd: number; maxIqd: number; expiresAt: number | null; expired?: boolean } | null;
  /** The grade span the range was priced at (wizard). */
  low?: UsedGrade;
  high?: UsedGrade;
  /** Accessories the device comes without, and what they took off. */
  missing?: string[];
  deductionsIqd?: number;
  /** Why there is no figure (when `range` is null). */
  reason?: "not_working" | "damaged" | "unpriced" | null;
  headingLevel?: 2 | 3;
  className?: string;
};

export function EstimatePanel({ range, low, high, missing = [], deductionsIqd = 0, reason = null, headingLevel = 2, className }: EstimatePanelProps) {
  const t = useUsedT();
  const shop = useT("ui-shop");
  const f = useFormat();
  const accessory = useAccessoryLabel();
  const Heading = `h${headingLevel}` as const;
  const words = (grade: UsedGrade) => `${shop(`grade.words.${gradeKey(grade)}`)} ${LRI}(${grade})${PDI}`;

  if (!range) {
    return (
      <section className={cx("grid gap-2 rounded-lg bg-paper p-5", className)} aria-labelledby="estimate-none" data-estimate="inspection">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <Heading id="estimate-none" className="type-sub text-ink">
            {t("tradein.estimate.inspection.title")}
          </Heading>
          <Tag kind="preorder">{t("tradein.estimate.pending")}</Tag>
        </div>
        {reason ? <p className="type-body text-ink">{t(`tradein.estimate.inspection.${reason}`)}</p> : null}
        <p className="type-body text-ink-2">{t("tradein.estimate.inspection.text")}</p>
      </section>
    );
  }

  return (
    <section className={cx("grid gap-3 rounded-lg bg-paper p-5", className)} aria-labelledby="estimate-range" data-estimate="range">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <Heading id="estimate-range" className="type-label font-semibold text-ink-2">
          {t("tradein.estimate.label")}
        </Heading>
        <Tag kind="preorder">{t("tradein.estimate.pending")}</Tag>
      </div>
      <p className="flex flex-wrap items-baseline gap-x-2 gap-y-1" data-range="">
        <VisuallyHidden>{t("tradein.estimate.range", { min: iqdText(f, range.minIqd), max: iqdText(f, range.maxIqd) })}</VisuallyHidden>
        <span aria-hidden="true" className="contents">
          <Price amountIqd={range.minIqd} size="xl" approx="off" as="span" />
          <span className="type-sub text-ink-2">–</span>
          <Price amountIqd={range.maxIqd} size="xl" approx="off" as="span" />
        </span>
      </p>
      {range.expiresAt !== null ? (
        <p className={cx("type-caption", range.expired ? "font-medium text-warn" : "text-ink-2")}>
          {range.expired ? t("tradein.estimate.expired", { date: f.date(range.expiresAt) }) : t("tradein.estimate.validUntil", { date: f.date(range.expiresAt) })}
        </p>
      ) : null}
      <p className="type-body font-medium text-ink">{t("tradein.estimate.note")}</p>
      {low && high ? <p className="type-caption text-ink-2">{t("tradein.estimate.grades", { low: words(low), high: words(high) })}</p> : null}
      {missing.length > 0 && deductionsIqd > 0 ? (
        <p className="type-caption text-ink-2">
          {fillNodes(t("tradein.estimate.deduction"), {
            amount: <bdi className="nums">{iqdText(f, deductionsIqd)}</bdi>,
            items: missing.map(accessory).join("، "),
          })}
        </p>
      ) : null}
      <p className="border-t border-line pt-3 type-caption text-ink-2">{t("tradein.estimate.payout")}</p>
    </section>
  );
}

export type AnswerListProps = {
  questions: readonly TradeInQuestion[];
  answers: TradeInAnswers;
  /** Wizard: a link per question that edits it. */
  edit?: Partial<Record<TradeInQuestion, string>>;
  className?: string;
};

export function AnswerList({ questions, answers, edit, className }: AnswerListProps) {
  const t = useUsedT();
  const accessory = useAccessoryLabel();
  const answerOf = (question: TradeInQuestion): string => {
    if (question === "included") {
      const list = answers.included ?? [];
      return list.length > 0 ? list.map(accessory).join("، ") : t("tradein.q.included.none");
    }
    const value = answers[question];
    return value ? t(`tradein.q.${question}.options.${value}.label`) : "—";
  };
  return (
    <dl className={cx("grid", className)}>
      {questions.map((question) => (
        <div key={question} className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1 border-b border-line py-2.5 last:border-b-0">
          <dt className="type-caption text-ink-2">{t(`tradein.q.${question}.short`)}</dt>
          <dd className="flex min-w-0 items-baseline gap-3 type-label text-ink">
            <span className="min-w-0">{answerOf(question)}</span>
            {edit?.[question] ? (
              <TextLink as={LocaleLink} to={edit[question]!} arrow={false} className="type-caption" aria-label={t("tradein.estimate.editQuestion", { question: t(`tradein.q.${question}.short`) })}>
                {t("tradein.estimate.edit")}
              </TextLink>
            ) : null}
          </dd>
        </div>
      ))}
    </dl>
  );
}

export type DeviceSummaryProps = {
  name: string;
  image: ImageRef | null;
  /** A link beside the name ("غيّر الجهاز"). */
  action?: { href: string; label: string } | null;
  children?: ReactNode;
  className?: string;
};

export function DeviceSummary({ name, image, action, children, className }: DeviceSummaryProps) {
  return (
    <div className={cx("flex items-center gap-3", className)}>
      <Niche as="span" ratio="1/1" tagZone={false} className="w-16 shrink-0">
        {image ? <ProductImage image={image} alt="" sizes="64px" pose={0} shadow={false} /> : null}
      </Niche>
      <div className="grid min-w-0 flex-1 gap-0.5">
        <p className="type-strong text-ink">
          <BidiText text={name} />
        </p>
        {children}
      </div>
      {action ? (
        <TextLink as={LocaleLink} to={action.href} arrow={false} className="shrink-0">
          {action.label}
        </TextLink>
      ) : null}
    </div>
  );
}
