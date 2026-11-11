/**
 * /support/assistant — the maintenance assistant (brief §7, DESIGN.md §9.22). A task screen: the tab bar gives way to
 * the composer's task bar below 1024px; from 1024 the composer sits at the end of the conversation column.
 *
 * Everything the shopper reads comes from approved trees and guides (services/support/assistant.server — no AI model
 * is configured, and the page says so). The conversation is the query string: every reply is a link, Back undoes the
 * last answer, nothing is stored. "Talk to staff" (?handoff=1) opens the handoff form; sending it (with consent)
 * stores the conversation, opens a ticket and comes back here with the ticket's reference and access token.
 */
import { useId } from "react";
import { data, Form, redirect } from "react-router";

import type { Route } from "./+types/assistant";
import { messagesFor } from "~/i18n/i18n.server";
import { LocaleLink, useT } from "~/i18n/react";
import { localePath } from "~/lib/locales";
import { MotionLink, type MotionHandle } from "~/motion";
import { getCtx } from "~/server/context.server";
import { getDb } from "~/server/db.server";
import { handOffToStaff, runAssistant } from "~/server/services/support/assistant.server";
import { assistantSearch, parseAssistantState, type AssistantState } from "~/server/services/support/state";
import { getTicketByAccessToken } from "~/server/services/support/tickets.server";
import type { AssistantView } from "~/server/services/support/types";
import { shellMeta } from "~/routes/storefront/shell/meta";
import { TaskBar } from "~/routes/storefront/shell/TabBar";
import type { ShellHandle } from "~/routes/storefront/shell/types";
import { DemoNote } from "~/ui/DemoNote";
import { Disclosure } from "~/ui/Disclosure";
import { TextField } from "~/ui/Field";
import { IconKey } from "~/ui/IconKey";
import { Key } from "~/ui/Key";
import { useOnline } from "~/ui/OfflineBanner";
import { HrefLink } from "~/ui/Pagination";
import { TextLink } from "~/ui/TextLink";
import { isFailure, keepFormOnFailure } from "./client";
import { Conversation } from "./components/Conversation";
import { HandoffForm, HandoffReceiptCard } from "./components/HandoffPanel";
import { DeviceArt, GuideList, Name, SafetyNote, SupportTabs } from "./components/parts";
import { failed, formFiles, formKey, photoStore, supportWho, textFields } from "./support.server";

export const handle = { shell: { tabBar: false }, nav: "push", order: 1, group: "support" } satisfies ShellHandle & MotionHandle;

export async function loader({ context, url }: Route.LoaderArgs) {
  const ctx = getCtx(context);
  const db = getDb();
  const state = parseAssistantState(url.searchParams);
  const ticketRef = url.searchParams.get("ticket");
  const [view, person, receipt] = await Promise.all([
    runAssistant(db, ctx.locale, state),
    supportWho(ctx, db),
    ticketRef ? getTicketByAccessToken(db, ticketRef, url.searchParams.get("tk")) : Promise.resolve(null),
  ]);
  const headers = receipt ? { "Cache-Control": "private, no-store", "Referrer-Policy": "no-referrer" } : undefined;
  return data(
    { view, receipt, contact: view.handoff ? person.contact : null, formKey: view.handoff && !receipt ? formKey() : null, i18n: messagesFor(ctx.locale, "support", "errors") },
    { headers },
  );
}

export function headers({ loaderHeaders }: Route.HeadersArgs) {
  return loaderHeaders;
}

/** The conversation's state from the handoff form's hidden fields (the same names as the query string). */
function stateFromForm(form: FormData): AssistantState {
  const text = (value: FormDataEntryValue | null) => (typeof value === "string" ? value : null);
  return parseAssistantState({ get: (name) => text(form.get(name)), getAll: (name) => form.getAll(name).filter((value): value is string => typeof value === "string") });
}

export async function action({ request, context }: Route.ActionArgs) {
  const ctx = getCtx(context);
  const db = getDb();
  const form = await request.formData();
  if (form.get("intent") !== "handoff") throw data({ error: "invalid" }, { status: 400 });
  const values = textFields(form, ["idempotencyKey", "phone", "contactName", "note", "consent"]);
  const state = stateFromForm(form);
  try {
    const { who } = await supportWho(ctx, db);
    const ticket = await handOffToStaff(db, who, ctx.locale, state, values, ctx.now, { store: photoStore(), photos: formFiles(form, "photos") });
    const params = new URLSearchParams(assistantSearch({ ...state, handoff: false }).slice(1));
    params.set("ticket", ticket.ref);
    params.set("tk", ticket.accessToken);
    return redirect(localePath(`/support/assistant?${params.toString()}`, ctx.locale));
  } catch (error) {
    return failed(error, { ...values, consent: "", idempotencyKey: values.idempotencyKey });
  }
}

/** A request that never reached the store comes back as a value: the form and everything typed stay on the page. */
export async function clientAction({ serverAction }: Route.ClientActionArgs) {
  return keepFormOnFailure(serverAction);
}

export const meta: Route.MetaFunction = (args) => {
  const tree = args.loaderData?.i18n.support as { meta?: { assistant?: { title?: string; description?: string } } } | undefined;
  return shellMeta(args, { title: tree?.meta?.assistant?.title, description: tree?.meta?.assistant?.description, noindex: (args.location.search ?? "").length > 1 });
};

export default function Assistant({ loaderData, actionData }: Route.ComponentProps) {
  const { view, receipt, contact } = loaderData;
  const t = useT("support");
  const failure = isFailure(actionData) ? actionData : null;
  const asideId = useId();
  const staffHref = `${view.search || "?"}${view.search ? "&" : ""}handoff=1#handoff`;

  return (
    <div className="page grid gap-6 pb-10 pt-4 lg:grid-cols-12 lg:gap-x-10 lg:pt-6">
      <div className="grid min-w-0 content-start gap-5 lg:col-span-8">
        <header className="grid gap-3">
          <SupportTabs current="assistant" />
          <h1 className="type-title text-ink">{t("assistant.title")}</h1>
          <p className="max-w-[68ch] type-body text-ink-2">{t("assistant.source")}</p>
        </header>
        <SafetyNote title={t("assistant.safety.title")}>{t("assistant.safety.text")}</SafetyNote>

        <Conversation view={view} />

        {view.stage === "done" ? <NextSteps view={view} staffHref={staffHref} /> : null}

        {receipt ? (
          <HandoffReceiptCard receipt={receipt} summary={view.summary} />
        ) : view.handoff && loaderData.formKey ? (
          <HandoffForm view={view} formKey={loaderData.formKey} contact={contact} failure={failure} />
        ) : null}

        <p className="flex flex-wrap items-center gap-x-6 gap-y-1">
          {!view.handoff && !receipt && view.stage !== "done" ? (
            <TextLink as={HrefLink} to={staffHref}>
              {t("assistant.done.staff")}
            </TextLink>
          ) : null}
          {view.turns.length > 1 ? (
            <TextLink as={LocaleLink} to="/support/assistant">
              {t("assistant.done.restart")}
            </TextLink>
          ) : null}
        </p>

        <Composer view={view} className="hidden lg:block" />
      </div>

      <aside aria-labelledby={asideId} className="grid content-start gap-5 lg:col-span-4 lg:pt-14">
        <h2 id={asideId} className="sr-only">
          {t("assistant.how.summary")}
        </h2>
        {view.device ? (
          <div className="flex items-center gap-3 lg:grid lg:justify-items-start">
            <div className="w-20 shrink-0 lg:w-40">
              <DeviceArt artKey={view.device.artKey} platform={view.device.platform.slug} sizes="(min-width: 1024px) 160px, 80px" />
            </div>
            <p className="type-strong text-ink">
              <Name>{view.device.name}</Name>
            </p>
          </div>
        ) : null}
        <Disclosure summary={t("assistant.how.summary")} icon="info" variant="panel">
          <ul className="grid list-disc gap-1.5 ps-5 type-caption text-ink-2">
            <li>{t("assistant.how.keywords")}</li>
            {!view.ai.configured ? <li>{t("assistant.how.ai")}</li> : null}
            <li>{t("assistant.how.storage")}</li>
            <li>{t("assistant.how.url")}</li>
            <li>{t("assistant.composer.hint")}</li>
          </ul>
        </Disclosure>
        {view.isDemo ? <DemoNote>{t("assistant.demo")}</DemoNote> : null}
        {view.guides.length > 0 && (view.stage === "steps" || view.stage === "done") ? (
          <section className="grid gap-1">
            <h3 className="type-label text-ink">{t("help.device.guides")}</h3>
            <GuideList articles={view.guides} showScope />
          </section>
        ) : null}
      </aside>

      <TaskBar aria-label={t("assistant.bar")} className="lg:hidden">
        <Composer view={view} compact />
      </TaskBar>
    </div>
  );
}

/** What the shopper can do once the conversation reached an outcome (never a red key: nothing here is an order). */
function NextSteps({ view, staffHref }: { view: AssistantView; staffHref: string }) {
  const t = useT("support");
  const outcome = view.outcome;
  const repairHref = `/support/repair${view.search ? `${view.search}&` : "?"}from=assistant`;
  return (
    <section className="grid gap-3 rounded-panel bg-niche p-4">
      <h2 className="type-sub text-ink">{t("assistant.done.title")}</h2>
      <div className="flex flex-wrap gap-2">
        {outcome?.type === "article" && outcome.article ? (
          <Key as={MotionLink} nav="rise" to={`/support/article/${outcome.article.slug}`} variant="ink" icon="book-open">
            {t("assistant.done.guide")}
          </Key>
        ) : null}
        {outcome?.type === "part" && outcome.productSlug ? (
          <Key as={MotionLink} nav="zoom" to={`/p/${outcome.productSlug}`} variant="ink" icon="package">
            {t("assistant.done.part")}
          </Key>
        ) : null}
        {outcome?.type === "resolved" ? (
          <Key as={LocaleLink} to="/support" variant="ink" icon="lifebuoy">
            {t("assistant.done.help")}
          </Key>
        ) : (
          <Key as={LocaleLink} to={repairHref} variant={outcome?.type === "repair" ? "ink" : "clay"} icon="wrench">
            {t("assistant.done.repair")}
          </Key>
        )}
        {outcome?.type !== "resolved" && !view.handoff ? (
          <Key as={HrefLink} to={staffHref} variant={outcome?.type === "human" ? "ink" : "clay"} icon="chat-circle">
            {t("assistant.done.staff")}
          </Key>
        ) : null}
      </div>
    </section>
  );
}

/**
 * The composer: what the shopper types goes into the URL as `q` with the chosen device; the server routes it to a
 * verified guide (or says it found none). Before a device is chosen it waits, flat, with the reason beside it.
 */
function Composer({ view, compact = false, className }: { view: AssistantView; compact?: boolean; className?: string }) {
  const t = useT("support");
  const online = useOnline();
  const reasonId = useId();
  const ready = view.device !== null || view.deviceOther;
  const reason = !ready ? t("assistant.composer.needDevice") : !online ? t("assistant.composer.offline") : null;
  return (
    <Form method="get" preventScrollReset key={view.search} className={className}>
      {view.device ? <input type="hidden" name="device" value={view.device.slug} /> : view.deviceOther ? <input type="hidden" name="device" value="other" /> : null}
      <div className="flex items-end gap-2">
        <TextField
          id={compact ? "assistant-q-bar" : "assistant-q"}
          label={t("assistant.composer.label")}
          name="q"
          maxLength={300}
          autoComplete="off"
          enterKeyHint="send"
          disabled={!ready}
          className="min-w-0 flex-1"
          hint={!compact ? t("assistant.composer.hint") : undefined}
          aria-describedby={reason ? reasonId : undefined}
          required={false}
        />
        <IconKey type="submit" variant="ink" icon="paper-plane-tilt" label={t("assistant.composer.send")} disabled={!ready || !online} className={compact ? "mb-1" : "mb-7"} />
      </div>
      {reason ? (
        <p id={reasonId} className="pt-1 type-caption text-ink-2">
          {reason}
        </p>
      ) : null}
    </Form>
  );
}
