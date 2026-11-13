/**
 * /support/assistant — the maintenance assistant (Design System v2 §6.13). A task flow (`chrome: "task"`): the store
 * header, no tab bar, the composer in a glass task bar below 1024px; from 1024 a centred chat column (≤720px) with the
 * device card and its guides in a sticky aside, the composer at the end of the column.
 *
 * A compact head: the title, a «ليس تشخيصاً» chip that opens how the assistant works, and the safety note collapsed to
 * one line «للسلامة: لا تفتح الجهاز» that opens by itself when the conversation reaches battery, power or liquid
 * (a danger stop, a battery topic, the power tree, a warning in a step). The composer is enabled from the first
 * question («اكتب اسم جهازك أو المشكلة»): the service reads a device or platform name, a problem, an error code — and
 * a danger sign before anything else. «تحدّث مع موظف» is the clear secondary action, «ابدأ من جديد» a quiet link.
 *
 * Everything the shopper reads comes from approved trees and guides (services/support/assistant.server — no AI model
 * is configured, and the page says so). The conversation is the query string: every reply is a link, Back undoes the
 * last answer, nothing is stored. "Talk to a person" (?handoff=1) opens the hand-off form; sending it (with consent)
 * stores the conversation, opens a ticket and comes back here with the ticket's reference and access token. The
 * ticket is routed by the support module's rules right after the answer (routeOnArrival; the scheduled job catches what
 * that misses). Opened from an order's page (`?order=TT-…`), the form says which order it is about and sends it along:
 * the ticket is linked to that order only when it is the shopper's (services/support/tickets.server ticketOrderOf).
 */
import { useId } from "react";
import { data, Form, redirect, type ShouldRevalidateFunctionArgs } from "react-router";

import type { Route } from "./+types/assistant";
import { Icon } from "~/art/Icon";
import { messagesFor } from "~/i18n/i18n.server";
import { LocaleLink, useT } from "~/i18n/react";
import { localePath } from "~/lib/locales";
import { MotionLink, type MotionHandle } from "~/motion";
import { getCtx } from "~/server/context.server";
import { getDb } from "~/server/db.server";
import { handOffToStaff, runAssistant } from "~/server/services/support/assistant.server";
import { assistantSearch, parseAssistantState, type AssistantState } from "~/server/services/support/state";
import { routeOnArrival } from "~/server/services/support/routing.server";
import { normalizeSupportRef } from "~/server/services/support/common.server";
import { getTicketByAccessToken, ORDER_REF_PREFIX } from "~/server/services/support/tickets.server";
import { afterResponse } from "~/routes/storefront/content/redirect.server";
import type { AssistantView } from "~/server/services/support/types";
import { shellMeta } from "~/routes/storefront/shell/meta";
import { TaskBar } from "~/routes/storefront/shell/TabBar";
import type { ShellHandle } from "~/routes/storefront/shell/types";
import { Chip } from "~/ui/Chip";
import { DemoNote } from "~/ui/DemoNote";
import { Disclosure } from "~/ui/Disclosure";
import { TextField } from "~/ui/Field";
import { Key } from "~/ui/Key";
import { Note } from "~/ui/Note";
import { useOnline } from "~/ui/OfflineBanner";
import { HrefLink } from "~/ui/Pagination";
import { TextLink } from "~/ui/TextLink";
import { isFailure, keepFormOnFailure, revalidateAfter } from "./client";
import { Conversation } from "./components/Conversation";
import { HandoffForm, HandoffReceiptCard } from "./components/HandoffPanel";
import { DeviceArt, GuideList, Name, PlatformName, SupportNav } from "./components/parts";
import { failed, formFiles, formKey, photoStore, PRIVATE_PAGE_HEADERS, readSupportForm, supportWho, textFields } from "./support.server";
import "./support.css";

export const handle = { shell: { chrome: "task" }, nav: "push", order: 1, group: "support" } satisfies ShellHandle & MotionHandle;

export async function loader({ context, url }: Route.LoaderArgs) {
  const ctx = getCtx(context);
  const db = getDb();
  const state = parseAssistantState(url.searchParams);
  const ticketRef = url.searchParams.get("ticket");
  // «سؤال عن طلبك؟» on an order's page opens the hand-off with the order's reference
  const orderRef = normalizeSupportRef(url.searchParams.get("order"), ORDER_REF_PREFIX);
  const [view, person, receipt] = await Promise.all([
    runAssistant(db, ctx.locale, state),
    supportWho(ctx, db),
    ticketRef ? getTicketByAccessToken(db, ticketRef, url.searchParams.get("tk")) : Promise.resolve(null),
  ]);
  const headers = receipt ? PRIVATE_PAGE_HEADERS : undefined;
  return data(
    { view, receipt, ticketToken: receipt ? url.searchParams.get("tk") : null, orderRef: view.handoff ? orderRef : null, contact: view.handoff ? person.contact : null, formKey: view.handoff && !receipt ? formKey() : null, i18n: messagesFor(ctx.locale, "support", "errors") },
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
  const form = await readSupportForm(request);
  if (!(form instanceof FormData)) return form;
  if (form.get("intent") !== "handoff") throw data({ error: "invalid" }, { status: 400 });
  const values = textFields(form, ["idempotencyKey", "phone", "contactName", "note", "consent", "order"]);
  const state = stateFromForm(form);
  try {
    const { who } = await supportWho(ctx, db);
    const ticket = await handOffToStaff(db, who, ctx.locale, state, values, ctx.now, { store: photoStore(), photos: formFiles(form, "photos") });
    // to the right person by the support module's rules, after the answer (never delays or fails the shopper's send)
    if (!ticket.replayed) afterResponse(routeOnArrival(db, ticket.ticketId, ctx.now), "ticket routing");
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

/** …and nothing is reloaded after it (the reload would fail too, and an error panel would replace the form). */
export function shouldRevalidate(args: ShouldRevalidateFunctionArgs) {
  return revalidateAfter(args);
}

export const meta: Route.MetaFunction = (args) => {
  const tree = args.loaderData?.i18n.support as { meta?: { assistant?: { title?: string; description?: string } } } | undefined;
  return shellMeta(args, { title: tree?.meta?.assistant?.title, description: tree?.meta?.assistant?.description, noindex: (args.location.search ?? "").length > 1 });
};

/** The conversation touched battery, power or liquid: the safety note opens by itself. */
function safetyTopic(view: AssistantView): boolean {
  if (view.symptom?.key === "no_power") return true;
  return view.turns.some((turn) => turn.role === "assistant" && (turn.kind === "danger" || turn.warning !== null || turn.warningKey !== null));
}

export default function Assistant({ loaderData, actionData }: Route.ComponentProps) {
  const { view, receipt, contact } = loaderData;
  const t = useT("support");
  const failure = isFailure(actionData) ? actionData : null;
  const asideId = useId();
  const staffHref = `${view.search || "?"}${view.search ? "&" : ""}handoff=1#handoff`;
  const formOpen = !receipt && view.handoff && loaderData.formKey !== null;
  // The conversation goes on unless the shopper is writing to a person or has just done so.
  const talking = !receipt && !view.handoff;
  const safety = safetyTopic(view);
  const showAside = view.device !== null;

  return (
    <div className="page sup">
      <SupportNav current="assistant" />
      <div className="sup-assist">
        <div className="sup-assist__main">
          <header className="sup-assist__head">
            <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
              <h1 className="type-h1 text-ink">{t("assistant.title")}</h1>
              {view.isDemo ? <DemoNote variant="tag" /> : null}
            </div>
            {/* «ليس تشخيصاً»: the kit's clay chip is the summary; it opens how the assistant works, on a calm note */}
            <details className="sup-about">
              <Chip as="summary">
                <span className="inline-flex items-center gap-1.5">
                  <Icon name="info" size={16} />
                  {t("assistant.notDiagnosis")}
                  <Icon name="caret-down" size={16} className="sup-details__caret" />
                </span>
              </Chip>
              <Note icon="info" title={t("assistant.notDiagnosis")} className="sup-about__panel">
                <p>{t("assistant.source")}</p>
                <ul className="mt-2 grid list-disc gap-1.5 ps-5">
                  <li>{t("assistant.how.keywords")}</li>
                  {!view.ai.configured ? <li>{t("assistant.how.ai")}</li> : null}
                  <li>{t("assistant.how.storage")}</li>
                  <li>{t("assistant.how.url")}</li>
                  <li>{t("assistant.how.private")}</li>
                </ul>
                {view.isDemo ? <DemoNote variant="line">{t("assistant.demo")}</DemoNote> : null}
              </Note>
            </details>
          </header>

          {/* the safety note, collapsed to one line: the kit's disclosure on the soft card, the warning on its tinted
              disc; it opens by itself (a new key) when the conversation reaches battery, power or liquid */}
          <Disclosure
            key={safety ? "safety-open" : "safety"}
            defaultOpen={safety}
            variant="panel"
            className="sup-safety"
            summary={
              <span className="sup-safety__summary">
                <span className="sup-tone-disc" aria-hidden="true">
                  <Icon name="warning" size={20} />
                </span>
                <span className="min-w-0 flex-1">{t("assistant.safety.summary")}</span>
              </span>
            }
          >
            <p className="sup-safety__text">{t("assistant.safety.text")}</p>
          </Disclosure>

          <Conversation view={view} replies={talking} />

          {view.stage === "done" && talking ? <NextSteps view={view} staffHref={staffHref} /> : null}

          {receipt ? (
            <HandoffReceiptCard receipt={receipt} summary={view.summary} token={loaderData.ticketToken} />
          ) : formOpen && loaderData.formKey ? (
            <HandoffForm view={view} formKey={loaderData.formKey} contact={contact} failure={failure} orderRef={loaderData.orderRef} />
          ) : null}

          {talking ? (
            <div className="flex flex-wrap items-center gap-x-6 gap-y-2">
              {view.stage !== "done" ? (
                <Key as={HrefLink} to={staffHref} icon="chat-circle">
                  {t("assistant.done.staff")}
                </Key>
              ) : null}
              {view.turns.length > 1 ? (
                <TextLink as={LocaleLink} to="/support/assistant" arrow={false} icon="arrow-counter-clockwise">
                  {t("assistant.done.restart")}
                </TextLink>
              ) : null}
            </div>
          ) : receipt ? (
            <TextLink as={LocaleLink} to="/support/assistant" arrow={false} icon="arrow-counter-clockwise" className="justify-self-start">
              {t("assistant.done.restart")}
            </TextLink>
          ) : null}

          {talking ? (
            <div className="sup-assist__dock">
              <Composer view={view} id="assistant-q" />
            </div>
          ) : null}
        </div>

        {showAside && view.device ? (
          <aside aria-labelledby={asideId} className="sup-assist__aside">
            <div className="sup-card sup-assist__device">
              <h2 id={asideId} className="sr-only">
                {t("assistant.device")}
              </h2>
              <div className="flex items-center gap-3">
                <DeviceArt artKey={view.device.artKey} kind={view.device.kind} small sizes="72px" className="w-18 shrink-0" />
                <div className="grid min-w-0 gap-1">
                  <p className="type-xs text-ink-2">
                    <PlatformName slug={view.device.platform.slug} name={view.device.platform.name} />
                  </p>
                  <p className="type-card text-ink">
                    <Name>{view.device.name}</Name>
                  </p>
                </div>
              </div>
              {view.guides.length > 0 && (view.stage === "steps" || view.stage === "done") ? (
                <div className="grid gap-1">
                  <h3 className="type-sm-strong text-ink">{t("help.device.guides")}</h3>
                  <GuideList articles={view.guides} showScope plain />
                </div>
              ) : null}
            </div>
          </aside>
        ) : null}

        {talking ? (
          <TaskBar aria-label={t("assistant.bar")} className="lg:hidden">
            <Composer view={view} id="assistant-q-bar" />
          </TaskBar>
        ) : null}
      </div>
    </div>
  );
}

/** What the shopper can do once the conversation reached an outcome — secondary keys: nothing here is an order. */
function NextSteps({ view, staffHref }: { view: AssistantView; staffHref: string }) {
  const t = useT("support");
  const outcome = view.outcome;
  const repairHref = `/support/repair${view.search ? `${view.search}&` : "?"}from=assistant`;
  return (
    <section aria-labelledby="assistant-next" className="sup-card">
      <h2 id="assistant-next" className="type-h3 text-ink">
        {t("assistant.done.title")}
      </h2>
      <div className="flex flex-wrap gap-2">
        {outcome?.type === "article" && outcome.article ? (
          <Key as={MotionLink} nav="rise" to={`/support/article/${outcome.article.slug}`} size="sm" icon="book-open">
            {t("assistant.done.guide")}
          </Key>
        ) : null}
        {outcome?.type === "part" && outcome.productSlug ? (
          <Key as={MotionLink} nav="zoom" to={`/p/${outcome.productSlug}`} size="sm" icon="package">
            {t("assistant.done.part")}
          </Key>
        ) : null}
        {outcome?.type === "resolved" ? (
          <Key as={LocaleLink} to="/support" size="sm" icon="lifebuoy">
            {t("assistant.done.help")}
          </Key>
        ) : (
          <Key as={LocaleLink} to={repairHref} size="sm" icon="wrench">
            {t("assistant.done.repair")}
          </Key>
        )}
        {outcome?.type !== "resolved" ? (
          <Key as={HrefLink} to={staffHref} size="sm" icon="chat-circle">
            {t("assistant.done.staff")}
          </Key>
        ) : null}
      </div>
    </section>
  );
}

/**
 * The composer: what the shopper types goes into the URL as `q` (with the chosen device or platform); the server
 * reads a device name, a problem, an error code or a danger sign and answers from approved content. Enabled from the
 * first question; offline, the send key goes flat with the reason under it.
 */
function Composer({ view, id }: { view: AssistantView; id: string }) {
  const t = useT("support");
  const online = useOnline();
  const reasonId = useId();
  const keep = view.device ? { name: "device", value: view.device.slug } : view.deviceOther ? { name: "device", value: "other" } : view.platform ? { name: "platform", value: view.platform.slug } : null;
  return (
    <Form method="get" action="." preventScrollReset key={view.search} className="sup-composer">
      {keep ? <input type="hidden" name={keep.name} value={keep.value} /> : null}
      <div className="sup-composer__row">
        <TextField
          id={id}
          label={t("assistant.composer.label")}
          hideLabel
          name="q"
          maxLength={300}
          autoComplete="off"
          enterKeyHint="send"
          placeholder={t("assistant.composer.placeholder")}
          className="min-w-0 flex-1"
          inputClassName="sup-composer__input"
          aria-describedby={!online ? reasonId : undefined}
        />
        <Key type="submit" variant="primary" icon="paper-plane-tilt" aria-label={t("assistant.composer.send")} title={t("assistant.composer.send")} disabled={!online} aria-describedby={!online ? reasonId : undefined} className="sup-composer__send" />
      </div>
      {!online ? (
        <p id={reasonId} className="sup-composer__reason">
          {t("assistant.composer.offline")}
        </p>
      ) : null}
    </Form>
  );
}
