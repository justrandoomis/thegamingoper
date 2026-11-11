import { useState } from "react";
import { Link, useRouteLoaderData } from "react-router";

import type { Route } from "./+types/customer";
import { Icon } from "~/art/Icon";
import { useFormat } from "~/i18n/react";
import { throwAsResponse } from "~/server/errors";
import { getCustomerProfile } from "~/server/services/admin/customers/profile.server";
import { FLAG_RULES, ORDER_STATUS_TONE, RFM_RULES, type CustomerAccess, type CustomerProfile } from "~/server/services/admin/customers/types";
import { ConfirmDialog } from "~/ui/Dialog";
import { TextArea, TextField } from "~/ui/Field";
import { Key } from "~/ui/Key";
import { Status } from "~/ui/Tag";
import { VisuallyHidden } from "~/ui/VisuallyHidden";
import { CUSTOMER_LAYOUT_ID, customersMeta } from "./meta";
import { openCustomers, respond } from "./customers.server";
import { profileAction } from "./customer.server";
import { activityLabel, FlagExplanations, Failure, Money, Num, PhoneText, PrivacyStatusBadge, Ref, Section, SegmentBadge, useCustomersT, useIntent, When } from "./ui";

/**
 * /admin/customers/:customerId — the 360° profile (07.01): what the customer bought and kept, RFM scores with the
 * rule behind each (07.02), labels with their reasons and the manual ones (07.06: VIP label, fraud flag, block — each
 * with a reason in a confirm dialog that says what changes), orders, returns, warranties, repairs, tickets, wallet
 * (the ledger sum; adjustments are module 10's, linked), notes, consents, privacy requests, merged accounts, activity.
 * Sections the employee may not read are not in the loader data at all.
 */
export async function loader({ params, context }: Route.LoaderArgs) {
  const { db, actor, locale, now } = await openCustomers(context, "customers.customer.read");
  try {
    return { profile: await getCustomerProfile(db, actor, params.customerId, locale, now), now };
  } catch (error) {
    throwAsResponse(error);
  }
}

export async function action({ request, params, context }: Route.ActionArgs) {
  const req = await openCustomers(context);
  return respond(await profileAction(req.ctx, req.db, req.session, params.customerId, await request.formData()));
}

export const meta: Route.MetaFunction = (args) => customersMeta(args, "customer.profileTitle", undefined, args.loaderData?.profile.header.name ?? null);

type LayoutData = { access: CustomerAccess };

export default function CustomerProfilePage({ loaderData }: Route.ComponentProps) {
  const t = useCustomersT();
  const { profile } = loaderData;
  const layout = useRouteLoaderData(CUSTOMER_LAYOUT_ID) as LayoutData | undefined;
  const access = layout?.access;
  const changeable = profile.header.status === "active" || profile.header.status === "blocked";
  return (
    <div className="cus-layout">
      <div className="cus-main">
        <Kpis profile={profile} />
        <RfmSection profile={profile} />
        <Section id="cus-flags" title={t("profile.flags.title")}>
          <FlagExplanations flags={profile.header.flags} />
          {changeable && access && (access.update || access.block) ? <LabelActions profile={profile} access={access} /> : null}
        </Section>
        {profile.orders ? <OrdersSection profile={profile} /> : null}
        {profile.returns ? <ReturnsSection profile={profile} /> : null}
        {profile.warranties ? <WarrantiesSection profile={profile} /> : null}
        {profile.repairs ? <RepairsSection profile={profile} /> : null}
        {profile.tickets ? <TicketsSection profile={profile} /> : null}
        <ActivitySection profile={profile} />
      </div>
      <aside className="cus-side" aria-label={t("profile.side")}>
        {profile.wallet ? <WalletSection profile={profile} /> : null}
        <NotesSection profile={profile} canWrite={Boolean(access?.note) && changeable} />
        {profile.consents ? <ConsentsSection profile={profile} /> : null}
        {profile.privacy ? <PrivacySection profile={profile} /> : null}
        {profile.mergedFrom.length ? <MergedSection profile={profile} /> : null}
      </aside>
    </div>
  );
}

type Props = { profile: CustomerProfile };

const RETURN_TONE: Record<string, "ok" | "warn" | "info" | "bad" | "neutral"> = { requested: "warn", approved: "info", rejected: "bad", in_transit: "info", received: "info", inspected: "warn", refunded: "ok", exchanged: "ok", repaired: "ok", closed: "neutral", cancelled: "neutral" };
const REPAIR_TONE: Record<string, "ok" | "warn" | "info" | "bad" | "neutral"> = { submitted: "warn", received: "info", diagnosing: "info", awaiting_approval: "warn", awaiting_parts: "warn", repairing: "info", ready: "ok", delivered: "neutral", unrepairable: "bad", cancelled: "neutral" };

function Kpis({ profile }: Props) {
  const t = useCustomersT();
  const { stats } = profile;
  const tiles = [
    { label: t("profile.kpi.purchases"), value: <Num value={stats.purchases} />, hint: t("profile.kpi.ordersAll", { count: stats.orders }) },
    {
      label: t("profile.kpi.spent"),
      value: <Money iqd={stats.spentIqd} />,
      hint:
        stats.refundedIqd > 0 ? (
          <>
            {t("profile.kpi.refunded")} <Money iqd={stats.refundedIqd} />
          </>
        ) : (
          t("profile.kpi.spentHint")
        ),
    },
    { label: t("profile.kpi.aov"), value: <Money iqd={stats.aovIqd} />, hint: stats.aovIqd === null ? t("profile.kpi.aovNone") : t("profile.kpi.aovHint") },
    { label: t("profile.kpi.lastOrder"), value: stats.lastOrderAt ? <When at={stats.lastOrderAt} style="date" /> : <span>—</span>, hint: t("profile.kpi.open", { count: stats.openOrders }), small: true },
  ];
  return (
    <section aria-labelledby="cus-kpis">
      <VisuallyHidden as="h2" id="cus-kpis">
        {t("profile.kpi.title")}
      </VisuallyHidden>
      <div className="cus-kpis">
        {tiles.map((tile, index) => (
          <div key={index} className="cus-kpi">
            <p className="type-caption text-ink-2">{tile.label}</p>
            <p className={"small" in tile && tile.small ? "type-sub nums" : "type-kpi nums"}>{tile.value}</p>
            <p className="type-caption text-ink-2">{tile.hint}</p>
          </div>
        ))}
      </div>
    </section>
  );
}

function RfmSection({ profile }: Props) {
  const t = useCustomersT();
  const f = useFormat();
  const { rfm } = profile;
  const stored = profile.header.segment;
  const bounds = {
    r: RFM_RULES.recencyDays.map((days) => f.number(days)).join(" / "),
    f: RFM_RULES.frequency.map((n) => f.number(n)).join(" / "),
    m: RFM_RULES.monetaryIqd.map((iqd) => f.iqd(iqd)).join(" / "),
  };
  const rows = [
    { axis: "r", score: rfm.r, value: rfm.recencyDays === null ? t("rfm.noPurchase") : t("rfm.daysAgo", { count: rfm.recencyDays }), rule: t("rfm.rule.r", { bounds: bounds.r }) },
    { axis: "f", score: rfm.f, value: t("rfm.purchases", { count: rfm.frequency }), rule: t("rfm.rule.f", { bounds: bounds.f }) },
    { axis: "m", score: rfm.m, value: <Money iqd={rfm.monetaryIqd} />, rule: t("rfm.rule.m", { bounds: bounds.m }) },
  ];
  return (
    <Section
      id="cus-rfm"
      title={t("rfm.title")}
      action={
        <Link to="/admin/customers/segments" className="adm-link type-caption">
          {t("rfm.howLink")}
        </Link>
      }
    >
      <div className="flex flex-wrap items-center gap-2">
        <span className="type-body">{t("rfm.segmentNow")}</span>
        <SegmentBadge segment={rfm.segment} />
        <span className="type-caption text-ink-2">{t(`segment.${rfm.segment}.why`)}</span>
      </div>
      <ul className="cus-rows">
        {rows.map((row) => (
          <li key={row.axis} className="cus-row">
            <span className="grid min-w-0">
              <span className="type-strong">{t(`rfm.axis.${row.axis}`)}</span>
              <span className="type-caption text-ink-2">{row.rule}</span>
            </span>
            <span className="flex items-baseline gap-3">
              <span className="type-body">{row.value}</span>
              <span className="type-strong nums">{t("rfm.score", { score: row.score })}</span>
            </span>
          </li>
        ))}
      </ul>
      <p className="type-caption text-ink-2">
        {stored ? (
          stored.key === rfm.segment ? (
            <>
              {t("rfm.storedSame")} <When at={stored.computedAt} />
            </>
          ) : (
            <>
              {t("rfm.storedOther", { segment: t(`segment.${stored.key}.name`) })} <When at={stored.computedAt} />
            </>
          )
        ) : (
          t("rfm.storedNone")
        )}
      </p>
    </Section>
  );
}

function LabelActions({ profile, access }: Props & { access: CustomerAccess }) {
  const t = useCustomersT();
  const header = profile.header;
  return (
    <div className="cus-actions">
      {access.update ? <VipButton profile={profile} /> : null}
      {access.block ? <FlagButton flagged={header.fraudFlag} /> : null}
      {access.block ? <BlockButton blocked={header.status === "blocked"} openOrders={profile.stats.openOrders} /> : null}
      <span className="type-caption text-ink-2">{t("profile.flags.rulesNote", { days: FLAG_RULES.vipWindowDays })}</span>
    </div>
  );
}

function VipButton({ profile }: Props) {
  const t = useCustomersT();
  const current = profile.header.vipTier;
  const [open, setOpen] = useState<null | "set" | "remove">(null);
  const [tier, setTier] = useState(current ?? "VIP");
  const { fetcher, pending, message, fields } = useIntent("vip", (result) => (result.value ? "done.vipSet" : "done.vipRemoved"), () => setOpen(null));
  return (
    <>
      <Key size="sm" icon="star" onClick={() => setOpen("set")}>
        {current ? t("profile.vip.change") : t("profile.vip.set")}
      </Key>
      {current ? (
        <Key size="sm" onClick={() => setOpen("remove")}>
          {t("profile.vip.remove")}
        </Key>
      ) : null}
      <ConfirmDialog
        open={open !== null}
        onClose={() => setOpen(null)}
        title={open === "remove" ? t("profile.vip.removeQ") : t("profile.vip.setQ")}
        consequence={open === "remove" ? t("profile.vip.removeWhat", { tier: current ?? "" }) : t("profile.vip.setWhat")}
        confirmLabel={open === "remove" ? t("profile.vip.remove") : t("profile.vip.save")}
        reason={{ label: t("dialog.reason"), hint: t("dialog.reasonHint") }}
        pending={pending}
        error={message}
        onConfirm={({ reason }) => fetcher.submit({ intent: "vip", tier: open === "remove" ? "" : tier, reason }, { method: "post" })}
      >
        {open === "set" ? <TextField name="tier" label={t("profile.vip.label")} hint={t("profile.vip.hint")} value={tier} onChange={(event) => setTier(event.currentTarget.value)} maxLength={30} error={fields.tier} /> : null}
      </ConfirmDialog>
    </>
  );
}

function FlagButton({ flagged }: { flagged: boolean }) {
  const t = useCustomersT();
  const [open, setOpen] = useState(false);
  const { fetcher, pending, message } = useIntent("flag", (result) => (result.value ? "done.flagged" : "done.unflagged"), () => setOpen(false));
  return (
    <>
      <Key size="sm" icon="flag" className={flagged ? undefined : "enabled:[--on:var(--red-ink)]"} onClick={() => setOpen(true)}>
        {flagged ? t("profile.flag.clear") : t("profile.flag.raise")}
      </Key>
      <ConfirmDialog
        open={open}
        onClose={() => setOpen(false)}
        tone={flagged ? "neutral" : "destructive"}
        title={flagged ? t("profile.flag.clearQ") : t("profile.flag.raiseQ")}
        consequence={flagged ? t("profile.flag.clearWhat") : t("profile.flag.raiseWhat")}
        confirmLabel={flagged ? t("profile.flag.clear") : t("profile.flag.raise")}
        impact={[{ label: t("profile.flag.impactOrders"), value: flagged ? t("profile.flag.impactNormal") : t("profile.flag.impactReview") }]}
        reason={{ label: t("dialog.reason"), hint: t("profile.flag.reasonHint") }}
        pending={pending}
        error={message}
        onConfirm={({ reason }) => fetcher.submit({ intent: "flag", flagged: flagged ? "0" : "1", reason }, { method: "post" })}
      />
    </>
  );
}

function BlockButton({ blocked, openOrders }: { blocked: boolean; openOrders: number }) {
  const t = useCustomersT();
  const [open, setOpen] = useState(false);
  const { fetcher, pending, message } = useIntent("block", (result) => (result.value === "blocked" ? "done.blocked" : "done.unblocked"), () => setOpen(false));
  return (
    <>
      <Key size="sm" icon="lock" className={blocked ? undefined : "enabled:[--on:var(--red-ink)]"} onClick={() => setOpen(true)}>
        {blocked ? t("profile.block.unblock") : t("profile.block.block")}
      </Key>
      <ConfirmDialog
        open={open}
        onClose={() => setOpen(false)}
        tone={blocked ? "neutral" : "destructive"}
        title={blocked ? t("profile.block.unblockQ") : t("profile.block.blockQ")}
        consequence={blocked ? t("profile.block.unblockWhat") : t("profile.block.blockWhat")}
        confirmLabel={blocked ? t("profile.block.unblock") : t("profile.block.block")}
        impact={
          blocked
            ? [{ label: t("profile.block.impactAccount"), value: t("profile.block.impactOpen") }]
            : [
                { label: t("profile.block.impactAccount"), value: t("profile.block.impactClosed") },
                { label: t("profile.block.impactOrders"), value: t("profile.block.impactOrdersValue", { count: openOrders }) },
              ]
        }
        reason={{ label: t("dialog.reason"), hint: t("dialog.reasonHint") }}
        pending={pending}
        error={message}
        onConfirm={({ reason }) => fetcher.submit({ intent: "block", blocked: blocked ? "0" : "1", reason }, { method: "post" })}
      />
    </>
  );
}

function OrdersSection({ profile }: Props) {
  const t = useCustomersT();
  const orders = profile.orders ?? [];
  return (
    <Section id="cus-orders" title={t("profile.orders.title", { count: profile.stats.orders })}>
      {orders.length === 0 ? (
        <p className="type-body text-ink-2">{t("profile.orders.none")}</p>
      ) : (
        <ul className="cus-rows">
          {orders.map((order) => (
            <li key={order.id} className="cus-row">
              <span className="grid min-w-0">
                <Link to={`/admin/orders/${order.ref}`} className="adm-link">
                  <Ref value={order.ref} />
                </Link>
                <span className="type-caption text-ink-2">
                  <When at={order.placedAt} /> · {t("profile.orders.items", { count: order.items })}
                </span>
              </span>
              <span className="flex flex-wrap items-baseline gap-3">
                <Status tone={ORDER_STATUS_TONE[order.status] ?? "neutral"}>{t(`orderStatus.${order.status}`)}</Status>
                <Money iqd={order.totalIqd} className="type-strong" />
              </span>
            </li>
          ))}
        </ul>
      )}
      {profile.stats.orders > orders.length ? <p className="type-caption text-ink-2">{t("profile.orders.more", { count: profile.stats.orders - orders.length })}</p> : null}
    </Section>
  );
}

function ReturnsSection({ profile }: Props) {
  const t = useCustomersT();
  const rows = profile.returns ?? [];
  return (
    <Section id="cus-returns" title={t("profile.returns.title")}>
      {rows.length === 0 ? (
        <p className="type-body text-ink-2">{t("profile.returns.none")}</p>
      ) : (
        <ul className="cus-rows">
          {rows.map((ret) => (
            <li key={ret.id} className="cus-row">
              <span className="grid min-w-0">
                <Link to={`/admin/returns/${ret.rma}`} className="adm-link">
                  <Ref value={ret.rma} />
                </Link>
                <span className="type-caption text-ink-2">
                  <When at={ret.createdAt} />
                  {ret.orderRef ? (
                    <>
                      {" · "}
                      <Ref value={ret.orderRef} />
                    </>
                  ) : null}
                </span>
              </span>
              <Status tone={RETURN_TONE[ret.status] ?? "neutral"}>{t(`returnStatus.${ret.status}`)}</Status>
            </li>
          ))}
        </ul>
      )}
    </Section>
  );
}

function WarrantiesSection({ profile }: Props) {
  const t = useCustomersT();
  const rows = profile.warranties ?? [];
  const tone = { active: "ok", ending: "warn", expired: "neutral", void: "bad" } as const;
  return (
    <Section id="cus-warranties" title={t("profile.warranties.title")}>
      {rows.length === 0 ? (
        <p className="type-body text-ink-2">{t("profile.warranties.none")}</p>
      ) : (
        <ul className="cus-rows">
          {rows.map((warranty) => (
            <li key={warranty.id} className="cus-row">
              <span className="grid min-w-0">
                <Link to={`/admin/returns/warranties/${warranty.id}`} className="adm-link">
                  {warranty.itemName || warranty.sku || warranty.id}
                </Link>
                <span className="type-caption text-ink-2">
                  {t("profile.warranties.until")} <When at={warranty.endsAt} style="date" />
                  {warranty.serial ? (
                    <>
                      {" · "}
                      <Ref value={warranty.serial} />
                    </>
                  ) : null}
                </span>
              </span>
              <Status tone={tone[warranty.state]}>{t(`warrantyState.${warranty.state}`)}</Status>
            </li>
          ))}
        </ul>
      )}
    </Section>
  );
}

function RepairsSection({ profile }: Props) {
  const t = useCustomersT();
  const rows = profile.repairs ?? [];
  if (rows.length === 0) return null;
  return (
    <Section id="cus-repairs" title={t("profile.repairs.title")}>
      <ul className="cus-rows">
        {rows.map((repair) => (
          <li key={repair.id} className="cus-row">
            <span className="grid min-w-0">
              <Link to={`/admin/returns/repairs/${repair.ref}`} className="adm-link">
                <Ref value={repair.ref} />
              </Link>
              <span className="type-caption text-ink-2">{repair.issue}</span>
            </span>
            <Status tone={REPAIR_TONE[repair.status] ?? "neutral"}>{t(`repairStatus.${repair.status}`)}</Status>
          </li>
        ))}
      </ul>
    </Section>
  );
}

function TicketsSection({ profile }: Props) {
  const t = useCustomersT();
  const rows = profile.tickets ?? [];
  return (
    <Section id="cus-tickets" title={t("profile.tickets.title")}>
      {rows.length === 0 ? (
        <p className="type-body text-ink-2">{t("profile.tickets.none")}</p>
      ) : (
        <ul className="cus-rows">
          {rows.map((ticket) => (
            <li key={ticket.id} className="cus-row">
              <span className="grid min-w-0">
                <span className="type-strong">
                  <Ref value={ticket.ref} /> · {ticket.subject}
                </span>
                <span className="type-caption text-ink-2">
                  <When at={ticket.createdAt} /> · {t(`ticketCategory.${ticket.category}`)}
                </span>
              </span>
              <span className="flex flex-wrap items-center gap-2">
                {ticket.complaint ? (
                  <span className="cus-tag">
                    <Icon name="chat-circle" size={13} />
                    {t("profile.tickets.complaint")}
                  </span>
                ) : null}
                <Status tone={ticket.open ? "warn" : "neutral"}>{t(`ticketStatus.${ticket.status}`)}</Status>
              </span>
            </li>
          ))}
        </ul>
      )}
      <p className="type-caption text-ink-2">{t("profile.tickets.boundary")}</p>
    </Section>
  );
}

function ActivitySection({ profile }: Props) {
  const t = useCustomersT();
  if (profile.activity.length === 0) return null;
  return (
    <Section id="cus-activity" title={t("profile.activity.title")}>
      <ol className="cus-timeline">
        {profile.activity.map((event) => (
          <li key={event.id} data-actor={event.actorKind}>
            <span className="type-body">
              {activityLabel(t, event.action)} — {event.by ?? t(`actor.${event.actorKind}`)}
            </span>
            <span className="type-caption text-ink-2">
              <When at={event.at} />
            </span>
            {event.reason ? <span className="cus-quote type-caption">{event.reason}</span> : null}
          </li>
        ))}
      </ol>
    </Section>
  );
}

function WalletSection({ profile }: Props) {
  const t = useCustomersT();
  const wallet = profile.wallet;
  if (!wallet) return null;
  return (
    <Section id="cus-wallet" title={t("profile.wallet.title")}>
      <p className="type-kpi nums">
        <Money iqd={wallet.balanceIqd} />
      </p>
      <p className="type-caption text-ink-2">{t("profile.wallet.rule")}</p>
      {wallet.entries.length ? (
        <ul className="cus-rows">
          {wallet.entries.map((entry) => (
            <li key={entry.id} className="cus-row">
              <span className="grid min-w-0">
                <span className="type-body">{t(`walletKind.${entry.kind}`)}</span>
                <span className="type-caption text-ink-2">
                  <When at={entry.at} />
                  {entry.orderRef ? (
                    <>
                      {" · "}
                      <Ref value={entry.orderRef} />
                    </>
                  ) : null}
                </span>
              </span>
              <Money iqd={entry.amountIqd} />
            </li>
          ))}
        </ul>
      ) : (
        <p className="type-body text-ink-2">{t("profile.wallet.none")}</p>
      )}
      {wallet.pendingTopups > 0 ? <p className="type-caption">{t("profile.wallet.pending", { count: wallet.pendingTopups })}</p> : null}
      {wallet.financeHref ? (
        <Key as={Link} to={wallet.financeHref} size="sm" iconEnd="arrow-right">
          {t("profile.wallet.open")}
        </Key>
      ) : (
        <p className="type-caption text-ink-2">{t("profile.wallet.noFinance")}</p>
      )}
    </Section>
  );
}

function NotesSection({ profile, canWrite }: Props & { canWrite: boolean }) {
  const t = useCustomersT();
  const [text, setText] = useState("");
  const { fetcher, pending, message, fields } = useIntent("note", "done.note", () => setText(""));
  return (
    <Section id="cus-notes" title={t("profile.notes.title")}>
      {canWrite ? (
        <fetcher.Form method="post" className="grid gap-2">
          <input type="hidden" name="intent" value="note" />
          <TextArea name="text" label={t("profile.notes.add")} hint={t("profile.notes.hint")} value={text} onChange={(event) => setText(event.currentTarget.value)} rows={3} maxLength={1000} error={fields.text} required />
          <Failure message={fields.text ? null : message} />
          <div>
            <Key type="submit" size="sm" loading={pending} icon="pencil-simple">
              {t("profile.notes.save")}
            </Key>
          </div>
        </fetcher.Form>
      ) : null}
      {profile.notes.length === 0 && !profile.legacyNote ? <p className="type-body text-ink-2">{t("profile.notes.none")}</p> : null}
      <ol className="cus-timeline">
        {profile.notes.map((note) => (
          <li key={note.id} data-actor="employee">
            <span className="cus-quote">{note.text}</span>
            <span className="type-caption text-ink-2">
              {note.by ?? t("actor.employee")} · <When at={note.at} />
              {note.fromAccount ? <> · {t("profile.notes.fromMerged")}</> : null}
            </span>
          </li>
        ))}
        {profile.legacyNote ? (
          <li data-actor="system">
            <span className="cus-quote">{profile.legacyNote}</span>
            <span className="type-caption text-ink-2">{t("profile.notes.legacy")}</span>
          </li>
        ) : null}
      </ol>
    </Section>
  );
}

function ConsentsSection({ profile }: Props) {
  const t = useCustomersT();
  return (
    <Section
      id="cus-consents"
      title={t("profile.consents.title")}
      action={
        <Link to={`/admin/customers/${encodeURIComponent(profile.header.id)}/privacy`} className="adm-link type-caption">
          {t("profile.consents.history")}
        </Link>
      }
    >
      <dl className="cus-ledger">
        {(profile.consents ?? []).map((consent) => (
          <div key={consent.kind}>
            <dt>{t(`consentKind.${consent.kind}`)}</dt>
            <dd>
              <Status tone={consent.granted === true ? "ok" : consent.granted === false ? "neutral" : "neutral"}>{t(consent.granted === true ? "consent.granted" : consent.granted === false ? "consent.withdrawn" : "consent.never")}</Status>
            </dd>
          </div>
        ))}
      </dl>
    </Section>
  );
}

function PrivacySection({ profile }: Props) {
  const t = useCustomersT();
  const rows = profile.privacy ?? [];
  return (
    <Section id="cus-privacy" title={t("profile.privacy.title")}>
      {rows.length === 0 ? (
        <p className="type-body text-ink-2">{t("profile.privacy.none")}</p>
      ) : (
        <ul className="cus-rows">
          {rows.map((request) => (
            <li key={request.ref} className="cus-row">
              <Link to={`/admin/customers/privacy/${request.ref}`} className="adm-link">
                <Ref value={request.ref} /> · {t(`privacy.kind.${request.kind}`)}
              </Link>
              <PrivacyStatusBadge status={request.status} />
            </li>
          ))}
        </ul>
      )}
    </Section>
  );
}

function MergedSection({ profile }: Props) {
  const t = useCustomersT();
  return (
    <Section id="cus-merged" title={t("profile.merged.title")}>
      <ul className="cus-rows">
        {profile.mergedFrom.map((merged) => (
          <li key={merged.id} className="cus-row">
            <Link to={`/admin/customers/${encodeURIComponent(merged.id)}`} className="adm-link">
              {merged.name ?? t("list.noName")}
            </Link>
            <span className="type-caption text-ink-2">
              <PhoneText phone={merged.phone} /> · <When at={merged.at} style="date" />
            </span>
          </li>
        ))}
      </ul>
    </Section>
  );
}
