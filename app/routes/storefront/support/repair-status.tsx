/**
 * /support/repair/status — where a repair request stands (services/support/repairs.server).
 *
 *   ?ref=RP-…&t=<token>[&new=1]   the link the shopper lands on after sending a request (only the token's hash is stored)
 *   POST ref + phone               anyone else: the reference AND the phone it was sent with; rate limited, and a wrong
 *                                  reference and a wrong phone get the same answer
 *
 * Shows what the shopper may see — status in words with its explanation, the dates of each change, the device, their
 * own description, hand-over preferences, how many photos they sent, a quote waiting for approval. Never the serial,
 * internal notes or anything staff wrote for themselves. Never cached.
 */
import { useId } from "react";
import { data, Form, useNavigation } from "react-router";

import type { Route } from "./+types/repair-status";
import { Icon } from "~/art/Icon";
import { messagesFor } from "~/i18n/i18n.server";
import { LocaleLink, useFormat, useT } from "~/i18n/react";
import type { MotionHandle } from "~/motion";
import { getCtx } from "~/server/context.server";
import { getDb } from "~/server/db.server";
import { getRepairByAccessToken, lookupRepair } from "~/server/services/support/repairs.server";
import type { RepairStatusKey, RepairStatusView } from "~/server/services/support/types";
import { shellMeta } from "~/routes/storefront/shell/meta";
import { DemoNote } from "~/ui/DemoNote";
import { TextField } from "~/ui/Field";
import { Key } from "~/ui/Key";
import { Price } from "~/ui/Price";
import { Status, type StatusTone } from "~/ui/Tag";
import { TextLink } from "~/ui/TextLink";
import { fieldMessage, formMessage, isFailure, keepFormOnFailure, phoneProblem } from "./client";
import { CopyKey, DeviceArt, Name, SupportTabs } from "./components/parts";
import { failed, textFields } from "./support.server";

export const handle = { nav: "push", order: 3, group: "support" } satisfies MotionHandle;

const PRIVATE = { "Cache-Control": "private, no-store", "Referrer-Policy": "no-referrer" };

export async function loader({ context, url }: Route.LoaderArgs) {
  const ctx = getCtx(context);
  const ref = url.searchParams.get("ref");
  const token = url.searchParams.get("t");
  const view = ref && token ? await getRepairByAccessToken(getDb(), ctx.locale, ref, token) : null;
  return data(
    { view, created: view !== null && url.searchParams.get("new") === "1", replayed: url.searchParams.get("replayed") === "1", askedRef: ref ?? "", i18n: messagesFor(ctx.locale, "support", "errors") },
    { headers: PRIVATE },
  );
}

export async function action({ request, context }: Route.ActionArgs) {
  const ctx = getCtx(context);
  const values = textFields(await request.formData(), ["ref", "phone"]);
  try {
    const view = await lookupRepair(getDb(), ctx.locale, values, { ip: ctx.ip }, ctx.now);
    if (!view) return data({ ok: false as const, code: "not_found", status: 200, values }, { headers: PRIVATE });
    return data({ ok: true as const, view }, { headers: PRIVATE });
  } catch (error) {
    return failed(error, values);
  }
}

export async function clientAction({ serverAction }: Route.ClientActionArgs) {
  return keepFormOnFailure(serverAction);
}

export function headers() {
  return PRIVATE;
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
  const formId = useId();

  return (
    <div className="page grid gap-section pb-12 pt-4 lg:grid-cols-12 lg:gap-x-10 lg:pt-6">
      <div className="grid min-w-0 content-start gap-5 lg:col-span-8">
        <header className="grid gap-3">
          <SupportTabs current="status" />
          <h1 className="type-title text-ink">{t("status.title")}</h1>
        </header>

        {loaderData.created && view ? (
          <div role="status" className="grid gap-1 rounded-panel border border-line bg-paper p-4">
            <p className="flex items-center gap-2 type-sub text-ink">
              <Icon name="check-circle" size={22} className="text-ok" />
              {t("status.created.title")}
            </p>
            <p className="type-body text-ink-2">{loaderData.replayed ? t("status.replayed") : t("status.created.text")}</p>
            <p className="type-caption text-ink-2">{t("status.created.save")}</p>
          </div>
        ) : null}

        {view ? (
          <RepairCard view={view} />
        ) : (
          <section aria-labelledby={formId} className="grid gap-4">
            <p id={formId} className="max-w-[60ch] type-body text-ink-2">
              {t("status.lede")}
            </p>
            {failure ? (
              <p role="alert" className="flex items-start gap-2 type-body text-red-ink">
                <Icon name="warning-circle" size={20} className="mt-0.5 shrink-0" />
                <span>{failure.code === "not_found" ? t("status.notFound") : formMessage(failure, t, errorsT)}</span>
              </p>
            ) : null}
            <Form method="post" noValidate className="grid max-w-xl gap-4">
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
              <TextField
                label={t("status.phone")}
                name="phone"
                type="tel"
                inputMode="tel"
                autoComplete="tel-national"
                required
                defaultValue={failure?.values?.phone ?? ""}
                error={failure?.fields?.phone ? (failure.fields.phone === "required" ? t("fieldErrors.phone.required") : phoneProblem(failure.values?.phone ?? "", t, errorsT) ?? fieldMessage("phone", failure.fields.phone, t, errorsT)) : undefined}
              />
              <div>
                <Key type="submit" variant="ink" icon="magnifying-glass" loading={busy}>
                  {t("status.submit")}
                </Key>
              </div>
            </Form>
          </section>
        )}
      </div>

      <aside className="grid content-start gap-3 lg:col-span-4 lg:pt-14">
        <div className="grid gap-2 rounded-panel bg-paper p-4 md:p-5">
          <p className="type-sub text-ink">{t("status.help")}</p>
          <TextLink as={LocaleLink} to="/support/assistant?handoff=1#handoff">
            {t("assistant.done.staff")}
          </TextLink>
          <TextLink as={LocaleLink} to="/support/repair">
            {t("status.book")}
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

function RepairCard({ view }: { view: RepairStatusView }) {
  const t = useT("support");
  const f = useFormat();
  const headingId = useId();
  const day = view.preferredDay ? f.date(Date.parse(`${view.preferredDay}T09:00:00Z`), "long") : null;
  return (
    <section aria-labelledby={headingId} className="grid gap-5 rounded-panel border border-line bg-paper p-4 md:p-6">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="grid gap-1">
          <h2 id={headingId} className="type-label text-ink-2">
            {t("status.labels.ref")}
          </h2>
          <p className="flex items-center gap-1">
            <bdi dir="ltr" className="type-kpi nums text-ink">
              {view.ref}
            </bdi>
            <CopyKey text={view.ref} what={t("status.labels.ref")} />
          </p>
        </div>
        {view.isDemo ? <DemoNote compact>{t("status.demo")}</DemoNote> : null}
      </div>

      <div className="grid gap-1 rounded-md bg-niche p-3" role="status">
        <p className="type-label text-ink-2">{t("status.labels.status")}</p>
        <p>
          <Status tone={TONE[view.status]}>{t(`status.states.${view.status}.label`)}</Status>
        </p>
        <p className="type-body text-ink">{t(`status.states.${view.status}.text`)}</p>
        {view.quoteIqd !== null ? (
          <div className="mt-2 grid gap-1 border-t border-line pt-2">
            <p className="type-label text-ink-2">{t("status.labels.quote")}</p>
            <Price amountIqd={view.quoteIqd} size="md" approx="off" />
            <p className="type-caption text-ink-2">{view.quoteApproved ? t("status.quoteApproved") : t("status.quotePending")}</p>
          </div>
        ) : null}
        {view.isWarranty ? <p className="type-caption text-ok">{t("status.warranty")}</p> : null}
      </div>

      <dl className="grid gap-x-6 gap-y-4 md:grid-cols-2">
        <div className="flex items-center gap-3 md:col-span-2">
          {view.device ? (
            <div className="w-16 shrink-0">
              <DeviceArt artKey={view.device.artKey} platform="" sizes="64px" />
            </div>
          ) : null}
          <div className="grid gap-0.5">
            <dt className="type-label text-ink-2">{t("status.labels.device")}</dt>
            <dd className="type-strong text-ink">
              <Name>{view.device?.name ?? view.deviceText ?? "—"}</Name>
            </dd>
          </div>
        </div>
        <Fact label={t("status.labels.sent")} value={f.dateTime(view.createdAt)} />
        <Fact label={t("status.labels.photos")} value={t("status.photoCount", { count: view.photoCount })} />
        <Fact label={t("status.labels.handover")} value={view.handover ? t(`handover.view.${view.handover}`) : t("handover.none")} />
        <Fact label={t("status.labels.day")} value={[day, view.preferredWindow && view.preferredWindow !== "any" ? t(`windows.${view.preferredWindow}`) : null].filter(Boolean).join(" · ") || t("handover.none")} />
        <div className="grid gap-0.5 md:col-span-2">
          <dt className="type-label text-ink-2">{t("status.labels.issue")}</dt>
          <dd className="whitespace-pre-wrap type-body text-ink">{view.issue}</dd>
        </div>
      </dl>
      {view.preferredDay || view.handover ? <p className="type-caption text-ink-2">{t("repair.preference")}</p> : null}

      <div className="grid gap-2 border-t border-line pt-4">
        <h3 className="type-sub text-ink">{t("status.timeline")}</h3>
        <ol className="grid gap-3 border-s border-line ps-4">
          {view.timeline.map((entry, index) => (
            <li key={`${entry.status}:${entry.at}`} className="relative grid gap-0.5">
              <span className={`absolute -start-[21px] top-1.5 size-[9px] rounded-full ${index === view.timeline.length - 1 ? "bg-ink" : "border border-ink-2 bg-paper"}`} aria-hidden="true" />
              <span className="type-strong text-ink">{t(`status.states.${entry.status}.label`)}</span>
              <span className="type-caption text-ink-2 nums">{f.dateTime(entry.at)}</span>
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
      <dt className="type-label text-ink-2">{label}</dt>
      <dd className="type-body text-ink">{value}</dd>
    </div>
  );
}
