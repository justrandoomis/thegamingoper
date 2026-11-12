/**
 * /support/ticket — following a message to staff ("SP-…", the hand-off's reference) and rating the help once staff
 * solved it (Design System v2 §6.13; services/support/tickets.server).
 *
 *   ?ref=SP-…&tk=<token>   the receipt's own link (the hand-off page links here: only the token's hash is stored)
 *   POST lookup            anyone else: the reference AND the phone it was sent with — rate limited, and a wrong
 *                          reference and a wrong phone get the same answer
 *   POST rate              1–5 and an optional comment, once staff resolved or closed it; proved by the same token or
 *                          reference + phone (they ride along as hidden fields). Written to the ticket's own
 *                          satisfaction fields, which the support module's metrics count (admin 14.05) — never a
 *                          default, never a score the shopper did not choose.
 *
 * A lookup card (560px), then the request card: the reference (Plex 600 20px, tabular, left-to-right, with a copy key),
 * the status in words, when it was sent, the replies staff wrote to the shopper (never internal notes), and the rating
 * part. A repair number typed here says where it is followed instead. After a lookup the result's heading takes
 * focus. Never cached; the private link's address is sent nowhere.
 */
import { useEffect, useId, useRef, useState } from "react";
import { data, Form, useNavigation, type ShouldRevalidateFunctionArgs } from "react-router";

import type { Route } from "./+types/ticket";
import { Icon } from "~/art/Icon";
import { messagesFor, serverT } from "~/i18n/i18n.server";
import { LocaleLink, useFormat, useT } from "~/i18n/react";
import type { MotionHandle } from "~/motion";
import { getCtx } from "~/server/context.server";
import { getDb } from "~/server/db.server";
import { actionError, isAppError } from "~/server/errors";
import { REPAIR_REF_PREFIX, normalizeSupportRef } from "~/server/services/support/common.server";
import { getTicketByAccessToken, lookupTicket, rateTicket, type TicketReceipt } from "~/server/services/support/tickets.server";
import { TICKET_RATING_SCALE } from "~/server/services/support/types";
import { shellMeta } from "~/routes/storefront/shell/meta";
import { DemoNote } from "~/ui/DemoNote";
import { FieldGroup, Radio, TextArea, TextField } from "~/ui/Field";
import { Key } from "~/ui/Key";
import { Status, type StatusTone } from "~/ui/Tag";
import { TextLink } from "~/ui/TextLink";
import { fieldMessage, formMessage, isFailure, keepFormOnFailure, phoneProblem, revalidateAfter, sentValues, ticketView, withSentValues, type FormFailure } from "./client";
import { CopyKey, SupportNav } from "./components/parts";
import { failed, LOOKUP_PAGE_HEADERS, supportWho, textFields, ticketPageHeaders } from "./support.server";
import "./support.css";

/** Part of «تتبّع» (the support navigation's fourth segment), between the repair status and nothing else. */
export const handle = { nav: "push", order: 3, group: "support" } satisfies MotionHandle;

export async function loader({ context, url }: Route.LoaderArgs) {
  const ctx = getCtx(context);
  const ref = url.searchParams.get("ref");
  const token = url.searchParams.get("tk");
  const receipt = ref && token ? await getTicketByAccessToken(getDb(), ref, token) : null;
  const t = serverT(ctx.locale, "support");
  return data(
    { receipt, token: receipt ? token : null, askedRef: ref ?? "", meta: { title: t("ticket.title"), description: t("ticket.lede") }, i18n: messagesFor(ctx.locale, "support", "errors") },
    // the private link's card sends its address nowhere — unless it holds the rating form, which (like the lookup form)
    // must post without script: `same-origin` then (ticketPageHeaders)
    { headers: ticketPageHeaders(receipt) },
  );
}

type Proof = { token: string } | { phone: string };

export async function action({ request, context }: Route.ActionArgs) {
  const ctx = getCtx(context);
  const db = getDb();
  const form = await request.formData();
  const values = textFields(form, ["intent", "ref", "phone", "tk", "rating", "comment"]);
  try {
    if (values.intent === "rate") {
      const { who } = await supportWho(ctx, db);
      const proof: Proof = values.tk ? { token: values.tk } : { phone: values.phone };
      try {
        const outcome = await rateTicket(db, who, { ref: values.ref, token: values.tk || undefined, phone: values.phone, rating: values.rating, comment: values.comment }, ctx.now);
        if (!outcome.receipt) return data({ ok: false as const, code: "not_found", status: 200, values: { ...values, tk: "" } }, { headers: LOOKUP_PAGE_HEADERS });
        const shown: Shown = { receipt: outcome.receipt, proof, rated: outcome.ok ? "thanks" : outcome.reason, ratingError: null };
        return data({ ok: true as const, ...shown }, { headers: LOOKUP_PAGE_HEADERS });
      } catch (error) {
        // nothing chosen (or a comment too long): the card stays, the rating says what is missing
        if (!isAppError(error, "invalid")) throw error;
        const receipt = values.tk ? await getTicketByAccessToken(db, values.ref, values.tk) : await lookupTicket(db, { ref: values.ref, phone: values.phone }, { ip: ctx.ip }, ctx.now);
        if (!receipt) throw error;
        const shown: Shown = { receipt, proof, rated: null, ratingError: { fields: actionError(error).fields ?? {}, comment: values.comment } };
        return data({ ok: true as const, ...shown }, { status: 400, headers: LOOKUP_PAGE_HEADERS });
      }
    }
    // a repair number typed here: it is followed on the repair status page (said under the field)
    if (normalizeSupportRef(values.ref, REPAIR_REF_PREFIX)) return data({ ok: false as const, code: "invalid", status: 400, fields: { ref: "repair_ref" }, values }, { status: 400, headers: LOOKUP_PAGE_HEADERS });
    const receipt = await lookupTicket(db, { ref: values.ref, phone: values.phone }, { ip: ctx.ip }, ctx.now);
    if (!receipt) return data({ ok: false as const, code: "not_found", status: 200, values }, { headers: LOOKUP_PAGE_HEADERS });
    const shown: Shown = { receipt, proof: { phone: values.phone }, rated: null, ratingError: null };
    return data({ ok: true as const, ...shown }, { headers: LOOKUP_PAGE_HEADERS });
  } catch (error) {
    return failed(error, { ...values, tk: "" });
  }
}

/**
 * A request that never reached the store comes back as a value, and nothing is reloaded after it: the form stays. The
 * value names the form it came from (`intent`) with the words typed — never the token or the phone — so a rating that
 * never reached the store keeps its card instead of turning into the lookup form (ticketView).
 */
export async function clientAction({ request, serverAction }: Route.ClientActionArgs) {
  const sent = await sentValues(request, ["intent", "ref", "rating", "comment"]);
  return withSentValues(await keepFormOnFailure(serverAction), sent);
}

export function shouldRevalidate(args: ShouldRevalidateFunctionArgs) {
  return revalidateAfter(args);
}

/** The document's headers: the action's after a post, else the loader's (above). */
export function headers({ actionHeaders, loaderHeaders }: Route.HeadersArgs) {
  return actionHeaders.has("Cache-Control") ? actionHeaders : loaderHeaders;
}

export const meta: Route.MetaFunction = (args) => shellMeta(args, { title: args.loaderData?.meta.title, description: args.loaderData?.meta.description, noindex: true });

const STATUS_TONE: Record<string, StatusTone> = { open: "warn", pending_staff: "warn", pending_customer: "info", on_hold: "neutral", resolved: "ok", closed: "neutral" };

/** The card on screen: the receipt, how this shopper proved it is theirs, and what the last rating post said. */
type Shown = {
  receipt: TicketReceipt;
  proof: Proof;
  rated: "thanks" | "not_found" | "not_ratable" | "already_rated" | null;
  /** A rating post with nothing chosen (or a comment too long): the field codes and the comment typed. */
  ratingError: { fields: Record<string, string>; comment: string } | null;
};

export default function TicketPage({ loaderData, actionData }: Route.ComponentProps) {
  const t = useT("support");
  const errorsT = useT("errors");
  const navigation = useNavigation();
  const busy = navigation.state !== "idle" && navigation.formMethod?.toUpperCase() === "POST" && navigation.formData?.get("intent") !== "rate";
  const failure = isFailure(actionData) ? actionData : null;
  const posted = actionData && "ok" in actionData && actionData.ok === true ? (actionData as unknown as Shown) : null;
  const fromLink: Shown | null = loaderData.receipt && loaderData.token ? { receipt: loaderData.receipt, proof: { token: loaderData.token }, rated: null, ratingError: null } : null;
  const ids = { lede: useId(), help: useId() };
  // the last card a post answered with (a lookup by number + phone): a rating sent from it that fails keeps it on
  // screen — with the form and the words typed — and says why in its rating part (ticketView)
  const [kept, setKept] = useState<Shown | null>(posted);
  if (posted && posted !== kept) setKept(posted);
  const { card, ratingFailure, lookupFailure } = ticketView({ posted, kept, fromLink, failure });
  const phoneError = lookupFailure?.fields?.phone
    ? lookupFailure.fields.phone === "required"
      ? t("fieldErrors.phone.required")
      : (phoneProblem(lookupFailure.values?.phone ?? "", t, errorsT) ?? fieldMessage("phone", lookupFailure.fields.phone, t, errorsT))
    : undefined;

  return (
    <div className="page sup sup-flow">
      <div className="sup-flow__main">
        <SupportNav current="status" section />
        <h1 className="type-h1 text-ink">{t("ticket.title")}</h1>

        {card ? (
          <TicketCard shown={card} focusOnShow={posted !== null && posted.rated === null} ratingFailure={ratingFailure} />
        ) : (
          <section aria-labelledby={ids.lede} className="sup-card sup-lookup">
            <p id={ids.lede} className="type-body text-ink">
              {t("ticket.lede")}
            </p>
            {lookupFailure && !lookupFailure.fields ? (
              <p role="alert" className="sup-alert">
                <Icon name="warning-circle" size={20} />
                <span>{lookupFailure.code === "not_found" ? t("ticket.notFound") : formMessage(lookupFailure, t, errorsT)}</span>
              </p>
            ) : null}
            <Form method="post" action="." noValidate className="grid gap-5">
              <input type="hidden" name="intent" value="lookup" />
              <TextField
                label={t("ticket.ref")}
                name="ref"
                required
                ltr
                autoCapitalize="characters"
                autoComplete="off"
                spellCheck={false}
                maxLength={24}
                hint={t("ticket.refHint")}
                defaultValue={lookupFailure?.values?.ref ?? loaderData.askedRef}
                error={fieldMessage("ticketRef", lookupFailure?.fields?.ref, t, errorsT)}
              />
              <TextField label={t("ticket.phone")} name="phone" type="tel" inputMode="tel" autoComplete="tel-national" required defaultValue={lookupFailure?.values?.phone ?? ""} error={phoneError} />
              <div>
                <Key type="submit" variant="primary" icon="magnifying-glass" loading={busy}>
                  {t("ticket.submit")}
                </Key>
              </div>
            </Form>
          </section>
        )}
      </div>

      <aside aria-labelledby={ids.help} className="sup-flow__aside sup-flow__aside--all">
        <div className="sup-card">
          <h2 id={ids.help} className="type-h3 text-ink">
            {t("ticket.help")}
          </h2>
          <TextLink as={LocaleLink} to="/support/assistant?handoff=1#handoff">
            {t("ticket.staff")}
          </TextLink>
          <TextLink as={LocaleLink} to="/support/repair/status">
            {t("ticket.repairStatus")}
          </TextLink>
          {card ? (
            <TextLink as={LocaleLink} to="/support/ticket">
              {t("ticket.another")}
            </TextLink>
          ) : null}
        </div>
      </aside>
    </div>
  );
}

function TicketCard({ shown, focusOnShow, ratingFailure }: { shown: Shown; focusOnShow: boolean; ratingFailure: FormFailure | null }) {
  const t = useT("support");
  const f = useFormat();
  const headingId = useId();
  const headingRef = useRef<HTMLHeadingElement>(null);
  const { receipt } = shown;
  // After a lookup the result's heading takes focus (the form it replaced is gone).
  useEffect(() => {
    if (!focusOnShow) return;
    headingRef.current?.focus({ preventScroll: true });
    headingRef.current?.scrollIntoView({ block: "nearest" });
  }, [focusOnShow]);
  const statusKey = `handoff.statuses.${receipt.status}`;
  const statusWords = t(statusKey) === statusKey ? receipt.status : t(statusKey);
  return (
    <section aria-labelledby={headingId} className="sup-card sup-request" data-ticket={receipt.ref}>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="grid gap-1">
          <h2 id={headingId} ref={headingRef} tabIndex={-1} className="type-sm-strong text-ink-2">
            {t("handoff.success.ticket")}
          </h2>
          <p className="flex flex-wrap items-center gap-x-1">
            <bdi dir="ltr" className="type-code text-ink">
              {receipt.ref}
            </bdi>
            <CopyKey text={receipt.ref} what={t("handoff.success.ticket")} />
          </p>
        </div>
        {receipt.isDemo ? <DemoNote variant="tag" what="order">{t("handoff.success.demo")}</DemoNote> : null}
      </div>

      <dl className="sup-request__facts">
        <div className="grid gap-0.5">
          <dt className="type-sm-strong text-ink-2">{t("handoff.success.status")}</dt>
          <dd>
            <Status tone={STATUS_TONE[receipt.status] ?? "neutral"} size="lg">
              {statusWords}
            </Status>
          </dd>
        </div>
        <div className="grid gap-0.5">
          <dt className="type-sm-strong text-ink-2">{t("ticket.sent")}</dt>
          <dd className="type-body text-ink nums">{f.dateTime(receipt.createdAt)}</dd>
        </div>
      </dl>

      <div className="grid gap-2 border-t border-line pt-4">
        <h3 className="type-h3 text-ink">{t("handoff.success.replies")}</h3>
        {receipt.replies.length > 0 ? (
          <ol className="grid gap-2">
            {receipt.replies.map((reply, index) => (
              <li key={`${reply.at}:${index}`} className="sup-bubble sup-bubble--bot">
                <p className="whitespace-pre-wrap type-body text-ink" dir="auto">
                  {reply.body}
                </p>
                <p className="type-xs text-ink-2">{f.dateTime(reply.at)}</p>
              </li>
            ))}
          </ol>
        ) : (
          <p className="type-sm text-ink-2">{t("handoff.success.noReply")}</p>
        )}
      </div>

      <Rating shown={shown} failure={ratingFailure} />
    </section>
  );
}

/**
 * «كيف كانت المساعدة؟» — only once staff resolved or closed the request, and only until the shopper answered: five
 * radio rows (1 «سيئة جداً» … 5 «ممتازة», each with its words, never colour or stars alone), an optional comment, and
 * «أرسل تقييمك». After it: the thanks and the rating given. Nothing is chosen in advance.
 */
function Rating({ shown, failure }: { shown: Shown; failure: FormFailure | null }) {
  const t = useT("support");
  const errorsT = useT("errors");
  const f = useFormat();
  const navigation = useNavigation();
  const rating = useId();
  const sending = navigation.state !== "idle" && navigation.formData?.get("intent") === "rate";
  const { receipt, proof, rated, ratingError } = shown;
  if (receipt.rating !== null) {
    return (
      <div className="grid gap-1 border-t border-line pt-4" role="status">
        {rated === "thanks" ? <p className="flex items-center gap-1.5 type-sm-strong text-ok">
            <Icon name="check-circle" size={20} filled />
            {t("ticket.rate.thanks")}
          </p> : rated === "already_rated" ? <p className="type-sm text-ink-2">{t("ticket.rate.already")}</p> : null}
        <p className="type-body text-ink nums">{t("ticket.rate.given", { rating: f.number(receipt.rating) })}</p>
      </div>
    );
  }
  if (!receipt.canRate) {
    return rated === "not_ratable" ? <p className="border-t border-line pt-4 type-sm text-ink-2">{t("ticket.rate.notYet")}</p> : null;
  }
  const fields = ratingError?.fields ?? failure?.fields ?? {};
  const comment = ratingError?.comment ?? failure?.values?.comment ?? "";
  return (
    <section id="rate" aria-labelledby={`${rating}-title`} className="grid gap-4 border-t border-line pt-4">
      <div className="grid gap-1">
        <h3 id={`${rating}-title`} className="type-h3 text-ink">
          {t("ticket.rate.title")}
        </h3>
        <p className="type-sm text-ink-2">{t("ticket.rate.lede")}</p>
      </div>
      {failure && !failure.fields ? (
        <p role="alert" className="sup-alert">
          <Icon name="warning-circle" size={20} />
          <span>{formMessage(failure, t, errorsT)}</span>
        </p>
      ) : null}
      <Form method="post" action="." preventScrollReset noValidate className="grid gap-4">
        <input type="hidden" name="intent" value="rate" />
        <input type="hidden" name="ref" value={receipt.ref} />
        {"token" in proof ? <input type="hidden" name="tk" value={proof.token} /> : <input type="hidden" name="phone" value={proof.phone} />}
        <FieldGroup id={`${rating}-scale`} legend={t("ticket.rate.scale")} required error={fieldMessage("rating", fields.rating, t, errorsT)}>
          {Array.from({ length: TICKET_RATING_SCALE }, (_, index) => index + 1).map((value) => (
            <Radio key={value} name="rating" value={String(value)} label={t(`ticket.rate.values.r${value}`)} />
          ))}
        </FieldGroup>
        <TextArea label={t("ticket.rate.comment")} name="comment" optional hint={t("ticket.rate.commentHint")} maxLength={500} rows={2} defaultValue={comment} error={fieldMessage("comment", fields.comment, t, errorsT)} />
        <div>
          {/* lint-design: allow primary-count — the lookup form and this card are never on screen together (the card replaces the form) */}
          <Key type="submit" variant="primary" icon="paper-plane-tilt" loading={sending}>
            {t("ticket.rate.submit")}
          </Key>
        </div>
      </Form>
    </section>
  );
}
