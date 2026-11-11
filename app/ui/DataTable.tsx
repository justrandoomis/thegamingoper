import { useEffect, useLayoutEffect, useRef, type ReactNode } from "react";

import { Icon, type IconName } from "~/art/Icon";
import { useT } from "~/i18n/react";
import { getMotionTier, springTiming } from "~/motion";
import { cx } from "./cx";
import { ErrorState } from "./ErrorState";
import { Glass } from "./Glass";
import { Key } from "./Key";
import { HrefLink } from "./Pagination";
import { VisuallyHidden } from "./VisuallyHidden";

/**
 * DataTable — the dense admin table (DESIGN.md §10, app/styles/admin.css `.table`): flat paper, hairlines, a sticky
 * solid header, numbers tabular and at the inline end, no clay, no glass, no shadow — except the bulk-action bar,
 * which is live glass because rows scroll under it.
 *
 * Controlled only: sort, page and selection belong to the caller, normally in the URL (filters and sorting are
 * shareable and survive Back). The table renders and reports; it never sorts, filters or fetches.
 *
 *   const columns: DataColumn<OrderRow>[] = [
 *     { key: "ref", header: t("order"), cell: (o) => <HrefLink to={`/admin/orders/${o.ref}`}>{o.ref}</HrefLink> },
 *     { key: "status", header: t("status"), cell: (o) => <Status tone={…}>{…}</Status> },
 *     { key: "total", header: t("totalIqd"), numeric: true, sortable: true, firstDir: "desc", cell: (o) => f.number(o.totalIqd),
 *       negative: (o) => o.totalIqd < 0 },
 *   ];
 *   <DataTable caption={t("orders")} columns={columns} rows={page.items} rowKey={(o) => o.id} rowLabel={(o) => o.ref}
 *              sort={sort} sortHref={(next) => withSearch({ sort: next.key, dir: next.dir })}
 *              selected={ids} onSelectedChange={setIds}
 *              bulkActions={(ids) => <Key size="sm" onClick={() => printLabels(ids)}>{t("printLabels")}</Key>}
 *              status={navigation.state === "loading" && !page ? "loading" : "ready"} busy={navigation.state === "loading"}
 *              footer={<Pagination page={n} pageCount={pages} href={(p) => withSearch({ page: p })} />} />
 *
 * - Sorting: sortable headers are links (`sortHref`, URL state) or buttons (`onSort`); `aria-sort` on the sorted one.
 * - Selection: a checkbox per row ("اختر TT-7K4M…") and one for the page (with the mixed state); Shift-click selects a
 *   range. Selected rows are `aria-selected` (niche fill, an ink bar at the start). The count is announced politely.
 *   With rows selected, a glass bar rises from the bottom of the table region: the count, your keys (at most one
 *   commit key; destructive bulk actions open a reason-code ConfirmDialog), "ألغِ التحديد". It never covers the last
 *   row: it takes its own space under the table.
 * - Small screens: the table scrolls sideways inside its region (a tab stop, so keys scroll it too) with the first
 *   column (and the checkboxes) pinned; the header stays on top while the rows scroll (`maxHeight`).
 * - States: `status="loading"` (no rows yet: one row says so), `"error"` (an ErrorState in the table — pass `error`
 *   with a retry), no rows (`empty`, default "لا توجد صفوف في هذا العرض."), `busy` (rows shown, a newer page loading:
 *   dimmed, `aria-busy`, nothing moves).
 * - Density: `data-density="admin"` (36px rows, compact type and keys) unless `density="inherit"`.
 * Protected columns (cost, margin) must be left out of `columns` AND the loader for actors without the permission —
 * never rendered empty (CONTRACTS §4).
 */
export type SortDir = "asc" | "desc";
export type DataSort = { key: string; dir: SortDir };

export type DataColumn<Row> = {
  key: string;
  header: ReactNode;
  cell: (row: Row, index: number) => ReactNode;
  /** Tabular, at the inline end, isolated (<bdi>). Put the unit in the header ("المبلغ (د.ع)"). */
  numeric?: boolean;
  /** Red-ink text and a minus sign come from you; this marks the cell (refunds, debits). */
  negative?: (row: Row) => boolean;
  sortable?: boolean;
  /** Direction when the column first becomes the sort. Default "asc"; "desc" suits dates and amounts. */
  firstDir?: SortDir;
  /** Inline size of the column ("8rem", "20%"). */
  width?: string;
  className?: string;
};

export type DataTableProps<Row> = {
  /** Names the table (a visually hidden <caption>) and its scroll region. */
  caption: string;
  columns: readonly DataColumn<Row>[];
  rows: readonly Row[];
  rowKey: (row: Row) => string;
  /** How a row is named in "اختر {label}" (default: its key). */
  rowLabel?: (row: Row) => string;
  sort?: DataSort | null;
  /** Sortable headers as links: the URL for a sort. */
  sortHref?: (sort: DataSort) => string;
  /** …or as buttons. */
  onSort?: (sort: DataSort) => void;
  /** Row keys that are selected. With `onSelectedChange` it turns selection on. */
  selected?: readonly string[];
  onSelectedChange?: (ids: string[]) => void;
  /** The keys of the bulk-action bar, for the selected ids. */
  bulkActions?: (ids: readonly string[]) => ReactNode;
  status?: "ready" | "loading" | "error";
  /** Rows are shown but a newer version is loading. */
  busy?: boolean;
  /** Shown in place of rows when there are none. */
  empty?: ReactNode;
  /** Shown when status is "error" (an <ErrorState onRetry …/>). */
  error?: ReactNode;
  /** Under the table: pagination, totals. */
  footer?: ReactNode;
  /** Height of the scroll region, so the header sticks while rows scroll. Default "min(70dvh, 720px)"; null = none. */
  maxHeight?: string | null;
  /** Pin the first column while the table scrolls sideways. Default true. */
  pinFirst?: boolean;
  density?: "admin" | "inherit";
  className?: string;
};

/* ───────────────────────────── selection (pure; tests/ui-overlays.test.ts) ───────────────────────────── */

/** "all" | "some" | "none" of this page's rows are selected (for the page checkbox). */
export function pageSelection(selected: readonly string[], pageIds: readonly string[]): "all" | "some" | "none" {
  if (pageIds.length === 0) return "none";
  const chosen = new Set(selected);
  const hits = pageIds.filter((id) => chosen.has(id)).length;
  return hits === 0 ? "none" : hits === pageIds.length ? "all" : "some";
}

/** Select or clear one id (order kept; a new id goes last). */
export function toggleOne(selected: readonly string[], id: string, on: boolean): string[] {
  const without = selected.filter((item) => item !== id);
  return on ? [...without, id] : without;
}

/** Shift-click: set every id between `from` and `to` (inclusive, in page order) to `on`. */
export function toggleRange(selected: readonly string[], pageIds: readonly string[], from: string, to: string, on: boolean): string[] {
  const a = pageIds.indexOf(from);
  const b = pageIds.indexOf(to);
  if (a === -1 || b === -1) return toggleOne(selected, to, on);
  const span = new Set(pageIds.slice(Math.min(a, b), Math.max(a, b) + 1));
  const kept = selected.filter((id) => !span.has(id));
  return on ? [...kept, ...pageIds.filter((id) => span.has(id))] : kept;
}

/** The page checkbox: every row of the page selected → clear them; otherwise select them all. Other pages untouched. */
export function toggleAllOnPage(selected: readonly string[], pageIds: readonly string[]): string[] {
  const page = new Set(pageIds);
  const kept = selected.filter((id) => !page.has(id));
  return pageSelection(selected, pageIds) === "all" ? kept : [...kept, ...pageIds];
}

/* ───────────────────────────── the table ───────────────────────────── */

// Pinned cells need an opaque background; utilities outrank admin.css, so hover and selection are repeated here.
const PINNED_TD = "sticky z-[1] bg-paper group-hover:bg-niche group-aria-selected:bg-niche";
const PINNED_TH = "sticky z-[calc(var(--z-sticky)+1)]";

export function DataTable<Row>({
  caption,
  columns,
  rows,
  rowKey,
  rowLabel,
  sort,
  sortHref,
  onSort,
  selected,
  onSelectedChange,
  bulkActions,
  status = "ready",
  busy = false,
  empty,
  error,
  footer,
  maxHeight = "min(70dvh, 720px)",
  pinFirst = true,
  density = "admin",
  className,
}: DataTableProps<Row>) {
  const t = useT("ui-overlays");
  const selectable = selected !== undefined && onSelectedChange !== undefined;
  const chosen = selected ?? [];
  const ids = rows.map(rowKey);
  const chosenSet = new Set(chosen);
  const page = pageSelection(chosen, ids);
  const anchor = useRef<string | null>(null);
  const shift = useRef(false);
  const span = columns.length + (selectable ? 1 : 0);
  const showRows = status === "ready" && rows.length > 0;

  const choose = (id: string, on: boolean) => {
    if (!onSelectedChange) return;
    const from = anchor.current;
    onSelectedChange(shift.current && from !== null && from !== id ? toggleRange(chosen, ids, from, id, on) : toggleOne(chosen, id, on));
    anchor.current = id;
    shift.current = false;
  };

  return (
    <div className={cx("grid min-w-0 gap-3", className)} data-density={density === "admin" ? "admin" : undefined}>
      {/* The selection count, announced politely (present from the start so the first change is heard). */}
      <p className="sr-only" role="status" aria-live="polite">
        {selectable && chosen.length > 0 ? t("table.selected", { count: chosen.length }) : ""}
      </p>
      <div
        role="region"
        aria-label={caption}
        tabIndex={0}
        className="scroll-thin relative min-w-0 overflow-auto rounded-sm border border-line"
        style={maxHeight ? { maxBlockSize: maxHeight } : undefined}
      >
        <table className="table" aria-busy={status === "loading" || busy || undefined}>
          <caption className="sr-only">{caption}</caption>
          <thead>
            <tr>
              {selectable ? (
                <th scope="col" className={cx("w-11 min-w-11 px-0", PINNED_TH, "start-0")}>
                  <SelectBox
                    label={t("table.selectAll")}
                    checked={page === "all"}
                    indeterminate={page === "some"}
                    disabled={!showRows}
                    onChange={() => onSelectedChange?.(toggleAllOnPage(chosen, ids))}
                  />
                </th>
              ) : null}
              {columns.map((column, index) => {
                const active = sort?.key === column.key ? sort.dir : null;
                const pinned = pinFirst && index === 0;
                return (
                  <th
                    key={column.key}
                    scope="col"
                    aria-sort={active ? (active === "asc" ? "ascending" : "descending") : undefined}
                    className={cx(
                      column.numeric && "is-num",
                      pinned && PINNED_TH,
                      pinned && (selectable ? "start-11" : "start-0"),
                      pinned && "border-e border-line",
                      column.className,
                    )}
                    style={column.width ? { inlineSize: column.width } : undefined}
                  >
                    {column.sortable && (sortHref || onSort) ? <SortControl column={column} active={active} sortHref={sortHref} onSort={onSort} /> : column.header}
                  </th>
                );
              })}
            </tr>
          </thead>
          <tbody className={cx("transition-opacity duration-(--t-micro)", busy && status === "ready" && "opacity-60")}>
            {status === "loading" ? (
              <tr>
                <td colSpan={span} className="h-auto py-8">
                  <p className="flex items-center justify-center gap-2 text-ink-2">
                    <Icon name="circle-notch" size={18} className="animate-spin motion-reduce:animate-none [[data-motion=reduced]_&]:animate-none" />
                    {t("table.loading")}
                  </p>
                </td>
              </tr>
            ) : status === "error" ? (
              <tr>
                <td colSpan={span} className="h-auto p-3">
                  {error ?? <ErrorState />}
                </td>
              </tr>
            ) : rows.length === 0 ? (
              <tr>
                <td colSpan={span} className="h-auto p-3">
                  {empty ?? <p className="py-6 text-center text-ink-2">{t("table.empty")}</p>}
                </td>
              </tr>
            ) : (
              rows.map((row, rowIndex) => {
                const id = ids[rowIndex];
                const isSelected = chosenSet.has(id);
                return (
                  <tr key={id} className="group" aria-selected={selectable ? isSelected : undefined}>
                    {selectable ? (
                      <td className={cx("w-11 min-w-11 px-0", PINNED_TD, "start-0")}>
                        <SelectBox
                          label={t("table.selectRow", { label: rowLabel ? rowLabel(row) : id })}
                          checked={isSelected}
                          onShift={(value) => {
                            shift.current = value;
                          }}
                          onChange={(on) => choose(id, on)}
                        />
                      </td>
                    ) : null}
                    {columns.map((column, index) => {
                      const pinned = pinFirst && index === 0;
                      const content = column.cell(row, rowIndex);
                      return (
                        <td
                          key={column.key}
                          className={cx(
                            column.numeric && "is-num",
                            column.negative?.(row) && "is-negative",
                            pinned && PINNED_TD,
                            pinned && (selectable ? "start-11" : "start-0"),
                            pinned && "border-e border-line",
                            column.className,
                          )}
                        >
                          {column.numeric ? <bdi>{content}</bdi> : content}
                        </td>
                      );
                    })}
                  </tr>
                );
              })
            )}
          </tbody>
        </table>
        {selectable && chosen.length > 0 && showRows ? (
          <BulkBar count={chosen.length} onClear={() => onSelectedChange?.([])}>
            {bulkActions?.(chosen)}
          </BulkBar>
        ) : null}
      </div>
      {footer}
    </div>
  );
}

function SortControl<Row>({
  column,
  active,
  sortHref,
  onSort,
}: {
  column: DataColumn<Row>;
  active: SortDir | null;
  sortHref?: (sort: DataSort) => string;
  onSort?: (sort: DataSort) => void;
}) {
  const t = useT("ui-overlays");
  const next: SortDir = active ? (active === "asc" ? "desc" : "asc") : (column.firstDir ?? "asc");
  const icon: IconName = active === "asc" ? "caret-up" : active === "desc" ? "caret-down" : "caret-up-down";
  const inner = (
    <>
      <span>{column.header}</span>
      <Icon name={icon} size={14} className={active ? "text-ink" : "text-ink-3"} />
      <VisuallyHidden>{` ${t(next === "asc" ? "table.sortAsc" : "table.sortDesc")}`}</VisuallyHidden>
    </>
  );
  const className = cx("inline-flex min-h-9 items-center gap-1 rounded-xs hover:text-ink", active && "text-ink");
  return sortHref ? (
    <HrefLink to={sortHref({ key: column.key, dir: next })} className={className}>
      {inner}
    </HrefLink>
  ) : (
    <button type="button" className={className} onClick={() => onSort?.({ key: column.key, dir: next })}>
      {inner}
    </button>
  );
}

/** A compact checkbox for a cell: the design system's box (`.choice__box`) on a native input that fills the cell. */
function SelectBox({
  label,
  checked,
  indeterminate = false,
  disabled = false,
  onChange,
  onShift,
}: {
  label: string;
  checked: boolean;
  indeterminate?: boolean;
  disabled?: boolean;
  onChange: (on: boolean) => void;
  onShift?: (shift: boolean) => void;
}) {
  const input = useRef<HTMLInputElement | null>(null);
  useEffect(() => {
    if (input.current) input.current.indeterminate = indeterminate;
  }, [indeterminate]);
  return (
    <label className="choice min-h-9 items-center justify-center py-0">
      <input
        ref={input}
        type="checkbox"
        className="choice__input"
        aria-label={label}
        checked={checked}
        disabled={disabled}
        onClick={(event) => onShift?.(event.shiftKey)}
        onChange={(event) => onChange(event.currentTarget.checked)}
      />
      <span className="choice__box mt-0" aria-hidden="true">
        <Icon name={indeterminate ? "minus" : "check"} size={16} />
      </span>
    </label>
  );
}

/** Rises from the bottom of the table region (glass slides; reduced motion fades) and stays there while rows scroll. */
function BulkBar({ count, onClear, children }: { count: number; onClear: () => void; children: ReactNode }) {
  const t = useT("ui-overlays");
  const bar = useRef<HTMLDivElement | null>(null);
  useLayoutEffect(() => {
    const element = bar.current;
    if (!element || typeof element.animate !== "function") return;
    if (getMotionTier() === "reduced") {
      element.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 120, easing: "linear" });
      return;
    }
    element.animate([{ opacity: 0, translate: "0 12px" }, { opacity: 1, translate: "0 0" }], springTiming("sheet"));
  }, []);
  return (
    <Glass
      ref={bar}
      role="group"
      aria-label={t("table.bulk")}
      className="sticky bottom-2 start-2 z-[calc(var(--z-sticky)+2)] m-2 flex flex-wrap items-center gap-2 rounded-md p-2 ps-4"
    >
      <p className="type-data text-ink" aria-hidden="true">
        <bdi className="nums">{t("table.selected", { count })}</bdi>
      </p>
      <div className="ms-auto flex flex-wrap items-center gap-2">
        {children}
        <Key size="sm" onClick={onClear}>
          {t("table.clear")}
        </Key>
      </div>
    </Glass>
  );
}
