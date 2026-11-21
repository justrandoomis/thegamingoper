/**
 * The planner's STORAGE FIGURES at the foot of /admin/catalog/switch-library (#storage; the settings page links here):
 * usable console memory per model and what is kept free in it, the usable share of a memory card and what is kept
 * free on it for updates — with a live preview of the space they give per card size (capacityOf), what the empty card
 * shows next to the staff's own reading, and who changed them last. Rules: switch-library-capacity.ts. The save: the
 * route's action (intent=capacity) → saveCapacityFigures → setSetting, guarded by the value this form showed
 * (`expected`), with the reason written to the audit log. Readers without the setting's permission see the figures
 * read-only.
 */
import { useMemo, useState, type FormEvent, type ReactNode } from "react";
import { Link, useFetcher, useRevalidator } from "react-router";

import { Icon } from "~/art/Icon";
import { useFormat } from "~/i18n/react";
import { toGiB } from "~/lib/switch-builder/storage";
import { SWITCH_MODELS, type CapacityConfig, type SwitchModel } from "~/lib/switch-builder/types";
import { TextField } from "~/ui/Field";
import { Key } from "~/ui/Key";
import {
  CAPACITY_FIELD,
  CAPACITY_FIELDS,
  CAPACITY_REASON_MAX,
  CAPACITY_REASON_MIN,
  CAPACITY_SETTING_KEY,
  capacityBoundText,
  capacityDraft,
  capacityKeyOfName,
  capacityPreview,
  cardLabel,
  readCapacityDraft,
  sameCapacity,
  type CapacityDraft,
  type CapacityField,
  type CapacityFieldKey,
  type CapacityFigures,
} from "./switch-library-capacity";
import { LibraryFailure, isLibraryFailure, useLibraryErrors, useLibraryT, useLibraryToast } from "./switch-library-ui";

/** The section's id: the page header's link and the settings page jump here. */
export const STORAGE_SECTION_ID = "storage";

/** What the route's action answers for intent=capacity (field errors as keys, by input name). */
type CapacityAnswer = { ok: true; intent: "capacity"; changed: boolean } | { ok: false; intent?: string; code: string; fields?: Record<string, string> };

const MODEL_FIELD: Record<SwitchModel, CapacityFieldKey> = { "switch-oled": "oled", switch: "switch", "switch-lite": "lite" };

/** The form starts again from the stored figures whenever they change (a save, or loading a colleague's). */
const formVersion = (figures: CapacityFigures) => JSON.stringify([figures.inUse, figures.expected, figures.updatedAt]);

/** An error key as the sentence for this figure: its bounds in the words, else this namespace's, else the catalogue's. */
function useFigureError() {
  const t = useLibraryT();
  const sentence = useLibraryErrors();
  return (field: CapacityField | null, key: string): string => {
    if (field && key === "too_small") return t("storage.errors.too_small", { min: capacityBoundText(field, field.min) });
    if (field && key === "too_big") return t("storage.errors.too_big", { max: capacityBoundText(field, field.max) });
    const own = t(`storage.errors.${key}`);
    return own !== `storage.errors.${key}` ? own : sentence(key);
  };
}

export function StorageFigures({ figures }: { figures: CapacityFigures }) {
  const t = useLibraryT();
  const f = useFormat();
  return (
    <section id={STORAGE_SECTION_ID} className="adm-section" aria-labelledby="library-storage">
      <div className="grid gap-1">
        <h2 id="library-storage" className="adm-h2">
          {t("storage.title")}
        </h2>
        <p className="max-w-[75ch] type-body text-ink-2">{t("storage.lead")}</p>
        <p className="flex flex-wrap items-center gap-x-4 gap-y-1 type-caption text-ink-2">
          {figures.updatedAt ? (
            <span>{figures.updatedByName ? t("storage.lastChanged", { time: f.dateTime(figures.updatedAt), name: figures.updatedByName }) : t("storage.lastChangedAt", { time: f.dateTime(figures.updatedAt) })}</span>
          ) : null}
          {figures.isDefault ? <span>{t("storage.defaultsInUse")}</span> : null}
          {figures.canSeeHistory ? (
            <Link to={`/admin/settings/keys/${encodeURIComponent(CAPACITY_SETTING_KEY)}`} className="adm-link">
              {t("storage.history")}
            </Link>
          ) : null}
        </p>
      </div>
      {figures.broken !== null ? (
        <p className="adm-notice adm-notice--warn" role="status">
          <Icon name="warning" size={18} />
          <span>{t("storage.broken")}</span>
        </p>
      ) : null}
      {!figures.canEdit ? (
        <p className="adm-notice">
          <Icon name="info" size={18} />
          <span>{t("storage.readOnly")}</span>
        </p>
      ) : null}
      <CapacityForm key={formVersion(figures)} figures={figures} />
    </section>
  );
}

function CapacityForm({ figures }: { figures: CapacityFigures }) {
  const t = useLibraryT();
  const figureError = useFigureError();
  const revalidator = useRevalidator();
  const fetcher = useFetcher<CapacityAnswer>({ key: "switch-library-capacity" });
  useLibraryToast(fetcher, (data) => (data.changed ? t("storage.saved") : t("common.unchanged")));

  const initial = useMemo(() => capacityDraft(figures.inUse), [figures.inUse]);
  const [draft, setDraft] = useState<CapacityDraft>(initial);
  const [reason, setReason] = useState("");
  /** Fields whose own error shows: left once, or every field after a send was stopped. */
  const [shown, setShown] = useState<ReadonlySet<string>>(() => new Set());
  /** What the last send carried: a server error stays under a field only while it still holds that text. */
  const [sent, setSent] = useState<Record<string, string> | null>(null);

  const read = readCapacityDraft(draft, figures.inUse);
  const reasonProblem = reason.trim().length < CAPACITY_REASON_MIN ? "reason_required" : undefined;
  const editable = figures.canEdit;
  const edited = CAPACITY_FIELDS.some((field) => draft[field.key] !== initial[field.key]);
  // a stored value that no longer fits is replaced even by the figures in use
  const changed = figures.broken !== null || Object.keys(read.errors).length > 0 || !sameCapacity(read.value, figures.inUse);
  // the keyed fetcher keeps its last answer across a remount: only an answer to THIS form's send is shown
  const failure = sent && isLibraryFailure(fetcher.data) ? fetcher.data : null;
  const serverKey = (name: string, current: string) => (failure?.fields && sent?.[name] === current ? failure.fields[name] : undefined);

  const errorOf = (field: CapacityField): string | undefined => {
    const key = (shown.has(field.key) ? read.errors[field.key] : undefined) ?? serverKey(field.name, draft[field.key]);
    return key ? figureError(field, key) : undefined;
  };
  const reasonKey = (shown.has("reason") ? reasonProblem : undefined) ?? serverKey("reason", reason);
  const reasonError = reasonKey ? figureError(null, reasonKey) : undefined;
  // "check the marked fields" only while one still is (a name the form has no field for counts as marked)
  const marked = Object.keys(failure?.fields ?? {}).some((name) => {
    if (name === "reason") return serverKey(name, reason) !== undefined;
    const key = capacityKeyOfName(name);
    return key ? serverKey(name, draft[key]) !== undefined : true;
  });

  const onSubmit = (event: FormEvent<HTMLFormElement>) => {
    if (!editable) {
      event.preventDefault();
      return;
    }
    const problems = CAPACITY_FIELDS.filter((field) => read.errors[field.key]).map((field) => field.name);
    if (reasonProblem) problems.push("reason");
    if (problems.length > 0) {
      event.preventDefault();
      setShown(new Set([...CAPACITY_FIELDS.map((field) => field.key), "reason"]));
      const first = event.currentTarget.elements.namedItem(problems[0]);
      if (first instanceof HTMLElement) first.focus();
      return;
    }
    setSent({ ...Object.fromEntries(CAPACITY_FIELDS.map((field) => [field.name, draft[field.key]])), reason });
  };

  const figure = (key: CapacityFieldKey, label: string, describedBy?: string, className?: string) => {
    const field = CAPACITY_FIELD[key];
    const unit = field.unit === "percent" ? "%" : "GB";
    return (
      <TextField
        key={key}
        className={className}
        name={field.name}
        // the unit inside the field is drawn only: the label says it to screen readers
        label={
          <>
            {label}
            <span className="sr-only"> ({unit})</span>
          </>
        }
        aria-describedby={describedBy}
        value={draft[key]}
        onChange={(event) => {
          const value = event.currentTarget.value;
          setDraft((current) => ({ ...current, [key]: value }));
        }}
        onBlur={() => setShown((current) => (current.has(key) ? current : new Set([...current, key])))}
        inputMode="decimal"
        autoComplete="off"
        readOnly={!editable}
        end={
          <span className="type-caption" aria-hidden="true">
            {unit}
          </span>
        }
        error={errorOf(field)}
      />
    );
  };

  return (
    <fetcher.Form method="post" className="grid gap-4" noValidate onSubmit={onSubmit}>
      <input type="hidden" name="intent" value="capacity" />
      <input type="hidden" name="expected" value={JSON.stringify(figures.expected)} />
      <div className="grid gap-4 xl:grid-cols-2">
        <Group id="storage-console" title={t("storage.internalTitle")} hint={t("storage.internalHint")}>
          {/* side by side, each field spans three shared rows (label, input, error): a model name that wraps («Nintendo
              Switch – OLED Model» when the two cards share a row) never pushes its input below the others */}
          <div className="grid gap-3 md:grid-cols-3 md:gap-y-1.5">
            {SWITCH_MODELS.map((model) => figure(MODEL_FIELD[model], t(`storage.models.${MODEL_FIELD[model]}`), undefined, "md:row-span-3 md:grid md:grid-rows-subgrid"))}
          </div>
          {/* a short field, its longer help across the card */}
          <div className="grid gap-1">
            <div className="md:max-w-[50%]">{figure("reserve", t("storage.reserve"), "storage-reserve-hint")}</div>
            <p id="storage-reserve-hint" className="max-w-[70ch] type-caption text-ink-2">
              {t("storage.reserveHint")}
            </p>
          </div>
        </Group>
        <Group id="storage-card" title={t("storage.cardTitle")}>
          <div className="grid gap-1">
            <div className="md:max-w-[50%]">{figure("margin", t("storage.margin"), "storage-margin-hint")}</div>
            <p id="storage-margin-hint" className="max-w-[70ch] type-caption text-ink-2">
              {t("storage.marginHint")}
            </p>
          </div>
          <fieldset className="grid min-w-0 gap-2" aria-describedby="storage-headroom-hint">
            <legend className="type-label text-ink">{t("storage.headroomTitle")}</legend>
            <p id="storage-headroom-hint" className="max-w-[70ch] type-caption text-ink-2">
              {t("storage.headroomHint")}
            </p>
            <div className="grid gap-3 md:grid-cols-3">
              {figure("fraction", t("storage.fraction"))}
              {figure("minGiB", t("storage.minGiB"))}
              {figure("maxGiB", t("storage.maxGiB"))}
            </div>
          </fieldset>
        </Group>
      </div>

      {editable ? (
        <div className="adm-card content-start">
          <TextField
            name="reason"
            label={t("storage.reason")}
            hint={t("storage.reasonHint")}
            value={reason}
            onChange={(event) => setReason(event.currentTarget.value)}
            onBlur={() => setShown((current) => (current.has("reason") ? current : new Set([...current, "reason"])))}
            maxLength={CAPACITY_REASON_MAX}
            autoComplete="off"
            required
            error={reasonError}
            className="max-w-[48rem]"
          />
          {failure && (!failure.fields || marked) ? <LibraryFailure answer={failure.fields ? { ...failure, code: "invalid" } : failure} /> : null}
          <div className="flex flex-wrap items-center gap-3">
            <Key type="submit" variant="ink" icon="floppy-disk" loading={fetcher.state !== "idle"} disabled={!changed}>
              {t("storage.save")}
            </Key>
            <Key
              icon="arrow-counter-clockwise"
              disabled={!edited}
              onClick={() => {
                setDraft(initial);
                setShown(new Set());
              }}
            >
              {t("storage.undo")}
            </Key>
            {failure?.code === "setting_changed" ? (
              <Key icon="arrows-clockwise" loading={revalidator.state !== "idle"} onClick={() => revalidator.revalidate()}>
                {t("storage.reload")}
              </Key>
            ) : null}
          </div>
        </div>
      ) : null}

      <CapacityPreview value={read.value} saved={figures.inUse} />
    </fetcher.Form>
  );
}

/** A card holding one group of figures, its legend and its help. */
function Group({ id, title, hint, children }: { id: string; title: string; hint?: string; children: ReactNode }) {
  return (
    <div className="adm-card content-start">
      <fieldset className="grid min-w-0 gap-3" aria-describedby={hint ? `${id}-hint` : undefined}>
        <legend className="adm-h3 mb-1">{title}</legend>
        {hint ? (
          <p id={`${id}-hint`} className="max-w-[70ch] type-caption text-ink-2">
            {hint}
          </p>
        ) : null}
        {children}
      </fieldset>
    </div>
  );
}

/** The space the figures in the form give, per card size; a figure that changes shows the saved one under it. */
function CapacityPreview({ value, saved }: { value: CapacityConfig; saved: CapacityConfig }) {
  const t = useLibraryT();
  const f = useFormat();
  const rows = capacityPreview(value);
  const before = capacityPreview(saved);
  const gb = (bytes: number) => `${f.number(toGiB(bytes), { minimumFractionDigits: 1, maximumFractionDigits: 1 })} GB`;
  const figure = (bytes: number, was: number, strong = false) => (
    <span className="grid justify-items-end gap-0.5 py-1.5">
      <bdi className={strong ? "nums font-semibold" : "nums"}>{gb(bytes)}</bdi>
      {toGiB(bytes) !== toGiB(was) ? <bdi className="type-caption text-ink-2 whitespace-nowrap">{t("storage.preview.saved", { size: gb(was) })}</bdi> : null}
    </span>
  );
  const none = <span className="text-ink-2">—</span>;
  return (
    <section className="adm-card content-start" aria-labelledby="storage-preview">
      <div className="grid gap-1">
        <h3 id="storage-preview" className="adm-h3">
          {t("storage.preview.title")}
        </h3>
        <p className="max-w-[75ch] type-caption text-ink-2">{t("storage.preview.lead")}</p>
      </div>
      <div className="overflow-x-auto rounded-sm border border-line" role="region" aria-labelledby="storage-preview" tabIndex={0}>
        <table className="table min-w-[46rem]">
          <caption className="sr-only">{t("storage.preview.caption")}</caption>
          <thead>
            <tr>
              <th scope="col" rowSpan={2}>
                {t("storage.preview.card")}
              </th>
              <th scope="col" rowSpan={2} className="is-num">
                {t("storage.preview.free")}
              </th>
              <th scope="col" rowSpan={2} className="is-num">
                {t("storage.preview.keptFree")}
              </th>
              <th scope="col" rowSpan={2} className="is-num">
                {t("storage.preview.forGames")}
              </th>
              <th scope="colgroup" colSpan={SWITCH_MODELS.length}>
                {t("storage.preview.total")}
              </th>
            </tr>
            <tr>
              {SWITCH_MODELS.map((model) => (
                <th key={model} scope="col" className="is-num">
                  {t(`storage.models.${MODEL_FIELD[model]}`)}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((row, index) => {
              const was = before[index];
              return (
                <tr key={row.sizeGB}>
                  <th scope="row">{row.sizeGB === 0 ? t("storage.preview.noCard") : <bdi dir="ltr">{cardLabel(row.sizeGB)}</bdi>}</th>
                  <td className="is-num">{row.sizeGB === 0 ? none : figure(row.cardBytes, was.cardBytes)}</td>
                  <td className="is-num">{row.sizeGB === 0 ? none : figure(row.headroomBytes, was.headroomBytes)}</td>
                  <td className="is-num">{row.sizeGB === 0 ? none : figure(row.gamesOnCardBytes, was.gamesOnCardBytes)}</td>
                  {SWITCH_MODELS.map((model) => (
                    <td key={model} className="is-num">
                      {figure(row.totals[model], was.totals[model], true)}
                    </td>
                  ))}
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <p className="max-w-[75ch] type-caption text-ink-2">{t("storage.preview.formula")}</p>
    </section>
  );
}
