import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { Link } from "react-router";

import type { Route } from "./+types/sell";
import { Icon } from "~/art/Icon";
import { useFormat } from "~/i18n/react";
import { posAccess } from "~/server/services/admin/pos/shared.server";
import { myShift } from "~/server/services/admin/pos/shifts.server";
import { getSetting } from "~/server/settings.server";
import {
  bpsShare,
  CATALOG_MAX_AGE_MS,
  cartTotals,
  discountBeyondLimit,
  latinDigits,
  parsePercentBps,
  parseWhole,
  type CatalogSnapshot,
  type CustomerHit,
  type LookupResult,
  type ReceiptView,
  type SaleOutcome,
  type SaleRequest,
  type TillItem,
} from "~/server/services/admin/pos/types";
import { Chip } from "~/ui/Chip";
import { ConfirmDialog } from "~/ui/Dialog";
import { EmptyState } from "~/ui/EmptyState";
import { TextArea, TextField } from "~/ui/Field";
import { IconKey } from "~/ui/IconKey";
import { Key } from "~/ui/Key";
import { Stepper } from "~/ui/Stepper";
import { Status } from "~/ui/Tag";
import { toast } from "~/ui/toast-store";
import { posMeta } from "./meta";
import { openPos } from "./pos.server";
import { PrintArea, ReceiptPaper } from "./receipt-paper";
import { enqueue, findInCatalog, QUEUE_EVENT, readCart, readCatalog, readQueue, removeQueued, updateQueued, writeCart, writeCatalog, type CartLine, type QueuedSale, type StoredCart } from "./till-store";
import { Failure, Money, newKey, Notice, Ref, usePosT, When } from "./ui";

/**
 * /admin/pos/sell — the till (06.01, 06.03–06.07). A keyboard-wedge scanner (or a person) types a code and presses
 * Enter: a SKU, a barcode or a serial number adds the item; the search field finds items by name. Lines carry their
 * quantity, serials (scanned one by one for tracked units), and a discount within the cashier's limit. The buyer is
 * optional (an account found by phone, or a phone kept with the sale). Payment mixes cash (tendered, change), card
 * (the bank's own terminal, recorded by its slip number) and wallet (an account looked up, online only; its balance
 * shows only with customers.wallet.read). The server prices everything again and records the sale through the commerce
 * core in one step; the receipt prints from the browser (80 mm) IN PLACE — the server records the print first (the
 * first print is the original, any later one a copy), then the page prints a hidden copy of the receipt paper (the
 * admin answers X-Frame-Options: DENY, so a frame never could).
 *
 * OFFLINE (06.07): the catalogue is kept on this device; without a connection a sale is priced from it and saved on the
 * device with the key it got at "charge", and is sent when the connection returns (also by "send now"). The server
 * confirms stock, prices and serials then: a conflict stays on the device with what to do about it. The page must be
 * open before the connection drops (no service worker).
 */
export async function loader({ context }: Route.LoaderArgs) {
  const { db, actor, locale } = await openPos(context, "pos.sale.create");
  // the cashier's discount limit in force (setting "pos.discount_limit_bps", admin 22): the same number the sale's
  // server check uses, so the till warns where the server would refuse
  const [shift, limitBps] = await Promise.all([myShift(db, actor, locale), getSetting(db, "pos.discount_limit_bps")]);
  return { shift, access: posAccess(actor), limitBps };
}

export const meta: Route.MetaFunction = (args) => posMeta(args, "sell.title");

type Data = Route.ComponentProps["loaderData"];
type Customer = NonNullable<StoredCart["customer"]>;
type LastSale = { kind: "online"; ref: string; number: string | null; totalIqd: number; changeIqd: number; replayed: boolean } | { kind: "queued"; key: string; totalIqd: number; changeIqd: number };

const EMPTY_CART: StoredCart = { key: null, lines: [], orderDiscountIqd: 0, customer: null, discountReason: "" };

export default function Sell({ loaderData }: Route.ComponentProps) {
  const t = usePosT();
  const { shift } = loaderData;
  if (!shift) {
    return (
      <>
        <header className="adm-page-head">
          <h1 className="adm-title">{t("sell.title")}</h1>
        </header>
        <EmptyState title={t("sell.noShift")} text={t("sell.noShiftHint")} icon="lock" action={<Key as={Link} to="/admin/pos/shift" variant="ink">{t("sell.openShift")}</Key>} />
      </>
    );
  }
  return <Till data={loaderData} shift={shift} />;
}

// ───────────────────────────────────────────────────────────────── connection, catalogue, queue

function useOnline(): boolean {
  const [online, setOnline] = useState(true);
  useEffect(() => {
    const update = () => setOnline(navigator.onLine);
    update();
    window.addEventListener("online", update);
    window.addEventListener("offline", update);
    return () => {
      window.removeEventListener("online", update);
      window.removeEventListener("offline", update);
    };
  }, []);
  return online;
}

function useQueue(): QueuedSale[] {
  const [queue, setQueue] = useState<QueuedSale[]>([]);
  useEffect(() => {
    const read = () => setQueue(readQueue());
    read();
    window.addEventListener(QUEUE_EVENT, read);
    window.addEventListener("storage", read);
    return () => {
      window.removeEventListener(QUEUE_EVENT, read);
      window.removeEventListener("storage", read);
    };
  }, []);
  return queue;
}

async function getJson<T>(url: string): Promise<{ status: number; body: T }> {
  const response = await fetch(url, { headers: { Accept: "application/json" }, credentials: "same-origin" });
  const body = (await response.json().catch(() => null)) as T;
  return { status: response.status, body };
}

async function postJson<T>(url: string, payload: unknown): Promise<{ status: number; body: T }> {
  const response = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json", Accept: "application/json" }, credentials: "same-origin", body: JSON.stringify(payload) });
  const body = (await response.json().catch(() => null)) as T;
  return { status: response.status, body };
}

// ───────────────────────────────────────────────────────────────── the till

function Till({ data, shift }: { data: Data; shift: NonNullable<Data["shift"]> }) {
  const t = usePosT();
  const f = useFormat();
  const { access, limitBps } = data;
  const online = useOnline();
  const queue = useQueue();
  const [catalog, setCatalog] = useState<CatalogSnapshot | null>(null);
  const [cart, setCart] = useState<StoredCart>(EMPTY_CART);
  const [loaded, setLoaded] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [failure, setFailure] = useState<Extract<SaleOutcome, { ok: false }> | null>(null);
  const [busy, setBusy] = useState(false);
  const [last, setLast] = useState<LastSale | null>(null);
  const [orderDiscountText, setOrderDiscountText] = useState("");
  const [cardText, setCardText] = useState("");
  const [cardRef, setCardRef] = useState("");
  const [walletText, setWalletText] = useState("");
  const [tenderText, setTenderText] = useState("");
  const [notes, setNotes] = useState("");
  const scanRef = useRef<HTMLInputElement | null>(null);
  /** The receipt being printed in place (what the server answered for this print: the original or a numbered copy). */
  const [printing, setPrinting] = useState<{ receipt: ReceiptView; copy: number } | null>(null);
  const [printState, setPrintState] = useState<{ busy: boolean; error: string | null }>({ busy: false, error: null });

  // The cart survives a reload; the catalogue snapshot is read from the device, then refreshed when online.
  useEffect(() => {
    const stored = readCart(shift.id);
    if (stored) {
      setCart(stored);
      setOrderDiscountText(stored.orderDiscountIqd ? String(stored.orderDiscountIqd) : "");
    }
    setCatalog(readCatalog(shift.register.id));
    setLoaded(true);
  }, [shift.id, shift.register.id]);
  useEffect(() => {
    if (loaded) writeCart(shift.id, cart.lines.length || cart.customer ? cart : null);
  }, [cart, loaded, shift.id]);
  const refreshCatalog = useCallback(async () => {
    try {
      const { status, body } = await getJson<CatalogSnapshot>(`/admin/pos/api/catalog?shift=${encodeURIComponent(shift.id)}`);
      if (status === 200 && body?.items) {
        writeCatalog(body);
        setCatalog(body);
      }
    } catch {
      /* offline: keep what the device has */
    }
  }, [shift.id]);
  useEffect(() => {
    if (!online) return;
    void refreshCatalog();
    const timer = window.setInterval(() => void refreshCatalog(), 10 * 60 * 1000);
    return () => window.clearInterval(timer);
  }, [online, refreshCatalog]);
  const catalogFresh = catalog !== null && Date.now() - catalog.at < CATALOG_MAX_AGE_MS;

  // ── cart edits
  const setLines = (update: (lines: CartLine[]) => CartLine[]) => setCart((now) => ({ ...now, lines: update(now.lines) }));
  const addItem = useCallback(
    (item: TillItem) => {
      setFailure(null);
      setLast(null);
      setCart((now) => {
        const lines = [...now.lines];
        if (item.kind === "used") {
          if (lines.some((line) => line.item.usedUnitId === item.usedUnitId)) return now;
          lines.push({ id: newKey(), item, qty: 1, discountIqd: 0, serials: item.serial ? [item.serial.serial] : [] });
          return { ...now, lines };
        }
        const index = lines.findIndex((line) => line.item.kind === "variant" && line.item.variantId === item.variantId);
        if (index >= 0) {
          const line = lines[index] as CartLine;
          const serials = item.serial && !line.serials.includes(item.serial.serial) ? [...line.serials, item.serial.serial] : line.serials;
          lines[index] = { ...line, qty: item.trackSerials ? Math.max(line.qty, serials.length) + (item.serial ? 0 : 1) : line.qty + 1, serials };
        } else {
          lines.push({ id: newKey(), item, qty: 1, discountIqd: 0, serials: item.serial ? [item.serial.serial] : [] });
        }
        return { ...now, lines };
      });
      toast.info(t("sell.added", { name: item.name }));
    },
    [t],
  );

  // ── scanning (keyboard wedge: the code, then Enter)
  const onScan = async (code: string) => {
    const clean = latinDigits(code).trim();
    if (!clean) return;
    setMessage(null);
    if (!online) {
      const item = findInCatalog(catalog, clean);
      if (item) addItem({ ...item, stockAll: item.stockAll });
      else setMessage(catalog ? t("sell.offlineUnknown", { code: clean }) : t("sell.offlineNoCatalog"));
      return;
    }
    try {
      const { status, body } = await getJson<LookupResult>(`/admin/pos/api/lookup?shift=${encodeURIComponent(shift.id)}&code=${encodeURIComponent(clean)}`);
      if (status !== 200 || !body) {
        setMessage(t("sell.lookupFailed"));
        return;
      }
      if (body.kind === "item") addItem(body.item);
      else if (body.kind === "none") setMessage(t("sell.unknownCode", { code: clean }));
      else if (body.kind === "serial_hidden") setMessage(t("sell.serialHidden"));
      else if (body.kind === "serial_unavailable") setMessage(t(body.here ? "sell.serialUnavailable" : "sell.serialElsewhere", { serial: body.serial, status: t(`serialStatus.${body.status}`) }));
      else setMessage(t(`sell.notSellable.${body.reason}`, { sku: body.sku }));
    } catch {
      // The connection dropped mid-scan: the device's catalogue answers.
      const item = findInCatalog(catalog, clean);
      if (item) addItem(item);
      else setMessage(t("sell.lookupFailed"));
    }
  };

  // ── sums (the server computes them again)
  const lines = cart.lines;
  const lineTotalsBase = useMemo(() => lines.map((line) => ({ unitPriceIqd: line.item.unitPriceIqd, qty: line.qty, discountIqd: line.discountIqd })), [lines]);
  const baseTotals = cartTotals(lineTotalsBase, 0);
  const orderDiscount = useMemo(() => {
    const textValue = orderDiscountText.trim();
    if (!textValue) return 0;
    if (/[%٪]$/.test(textValue)) {
      const bps = parsePercentBps(textValue);
      return bps === null || Number.isNaN(bps) ? Number.NaN : bpsShare(baseTotals.subtotalIqd, bps);
    }
    const value = parseWhole(textValue);
    return value === null ? 0 : value;
  }, [orderDiscountText, baseTotals.subtotalIqd]);
  const totals = cartTotals(lineTotalsBase, Number.isNaN(orderDiscount) ? 0 : orderDiscount);
  const wallet = parseWhole(walletText) ?? 0;
  const card = parseWhole(cardText) ?? 0;
  const tender = parseWhole(tenderText);
  const cashDue = totals.totalIqd - (Number.isNaN(wallet) ? 0 : wallet) - (Number.isNaN(card) ? 0 : card);
  const change = tender !== null && !Number.isNaN(tender) && cashDue >= 0 ? tender - cashDue : 0;
  const discounted = totals.discountIqd > 0;
  const beyond = discounted ? discountBeyondLimit(lineTotalsBase, totals.orderDiscountIqd, limitBps) : null;

  const problems: string[] = [];
  if (lines.length === 0) problems.push(t("sell.problem.empty"));
  if (Number.isNaN(orderDiscount) || orderDiscount > baseTotals.subtotalIqd) problems.push(t("sell.problem.discount"));
  if (discounted && !access.discount && !access.override) problems.push(t("errors.discount_not_allowed"));
  if (discounted && beyond !== null && !access.override) problems.push(t("errors.discount_over_limit"));
  if (discounted && cart.discountReason.trim().length < 3) problems.push(t("errors.discount_reason_required"));
  for (const line of lines) {
    const need = line.item.trackSerials && line.item.kind === "variant" && !line.item.bundle ? line.qty : 0;
    if (need > 0 && line.serials.length !== need) problems.push(t("sell.problem.serials", { name: line.item.name, count: need - line.serials.length }));
  }
  if (Number.isNaN(card) || Number.isNaN(wallet) || (tender !== null && Number.isNaN(tender)) || lines.some((line) => line.discountInvalid)) problems.push(t("errors.invalid_amount"));
  if (card > 0 && cardRef.trim().length < 3) problems.push(t("errors.card_reference_required"));
  if (wallet > 0 && !cart.customer?.id) problems.push(t("errors.wallet_requires_account"));
  if (wallet > 0 && !online) problems.push(t("errors.wallet_offline"));
  if (wallet > 0 && cart.customer?.walletIqd !== null && cart.customer?.walletIqd !== undefined && wallet > cart.customer.walletIqd) problems.push(t("errors.wallet_insufficient"));
  if (cashDue < 0) problems.push(t("sell.problem.overpaid"));
  if (tender !== null && !Number.isNaN(tender) && cashDue > 0 && tender < cashDue) problems.push(t("errors.cash_tendered_short"));
  if (!online && !catalogFresh && lines.some((line) => line.item.kind === "variant")) problems.push(t("sell.problem.catalogOld"));
  if (!online && lines.some((line) => line.item.kind === "used")) problems.push(t("sell.problem.usedOffline"));

  const request = (key: string): SaleRequest => ({
    idempotencyKey: key,
    shiftId: shift.id,
    customer: cart.customer ? { id: cart.customer.id, phone: cart.customer.id ? null : cart.customer.phone, name: cart.customer.name } : null,
    lines: lines.map((line) => ({
      variantId: line.item.kind === "variant" ? line.item.variantId : undefined,
      usedUnitId: line.item.usedUnitId ?? undefined,
      qty: line.qty,
      unitPriceIqd: line.item.unitPriceIqd,
      discountIqd: line.discountIqd,
      serials: line.item.kind === "used" ? [] : line.serials,
    })),
    orderDiscountIqd: totals.orderDiscountIqd,
    payments: [
      ...(cashDue > 0 ? [{ method: "pos_cash" as const, amountIqd: cashDue, tenderedIqd: tender !== null && !Number.isNaN(tender) ? tender : cashDue }] : []),
      ...(card > 0 ? [{ method: "pos_card" as const, amountIqd: card, reference: cardRef.trim() }] : []),
      ...(wallet > 0 ? [{ method: "wallet" as const, amountIqd: wallet }] : []),
    ],
    discountReason: discounted ? cart.discountReason.trim() : null,
    notes: notes.trim() || null,
    offlineCreatedAt: online ? null : Date.now(),
  });

  const resetSale = () => {
    setCart(EMPTY_CART);
    setOrderDiscountText("");
    setCardText("");
    setCardRef("");
    setWalletText("");
    setTenderText("");
    setNotes("");
    setFailure(null);
    scanRef.current?.focus();
  };

  const queueSale = (key: string, payload: SaleRequest) => {
    const saved = enqueue({ key, shiftId: shift.id, createdAt: Date.now(), totalIqd: totals.totalIqd, lines: lines.length, request: { ...payload, offlineCreatedAt: payload.offlineCreatedAt ?? Date.now() } });
    if (!saved) {
      setFailure({ ok: false, code: "device_storage", message: t("sell.storageFull") });
      return;
    }
    setLast({ kind: "queued", key, totalIqd: totals.totalIqd, changeIqd: Math.max(0, change) });
    resetSale();
  };

  const charge = async () => {
    if (problems.length || busy) return;
    const key = cart.key ?? newKey();
    if (!cart.key) setCart((now) => ({ ...now, key }));
    const payload = request(key);
    setBusy(true);
    setFailure(null);
    try {
      if (!online) {
        queueSale(key, payload);
        return;
      }
      let response: { status: number; body: SaleOutcome };
      try {
        response = await postJson<SaleOutcome>("/admin/pos/api/sale", payload);
      } catch {
        // No answer: the sale may or may not have reached the server — the key makes the replay safe either way.
        queueSale(key, { ...payload, offlineCreatedAt: Date.now() });
        return;
      }
      const outcome = response.body;
      if (response.status >= 500 || !outcome) {
        queueSale(key, { ...payload, offlineCreatedAt: Date.now() });
        return;
      }
      if (outcome.ok) {
        setLast({ kind: "online", ref: outcome.ref, number: outcome.receiptNumber, totalIqd: outcome.totalIqd, changeIqd: outcome.changeIqd, replayed: outcome.replayed });
        toast.success(t(outcome.replayed ? "sell.doneReplayed" : "sell.done", { ref: outcome.ref }));
        resetSale();
        return;
      }
      if (outcome.code === "price_changed" && outcome.prices) {
        // Show the prices now; the cashier tells the customer and charges again (same key: nothing is twice).
        setCart((now) => ({ ...now, lines: now.lines.map((line, index) => ({ ...line, item: { ...line.item, unitPriceIqd: outcome.prices?.find((entry) => entry.index === index)?.unitPriceIqd ?? line.item.unitPriceIqd } })) }));
      }
      setFailure(outcome);
    } finally {
      setBusy(false);
    }
  };

  // The server records the print first (the original once, a copy after that), then the page prints it in place.
  const printReceipt = async (ref: string) => {
    if (printState.busy) return;
    setPrintState({ busy: true, error: null });
    try {
      const { status, body } = await postJson<{ ok?: boolean; copy?: number; receipt?: ReceiptView; code?: string; message?: string }>("/admin/pos/api/print", { ref });
      if (status === 200 && body?.ok && body.receipt && typeof body.copy === "number") {
        setPrinting({ receipt: body.receipt, copy: body.copy });
        setPrintState({ busy: false, error: null });
      } else setPrintState({ busy: false, error: body?.message ?? t(`errors.${body?.code ?? "invalid"}`) });
    } catch {
      setPrintState({ busy: false, error: t("sell.printFailed") });
    }
  };
  useEffect(() => {
    if (!printing) return;
    const done = () => setPrinting(null);
    window.addEventListener("afterprint", done);
    // Print once React has drawn the receipt (and its COPY mark) into the print area.
    const timer = window.setTimeout(() => window.print(), 100);
    return () => {
      window.clearTimeout(timer);
      window.removeEventListener("afterprint", done);
    };
  }, [printing]);

  return (
    <div className="grid gap-4">
      <div className="pos-noprint pos-bar">
        <div className="grid gap-0.5">
          <h1 className="adm-title">{t("sell.title")}</h1>
          <p className="type-caption text-ink-2">
            <Ref value={shift.register.code} /> · {shift.register.name} · {t("sell.since")} <When at={shift.openedAt} />
          </p>
        </div>
        <div className="pos-actions">
          <span className="pos-pill" data-tone={online ? "ok" : "warn"} role="status" aria-live="polite">
            <Icon name={online ? "check-circle" : "wifi-slash"} size={16} />
            {online ? t("sell.online") : t("sell.offline")}
          </span>
          <span className="pos-pill" data-tone={catalogFresh ? "ok" : "warn"}>
            <Icon name="database" size={16} />
            {catalog ? t("sell.catalogAt", { time: f.dateTime(catalog.at) }) : t("sell.catalogNone")}
          </span>
        </div>
      </div>

      {!online ? (
        <div className="pos-noprint">
          <Notice tone="warn" icon="wifi-slash">
            {t("sell.offlineNotice")}
          </Notice>
        </div>
      ) : null}

      <QueuePanel
        queue={queue}
        online={online}
        shiftId={shift.id}
        access={access}
        onSynced={(key, outcome) => setLast((now) => (now?.kind === "queued" && now.key === key ? { kind: "online", ref: outcome.ref, number: outcome.receiptNumber, totalIqd: outcome.totalIqd, changeIqd: outcome.changeIqd, replayed: outcome.replayed } : now))}
      />

      <div className="pos-till pos-noprint">
        <div className="pos-till__main">
          <section className="pos-panel" aria-labelledby="scan-head">
            <h2 id="scan-head" className="adm-h3">
              {t("sell.scanHead")}
            </h2>
            <ScanBox inputRef={scanRef} onScan={onScan} />
            {message ? <p className="type-body text-ink-2" role="status">{message}</p> : null}
            <SearchBox shiftId={shift.id} online={online} catalog={catalog} onPick={addItem} />
          </section>

          <section className="pos-panel" aria-labelledby="cart-head">
            <div className="pos-bar">
              <h2 id="cart-head" className="adm-h3">
                {t("sell.cart", { count: lines.length })}
              </h2>
              {lines.length ? (
                <Key size="sm" variant="quiet" icon="trash" onClick={() => setCart((now) => ({ ...now, lines: [] }))}>
                  {t("sell.clear")}
                </Key>
              ) : null}
            </div>
            {lines.length === 0 ? (
              <p className="type-body text-ink-2">{t("sell.cartEmpty")}</p>
            ) : (
              <ul className="pos-lines" aria-label={t("sell.cartLabel")}>
                {lines.map((line, index) => (
                  <CartRow
                    key={line.id}
                    line={line}
                    index={index}
                    canDiscount={access.discount || access.override}
                    limitBps={access.override ? null : limitBps}
                    onChange={(next) => setLines((all) => all.map((entry) => (entry.id === line.id ? next : entry)))}
                    onRemove={() => setLines((all) => all.filter((entry) => entry.id !== line.id))}
                    fieldError={failure?.fields?.[`lines.${index}.serials`] ?? failure?.fields?.[`lines.${index}.serialIds`] ?? failure?.fields?.[`lines.${index}.discountIqd`] ?? failure?.fields?.[`lines.${index}.qty`] ?? failure?.fields?.[`lines.${index}`] ?? null}
                  />
                ))}
              </ul>
            )}
          </section>
        </div>

        <aside className="pos-till__side" aria-label={t("sell.payHead")}>
          <CustomerPanel customer={cart.customer} online={online} canLookup={access.customers} onChange={(customer) => setCart((now) => ({ ...now, customer }))} />

          <section className="pos-panel" aria-labelledby="pay-head">
            <h2 id="pay-head" className="adm-h3">
              {t("sell.payHead")}
            </h2>
            {access.discount || access.override ? (
              <>
                <TextField label={t("sell.orderDiscount")} hint={access.override ? t("sell.overrideHint") : t("sell.limitHint", { pct: f.number(limitBps / 100) })} inputMode="text" value={orderDiscountText} onChange={(event) => setOrderDiscountText(event.target.value)} error={Number.isNaN(orderDiscount) ? t("errors.invalid_amount") : undefined} />
                {discounted ? <TextField label={t("sell.discountReason")} required value={cart.discountReason} onChange={(event) => setCart((now) => ({ ...now, discountReason: event.target.value }))} /> : null}
              </>
            ) : null}
            <div className="pos-sum" aria-live="polite">
              <div>
                <span>{t("sell.subtotal")}</span>
                <Money iqd={totals.grossIqd} />
              </div>
              {totals.discountIqd > 0 ? (
                <div>
                  <span>{t("sell.discounts")}</span>
                  <Money iqd={-totals.discountIqd} />
                </div>
              ) : null}
              <div className="pos-sum__total">
                <span>{t("sell.total")}</span>
                <Money iqd={totals.totalIqd} />
              </div>
            </div>
            <TextField label={t("sell.card")} hint={t("sell.cardHint")} inputMode="numeric" autoComplete="off" value={cardText} onChange={(event) => setCardText(event.target.value)} />
            {card > 0 ? <TextField label={t("sell.cardRef")} hint={t("sell.cardRefHint")} required ltr autoComplete="off" value={cardRef} onChange={(event) => setCardRef(event.target.value)} error={failure?.fields?.["payments.1.reference"] ?? failure?.fields?.["payments.0.reference"]} /> : null}
            {cart.customer?.id && online ? (
              <TextField
                label={t("sell.wallet")}
                hint={typeof cart.customer.walletIqd === "number" ? t("sell.walletHint", { amount: f.iqd(cart.customer.walletIqd) }) : t("sell.walletHidden")}
                inputMode="numeric"
                autoComplete="off"
                value={walletText}
                onChange={(event) => setWalletText(event.target.value)}
                error={failure?.fields?.wallet}
              />
            ) : null}
            <div className="grid gap-2">
              <TextField label={t("sell.tendered")} hint={cashDue > 0 ? t("sell.cashDue", { amount: f.iqd(cashDue) }) : t("sell.noCash")} inputMode="numeric" autoComplete="off" value={tenderText} onChange={(event) => setTenderText(event.target.value)} disabled={cashDue <= 0} />
              {cashDue > 0 ? (
                <div className="pos-quick" role="group" aria-label={t("sell.quickCash")}>
                  {[cashDue, ...quickNotes(cashDue)].map((value) => (
                    <Key key={value} size="sm" onClick={() => setTenderText(String(value))}>
                      <bdi className="nums">{f.number(value)}</bdi>
                    </Key>
                  ))}
                </div>
              ) : null}
              {change > 0 ? (
                <p className="type-strong" aria-live="polite">
                  {t("sell.change")} <Money iqd={change} />
                </p>
              ) : null}
            </div>
            <TextArea label={t("sell.notes")} optional rows={2} value={notes} onChange={(event) => setNotes(event.target.value)} />
            {problems.length && lines.length ? (
              <ul className="grid gap-1" aria-live="polite">
                {problems.map((problem) => (
                  <li key={problem} className="flex items-start gap-1 type-caption text-ink-2">
                    <Icon name="info" size={14} className="mt-0.5 flex-none" />
                    {problem}
                  </li>
                ))}
              </ul>
            ) : null}
            <SaleFailure failure={failure} />
            <Key variant="commit" block size="lg" icon={online ? "check" : "floppy-disk"} loading={busy} disabled={problems.length > 0} onClick={() => void charge()}>
              {online ? t("sell.charge", { amount: f.iqd(totals.totalIqd) }) : t("sell.chargeOffline", { amount: f.iqd(totals.totalIqd) })}
            </Key>
          </section>
          <LastSalePanel last={last} onPrint={(ref) => void printReceipt(ref)} canPrint={access.reprint || access.review} printing={printState.busy} printError={printState.error} />
        </aside>
      </div>

      {lines.length ? (
        <div className="pos-paybar pos-noprint">
          <span className="type-strong">
            {t("sell.total")} <Money iqd={totals.totalIqd} />
          </span>
          <Key variant="ink" size="sm" onClick={() => document.getElementById("pay-head")?.scrollIntoView({ behavior: "smooth", block: "start" })}>
            {t("sell.toPay")}
          </Key>
        </div>
      ) : null}

      {printing ? (
        <PrintArea>
          <ReceiptPaper receipt={printing.receipt} copy={printing.copy} />
        </PrintArea>
      ) : null}
    </div>
  );
}

/** Round amounts above what is due (the notes a customer usually hands over). */
function quickNotes(due: number): number[] {
  const out = new Set<number>();
  for (const step of [5_000, 10_000, 25_000, 50_000]) {
    const value = Math.ceil(due / step) * step;
    if (value > due) out.add(value);
  }
  return [...out].sort((a, b) => a - b).slice(0, 3);
}

function ScanBox({ inputRef, onScan }: { inputRef: React.RefObject<HTMLInputElement | null>; onScan: (code: string) => Promise<void> }) {
  const t = usePosT();
  const [busy, setBusy] = useState(false);
  const onKeyDown = async (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key !== "Enter") return;
    event.preventDefault();
    const code = event.currentTarget.value;
    if (!code.trim() || busy) return;
    setBusy(true);
    try {
      await onScan(code);
      if (inputRef.current) inputRef.current.value = "";
    } finally {
      setBusy(false);
      inputRef.current?.focus();
    }
  };
  return (
    <TextField
      ref={inputRef}
      name="scan"
      label={t("sell.scan")}
      hint={t("sell.scanHint")}
      ltr
      autoFocus
      autoComplete="off"
      autoCapitalize="characters"
      spellCheck={false}
      enterKeyHint="search"
      aria-busy={busy || undefined}
      onKeyDown={onKeyDown}
    />
  );
}

function SearchBox({ shiftId, online, catalog, onPick }: { shiftId: string; online: boolean; catalog: CatalogSnapshot | null; onPick: (item: TillItem) => void }) {
  const t = usePosT();
  const [q, setQ] = useState("");
  const [items, setItems] = useState<TillItem[]>([]);
  const [state, setState] = useState<"idle" | "loading" | "failed">("idle");
  useEffect(() => {
    const text = latinDigits(q).trim();
    if (text.length < 2) {
      setItems([]);
      return;
    }
    if (!online) {
      const lower = text.toLowerCase();
      setItems((catalog?.items ?? []).filter((item) => item.name.toLowerCase().includes(lower) || item.sku.toLowerCase().includes(lower)).slice(0, 12));
      return;
    }
    let live = true;
    setState("loading");
    const timer = window.setTimeout(async () => {
      try {
        const { status, body } = await getJson<{ items: TillItem[] }>(`/admin/pos/api/search?shift=${encodeURIComponent(shiftId)}&q=${encodeURIComponent(text)}`);
        if (!live) return;
        setItems(status === 200 ? (body?.items ?? []) : []);
        setState(status === 200 ? "idle" : "failed");
      } catch {
        if (live) setState("failed");
      }
    }, 250);
    return () => {
      live = false;
      window.clearTimeout(timer);
    };
  }, [q, online, catalog, shiftId]);
  return (
    <div className="grid gap-2">
      <TextField name="q" type="search" label={t("sell.search")} hint={t("sell.searchHint")} autoComplete="off" value={q} onChange={(event) => setQ(event.target.value)} />
      {state === "failed" ? <p className="type-caption text-ink-2">{t("sell.searchFailed")}</p> : null}
      {items.length ? (
        <ul className="pos-results" aria-label={t("sell.results")}>
          {items.map((item) => (
            <li key={`${item.variantId}|${item.usedUnitId ?? ""}`}>
              <button type="button" className="pos-result" onClick={() => onPick(item)}>
                <span className="grid gap-0.5">
                  <span className="type-strong">{item.name}</span>
                  <span className="type-caption text-ink-2">
                    <Ref value={item.sku} /> · {t("sell.here", { count: item.stockHere })} · {t("sell.all", { count: item.stockAll })}
                  </span>
                </span>
                <Money iqd={item.unitPriceIqd} />
              </button>
            </li>
          ))}
        </ul>
      ) : q.trim().length >= 2 && state === "idle" ? (
        <p className="type-caption text-ink-2">{t("sell.noResults")}</p>
      ) : null}
    </div>
  );
}

function CartRow({ line, index, canDiscount, limitBps, onChange, onRemove, fieldError }: { line: CartLine; index: number; canDiscount: boolean; limitBps: number | null; onChange: (line: CartLine) => void; onRemove: () => void; fieldError: string | null }) {
  const t = usePosT();
  const f = useFormat();
  const [serialText, setSerialText] = useState("");
  const [discountText, setDiscountText] = useState(line.discountIqd ? String(line.discountIqd) : "");
  const gross = line.item.unitPriceIqd * line.qty;
  // A bundle may hold serial-tracked devices: its serials are asked for too (the server says when they are needed).
  const tracked = (line.item.trackSerials || line.item.bundle) && line.item.kind === "variant";
  const addSerial = () => {
    const value = latinDigits(serialText).trim();
    if (!value || line.serials.some((serial) => serial.toUpperCase() === value.toUpperCase())) {
      setSerialText("");
      return;
    }
    const serials = [...line.serials, value];
    onChange({ ...line, serials, qty: line.item.bundle ? line.qty : Math.max(line.qty, serials.length) });
    setSerialText("");
  };
  const setDiscount = (textValue: string) => {
    setDiscountText(textValue);
    const trimmed = textValue.trim();
    // A typo ("1.5", "abc", a negative number) is an error the till shows and that blocks the charge — never a silent 0.
    let value: number | null = 0;
    if (/[%٪]$/.test(trimmed)) {
      const bps = parsePercentBps(trimmed);
      value = bps === null ? 0 : Number.isNaN(bps) ? null : bpsShare(gross, bps);
    } else {
      const parsed = parseWhole(trimmed);
      value = parsed === null ? 0 : Number.isNaN(parsed) || parsed < 0 ? null : parsed;
    }
    onChange({ ...line, discountIqd: value === null ? 0 : Math.min(value, gross), discountInvalid: value === null || undefined });
  };
  const overLimit = limitBps !== null && line.discountIqd > bpsShare(gross, limitBps);
  return (
    <li className="pos-line">
      <div className="grid gap-0.5">
        <p className="pos-line__name">{line.item.name}</p>
        <p className="pos-line__meta">
          <Ref value={line.item.sku} />
          {line.item.kind === "used" ? ` · ${t("sell.used", { grade: line.item.grade ?? "" })}` : ""}
          {" · "}
          <Money iqd={line.item.unitPriceIqd} />
          {line.item.listCode ? (
            <>
              {" · "}
              {t("sell.listPrice", { code: line.item.listCode })} <s className="text-ink-2"><Money iqd={line.item.basePriceIqd} /></s>
            </>
          ) : null}
          {line.item.kind === "variant" ? ` · ${t("sell.here", { count: line.item.stockHere })}` : ""}
          {line.item.warrantyMonths ? ` · ${t("sell.warrantyMonths", { count: line.item.warrantyMonths })}` : line.item.warrantyDays ? ` · ${t("sell.warrantyDays", { count: line.item.warrantyDays })}` : ""}
        </p>
      </div>
      <p className="pos-line__total">
        <Money iqd={gross - line.discountIqd} />
        {line.discountIqd > 0 ? (
          <span className="block type-caption text-ink-2">
            <s>
              <Money iqd={gross} />
            </s>
          </span>
        ) : null}
      </p>
      <div className="pos-line__controls">
        {line.item.kind === "used" ? (
          <Status tone="info">{t("sell.oneUnit")}</Status>
        ) : (
          <Stepper size="sm" label={t("sell.qtyOf", { name: line.item.name })} value={line.qty} min={line.item.bundle ? 1 : Math.max(1, line.serials.length)} max={999} onChange={(qty) => onChange({ ...line, qty })} />
        )}
        {canDiscount ? <TextField className="w-36" label={t("sell.lineDiscount")} hideLabel={false} inputMode="text" autoComplete="off" value={discountText} onChange={(event) => setDiscount(event.target.value)} error={line.discountInvalid ? t("errors.invalid_amount") : overLimit ? t("errors.discount_over_limit") : undefined} /> : null}
        <IconKey icon="trash" label={t("sell.remove", { name: line.item.name })} size="sm" onClick={onRemove} />
      </div>
      {tracked ? (
        <div className="pos-serials">
          <TextField
            className="w-60"
            label={line.item.bundle ? t("sell.bundleSerials") : t("sell.serial", { count: Math.max(0, line.qty - line.serials.length) })}
            ltr
            autoComplete="off"
            value={serialText}
            onChange={(event) => setSerialText(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                event.preventDefault();
                addSerial();
              }
            }}
            error={fieldError ?? undefined}
          />
          {line.serials.map((serial) => (
            <Chip key={serial} onRemove={() => onChange({ ...line, serials: line.serials.filter((entry) => entry !== serial) })}>
              {serial}
            </Chip>
          ))}
        </div>
      ) : line.item.kind === "used" && line.item.serial ? (
        <div className="pos-serials">
          <span className="pos-tag">
            <Ref value={line.item.serial.serial} />
          </span>
        </div>
      ) : fieldError ? (
        <div className="pos-serials">
          <Failure message={fieldError} />
        </div>
      ) : null}
      <span className="sr-only">{f.number(index + 1)}</span>
    </li>
  );
}

function CustomerPanel({ customer, online, canLookup, onChange }: { customer: Customer | null; online: boolean; canLookup: boolean; onChange: (customer: Customer | null) => void }) {
  const t = usePosT();
  const f = useFormat();
  const [phone, setPhone] = useState(customer?.phone ?? "");
  const [name, setName] = useState(customer?.name ?? "");
  const [hit, setHit] = useState<CustomerHit | null | undefined>(undefined);
  const [state, setState] = useState<"idle" | "loading" | "failed" | "invalid">("idle");
  const lookup = async () => {
    setState("loading");
    try {
      const { status, body } = await getJson<{ customer?: CustomerHit | null; code?: string }>(`/admin/pos/api/customer?phone=${encodeURIComponent(phone)}`);
      if (status === 400) {
        setState("invalid");
        return;
      }
      if (status !== 200) {
        setState("failed");
        return;
      }
      setHit(body.customer ?? null);
      setState("idle");
    } catch {
      setState("failed");
    }
  };
  if (customer) {
    return (
      <section className="pos-panel" aria-labelledby="buyer-head">
        <div className="pos-bar">
          <h2 id="buyer-head" className="adm-h3">
            {t("buyer.head")}
          </h2>
          <Key size="sm" variant="quiet" icon="x" onClick={() => onChange(null)}>
            {t("buyer.remove")}
          </Key>
        </div>
        <p className="type-strong">{customer.name ?? t("buyer.noName")}</p>
        <p className="type-caption text-ink-2">
          <Ref value={customer.phoneMasked ?? customer.phone} /> · {customer.id ? t("buyer.account") : t("buyer.guest")}
          {customer.id && customer.walletIqd !== null ? ` · ${t("buyer.wallet", { amount: f.iqd(customer.walletIqd) })}` : ""}
        </p>
      </section>
    );
  }
  return (
    <section className="pos-panel" aria-labelledby="buyer-head">
      <h2 id="buyer-head" className="adm-h3">
        {t("buyer.head")}
      </h2>
      <p className="type-caption text-ink-2">{t("buyer.lead")}</p>
      <TextField label={t("buyer.phone")} type="tel" autoComplete="off" value={phone} onChange={(event) => { setPhone(event.target.value); setHit(undefined); }} error={state === "invalid" ? t("errors.phone_invalid") : undefined} />
      <div className="pos-actions">
        {online && canLookup ? (
          <Key size="sm" icon="magnifying-glass" loading={state === "loading"} disabled={phone.trim().length < 7} onClick={() => void lookup()}>
            {t("buyer.find")}
          </Key>
        ) : null}
        {hit === null || !online || !canLookup ? (
          <Key size="sm" icon="user" disabled={phone.trim().length < 7} onClick={() => onChange({ id: null, phone: phone.trim(), name: name.trim() || null, walletIqd: null, phoneMasked: null })}>
            {t("buyer.keepPhone")}
          </Key>
        ) : null}
      </div>
      {state === "failed" ? <p className="type-caption text-ink-2">{t("buyer.failed")}</p> : null}
      {hit === null ? (
        <>
          <p className="type-caption text-ink-2">{t("buyer.none")}</p>
          <TextField label={t("buyer.name")} optional value={name} onChange={(event) => setName(event.target.value)} />
        </>
      ) : null}
      {hit ? (
        <div className="pos-card">
          <p className="type-strong">{hit.name ?? t("buyer.noName")}</p>
          <p className="type-caption text-ink-2">
            <Ref value={hit.phoneMasked} />
            {typeof hit.walletIqd === "number" ? ` · ${t("buyer.wallet", { amount: f.iqd(hit.walletIqd) })}` : ""}
          </p>
          {hit.status !== "active" ? (
            <Failure message={t("errors.account_blocked")} />
          ) : (
            <div className="pos-actions">
              <Key size="sm" variant="ink" icon="check" onClick={() => onChange({ id: hit.id, phone: phone.trim(), name: hit.name, walletIqd: hit.walletIqd, phoneMasked: hit.phoneMasked })}>
                {t("buyer.use")}
              </Key>
            </div>
          )}
          <p className="type-caption text-ink-2">{t("buyer.confirmIdentity")}</p>
        </div>
      ) : null}
    </section>
  );
}

function SaleFailure({ failure }: { failure: Extract<SaleOutcome, { ok: false }> | null }) {
  const t = usePosT();
  if (!failure) return null;
  const text = failure.code === "price_changed" ? t("sell.priceChanged") : (failure.message ?? t(`errors.${failure.code}`));
  return <Failure message={text} />;
}

function LastSalePanel({ last, onPrint, canPrint, printing, printError }: { last: LastSale | null; onPrint: (ref: string) => void; canPrint: boolean; printing: boolean; printError: string | null }) {
  const t = usePosT();
  if (!last) return null;
  if (last.kind === "queued") {
    return (
      <section className="pos-panel" aria-live="polite">
        <Notice tone="warn" icon="wifi-slash">
          <p className="type-strong">{t("sell.queuedTitle")}</p>
          <p>{t("sell.queuedText")}</p>
        </Notice>
        <p className="type-body">
          {t("sell.total")} <Money iqd={last.totalIqd} />
          {last.changeIqd > 0 ? (
            <>
              {" · "}
              {t("sell.change")} <Money iqd={last.changeIqd} />
            </>
          ) : null}
        </p>
        <p className="type-caption text-ink-2">
          {t("sell.queuedKey")} <Ref value={last.key.slice(0, 8)} />
        </p>
      </section>
    );
  }
  return (
    <section className="pos-panel" aria-live="polite">
      <Notice tone="ok">
        <p className="type-strong">{t(last.replayed ? "sell.doneReplayed" : "sell.done", { ref: last.ref })}</p>
        <p>
          {t("sell.receiptNo")} <Ref value={last.number ?? "—"} /> · {t("sell.total")} <Money iqd={last.totalIqd} />
        </p>
        {last.changeIqd > 0 ? (
          <p className="type-strong">
            {t("sell.change")} <Money iqd={last.changeIqd} />
          </p>
        ) : null}
      </Notice>
      {canPrint ? (
        <div className="pos-actions">
          <Key icon="printer" variant="ink" loading={printing} onClick={() => onPrint(last.ref)}>
            {t("sell.print")}
          </Key>
          <Key as={Link} to={`/admin/pos/receipts/${last.ref}`} icon="receipt">
            {t("sell.openReceipt")}
          </Key>
        </div>
      ) : (
        <p className="type-caption text-ink-2">{t("sell.noReceiptRight")}</p>
      )}
      <Failure message={printError} />
    </section>
  );
}

// ───────────────────────────────────────────────────────────────── the device's queue

function QueuePanel({ queue, online, shiftId, access, onSynced }: { queue: QueuedSale[]; online: boolean; shiftId: string; access: Data["access"]; onSynced: (key: string, outcome: Extract<SaleOutcome, { ok: true }>) => void }) {
  const t = usePosT();
  const [syncing, setSyncing] = useState(false);
  // the latest callback without re-creating `sync` (which would re-run the reconnect effect on every render)
  const syncedRef = useRef(onSynced);
  syncedRef.current = onSynced;
  const [resolve, setResolve] = useState<{ sale: QueuedSale; mode: "accept_prices" | "oversell" | "discard" } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const sync = useCallback(
    async (only?: { key: string; extra?: Partial<SaleRequest> }) => {
      const list = readQueue().filter((entry) => (only ? entry.key === only.key : entry.status === "queued"));
      if (list.length === 0) return;
      setSyncing(true);
      try {
        const { status, body } = await postJson<{ results?: { key: string; outcome: SaleOutcome }[] }>("/admin/pos/api/sync", { sales: list.map((entry) => ({ ...entry.request, ...(only?.extra ?? {}) })) });
        if (status !== 200 || !body?.results) return;
        let done = 0;
        for (const result of body.results) {
          const entry = list.find((item) => item.key === result.key);
          if (!entry) continue;
          if (result.outcome.ok) {
            removeQueued(entry.key);
            syncedRef.current(entry.key, result.outcome);
            done += 1;
          } else updateQueued(entry.key, { status: "conflict", outcome: result.outcome, attempts: entry.attempts + 1, lastTriedAt: Date.now() });
        }
        if (done) toast.success(t("queue.synced", { count: done }));
      } catch {
        /* still offline */
      } finally {
        setSyncing(false);
      }
    },
    [t],
  );
  // Back online: send what waits (sales in conflict wait for a person).
  useEffect(() => {
    if (online && queue.some((entry) => entry.status === "queued")) void sync();
  }, [online, queue, sync]);
  if (queue.length === 0) return null;
  const mine = queue.filter((entry) => entry.shiftId === shiftId);
  return (
    <section className="pos-panel pos-noprint" aria-labelledby="queue-head">
      <div className="pos-bar">
        <h2 id="queue-head" className="adm-h3">
          {t("queue.head", { count: queue.length })}
        </h2>
        <Key size="sm" icon="arrows-clockwise" loading={syncing} disabled={!online || !queue.some((entry) => entry.status === "queued")} onClick={() => void sync()}>
          {t("queue.sync")}
        </Key>
      </div>
      <p className="type-caption text-ink-2">{t("queue.lead")}</p>
      {mine.length !== queue.length ? <p className="type-caption text-ink-2">{t("queue.otherShifts", { count: queue.length - mine.length })}</p> : null}
      <ul className="pos-queue">
        {queue.map((entry) => (
          <li key={entry.key} className="pos-queue__item">
            <div className="pos-card__row">
              <span className="type-strong">
                <Money iqd={entry.totalIqd} /> · {t("queue.lines", { count: entry.lines })}
              </span>
              <Status tone={entry.status === "conflict" ? "warn" : "info"}>{t(`queue.status.${entry.status}`)}</Status>
            </div>
            <p className="type-caption text-ink-2">
              <When at={entry.createdAt} /> · <Ref value={entry.key.slice(0, 8)} />
            </p>
            {entry.outcome ? <Failure message={entry.outcome.code === "price_changed" ? t("queue.priceChanged") : (entry.outcome.message ?? t(`errors.${entry.outcome.code}`))} /> : null}
            {entry.status === "conflict" ? (
              <div className="pos-actions">
                {online ? (
                  <Key size="sm" icon="arrows-clockwise" onClick={() => void sync({ key: entry.key })}>
                    {t("queue.retry")}
                  </Key>
                ) : null}
                {online && entry.outcome?.code === "price_changed" && access.override ? (
                  <Key size="sm" variant="ink" onClick={() => setResolve({ sale: entry, mode: "accept_prices" })}>
                    {t("queue.acceptPrices")}
                  </Key>
                ) : null}
                {online && entry.outcome?.code === "insufficient_stock" && access.oversell ? (
                  <Key size="sm" variant="ink" onClick={() => setResolve({ sale: entry, mode: "oversell" })}>
                    {t("queue.oversell")}
                  </Key>
                ) : null}
                {online && access.review ? (
                  <Key size="sm" icon="trash" onClick={() => setResolve({ sale: entry, mode: "discard" })}>
                    {t("queue.discard")}
                  </Key>
                ) : null}
              </div>
            ) : null}
            {entry.status === "conflict" && !access.review ? <p className="type-caption text-ink-2">{t("queue.discardSupervisor")}</p> : null}
          </li>
        ))}
      </ul>
      {resolve ? (
        <ConfirmDialog
          open
          onClose={() => {
            setResolve(null);
            setError(null);
          }}
          tone={resolve.mode === "discard" ? "destructive" : "neutral"}
          title={t(`queue.${resolve.mode}Q`)}
          consequence={t(`queue.${resolve.mode}What`)}
          confirmLabel={t(`queue.${resolve.mode === "accept_prices" ? "acceptPrices" : resolve.mode}`)}
          impact={[
            { label: t("queue.impactTotal"), value: <Money iqd={resolve.sale.totalIqd} /> },
            ...(resolve.mode === "discard"
              ? [
                  { label: t("queue.impactBooks"), value: t("queue.impactNothing"), negative: true },
                  { label: t("queue.impactDrawer"), value: t("queue.impactDrawerValue"), negative: true },
                ]
              : resolve.mode === "oversell"
                ? [{ label: t("queue.impactStock"), value: t("queue.impactOversold"), negative: true }]
                : [{ label: t("queue.impactPrices"), value: t("queue.impactCharged") }]),
          ]}
          reason={{ label: t("queue.reason"), hint: t("queue.reasonHint") }}
          pending={syncing}
          error={error}
          onConfirm={async ({ reason }) => {
            setError(null);
            if (resolve.mode === "discard") {
              try {
                const { status, body } = await postJson<{ ok?: boolean; code?: string; message?: string; fields?: Record<string, string> }>("/admin/pos/api/discard", { key: resolve.sale.key, reason, sale: resolve.sale.request });
                if (status !== 200) {
                  // A sale the server recorded already is not dropped: sending it answers with the sale.
                  setError(body?.fields?.reason ?? body?.message ?? t("queue.discardFailed"));
                  return;
                }
                removeQueued(resolve.sale.key);
                setResolve(null);
              } catch {
                setError(t("queue.discardFailed"));
              }
              return;
            }
            const extra: Partial<SaleRequest> = resolve.mode === "accept_prices" ? { acceptChargedPrices: true, overrideReason: reason } : { allowOversell: true, overrideReason: reason };
            updateQueued(resolve.sale.key, { request: { ...resolve.sale.request, ...extra } });
            await sync({ key: resolve.sale.key, extra });
            setResolve(null);
          }}
        />
      ) : null}
    </section>
  );
}
