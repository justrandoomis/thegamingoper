import { useEffect, useRef } from "react";
import { useActionData, useFetcher } from "react-router";

import { Icon } from "~/art/Icon";
import { LocaleLink, useDir, useFormat, useT } from "~/i18n/react";
import { keepTokens } from "~/lib/keep-tokens";
import { OWN_REJECT_CODES, REVIEW_LIMITS, type OwnReview, type ReviewSlot } from "~/server/services/account/types";
import type { OrderLineView } from "~/server/services/orders/types";
import { BidiText, latinName } from "~/ui/BidiText";
import { cx } from "~/ui/cx";
import { FieldGroup, TextArea } from "~/ui/Field";
import { Niche } from "~/ui/Niche";
import { Note } from "~/ui/Note";
import { ProductImage } from "~/ui/ProductCard";
import { sakuga } from "~/ui/sakuga/fx";
import { Status, type StatusTone } from "~/ui/Tag";
import { TextLink } from "~/ui/TextLink";
import { toast } from "~/ui/toast-store";
import { fieldError, FormFailure, rescueFocus, SubmitKey, type ActionAnswer } from "./FormBits";
import { splitOption } from "./OrderBits";

/** What the order page's action answers for a review (account/order.tsx `intent=review`). */
export type ReviewAnswer = ActionAnswer & { intent?: string; orderItemId?: string | null; rating?: string | null; body?: string | null; verified?: boolean };

const STARS = [1, 2, 3, 4, 5] as const;

/**
 * «قيّم ما استلمته» — a delivered order's products, each reviewed once by its buyer (account/reviews.server; the review
 * hub's model, admin 16.06): five stars and an optional short text, sent as `pending` and counted nowhere until staff
 * approve it. Each open product is a plain post form (intent=review, its line, the stars as radios, the text) — it
 * works before and without script; with script it is a fetcher (no navigation), a toast and the sent state in its
 * place. The text and the send key come with the first star (CSS `:has`, everywhere it exists — elsewhere they are
 * always there). A sent review shows its stars, its words and where it stands: waiting for the team, approved (it
 * counts on the product page), not approved (the reason's words, never the staff's note), or — from a demo order —
 * a test that is never published. The card says how reviews are treated, and a demo order says so first.
 */
export function OrderReviews({ lines, slots, demo }: { lines: readonly OrderLineView[]; slots: readonly ReviewSlot[]; demo: boolean }) {
  const t = useT("account");
  const bySlot = new Map(slots.map((slot) => [slot.orderItemId, slot]));
  const rows = lines.flatMap((line) => {
    const slot = bySlot.get(line.id);
    return slot ? [{ line, slot }] : [];
  });
  if (rows.length === 0) return null;
  return (
    <section aria-labelledby="order-review-title" className="acct-card">
      <div className="acct-fact">
        <span className="clay-disc" aria-hidden="true">
          <Icon name="star" size={20} />
        </span>
        <h2 id="order-review-title" className="acct-card__title">
          {t("order.review.title")}
        </h2>
        <div className="acct-fact__text grid gap-1">
          <p>{t("order.review.lead")}</p>
          <p>{t("order.review.fair")}</p>
        </div>
      </div>
      {demo ? (
        <Note tone="demo" variant="flat">
          {t("order.review.demo")}
        </Note>
      ) : null}
      <ul className="acct-reviews">
        {rows.map(({ line, slot }) => (
          <ReviewRow key={slot.orderItemId} line={line} slot={slot} />
        ))}
      </ul>
    </section>
  );
}

function ReviewRow({ line, slot }: { line: OrderLineView; slot: ReviewSlot }) {
  const t = useT("account");
  const dir = useDir();
  const { name, option } = splitOption(line.name);
  const latin = latinName(name, dir);
  const titleId = `review-${slot.orderItemId}`;
  // Sent from this page (the form gave way to the review once the order was read again): say so, and put focus on the
  // product's name — the key that sent it is gone. A review that was already there when the page opened says nothing.
  const had = useRef(slot.review !== null);
  useEffect(() => {
    if (had.current || !slot.review) return;
    had.current = true;
    toast.success(t(slot.review.verified ? "order.review.sent" : "order.review.sentDemo"));
    rescueFocus(titleId);
  }, [slot.review, t, titleId]);
  return (
    <li className="acct-review">
      <Niche as="span" size="sm" aria-hidden="true">
        {line.image ? <ProductImage image={line.image} alt="" sizes="72px" /> : null}
      </Niche>
      <div className="acct-review__body">
        <div className="grid gap-0.5">
          {/* focus lands here once the form gives way to the sent review (never on <body>) */}
          <h3 id={titleId} tabIndex={-1} className="acct-review__name">
            <span dir={latin.dir} className={latin.className}>
              <BidiText text={keepTokens(name)} />
            </span>
          </h3>
          {option ? <p className="acct-review__option">{option}</p> : null}
        </div>
        {slot.review ? <SentReview review={slot.review} href={line.href} /> : <ReviewForm slot={slot} name={name} />}
      </div>
    </li>
  );
}

function ReviewForm({ slot, name }: { slot: ReviewSlot; name: string }) {
  const t = useT("account");
  const fetcher = useFetcher();
  const sent = fetcher.data as ReviewAnswer | undefined;
  // a post without script renders the page again with the action's answer (the form's stars and text come back); a
  // refusal keeps this form (a 4xx answer reads nothing again), a review that was saved replaces it
  const page = useActionData() as ReviewAnswer | undefined;
  const mine = (answer: ReviewAnswer | null | undefined) => (answer && answer.intent === "review" && answer.orderItemId === slot.orderItemId ? answer : null);
  const answer = mine(sent) ?? (fetcher.state === "idle" && !sent ? mine(page) : null);
  const failed = answer && answer.ok === false ? answer : null;
  const ids = `rv-${slot.orderItemId}`;
  const sentRating = failed?.rating ?? null;
  return (
    // data-refused: a refused send shows its text even with no star chosen (account.css holds the text back until the
    // first star — a refusal's error link to the text must lead to a field that is there)
    <fetcher.Form method="post" className="acct-review__form" noValidate data-refused={failed ? "true" : undefined}>
      <input type="hidden" name="intent" value="review" />
      <input type="hidden" name="orderItemId" value={slot.orderItemId} />
      <FormFailure
        answer={failed}
        fields={[
          { name: "rating", id: `${ids}-1`, label: t("order.review.stars") },
          { name: "body", id: `${ids}-body`, label: t("order.review.text") },
        ]}
      />
      {/* the product's name is part of each field's name for a screen reader (every product has the same two fields) */}
      <FieldGroup legend={<>{t("order.review.stars")}<span className="sr-only"> — {name}</span></>} required layout="row" error={fieldError(failed, "rating")}>
        {/* five radios under star faces: the chosen star and every one before it fill (CSS, no script) */}
        <span className="acct-stars">
          {STARS.map((n) => (
            <label key={n} className="acct-star">
              <input
                id={`${ids}-${n}`}
                type="radio"
                name="rating"
                value={n}
                defaultChecked={sentRating === String(n)}
                className="acct-star__input"
                // the kit's drawn moment for a rating chosen (~/ui/sakuga): the lit stars pop one after another
                onChange={(event) => {
                  const row = event.currentTarget.closest(".acct-stars");
                  if (row) sakuga.rate([...row.querySelectorAll(".acct-star")], n);
                }}
              />
              <Icon name="star" size={28} className="acct-star__off" />
              <Icon name="star" filled size={28} className="acct-star__on" />
              <span className="sr-only">{t("order.review.star", { count: n })}</span>
            </label>
          ))}
        </span>
      </FieldGroup>
      <div className="acct-review__more">
        <TextArea
          id={`${ids}-body`}
          name="body"
          label={
            <>
              {t("order.review.text")}
              <span className="sr-only"> — {name}</span>
            </>
          }
          optional
          hint={t("order.review.textHint")}
          maxLength={REVIEW_LIMITS.body}
          rows={3}
          defaultValue={failed?.body ?? ""}
          error={fieldError(failed, "body")}
        />
        <SubmitKey pending={fetcher.state !== "idle"} icon="paper-plane-tilt" className="justify-self-start">
          {t("order.review.send")}
        </SubmitKey>
      </div>
    </fetcher.Form>
  );
}

/** The state of a review that was sent, in words: a pill, the stars, the text, and one note on what it means. */
function SentReview({ review, href }: { review: OwnReview; href: string | null }) {
  const t = useT("account");
  const f = useFormat();
  const state = review.status === "pending" && !review.verified ? "demo" : review.status;
  const tone: StatusTone = state === "approved" ? "ok" : state === "pending" ? "info" : "neutral";
  const reason = review.rejectCode && (OWN_REJECT_CODES as readonly string[]).includes(review.rejectCode) ? t(`order.review.reasons.${review.rejectCode}`) : null;
  return (
    <div className="acct-review__sent">
      <div className="acct-review__top">
        <span role="img" aria-label={t("order.review.star", { count: review.rating })} className="acct-review__stars">
          {STARS.map((n) => (
            <Icon key={n} name="star" filled={n <= review.rating} size={20} className={cx(n > review.rating && "text-ink-3")} />
          ))}
        </span>
        <Status tone={tone} pill>
          {t(`order.review.status.${state}`)}
        </Status>
      </div>
      {review.body ? (
        <p className="acct-review__text">
          <bdi dir="auto">{review.body}</bdi>
        </p>
      ) : null}
      <ul className="acct-review__notes">
        {/* a demo order's review: its pill and the card's demo note say it all */}
        {state === "pending" ? <li>{t("order.review.pendingNote")}</li> : null}
        {state === "approved" ? (
          <li className="flex flex-wrap items-baseline gap-x-3">
            <span>{t("order.review.approvedNote")}</span>
            {href ? (
              <TextLink as={LocaleLink} to={href}>
                {t("order.review.productPage")}
              </TextLink>
            ) : null}
          </li>
        ) : null}
        {state === "rejected" && reason ? <li>{t("order.review.reason", { reason })}</li> : null}
        {!review.here ? <li>{t("order.review.elsewhere")}</li> : null}
        <li className="type-xs">{t("order.review.writtenOn", { date: f.date(review.createdAt, "long") })}</li>
      </ul>
    </div>
  );
}
