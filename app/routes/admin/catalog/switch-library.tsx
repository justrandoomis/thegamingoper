import { useEffect, useMemo, useState } from "react";
import { Link, useNavigate, useSearchParams, type ShouldRevalidateFunctionArgs } from "react-router";

import type { Route } from "./+types/switch-library";
import { Icon } from "~/art/Icon";
import { messagesFor, serverT } from "~/i18n/i18n.server";
import { useFormat } from "~/i18n/react";
import { can } from "~/server/actor";
import { toCsv } from "~/server/services/admin/catalog/csv";
import { listLibraryRows, SWITCH_LIBRARY_MANAGE, type LibraryListRow } from "~/server/services/admin/switch-library.server";
import { DataTable, type DataColumn } from "~/ui/DataTable";
import { EmptyState } from "~/ui/EmptyState";
import { Select, TextField } from "~/ui/Field";
import { Key } from "~/ui/Key";
import { Pagination } from "~/ui/Pagination";
import { Status } from "~/ui/Tag";
import { adminMeta } from "../shell/meta";
import { catalogRequest } from "./catalog.server";
import { FilterFields, Thumb } from "./components/ui";
import { baghdadDay, formatSizeInput, formatUsdInput, isLibraryGameId, isoDayToEpoch, LIBRARY_CSV_MAX_ROWS, normalizeGameId, sizeLabel, usdLabel } from "./switch-library-input";
import { filterLibrary, filtersQuery, HIDDEN_FILTERS, LIBRARY_PAGE_SIZE, LIBRARY_SORTS, libraryItems, oneOf, PRICE_FILTERS, readFilters, SIZE_FILTERS, type LibraryFilters, type LibraryItem } from "./switch-library-list";
import { GameName, LIBRARY_PATH, libraryGamePath, useLibraryList, useLibraryT } from "./switch-library-ui";

/**
 * /admin/catalog/switch-library — the Switch bundle builder's game library (docs/switch-builder.md §7): every game of
 * the OPEN list (Wikidata, fetched on the client from the static file) merged with TamTam's rows (the loader), plus
 * rows for games that are not in the list. Search by title or id; filters for the size, the price and hidden games;
 * sorting; pages of 50. Filters live in the address (shareable, survive Back) without a request: they are applied in
 * the browser and written with history.replaceState. Reading needs catalog.product.read; the import, the export and
 * the sheet of the games shown need catalog.switch_library.manage.
 */
export async function loader({ context }: Route.LoaderArgs) {
  const { db, actor, locale, now } = await catalogRequest(context, "catalog.product.read");
  const rows = await listLibraryRows(db, actor);
  return {
    rows,
    today: baghdadDay(now),
    can: { manage: can(actor, SWITCH_LIBRARY_MANAGE) },
    title: serverT(locale, "admin-switch-library")("title"),
    i18n: messagesFor(locale, "admin-switch-library"),
  };
}

/** Filters and pages change in the browser only: the rows are the same. */
export function shouldRevalidate({ currentUrl, nextUrl, formMethod, defaultShouldRevalidate }: ShouldRevalidateFunctionArgs) {
  if (!formMethod && currentUrl.pathname === nextUrl.pathname && currentUrl.search !== nextUrl.search) return false;
  return defaultShouldRevalidate;
}

export const meta: Route.MetaFunction = (args) => adminMeta(args, args.loaderData?.title);

export default function SwitchLibraryList({ loaderData }: Route.ComponentProps) {
  const t = useLibraryT();
  const f = useFormat();
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const { rows, can: allowed, today } = loaderData;
  const { status, list, retry } = useLibraryList();

  const [filters, setFilters] = useState<LibraryFilters>(() => readFilters(params));
  const [query, setQuery] = useState(filters.q);
  // Typing filters after a short pause; the address follows without a request (see shouldRevalidate).
  useEffect(() => {
    const id = window.setTimeout(() => setFilters((current) => (current.q === query ? current : { ...current, q: query, page: 1 })), 150);
    return () => window.clearTimeout(id);
  }, [query]);
  useEffect(() => {
    const next = `${window.location.pathname}${filtersQuery(filters)}`;
    if (next !== `${window.location.pathname}${window.location.search}`) window.history.replaceState(window.history.state, "", next);
  }, [filters]);
  const change = (patch: Partial<LibraryFilters>) => setFilters((current) => ({ ...current, page: 1, ...patch }));

  const items = useMemo(() => libraryItems(list?.games ?? [], rows), [list, rows]);
  const shown = useMemo(() => filterLibrary(items, filters), [items, filters]);
  const pageCount = Math.max(1, Math.ceil(shown.length / LIBRARY_PAGE_SIZE));
  const page = Math.min(filters.page, pageCount);
  const pageItems = shown.slice((page - 1) * LIBRARY_PAGE_SIZE, page * LIBRARY_PAGE_SIZE);
  const filtered = Boolean(filters.q.trim() || filters.size || filters.price || filters.hidden);
  const counts = useMemo(
    () => ({
      games: items.length,
      sized: items.filter((item) => item.row?.sizeBytes != null).length,
      priced: items.filter((item) => item.row?.priceUsdCents != null).length,
      hidden: items.filter((item) => item.row?.hidden).length,
    }),
    [items],
  );
  const waiting = status === "loading";

  const columns: DataColumn<LibraryItem>[] = [
    {
      key: "game",
      header: t("list.colGame"),
      cell: (item) => (
        <span className="flex min-w-[16rem] items-center gap-3 py-1.5">
          <Thumb image={item.row?.image ? { artKey: null, mediaKey: item.row.image.key, alt: "", isIllustration: false, width: item.row.image.width ?? undefined, height: item.row.image.height ?? undefined } : null} size={40} />
          <span className="grid min-w-0 gap-0.5">
            <Link to={libraryGamePath(item.id)} className="adm-link">
              <GameName game={item.game} gameId={item.id} />
            </Link>
            <bdi dir="ltr" className="truncate type-caption text-ink-2">
              {item.id}
            </bdi>
          </span>
        </span>
      ),
    },
    { key: "year", header: t("list.colYear"), cell: (item) => (item.game?.year ? <bdi className="nums">{item.game.year}</bdi> : <span className="text-ink-2">—</span>) },
    {
      key: "size",
      header: t("list.colSize"),
      cell: (item) => <SizeCell row={item.row} />,
    },
    {
      key: "price",
      header: t("list.colPrice"),
      numeric: true,
      cell: (item) => (item.row?.priceUsdCents != null ? <bdi className="nums">{usdLabel(item.row.priceUsdCents)}</bdi> : <span className="type-caption text-ink-2">{t("list.noPrice")}</span>),
    },
    { key: "data", header: t("list.colData"), cell: (item) => <DataMarks row={item.row} /> },
    {
      key: "status",
      header: t("list.colStatus"),
      cell: (item) => (
        <span className="grid gap-0.5">
          {item.row?.hidden ? <Status tone="warn" className="whitespace-nowrap">{t("list.hidden")}</Status> : <Status tone="ok" className="whitespace-nowrap">{t("list.visible")}</Status>}
          {!item.game && status === "ready" ? <span className="type-caption text-ink-2 whitespace-nowrap">{t("list.notInList")}</span> : null}
        </span>
      ),
    },
    { key: "updated", header: t("list.colUpdated"), cell: (item) => (item.row ? <span className="whitespace-nowrap nums text-ink-2">{f.date(item.row.updatedAt, "short")}</span> : <span className="text-ink-2">—</span>) },
  ];

  const downloadSheet = () => {
    const records = shown.slice(0, LIBRARY_CSV_MAX_ROWS).map((item) => ({
      game_id: item.id,
      title: item.game?.title ?? "",
      year: item.game?.year ?? "",
      size_gb: item.row?.sizeBytes != null ? formatSizeInput(item.row.sizeBytes) : "",
      cartridge_gb: item.row?.cartridgeBytes != null ? formatSizeInput(item.row.cartridgeBytes) : "",
      size_as_of: item.row?.sizeAsOf ?? "",
      price_usd: item.row?.priceUsdCents != null ? formatUsdInput(item.row.priceUsdCents) : "",
      price_as_of: item.row?.priceAsOf ?? "",
      hidden: item.row ? (item.row.hidden ? "yes" : "no") : "",
    }));
    const csv = toCsv(["game_id", "title", "year", "size_gb", "cartridge_gb", "size_as_of", "price_usd", "price_as_of", "hidden"], records);
    const url = URL.createObjectURL(new Blob([csv], { type: "text/csv;charset=utf-8" }));
    const link = document.createElement("a");
    link.href = url;
    link.download = `tamtam-switch-sheet-${today}.csv`;
    document.body.appendChild(link);
    link.click();
    link.remove();
    window.setTimeout(() => URL.revokeObjectURL(url), 1000);
  };

  return (
    <>
      <header className="adm-page-head">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <h1 className="adm-title">{t("title")}</h1>
          {allowed.manage ? (
            <div className="flex flex-wrap gap-2">
              <Key as="a" href={`${LIBRARY_PATH}/export`} icon="download-simple" variant="quiet">
                {t("list.export")}
              </Key>
              <Key as={Link} to={`${LIBRARY_PATH}/import`} icon="upload-simple" variant="ink">
                {t("list.import")}
              </Key>
            </div>
          ) : null}
        </div>
        <p className="max-w-[75ch] type-body text-ink-2">{t("lead")}</p>
        <p className="flex flex-wrap gap-x-4 gap-y-1 type-caption text-ink-2">
          {status === "ready" ? (
            <span className="nums">{t("list.summary", { games: f.number(counts.games), sized: f.number(counts.sized), priced: f.number(counts.priced), hidden: f.number(counts.hidden) })}</span>
          ) : null}
          {list?.asOf ? <span>{t("list.asOf", { date: f.date(isoDayToEpoch(list.asOf.slice(0, 10)), "medium") })}</span> : null}
        </p>
      </header>

      {status === "missing" || status === "error" ? (
        <div className={status === "error" ? "adm-notice adm-notice--warn mb-4" : "adm-notice mb-4"} role={status === "error" ? "alert" : undefined}>
          <Icon name={status === "error" ? "warning-circle" : "info"} size={18} />
          <div className="grid gap-2">
            <p>{status === "error" ? t("list.failed") : t("list.missing")}</p>
            {status === "error" ? (
              <div>
                <Key size="sm" icon="arrows-clockwise" onClick={retry}>
                  {t("common.retry")}
                </Key>
              </div>
            ) : null}
          </div>
        </div>
      ) : null}

      <section className="adm-section" aria-label={t("list.searchLabel")}>
        <form
          role="search"
          className="grid items-start gap-3 lg:grid-cols-[minmax(0,2fr)_minmax(0,4fr)_auto]"
          onSubmit={(event) => {
            event.preventDefault();
            change({ q: query });
          }}
        >
          <TextField label={t("list.searchLabel")} hint={t("list.searchHint")} name="q" type="search" value={query} onChange={(event) => setQuery(event.currentTarget.value)} autoComplete="off" enterKeyHint="search" />
          {/* On a phone the four selects fold into "Filters (n)", so the games come first (the catalogue's own pattern). */}
          <FilterFields active={[filters.size, filters.price, filters.hidden].filter(Boolean).length + (filters.sort !== "popular" ? 1 : 0)}>
            <Select label={t("list.size")} name="size" value={filters.size} onChange={(event) => change({ size: oneOf(SIZE_FILTERS, event.currentTarget.value, "") })} options={SIZE_FILTERS.map((value) => ({ value, label: t(`list.sizeFilter.${value || "all"}`) }))} />
            <Select label={t("list.price")} name="price" value={filters.price} onChange={(event) => change({ price: oneOf(PRICE_FILTERS, event.currentTarget.value, "") })} options={PRICE_FILTERS.map((value) => ({ value, label: t(`list.priceFilter.${value || "all"}`) }))} />
            <Select label={t("list.visibility")} name="hidden" value={filters.hidden} onChange={(event) => change({ hidden: oneOf(HIDDEN_FILTERS, event.currentTarget.value, "") })} options={HIDDEN_FILTERS.map((value) => ({ value, label: t(`list.hiddenFilter.${value || "all"}`) }))} />
            <Select label={t("list.sort")} name="sort" value={filters.sort} onChange={(event) => change({ sort: oneOf(LIBRARY_SORTS, event.currentTarget.value, "popular") })} options={LIBRARY_SORTS.map((value) => ({ value, label: t(`list.sorts.${value}`) }))} />
          </FilterFields>
          {filtered ? (
            <div className="self-start lg:pt-6">
              <Key
                onClick={() => {
                  setQuery("");
                  setFilters((current) => ({ ...current, q: "", size: "", price: "", hidden: "", page: 1 }));
                }}
              >
                {t("list.clear")}
              </Key>
            </div>
          ) : null}
        </form>
      </section>

      <section className="adm-section" aria-labelledby="library-results">
        <div className="adm-section__head">
          <h2 id="library-results" className="adm-h2" aria-live="polite">
            {waiting ? t("list.loading") : t("list.shown", { count: shown.length })}
          </h2>
          {allowed.manage && shown.length > 0 && !waiting ? (
            <div className="grid justify-items-start gap-1 md:justify-items-end">
              <Key size="sm" icon="download-simple" onClick={downloadSheet}>
                {t("list.sheet")}
              </Key>
              <p className="max-w-[48ch] type-caption text-ink-2 md:text-end">{t("list.sheetHint", { max: f.number(LIBRARY_CSV_MAX_ROWS) })}</p>
            </div>
          ) : null}
        </div>

        {!waiting && shown.length === 0 ? (
          <EmptyState
            icon={filtered ? "magnifying-glass" : "game-controller"}
            title={filtered ? t("list.emptyTitle") : t("list.emptyAll")}
            text={filtered ? t("list.emptyText") : undefined}
            action={
              filtered ? (
                <Key
                  onClick={() => {
                    setQuery("");
                    setFilters((current) => ({ ...current, q: "", size: "", price: "", hidden: "", page: 1 }));
                  }}
                >
                  {t("list.clear")}
                </Key>
              ) : undefined
            }
          />
        ) : (
          <>
            <div className="hidden md:block">
              <DataTable
                caption={t("list.caption")}
                columns={columns}
                rows={pageItems}
                rowKey={(item) => item.id}
                rowLabel={(item) => item.game?.title ?? item.id}
                status={waiting && pageItems.length === 0 ? "loading" : "ready"}
                busy={waiting}
                footer={pageCount > 1 ? <Pagination page={page} pageCount={pageCount} onPage={(next) => setFilters((current) => ({ ...current, page: next }))} /> : undefined}
              />
            </div>
            <ul role="list" className="grid gap-2 md:hidden" aria-busy={waiting || undefined}>
              {pageItems.map((item) => (
                <li key={item.id}>
                  <Link to={libraryGamePath(item.id)} className="adm-card flex items-center gap-3 no-underline">
                    <Thumb image={item.row?.image ? { artKey: null, mediaKey: item.row.image.key, alt: "", isIllustration: false } : null} size={56} />
                    <span className="grid min-w-0 flex-1 gap-1">
                      <span className="type-strong text-ink">
                        <GameName game={item.game} gameId={item.id} />
                      </span>
                      <span className="flex flex-wrap items-center gap-x-3 gap-y-1 type-caption">
                        <SizeCell row={item.row} />
                        {item.row?.priceUsdCents != null ? <bdi className="nums text-ink">{usdLabel(item.row.priceUsdCents)}</bdi> : null}
                        {item.row?.hidden ? <Status tone="warn">{t("list.hidden")}</Status> : null}
                      </span>
                    </span>
                    <Icon name="caret-right" size={18} className="text-ink-3" />
                  </Link>
                </li>
              ))}
            </ul>
            {pageCount > 1 ? (
              <div className="md:hidden">
                <Pagination page={page} pageCount={pageCount} onPage={(next) => setFilters((current) => ({ ...current, page: next }))} />
              </div>
            ) : null}
          </>
        )}
        <p className="type-caption text-ink-2">{t("list.attribution")}</p>
      </section>

      <OpenById onOpen={(id) => navigate(libraryGamePath(id))} />
    </>
  );
}

/** The digital size (and the cartridge figure under it), or "size not added yet". */
function SizeCell({ row }: { row: LibraryListRow | null }) {
  const t = useLibraryT();
  if (row?.sizeBytes == null && row?.cartridgeBytes == null) return <span className="type-caption text-ink-2 whitespace-nowrap">{t("list.noSize")}</span>;
  return (
    <span className="grid gap-0.5 whitespace-nowrap">
      {row.sizeBytes != null ? <bdi className="nums text-ink">{sizeLabel(row.sizeBytes)}</bdi> : <span className="type-caption text-ink-2">{t("list.noSize")}</span>}
      {row.cartridgeBytes != null ? <bdi className="type-caption nums text-ink-2">{t("list.cartridge", { size: sizeLabel(row.cartridgeBytes) })}</bdi> : null}
    </span>
  );
}

/** Which of TamTam's extras the game has: words with icons, never icons alone. */
function DataMarks({ row }: { row: LibraryListRow | null }) {
  const t = useLibraryT();
  if (!row) return <span className="text-ink-2">—</span>;
  const marks = [
    row.hasTrailer ? { icon: "monitor" as const, label: t("list.trailer") } : null,
    row.image ? { icon: "image" as const, label: t("list.picture") } : null,
    row.descriptionLangs.length > 0 ? { icon: "translate" as const, label: `${t("list.description")} (${row.descriptionLangs.join(", ")})` } : null,
    row.hasMetacritic ? { icon: "star" as const, label: t("list.metacritic") } : null,
  ].filter((mark): mark is { icon: "monitor" | "image" | "translate" | "star"; label: string } => mark !== null);
  if (marks.length === 0) return <span className="text-ink-2">—</span>;
  return (
    <ul className="flex flex-wrap gap-x-3 gap-y-0.5 type-caption text-ink-2">
      {marks.map((mark) => (
        <li key={mark.icon} className="inline-flex items-center gap-1 whitespace-nowrap">
          <Icon name={mark.icon} size={14} />
          <bdi>{mark.label}</bdi>
        </li>
      ))}
    </ul>
  );
}

/** Opens a game by its id — for a game the open list does not have yet. */
function OpenById({ onOpen }: { onOpen: (id: string) => void }) {
  const t = useLibraryT();
  const [value, setValue] = useState("");
  const [error, setError] = useState<string | null>(null);
  return (
    <section className="adm-section" aria-labelledby="library-open-id">
      <h2 id="library-open-id" className="adm-h3">
        {t("list.openId")}
      </h2>
      <form
        className="grid gap-1"
        onSubmit={(event) => {
          event.preventDefault();
          const id = normalizeGameId(value);
          if (!isLibraryGameId(id)) {
            setError(t("errors.id_invalid"));
            return;
          }
          setError(null);
          onOpen(id);
        }}
      >
        <div className="flex flex-wrap items-end gap-3">
          <TextField label={t("list.openIdLabel")} name="gameId" value={value} onChange={(event) => setValue(event.currentTarget.value)} error={error ?? undefined} aria-describedby="library-open-id-hint" ltr autoComplete="off" spellCheck={false} className="min-w-[16rem] flex-1 md:max-w-md" />
          <Key type="submit" icon="arrow-square-out">
            {t("list.openKey")}
          </Key>
        </div>
        <p id="library-open-id-hint" className="type-caption text-ink-2">
          {t("list.openIdHint")}
        </p>
      </form>
    </section>
  );
}
