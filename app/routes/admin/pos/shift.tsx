import { useEffect, useMemo, useState } from "react";
import { data, Link, useNavigate } from "react-router";

import type { Route } from "./+types/shift";
import { useFormat } from "~/i18n/react";
import { throwAsResponse } from "~/server/errors";
import { posAccess } from "~/server/services/admin/pos/shared.server";
import { closeShift, moveCash, openShift, openShiftForm, shiftReport } from "~/server/services/admin/pos/shifts.server";
import { IQD_DENOMINATIONS, parseWhole, type CashMoveKind } from "~/server/services/admin/pos/types";
import { ConfirmDialog, type ImpactRow } from "~/ui/Dialog";
import { EmptyState } from "~/ui/EmptyState";
import { FieldGroup, Radio, Select, TextArea, TextField } from "~/ui/Field";
import { Key } from "~/ui/Key";
import { posMeta } from "./meta";
import { denominations, failed, openPos, text, whole } from "./pos.server";
import { queuedFor } from "./till-store";
import { Facts, Failure, Money, newKey, Notice, Num, Ref, Section, useIntent, usePosT, When } from "./ui";

/**
 * /admin/pos/shift — the employee's drawer (06.02): open a shift on a free register with a counted float, move cash in
 * or out by hand (pay-in, pay-out, drop to the safe — each with a reason, confirmed with its effect on the drawer),
 * and close it with a BLIND count by note (the page never shows what the system expects; a supervisor reviews a
 * difference). Closing is refused on this device while sales it queued offline have not reached the server.
 */
export async function loader({ context }: Route.LoaderArgs) {
  const { db, actor, locale } = await openPos(context, ["pos.shift.open", "pos.shift.close", "pos.cash.move"]);
  try {
    const form = await openShiftForm(db, actor, locale);
    const report = form.mine ? await shiftReport(db, actor, form.mine.id, locale) : null;
    return { form, report, access: posAccess(actor) };
  } catch (error) {
    throwAsResponse(error);
  }
}

export async function action({ request, context }: Route.ActionArgs) {
  const form = await request.formData();
  const intent = text(form, "intent");
  const permission = intent === "open" ? "pos.shift.open" : intent === "move" ? "pos.cash.move" : intent === "close" ? "pos.shift.close" : null;
  if (!permission) return data({ ok: false as const, intent: null, code: "invalid", status: 400 }, { status: 400 });
  const { db, actor, now, locale } = await openPos(context, permission);
  try {
    if (intent === "open") {
      const result = await openShift(db, actor, { registerId: text(form, "registerId"), openingFloatIqd: countedOf(form), denominations: denominations(form, IQD_DENOMINATIONS), idempotencyKey: text(form, "key") }, now);
      return { ok: true as const, intent, replayed: result.replayed, shiftId: result.shiftId };
    }
    if (intent === "move") {
      const result = await moveCash(db, actor, { shiftId: text(form, "shiftId"), kind: text(form, "kind") as CashMoveKind, amountIqd: whole(form, "amount") ?? Number.NaN, reason: text(form, "reason"), idempotencyKey: text(form, "key") }, now);
      return { ok: true as const, intent, replayed: result.replayed };
    }
    const result = await closeShift(db, actor, { shiftId: text(form, "shiftId"), denominations: denominations(form, IQD_DENOMINATIONS), notes: text(form, "notes") || null }, now);
    return { ok: true as const, intent, replayed: result.replayed, needsReview: result.needsReview, shiftId: text(form, "shiftId") };
  } catch (error) {
    return failed(error, locale, intent);
  }
}

/** The float / count from the note fields (a field that is not a whole number makes the whole count NaN). */
function countedOf(form: FormData): number {
  const notes = denominations(form, IQD_DENOMINATIONS);
  return Object.entries(notes).reduce((sum, [note, count]) => sum + Number(note) * count, 0);
}

export const meta: Route.MetaFunction = (args) => posMeta(args, "shift.title");

export default function ShiftPage({ loaderData }: Route.ComponentProps) {
  const t = usePosT();
  const { form, report, access } = loaderData;
  return (
    <>
      <header className="adm-page-head">
        <h1 className="adm-title">{t("shift.title")}</h1>
        <p className="max-w-[70ch] type-body text-ink-2">{t("shift.lead")}</p>
      </header>
      {report ? <OpenDrawer report={report} canMove={access.cash} canClose={access.close} /> : <OpenForm registers={form.registers} canOpen={access.open} />}
    </>
  );
}

type Data = Route.ComponentProps["loaderData"];

function OpenForm({ registers, canOpen }: { registers: Data["form"]["registers"]; canOpen: boolean }) {
  const t = usePosT();
  const free = registers.filter((register) => !register.busy);
  const [key] = useState(newKey);
  const { fetcher, pending, message, fields } = useIntent("open", "done.shiftOpened");
  if (!canOpen) return <Notice tone="warn">{t("shift.cannotOpen")}</Notice>;
  if (registers.length === 0) return <EmptyState title={t("shift.noRegisters")} text={t("shift.noRegistersHint")} icon="storefront" action={<Key as={Link} to="/admin/pos/registers">{t("shift.toRegisters")}</Key>} />;
  return (
    <Section id="open-shift" title={t("shift.open")}>
      <fetcher.Form method="post" className="grid max-w-[44rem] gap-4">
        <input type="hidden" name="intent" value="open" />
        <input type="hidden" name="key" value={key} />
        <Select name="registerId" label={t("shift.register")} required error={fields.registerId} options={registers.map((register) => ({ value: register.id, label: `${register.code} · ${register.name} — ${register.location}${register.busy ? ` (${t("shift.busy")})` : ""}`, disabled: register.busy }))} defaultValue={free[0]?.id} />
        <CountFields legend={t("shift.float")} hint={t("shift.floatHint")} error={fields.openingFloatIqd} />
        <Failure message={message} />
        <div className="pos-actions">
          <Key type="submit" variant="ink" icon="lock" loading={pending} disabled={free.length === 0}>
            {t("shift.openKey")}
          </Key>
        </div>
      </fetcher.Form>
    </Section>
  );
}

/** Note counts (the float, the closing count): one field per note, the total beside them. */
function CountFields({ legend, hint, error, onTotal }: { legend: string; hint?: string; error?: string; onTotal?: (total: number) => void }) {
  const t = usePosT();
  const f = useFormat();
  const [counts, setCounts] = useState<Record<string, string>>({});
  const parsed = IQD_DENOMINATIONS.map((note) => ({ note, value: parseWhole(counts[String(note)] ?? "") }));
  const bad = parsed.some((entry) => entry.value !== null && (Number.isNaN(entry.value) || entry.value < 0));
  const total = parsed.reduce((sum, entry) => sum + (entry.value && entry.value > 0 ? entry.value * entry.note : 0), 0);
  useEffect(() => onTotal?.(bad ? Number.NaN : total), [total, bad, onTotal]);
  return (
    <FieldGroup legend={legend} hint={hint} error={error ?? (bad ? t("count.bad") : undefined)}>
      <div className="pos-count">
        {IQD_DENOMINATIONS.map((note) => (
          <TextField key={note} name={`note_${note}`} label={t("count.note", { value: f.number(note) })} inputMode="numeric" autoComplete="off" value={counts[String(note)] ?? ""} onChange={(event) => setCounts((now) => ({ ...now, [String(note)]: event.target.value }))} />
        ))}
      </div>
      <p className="type-strong" aria-live="polite">
        {t("count.total")} {bad ? "—" : <Money iqd={total} />}
      </p>
    </FieldGroup>
  );
}

function OpenDrawer({ report, canMove, canClose }: { report: NonNullable<Data["report"]>; canMove: boolean; canClose: boolean }) {
  const t = usePosT();
  const queued = useQueued(report.id);
  return (
    <div className="grid gap-6">
      <section className="pos-panel" aria-labelledby="drawer-now">
        <h2 id="drawer-now" className="adm-h2">
          {t("shift.now")}
        </h2>
        <Facts
          rows={[
            { label: t("shift.register"), value: <><Ref value={report.register.code} /> · {report.register.name}</> },
            { label: t("shift.location"), value: report.location ? <><Ref value={report.location.code} /> · {report.location.name}</> : "—" },
            { label: t("shift.openedAt"), value: <When at={report.openedAt} /> },
            { label: t("shift.float"), value: <Money iqd={report.openingFloatIqd} /> },
            { label: t("shift.salesCount"), value: <Num value={report.sales.count} /> },
          ]}
        />
        <p className="type-caption text-ink-2">{t("shift.blindNote")}</p>
        <div className="pos-actions">
          <Key as={Link} to="/admin/pos/sell" variant="ink" icon="barcode">
            {t("shift.toTill")}
          </Key>
          <Key as={Link} to={`/admin/pos/shifts/${report.id}`} icon="receipt">
            {t("shift.report")}
          </Key>
        </div>
      </section>
      {canMove ? <MoveForm shiftId={report.id} /> : null}
      {report.moves.length ? (
        <Section id="moves" title={t("shift.moves")}>
          <ul className="grid gap-2">
            {report.moves.map((move) => (
              <li key={move.id} className="pos-card">
                <div className="pos-card__row">
                  <span className="type-strong">{t(`move.${move.kind}`)}</span>
                  <Money iqd={move.amountIqd} signed />
                </div>
                <p className="type-caption text-ink-2">
                  <When at={move.at} /> · {move.by}
                  {move.reason ? ` · ${move.reason}` : ""}
                </p>
              </li>
            ))}
          </ul>
        </Section>
      ) : null}
      {canClose ? <CloseForm shiftId={report.id} queued={queued} /> : null}
    </div>
  );
}

/** Sales this device queued offline for the shift (read after hydration; the server cannot know them). */
function useQueued(shiftId: string): number {
  const [count, setCount] = useState(0);
  useEffect(() => {
    const read = () => setCount(queuedFor(shiftId));
    read();
    window.addEventListener("storage", read);
    return () => window.removeEventListener("storage", read);
  }, [shiftId]);
  return count;
}

function MoveForm({ shiftId }: { shiftId: string }) {
  const t = usePosT();
  const [kind, setKind] = useState<CashMoveKind>("drop");
  const [amount, setAmount] = useState("");
  const [open, setOpen] = useState(false);
  const [key, setKey] = useState(newKey);
  const { fetcher, pending, message, fields } = useIntent("move", "done.moved", () => {
    setOpen(false);
    setAmount("");
    setKey(newKey());
  });
  const value = parseWhole(amount);
  const valid = value !== null && Number.isSafeInteger(value) && value > 0;
  const impact: ImpactRow[] = valid ? [{ label: t("move.impact"), value: <Money iqd={kind === "pay_in" ? value : -value} signed />, negative: kind !== "pay_in" }] : [];
  return (
    <Section id="move" title={t("shift.move")}>
      <div className="grid max-w-[44rem] gap-4">
        <FieldGroup legend={t("move.kind")}>
          {(["drop", "pay_out", "pay_in"] as const).map((entry) => (
            <Radio key={entry} row name="kindPick" value={entry} label={t(`move.${entry}`)} hint={t(`move.${entry}Hint`)} checked={kind === entry} onChange={() => setKind(entry)} />
          ))}
        </FieldGroup>
        <TextField name="amountPick" label={t("move.amount")} inputMode="numeric" autoComplete="off" value={amount} onChange={(event) => setAmount(event.target.value)} error={amount && !valid ? t("errors.invalid_amount") : fields.amountIqd} />
        <div className="pos-actions">
          <Key icon="coins" disabled={!valid} onClick={() => setOpen(true)}>
            {t(`move.${kind}Key`)}
          </Key>
        </div>
      </div>
      <ConfirmDialog
        open={open}
        onClose={() => setOpen(false)}
        tone={kind === "pay_in" ? "neutral" : "destructive"}
        title={t(`move.${kind}Q`)}
        consequence={t(`move.${kind}What`)}
        confirmLabel={t(`move.${kind}Key`)}
        impact={impact}
        reason={{ label: t("move.reason"), hint: t("move.reasonHint") }}
        pending={pending}
        error={message}
        onConfirm={({ reason }) => fetcher.submit({ intent: "move", shiftId, kind, amount, reason, key }, { method: "post" })}
      />
    </Section>
  );
}

function CloseForm({ shiftId, queued }: { shiftId: string; queued: number }) {
  const t = usePosT();
  const [total, setTotal] = useState(Number.NaN);
  const [open, setOpen] = useState(false);
  const [notes, setNotes] = useState("");
  const navigate = useNavigate();
  const { fetcher, pending, message } = useIntent("close", "done.closed", (result) => navigate(`/admin/pos/shifts/${shiftId}?closed=${result.needsReview ? "review" : "ok"}`));
  const formId = "close-form";
  const impact = useMemo<ImpactRow[]>(() => (Number.isNaN(total) ? [] : [{ label: t("close.counted"), value: <Money iqd={total} /> }, { label: t("close.next"), value: t("close.nextValue") }]), [total, t]);
  return (
    <Section id="close" title={t("shift.close")}>
      <form id={formId} className="grid max-w-[44rem] gap-4" onSubmit={(event) => event.preventDefault()}>
        <p className="type-body text-ink-2">{t("close.lead")}</p>
        <CountFields legend={t("close.count")} hint={t("close.countHint")} onTotal={setTotal} />
        <TextArea name="notes" label={t("close.notes")} optional value={notes} onChange={(event) => setNotes(event.target.value)} rows={2} />
        {queued > 0 ? <Notice tone="bad" icon="wifi-slash">{t("close.queued", { count: queued })}</Notice> : null}
        <Failure message={message} />
        <div className="pos-actions">
          <Key variant="commit" icon="lock" disabled={Number.isNaN(total) || queued > 0} onClick={() => setOpen(true)}>
            {t("close.key")}
          </Key>
        </div>
      </form>
      <ConfirmDialog
        open={open}
        onClose={() => setOpen(false)}
        tone="commit"
        title={t("close.q")}
        consequence={t("close.what")}
        confirmLabel={t("close.key")}
        impact={impact}
        pending={pending}
        error={message}
        onConfirm={() => {
          const form = document.getElementById(formId) as HTMLFormElement | null;
          const body = new FormData(form ?? undefined);
          body.set("intent", "close");
          body.set("shiftId", shiftId);
          body.set("notes", notes);
          fetcher.submit(body, { method: "post" });
        }}
      />
    </Section>
  );
}
