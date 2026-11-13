/**
 * Pieces shared by the trade-in wizard and its tracking page (Design System v2 §6.14):
 *   <EstimatePanel>   the indicative RANGE in price type under «سعر تقديري», «بانتظار الفحص», the expiry as 18/11/2026,
 *                     the grade span, the deduction reasons («خصمنا 15,000 د.ع لأن الجهاز سيأتي بدون: الشاحن») and
 *                     the payout options — or, without a figure, why the price comes after the inspection. Never a
 *                     primary key: an estimate is not an offer. Once the device is past the inspection (`pending`
 *                     false) it is only «التقدير المبدئي» and the range beside the offer; without a range, nothing.
 *   <AnswerList>      the shopper's description, question by question (with edit links in the wizard).
 *   <DeviceSummary>   the device being traded in: its catalogue photo in a small well, the name, an optional link.
 *   <WhatNext>        what happens after the request, as numbered rows (the aside, the estimate step).
 */
import { useId, type ReactNode } from "react";

import { Icon } from "~/art/Icon";
import { LocaleLink, useFormat, useT } from "~/i18n/react";
import type { ImageRef, UsedGrade } from "~/lib/dto";
import type { TradeInAnswers, TradeInQuestion } from "~/server/services/tradein.server";
import { cx } from "~/ui/cx";
import { FactList } from "~/ui/FactList";
import { gradeKey } from "~/ui/GradeBadge";
import { Niche } from "~/ui/Niche";
import { Note } from "~/ui/Note";
import { Price } from "~/ui/Price";
import { fillNodes, iqdText } from "~/ui/PriceTag";
import { BidiText, ProductImage } from "~/ui/ProductCard";
import { Status } from "~/ui/Tag";
import { TextLink } from "~/ui/TextLink";
import { VisuallyHidden } from "~/ui/VisuallyHidden";
import { useUsedT } from "../i18n";
import { keepLatinHyphens } from "../names";

/** Left-to-right isolate and its end: grade letters and amounts keep their order inside Arabic and Sorani. */
const LRI = String.fromCharCode(0x2066);
const PDI = String.fromCharCode(0x2069);

const ACCESSORY_KEYS = new Set(["controller", "power_cable", "hdmi_cable", "dock", "joy_con", "charger", "case"]);

/**
 * Words for an accessory key of a price guide ("missing_controller" → "controller" → "يد التحكم"). A Latin name in
 * them never breaks at its hyphen («يدا Joy‑Con»: ../names keepLatinHyphens — round-1 fixes).
 */
export function useAccessoryLabel(): (key: string) => string {
  const t = useUsedT();
  return (key) => keepLatinHyphens(t(`tradein.accessories.${ACCESSORY_KEYS.has(key) ? key : "extra"}`));
}

/** «جيد جداً (B)» — a grade in words with its letter isolated left to right. */
export function useGradeWords(): (grade: UsedGrade) => string {
  const shop = useT("ui-shop");
  return (grade) => `${shop(`grade.words.${gradeKey(grade)}`)} ${LRI}(${grade})${PDI}`;
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
  /** Show how the money is paid out (the wizard's estimate step). */
  payout?: boolean;
  /** Still before the inspection (default). False once the request is inspected, offered or closed: no «بانتظار الفحص», no expiry, no note. */
  pending?: boolean;
  headingLevel?: 2 | 3;
  className?: string;
};

export function EstimatePanel({ range, low, high, missing = [], deductionsIqd = 0, reason = null, payout = false, pending: awaiting = true, headingLevel = 2, className }: EstimatePanelProps) {
  const t = useUsedT();
  const f = useFormat();
  const accessory = useAccessoryLabel();
  const words = useGradeWords();
  const Heading = `h${headingLevel}` as const;
  const pending = (
    <Status tone="warn" className="shrink-0">
      {t("tradein.estimate.pending")}
    </Status>
  );

  if (!range) {
    if (!awaiting) return null;
    return (
      <section className={cx("panel grid gap-2 p-5", className)} aria-labelledby="estimate-none" data-estimate="inspection">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <Heading id="estimate-none" className="type-h3 text-ink">
            {t("tradein.estimate.inspection.title")}
          </Heading>
          {pending}
        </div>
        {reason ? <p className="type-body text-ink">{t(`tradein.estimate.inspection.${reason}`)}</p> : null}
        <p className="used-read text-ink-2">{t("tradein.estimate.inspection.text")}</p>
        {payout ? <PayoutOptions /> : null}
      </section>
    );
  }

  // v2.1: the estimate is the step's one showcase — frosted glass over the brand's ambient light (the kit's .glow and
  // .surface--glass; solid under reduced transparency); the range in price type, the validity as a pill, the note calm.
  return (
    <div className={cx("glow used-estimate", className)}>
      <section className="surface surface--glass grid gap-3 p-5 lg:p-6" aria-labelledby="estimate-range" data-estimate="range">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <Heading id="estimate-range" className="type-sm-strong text-ink-2">
            {awaiting ? t("tradein.estimate.label") : t("tradein.estimate.title")}
          </Heading>
          {awaiting ? pending : null}
        </div>
        <p className="flex flex-wrap items-baseline gap-x-2 gap-y-1" data-range="">
          <VisuallyHidden>{t("tradein.estimate.range", { min: iqdText(f, range.minIqd), max: iqdText(f, range.maxIqd) })}</VisuallyHidden>
          <span aria-hidden="true" className="contents">
            <Price amountIqd={range.minIqd} size="lg" approx="off" as="span" />
            <span className="type-h3 text-ink-2">–</span>
            <Price amountIqd={range.maxIqd} size="lg" approx="off" as="span" />
          </span>
        </p>
        {awaiting && range.expiresAt !== null ? (
          <p className={cx("used-date", range.expired && "used-date--warn")}>
            <Icon name={range.expired ? "hourglass" : "calendar"} size={16} />
            {range.expired ? t("tradein.estimate.expired", { date: f.date(range.expiresAt, "short") }) : t("tradein.estimate.validUntil", { date: f.date(range.expiresAt, "short") })}
          </p>
        ) : null}
        {awaiting ? (
          // the kit's quiet line, its words at the reading size (G7: 16px on phones — the line's 14 read small here)
          <Note variant="line" icon="info" className="used-line-note">
            {t("tradein.estimate.note")}
          </Note>
        ) : null}
        {low && high ? <p className="used-read text-ink-2">{t("tradein.estimate.grades", { low: words(low), high: words(high) })}</p> : null}
        {missing.length > 0 && deductionsIqd > 0 ? (
          <p className="used-read text-ink-2">
            {fillNodes(t("tradein.estimate.deduction"), {
              amount: <bdi className="nums">{iqdText(f, deductionsIqd)}</bdi>,
              items: missing.map(accessory).join(t("tradein.listJoin")),
            })}
          </p>
        ) : null}
        {payout ? <PayoutOptions /> : null}
      </section>
    </div>
  );
}

/** How the money is paid once a final offer is accepted: store credit (with an account) or cash at the hand-over. */
function PayoutOptions() {
  const t = useUsedT();
  return (
    <div className="mt-1 grid gap-1 border-t border-line pt-4">
      <h3 className="used-title text-ink">{t("tradein.estimate.payoutTitle")}</h3>
      <FactList
        plain
        className="used-facts"
        facts={[
          { id: "credit", icon: "wallet", title: t("tradein.estimate.payoutCredit"), text: t("tradein.estimate.payoutCreditText") },
          { id: "cash", icon: "money", title: t("tradein.estimate.payoutCash"), text: t("tradein.estimate.payoutCashText") },
        ]}
      />
    </div>
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
  const answerOf = (question: TradeInQuestion): string | null => {
    if (question === "included") {
      const list = answers.included;
      if (!list) return null;
      return list.length > 0 ? list.map(accessory).join(t("tradein.listJoin")) : t("tradein.q.included.none");
    }
    const value = answers[question];
    return value ? t(`tradein.q.${question}.options.${value}.label`) : null;
  };
  return (
    <dl className={cx("grid", className)}>
      {questions.map((question) => {
        const answer = answerOf(question);
        return (
          <div key={question} className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-x-3 border-b border-line py-2 last:border-b-0">
            <dt className="type-xs text-ink-2">{t(`tradein.q.${question}.short`)}</dt>
            <dd className="used-title col-start-1 row-start-2 min-w-0 text-ink">{answer ?? <span className="font-normal text-ink-2">{t("tradein.notAnswered")}</span>}</dd>
            {answer && edit?.[question] ? (
              <dd className="col-start-2 row-span-2 row-start-1">
                <TextLink as={LocaleLink} to={edit[question]!} arrow={false} className="type-xs min-w-11 justify-end" aria-label={t("tradein.estimate.editQuestion", { question: t(`tradein.q.${question}.short`) })}>
                  {t("tradein.estimate.edit")}
                </TextLink>
              </dd>
            ) : null}
          </div>
        );
      })}
    </dl>
  );
}

export type DeviceSummaryProps = {
  name: string;
  image: ImageRef | null;
  /** A link beside the name («غيّر الجهاز»). */
  action?: { href: string; label: string } | null;
  children?: ReactNode;
  /** md: a 64px well (default) · lg: a larger well on top (the aside). */
  size?: "md" | "lg";
  className?: string;
};

export function DeviceSummary({ name, image, action, children, size = "md", className }: DeviceSummaryProps) {
  if (size === "lg") {
    return (
      <div className={cx("grid gap-3", className)}>
        <Niche as="span" size="sm" className="w-full max-w-[12rem] justify-self-center">
          {image ? <ProductImage image={image} alt="" sizes="192px" /> : null}
        </Niche>
        <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
          <p className="min-w-0 type-card text-ink">
            <BidiText text={name} />
          </p>
          {action ? (
            <TextLink as={LocaleLink} to={action.href} arrow={false} className="type-xs">
              {action.label}
            </TextLink>
          ) : null}
        </div>
        {children}
      </div>
    );
  }
  return (
    <div className={cx("flex items-center gap-3", className)}>
      <Niche as="span" size="sm" className="w-16 shrink-0">
        {image ? <ProductImage image={image} alt="" sizes="64px" /> : null}
      </Niche>
      <div className="grid min-w-0 flex-1 gap-0.5">
        <p className="type-card text-ink">
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

/** What happens after the request: numbered rows (the aside, the estimate step). Honest: staff steps, then the answer. */
export function WhatNext({ className, headingLevel = 2 }: { className?: string; headingLevel?: 2 | 3 }) {
  const t = useUsedT();
  const f = useFormat();
  // Two copies can be on a page (the estimate step's column and the aside from 1280): each names itself by its own id.
  const headingId = useId();
  const Heading = `h${headingLevel}` as const;
  const steps = ["schedule", "inspect", "offer", "decide"] as const;
  return (
    <section className={cx("grid gap-3", className)} aria-labelledby={headingId}>
      <Heading id={headingId} className="used-title text-ink">
        {t("tradein.next.title")}
      </Heading>
      {/* reading text (G7: 16 / 1.75); the number sits on the first line */}
      <ol className="grid gap-3">
        {steps.map((step, index) => (
          <li key={step} className="grid grid-cols-[24px_minmax(0,1fr)] items-start gap-3">
            <span className="step__n mt-0.5" aria-hidden="true">
              {f.number(index + 1)}
            </span>
            <span className="used-read text-ink">{t(`tradein.next.${step}`)}</span>
          </li>
        ))}
      </ol>
    </section>
  );
}
