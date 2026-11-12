/**
 * /support/repair/status — where a repair request stands (Design System v2 §6.13; services/support/repairs.server).
 *
 *   ?ref=RP-…&t=<token>[&new=1]   the link the shopper lands on after sending a request (only the token's hash is stored)
 *   POST ref + phone               anyone else: the reference AND the phone it was sent with; rate limited, and a wrong
 *                                  reference and a wrong phone get the same answer
 *
 * A lookup card (560px), then the request card: the reference (Plex 600 20px, tabular, left-to-right, with a copy
 * key), the status in words with its explanation, a quote waiting for approval, the device, the shopper's own
 * description, hand-over preferences, how many photos they sent, and the status timeline with dates. Never the serial,
 * internal notes or anything staff wrote for themselves; never a call promise. After a lookup the result's heading takes
 * focus. Never cached.
 */
import { useEffect, useId, useRef } from "react";
import { data, Form, useNavigation, type ShouldRevalidateFunctionArgs } from "react-router";

import type { Route } from "./+types/repair-status";
import { Icon } from "~/art/Icon";
import { messagesFor } from "~/i18n/i18n.server";
import { LocaleLink, useFormat, useT } from "~/i18n/react";
import type { MotionHandle } from "~/motion";
import { getCtx } from "~/server/context.server";
import { getDb } from "~/server/db.server";
import { normalizeSupportRef, TICKET_REF_PREFIX } from "~/server/services/support/common.server";
import { getRepairByAccessToken, lookupRepair } from "~/server/services/support/repairs.server";
import type { RepairStatusKey, RepairStatusView } from "~/server/services/support/types";
import { shellMeta } from "~/routes/storefront/shell/meta";
import { DemoNote } from "~/ui/DemoNote";
import { TextField } from "~/ui/Field";
import { Key } from "~/ui/Key";
import { Price } from "~/ui/Price";
import { Status, type StatusTone } from "~/ui/Tag";
import { TextLink } from "~/ui/TextLink";
import { fieldMessage, formMessage, isFailure, keepFormOnFailure, phoneProblem, revalidateAfter } from "./client";
import { CopyKey, CopyLinkKey, DeviceArt, Name, SupportNav } from "./components/parts";
import { failed, LOOKUP_PAGE_HEADERS, repairStatusHeaders, textFields } from "./support.server";
import "./support.css";

export const handle = { nav: "push", order: 3, group: "support" } satisfies MotionHandle;

export async function loader({ context, url }: Route.LoaderArgs) {
  const ctx = getCtx(context);
  const ref = url.searchParams.get("ref");
  const token = url.searchParams.get("t");
  const view = ref && token ? await getRepairByAccessToken(getDb(), ctx.locale, ref, token) : null;
  // the request's card behind its private link sends the address nowhere; the lookup form must post as same-origin
  return data(
    { view, created: view !== null && url.searchParams.get("new") === "1", replayed: url.searchParams.get("replayed") === "1", askedRef: ref ?? "", i18n: messagesFor(ctx.locale, "support", "errors") },
    { headers: repairStatusHeaders(view !== null) },
  );
}

export async function action({ request, context }: Route.ActionArgs) {
  const ctx = getCtx(context);
  const values = textFields(await request.formData(), ["ref", "phone"]);
  // a message-to-staff number typed here: it is followed on /support/ticket (said under the field, linked beside)
  if (normalizeSupportRef(values.ref, TICKET_REF_PREFIX)) return data({ ok: false as const, code: "invalid", status: 400, fields: { ref: "ticket_ref" }, values }, { status: 400, headers: LOOKUP_PAGE_HEADERS });
  try {
    const view = await lookupRepair(getDb(), ctx.locale, values, { ip: ctx.ip }, ctx.now);
    // the address carries no token after a lookup; the form may show again (not found), so it must keep posting
    if (!view) return data({ ok: false as const, code: "not_found", status: 200, values }, { headers: LOOKUP_PAGE_HEADERS });
    return data({ ok: true as const, view }, { headers: LOOKUP_PAGE_HEADERS });
  } catch (error) {
    return failed(error, values);
  }
}

/** A lookup that never reached the store comes back as a value, and nothing is reloaded after it: the form stays. */
export async function clientAction({ serverAction }: Route.ClientActionArgs) {
  return keepFormOnFailure(serverAction);
}

export function shouldRevalidate(args: ShouldRevalidateFunctionArgs) {
  return revalidateAfter(args);
}

/** The document's headers: the action's after a lookup was posted, else the loader's (above). */
export function headers({ actionHeaders, loaderHeaders }: Route.HeadersArgs) {
  return actionHeaders.has("Cache-Control") ? actionHeaders : loaderHeaders;
}

export const meta: Route.MetaFunction = (args) => {
  const tree = args.loaderData?.i18n.support as { meta?: { status?: { title?: string; description?: string } } } | undefined;
  return shellMeta(args, { title: tree?.meta?.status?.title, description: tree?.meta?.status?.description, noindex: true });
};

const TONE: Record<RepairStatusKey, StatusTone> = {
  submitted: "warn",
  received: "info",
  diagnosing: "info",
  awaiting_approval: "warn",
  awaiting_parts: "info",
  repairing: "info",
  ready: "ok",
  delivered: "ok",
  unrepairable: "bad",
  cancelled: "neutral",
};

export default function RepairStatusPage({ loaderData, actionData }: Route.ComponentProps) {
  const t = useT("support");
  const errorsT = useT("errors");
  const navigation = useNavigation();
  const busy = navigation.state !== "idle" && navigation.formMethod?.toUpperCase() === "POST";
  const looked = actionData && "ok" in actionData && actionData.ok === true && "view" in actionData ? (actionData.view as RepairStatusView) : null;
  const failure = isFailure(actionData) ? actionData : null;
  const view = looked ?? loaderData.view;
  const ids = { lede: useId(), help: useId() };
  const phoneError = failure?.fields?.phone
    ? failure.fields.phone === "required"
      ? t("fieldErrors.phone.required")
      : (phoneProblem(failure.values?.phone ?? "", t, errorsT) ?? fieldMessage("phone", failure.fields.phone, t, errorsT))
    : undefined;

  return (
    <div className="page sup sup-flow">
      <div className="sup-flow__main">
        <SupportNav current="status" />
        <h1 className="type-h1 text-ink">{t("status.title")}</h1>

        {loaderData.created && view ? (
          <div role="status" className="sup-callout sup-callout--ok">
            <Icon name="check-circle" size={20} className="sup-callout__icon" />
            <div className="grid min-w-0 gap-1">
              <p className="sup-callout__title">{t("status.created.title")}</p>
              <p className="type-sm text-ink">{loaderData.replayed ? t("status.replayed") : t("status.created.text")}</p>
              <p className="type-xs text-ink-2">{t("status.created.save")}</p>
              <div className="mt-1">
                <CopyLinkKey drop={["new", "replayed"]} />
              </div>
            </div>
          </div>
        ) : null}

        {view ? (
          <RepairCard view={view} focusOnShow={looked !== null} />
        ) : (
          <section aria-labelledby={ids.lede} className="sup-card sup-lookup">
            <p id={ids.lede} className="type-body text-ink">
              {t("status.lede")}
            </p>
            {failure && !failure.fields ? (
              <p role="alert" className="sup-alert">
                <Icon name="warning-circle" size={20} />
                <span>{failure.code === "not_found" ? t("status.notFound") : formMessage(failure, t, errorsT)}</span>
              </p>
            ) : null}
            <Form method="post" action="." noValidate className="grid gap-5">
              <TextField
                label={t("status.ref")}
                name="ref"
                required
                ltr
                autoCapitalize="characters"
                autoComplete="off"
                spellCheck={false}
                maxLength={24}
                hint={t("status.refHint")}
                defaultValue={failure?.values?.ref ?? loaderData.askedRef}
                error={fieldMessage("ref", failure?.fields?.ref, t, errorsT)}
              />
              <TextField label={t("status.phone")} name="phone" type="tel" inputMode="tel" autoComplete="tel-national" required defaultValue={failure?.values?.phone ?? ""} error={phoneError} />
              <div>
                <Key type="submit" variant="primary" icon="magnifying-glass" loading={busy}>
                  {t("status.submit")}
                </Key>
              </div>
            </Form>
          </section>
        )}
      </div>

      <aside aria-labelledby={ids.help} className="sup-flow__aside sup-flow__aside--all">
        <div className="sup-card">
          <h2 id={ids.help} className="type-h3 text-ink">
            {t("status.help")}
          </h2>
          <TextLink as={LocaleLink} to="/support/assistant?handoff=1#handoff">
            {t("assistant.done.staff")}
          </TextLink>
          <TextLink as={LocaleLink} to="/support/repair">
            {t("status.book")}
          </TextLink>
          <TextLink as={LocaleLink} to="/support/ticket">
            {t("ticket.title")}
          </TextLink>
          {view ? (
            <TextLink as={LocaleLink} to="/support/repair/status">
              {t("status.another")}
            </TextLink>
          ) : null}
        </div>
      </aside>
    </div>
  );
}

function RepairCard({ view, focusOnShow }: { view: RepairStatusView; focusOnShow: boolean }) {
  const t = useT("support");
  const f = useFormat();
  const headingId = useId();
  const headingRef = useRef<HTMLHeadingElement>(null);
  // After a lookup the result's heading takes focus (the form it replaced is gone).
  useEffect(() => {
    if (!focusOnShow) return;
    headingRef.current?.focus({ preventScroll: true });
    headingRef.current?.scrollIntoView({ block: "nearest" });
  }, [focusOnShow]);
  const day = view.preferredDay ? f.date(Date.parse(`${view.preferredDay}T09:00:00Z`), "long") : null;
  const preferred = [day, view.preferredWindow && view.preferredWindow !== "any" ? t(`windows.${view.preferredWindow}`) : null].filter(Boolean).join(" · ");
  return (
    <section aria-labelledby={headingId} className="sup-card sup-request">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="grid gap-1">
          <h2 id={headingId} ref={headingRef} tabIndex={-1} className="type-sm-strong text-ink-2">
            {t("status.labels.ref")}
          </h2>
          <p className="flex flex-wrap items-center gap-x-1">
            <bdi dir="ltr" className="type-code text-ink">
              {view.ref}
            </bdi>
            <CopyKey text={view.ref} what={t("status.labels.ref")} />
          </p>
        </div>
        {view.isDemo ? <DemoNote variant="tag" what="order">{t("status.demo")}</DemoNote> : null}
      </div>

      <div className="sup-request__status" role="status">
        <p className="type-sm-strong text-ink-2">{t("status.labels.status")}</p>
        <p>
          <Status tone={TONE[view.status]} size="lg">
            {t(`status.states.${view.status}.label`)}
          </Status>
        </p>
        <p className="type-body text-ink">{t(`status.states.${view.status}.text`)}</p>
        {view.quoteIqd !== null ? (
          <div className="sup-request__quote">
            <p className="type-sm-strong text-ink-2">{t("status.labels.quote")}</p>
            <Price amountIqd={view.quoteIqd} size="md" approx="off" />
            <p className="type-sm text-ink-2">{view.quoteApproved ? t("status.quoteApproved") : t("status.quotePending")}</p>
            {!view.quoteApproved ? (
              <p className="flex flex-wrap items-center gap-x-2 type-sm text-ink-2">
                <span>{t("status.quoteHow")}</span>
                <TextLink as={LocaleLink} to="/support/assistant?handoff=1#handoff">
                  {t("assistant.done.staff")}
                </TextLink>
              </p>
            ) : null}
          </div>
        ) : null}
        {view.isWarranty ? <p className="type-sm-strong text-ok">{t("status.warranty")}</p> : null}
      </div>

      <div className="flex items-center gap-3">
        {view.device ? <DeviceArt artKey={view.device.artKey} small sizes="56px" className="w-14 shrink-0" /> : null}
        <div className="grid min-w-0 gap-0.5">
          <p className="type-sm-strong text-ink-2">{t("status.labels.device")}</p>
          <p className="type-card text-ink">
            <Name>{view.device?.name ?? view.deviceText ?? "—"}</Name>
          </p>
        </div>
      </div>

      <dl className="sup-request__facts">
        <Fact label={t("status.labels.sent")} value={f.dateTime(view.createdAt)} />
        <Fact label={t("status.labels.photos")} value={t("status.photoCount", { count: view.photoCount })} />
        <Fact label={t("status.labels.handover")} value={view.handover ? t(`handover.view.${view.handover}`) : t("handover.none")} />
        <Fact label={t("status.labels.day")} value={preferred || t("handover.none")} />
        <div className="grid gap-0.5 md:col-span-2">
          <dt className="type-sm-strong text-ink-2">{t("status.labels.issue")}</dt>
          <dd className="whitespace-pre-wrap type-body text-ink" dir="auto">
            {view.issue}
          </dd>
        </div>
      </dl>

      <div className="grid gap-3 border-t border-line pt-4">
        <h3 className="type-h3 text-ink">{t("status.timeline")}</h3>
        <ol className="sup-timeline">
          {view.timeline.map((entry, index) => (
            <li key={`${entry.status}:${entry.at}`} className="sup-timeline__item" data-current={index === view.timeline.length - 1 ? "" : undefined}>
              <span className="sup-timeline__dot" aria-hidden="true">
                {index === view.timeline.length - 1 ? null : <Icon name="check" size={16} />}
              </span>
              <span className="type-card text-ink">{t(`status.states.${entry.status}.label`)}</span>
              <span className="type-xs text-ink-2 nums">{f.dateTime(entry.at)}</span>
            </li>
          ))}
        </ol>
      </div>
    </section>
  );
}

function Fact({ label, value }: { label: string; value: string }) {
  return (
    <div className="grid gap-0.5">
      <dt className="type-sm-strong text-ink-2">{label}</dt>
      <dd className="type-body text-ink">{value}</dd>
    </div>
  );
}
