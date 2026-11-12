/**
 * The sections of a used unit's page (/admin/devices/used/:id): what keeps it from the shop window, its checklist
 * (13.02), grading and what the customer reads (13.09), ownership and data wipe (13.08), its photos — which ones show
 * THIS unit (13.09), game facts (13.05), price (pricing 03's rules) and history. Every change is a POST to the page's
 * action (used-unit.server.ts) through a fetcher or a plain form.
 */
import { useState } from "react";
import { Link } from "react-router";

import { Icon } from "~/art/Icon";
import { useFormat } from "~/i18n/react";
import { DEFECT_SEVERITY_LIST, GRADE_LIST, MAX_USED_WARRANTY_DAYS, type UsedDetail } from "~/server/services/admin/devices/types";
import { ConfirmDialog, type ImpactRow } from "~/ui/Dialog";
import { Checkbox, FieldGroup, Select, TextArea, TextField } from "~/ui/Field";
import { Key } from "~/ui/Key";
import { Check, ChecklistFields, ChecklistTable, Facts, Failure, GradeTag, Money, Ref, Section, SerialBadge, useDevicesT, useIntent, When } from "./ui";

type Props = { unit: UsedDetail };

const DEFECT_AREAS = ["screen", "shell", "back", "top", "corner", "ports", "buttons", "sticks", "triggers", "grips", "kickstand", "disc_drive", "battery", "fan", "case", "cover", "disc", "other"] as const;
const INCLUDED_KEYS = ["controller", "controllers", "power_cable", "hdmi_cable", "usb_cable", "dock", "joy_con", "joy_con_pair", "joy_con_grip", "charger", "ac_adapter", "case", "carrying_case", "original_box", "manual"] as const;
const BLANK_DEFECT_ROWS = 2;

// ───────────────────────────────────────────────────────────────── readiness and listing

export function ReadinessSection({ unit }: Props) {
  const t = useDevicesT();
  const ready = unit.listBlockers.length === 0;
  return (
    <section className="adm-section" aria-labelledby="unit-ready">
      <h2 id="unit-ready" className="adm-h2">
        {t("unit.readiness")}
      </h2>
      {unit.status === "listed" ? <p className="type-body">{t("unit.isListed")}</p> : unit.status === "reserved" || unit.status === "sold" ? <p className="type-body">{t(`unit.is.${unit.status}`)}</p> : ready ? <p className="type-body">{t("unit.readyToList")}</p> : null}
      {unit.listBlockers.length > 0 && unit.status !== "listed" && unit.status !== "reserved" && unit.status !== "sold" ? (
        <ul className="dev-blockers" aria-label={t("unit.blockersLabel")}>
          {unit.listBlockers.map((key) => (
            <li key={key}>
              <Icon name="minus" size={16} className="mt-0.5 flex-none text-ink-2" />
              <span>{t(`blocker.${key}`)}</span>
            </li>
          ))}
        </ul>
      ) : null}
      <div className="dev-actions">
        {unit.can.list ? <ListButton unit={unit} /> : null}
        {unit.can.unlist ? <UnlistButton unit={unit} /> : null}
        {unit.status === "returned" && unit.can.inspect ? <ReinspectButton unit={unit} /> : null}
      </div>
    </section>
  );
}

function ListButton({ unit }: Props) {
  const t = useDevicesT();
  const f = useFormat();
  const [open, setOpen] = useState(false);
  const { fetcher, pending, message } = useIntent("list", "done.listed", () => setOpen(false));
  const blocked = unit.listBlockers.length > 0;
  const real = unit.photos.filter((photo) => photo.real && photo.fileId).length;
  const impact: ImpactRow[] = [
    { label: t("unit.listPrice"), value: f.iqd(unit.priceIqd) },
    { label: t("unit.listPhotos"), value: t("unit.photosPublished", { count: real }) },
  ];
  return (
    <>
      <Key size="sm" variant="ink" icon="storefront" onClick={() => setOpen(true)} disabled={blocked}>
        {t("unit.list")}
      </Key>
      <ConfirmDialog
        open={open}
        onClose={() => setOpen(false)}
        title={t("unit.listTitle")}
        consequence={t("unit.listWhat")}
        confirmLabel={t("unit.list")}
        impact={impact}
        pending={pending}
        error={message}
        onConfirm={() => fetcher.submit({ intent: "list" }, { method: "post" })}
      />
    </>
  );
}

function UnlistButton({ unit }: Props) {
  const t = useDevicesT();
  const [open, setOpen] = useState(false);
  const { fetcher, pending, message } = useIntent("unlist", "done.unlisted", () => setOpen(false));
  return (
    <>
      <Key size="sm" icon="eye-slash" onClick={() => setOpen(true)}>
        {t("unit.unlist")}
      </Key>
      <ConfirmDialog
        open={open}
        onClose={() => setOpen(false)}
        tone="destructive"
        title={t("unit.unlistTitle")}
        consequence={t("unit.unlistWhat", { slug: unit.slug })}
        confirmLabel={t("unit.unlist")}
        reason={{ label: t("unit.reason") }}
        pending={pending}
        error={message}
        onConfirm={({ reason }) => fetcher.submit({ intent: "unlist", reason }, { method: "post" })}
      />
    </>
  );
}

function ReinspectButton({ unit }: Props) {
  const t = useDevicesT();
  const [open, setOpen] = useState(false);
  const { fetcher, pending, message } = useIntent("reinspect", "done.reinspect", () => setOpen(false));
  void unit;
  return (
    <>
      <Key size="sm" variant="ink" icon="arrows-clockwise" onClick={() => setOpen(true)}>
        {t("unit.reinspect")}
      </Key>
      <ConfirmDialog
        open={open}
        onClose={() => setOpen(false)}
        title={t("unit.reinspectTitle")}
        consequence={t("unit.reinspectWhat")}
        confirmLabel={t("unit.reinspect")}
        reason={{ label: t("unit.reason"), hint: t("unit.reinspectHint") }}
        pending={pending}
        error={message}
        onConfirm={({ reason }) => fetcher.submit({ intent: "reinspect", reason }, { method: "post" })}
      />
    </>
  );
}

// ───────────────────────────────────────────────────────────────── facts and price

export function UnitFactsSection({ unit }: Props) {
  const t = useDevicesT();
  const f = useFormat();
  return (
    <Section id="unit-facts" title={t("unit.facts")}>
      <Facts
        rows={[
          { label: t("unit.sku"), value: <Ref value={unit.sku} /> },
          { label: t("unit.serial"), value: unit.serial ? <span className="inline-flex flex-wrap items-center gap-2"><Ref value={unit.serial.serial} /><SerialBadge status={unit.serial.status} /></span> : t("unit.noSerial") },
          { label: t("unit.location"), value: unit.location ? `${unit.location.code} · ${unit.location.name}` : "—" },
          { label: t("unit.source"), value: unit.tradeIn ? <Link to={`/admin/devices/trade-ins/${unit.tradeIn.ref}`} className="adm-link"><Ref value={unit.tradeIn.ref} /></Link> : t(`source.${unit.source}`) },
          { label: t("unit.grade"), value: <GradeTag grade={unit.grade} /> },
          { label: t("unit.battery"), value: unit.batteryHealthPct !== null ? <bdi className="nums">{unit.batteryHealthPct} %</bdi> : t("checklist.notMeasurable") },
          { label: t("unit.warranty"), value: unit.warrantyDays > 0 ? t("unit.warrantyDays", { count: unit.warrantyDays }) : t("unit.noWarranty") },
          { label: t("unit.price"), value: unit.priceIqd > 0 ? <Money iqd={unit.priceIqd} /> : t("used.unpriced") },
          { label: t("unit.newPrice"), value: <Money iqd={unit.newPriceIqd > 0 ? unit.newPriceIqd : null} /> },
          { label: t("unit.cost"), value: <Money iqd={unit.acquisitionCostIqd ?? null} />, hidden: !("acquisitionCostIqd" in unit) },
          { label: t("unit.margin"), value: unit.marginBps != null ? <bdi className="nums">{f.number(unit.marginBps / 100)} %</bdi> : t("unit.marginUnknown"), hidden: !("marginBps" in unit) },
          { label: t("unit.listedAt"), value: <When at={unit.listedAt} />, hidden: !unit.listedAt },
          { label: t("unit.soldAt"), value: <span><When at={unit.soldAt} />{unit.soldOrderRef ? <> · <Ref value={unit.soldOrderRef} /></> : null}</span>, hidden: !unit.soldAt },
        ]}
      />
      {unit.pricing.pending ? <p className="type-caption text-ink-2">{t("unit.pricePending")}</p> : null}
      {unit.pricing.canEdit ? <PriceForm unit={unit} /> : null}
    </Section>
  );
}

function PriceForm({ unit }: Props) {
  const t = useDevicesT();
  const { fetcher, pending, message, fields } = useIntent("price", (result) => (result.status === "pending" ? "done.pricePending" : result.status === "unchanged" ? "done.priceUnchanged" : "done.priced"));
  return (
    <details>
      <summary className="cursor-pointer type-strong">{unit.priceIqd > 0 ? t("unit.changePrice") : t("unit.setPrice")}</summary>
      <fetcher.Form method="post" className="grid gap-3 pt-3" noValidate>
        <input type="hidden" name="intent" value="price" />
        <input type="hidden" name="expectedPriceIqd" value={unit.priceIqd} />
        <TextField name="price" label={t("unit.price")} inputMode="numeric" ltr required defaultValue={unit.priceIqd > 0 ? String(unit.priceIqd) : ""} error={fields.price} hint={t("unit.priceHint")} end={<span className="type-caption">{t("iqd")}</span>} />
        <TextField name="reason" label={t("unit.reason")} required error={fields.reason} />
        <Failure message={message} />
        <div>
          <Key type="submit" size="sm" variant="ink" icon="tag" loading={pending}>
            {t("unit.savePrice")}
          </Key>
        </div>
      </fetcher.Form>
    </details>
  );
}

// ───────────────────────────────────────────────────────────────── checklist (13.02)

export function UnitChecklistSection({ unit }: Props) {
  const t = useDevicesT();
  const { fetcher, pending, message, fields } = useIntent("checklist", "done.checklist");
  return (
    <Section id="unit-checklist" title={t("unit.checklist")}>
      <ChecklistTable checklist={unit.checklist} />
      {unit.can.inspect && unit.can.editable ? (
        unit.checklistForm.templateId ? (
          <details open={!unit.checklist.completedAt}>
            <summary className="cursor-pointer type-strong">{unit.checklist.completedAt ? t("unit.editChecklist") : t("unit.fillChecklist")}</summary>
            <fetcher.Form method="post" className="grid gap-3 pt-3" noValidate>
              <input type="hidden" name="intent" value="checklist" />
              <input type="hidden" name="templateId" value={unit.checklistForm.templateId} />
              <ChecklistFields checklist={unit.checklistForm} errors={fields} />
              <Failure message={fields.templateId ?? message} />
              <div>
                <Key type="submit" variant="ink" icon="floppy-disk" loading={pending}>
                  {t("unit.saveChecklist")}
                </Key>
              </div>
            </fetcher.Form>
          </details>
        ) : (
          <p className="type-body text-ink-2">{t("checklist.noTemplateFor", { kind: t(`kind.${unit.checklist.kind}`) })}</p>
        )
      ) : null}
    </Section>
  );
}

// ───────────────────────────────────────────────────────────────── grading (13.09)

export function GradingSection({ unit }: Props) {
  const t = useDevicesT();
  const { fetcher, pending, message, fields } = useIntent("grade", "done.graded");
  const rows = [...unit.defects, ...Array.from({ length: BLANK_DEFECT_ROWS }, () => null)];
  const extra = unit.included.find((item) => item.key === "extra");
  return (
    <Section id="unit-grading" title={t("unit.grading")}>
      <div className="grid gap-2">
        <p className="type-body">
          <GradeTag grade={unit.grade} />
        </p>
        <p className="type-body">{unit.cosmeticNotes.ar || unit.cosmeticNotes.en || t("unit.noNotes")}</p>
        {unit.defects.length > 0 ? (
          <ul className="grid gap-1">
            {unit.defects.map((defect, index) => (
              <li key={index} className="type-body">
                <span className="dev-tag me-2">{t(`defectArea.${defect.area}`)}</span>
                {defect.note.ar || defect.note.en} — {t(`severity.${defect.severity}`)}
              </li>
            ))}
          </ul>
        ) : (
          <p className="type-caption text-ink-2">{t("unit.noDefects")}</p>
        )}
        <p className="type-caption text-ink-2">
          {t("unit.included")}: {unit.included.length ? unit.included.map((item) => (item.key === "extra" ? item.label.ar || item.label.en : t(`accessory.${item.key}`))).join("، ") : t("inspect.nothingIncluded")}
        </p>
      </div>
      {unit.can.grade ? (
        <details>
          <summary className="cursor-pointer type-strong">{t("unit.editGrading")}</summary>
          <fetcher.Form method="post" className="grid gap-4 pt-3" noValidate>
            <input type="hidden" name="intent" value="grade" />
            <div className="dev-grid-2">
              <Select name="grade" label={t("unit.grade")} required defaultValue={unit.grade} error={fields.grade} hint={t("unit.gradeHint")} options={GRADE_LIST.map((grade) => ({ value: grade, label: `${grade} · ${t(`gradeWord.${grade}`)}` }))} />
              <TextField name="warrantyDays" label={t("unit.warranty")} inputMode="numeric" ltr defaultValue={String(unit.warrantyDays)} error={fields.warrantyDays} hint={t("unit.warrantyHint", { max: MAX_USED_WARRANTY_DAYS })} />
            </div>
            <TextArea name="notesAr" label={t("unit.notesAr")} required defaultValue={unit.cosmeticNotes.ar} error={fields["cosmeticNotes.ar"]} hint={t("unit.notesHint")} />
            <div className="dev-grid-2">
              <TextArea name="notesEn" label={t("unit.notesEn")} optional defaultValue={unit.cosmeticNotes.en} error={fields["cosmeticNotes.en"]} dir="ltr" />
              <TextArea name="notesCkb" label={t("unit.notesCkb")} optional defaultValue={unit.cosmeticNotes.ckb} error={fields["cosmeticNotes.ckb"]} />
            </div>
            <fieldset className="grid gap-2">
              <legend className="type-label">{t("unit.defects")}</legend>
              <p className="type-caption text-ink-2">{t("unit.defectsHint")}</p>
              <div className="dev-rows">
                {rows.map((defect, index) => (
                  <div key={index} className="dev-row dev-row--4">
                    <Select name={`d.${index}.area`} label={t("unit.defectArea")} defaultValue={defect?.area ?? "other"} options={DEFECT_AREAS.map((area) => ({ value: area, label: t(`defectArea.${area}`) }))} />
                    <Select name={`d.${index}.severity`} label={t("unit.severity")} defaultValue={defect?.severity ?? "minor"} options={DEFECT_SEVERITY_LIST.map((severity) => ({ value: severity, label: t(`severity.${severity}`) }))} />
                    <TextField name={`d.${index}.ar`} label={t("unit.defectAr")} defaultValue={defect?.note.ar ?? ""} error={fields[`defects.${index}.note.ar`]} />
                    <TextField name={`d.${index}.en`} label={t("unit.defectEn")} defaultValue={defect?.note.en ?? ""} ltr lang="en" />
                  </div>
                ))}
              </div>
            </fieldset>
            <FieldGroup legend={t("unit.included")} layout="row" hint={t("unit.includedHint")}>
              {INCLUDED_KEYS.map((key) => (
                <Checkbox key={key} name="included" value={key} label={t(`accessory.${key}`)} defaultChecked={unit.included.some((item) => item.key === key)} />
              ))}
            </FieldGroup>
            <div className="dev-grid-2">
              <TextField name="extraAr" label={t("unit.extraAr")} optional defaultValue={extra?.label.ar ?? ""} />
              <TextField name="extraEn" label={t("unit.extraEn")} optional defaultValue={extra?.label.en ?? ""} ltr lang="en" />
            </div>
            <Failure message={message} />
            <div>
              <Key type="submit" variant="ink" icon="floppy-disk" loading={pending}>
                {t("unit.saveGrading")}
              </Key>
            </div>
          </fetcher.Form>
        </details>
      ) : null}
    </Section>
  );
}

// ───────────────────────────────────────────────────────────────── ownership and wipe (13.08)

export function ChecksSection({ unit }: Props) {
  const t = useDevicesT();
  const [open, setOpen] = useState<"ownership" | "wipe" | null>(null);
  const { fetcher, pending, message } = useIntent("checks", "done.checks", () => setOpen(null));
  return (
    <Section id="unit-checks" title={t("unit.checks")}>
      <Facts
        rows={[
          { label: t("unit.ownership"), value: <span><Check value={unit.ownership.at !== null ? true : null} yes={t("unit.ownershipDone")} no="" unknown={t("unit.notYet")} />{unit.ownership.at ? <span className="type-caption text-ink-2"> · <When at={unit.ownership.at} /> · {unit.ownership.by ?? "—"}</span> : null}</span> },
          { label: t("unit.wipe"), value: <span><Check value={unit.wipe.at !== null ? true : null} yes={t("unit.wipeDone")} no="" unknown={t("unit.notYet")} />{unit.wipe.at ? <span className="type-caption text-ink-2"> · <When at={unit.wipe.at} /> · {unit.wipe.by ?? "—"}</span> : null}</span> },
        ]}
      />
      {unit.can.verify ? (
        <div className="dev-actions">
          {unit.ownership.at === null ? (
            <Key size="sm" icon="seal-check" onClick={() => setOpen("ownership")}>
              {t("unit.confirmOwnership")}
            </Key>
          ) : null}
          {unit.wipe.at === null ? (
            <Key size="sm" icon="shield-check" onClick={() => setOpen("wipe")}>
              {t("unit.confirmWipe")}
            </Key>
          ) : null}
        </div>
      ) : null}
      <ConfirmDialog
        open={open !== null}
        onClose={() => setOpen(null)}
        title={open === "wipe" ? t("unit.wipeTitle") : t("unit.ownershipTitle")}
        consequence={open === "wipe" ? t("unit.wipeWhat") : t("unit.ownershipWhat")}
        confirmLabel={open === "wipe" ? t("unit.confirmWipe") : t("unit.confirmOwnership")}
        reason={{ label: t("unit.checkNote"), noteRequired: false, minLength: 0 }}
        pending={pending}
        error={message}
        onConfirm={({ reason }) => fetcher.submit({ intent: "checks", ownership: open === "ownership" ? "1" : "", wipe: open === "wipe" ? "1" : "", note: reason }, { method: "post" })}
      />
    </Section>
  );
}

// ───────────────────────────────────────────────────────────────── photos (13.09)

export function UnitPhotosSection({ unit }: Props) {
  const t = useDevicesT();
  const upload = useIntent("photo", "done.photo");
  const mark = useIntent("photo-real", "done.photoReal");
  const remove = useIntent("photo-remove", "done.photoRemoved");
  return (
    <Section id="unit-photos" title={t("unit.photos")}>
      <p className="type-caption text-ink-2">{t("unit.photosLead")}</p>
      {unit.photos.length === 0 ? (
        <p className="type-body text-ink-2">{t("unit.noPhotos")}</p>
      ) : (
        <ul className="dev-photos">
          {unit.photos.map((photo, index) => (
            <li key={photo.mediaId} className="dev-photo">
              {photo.url ? (
                <a href={photo.url} target="_blank" rel="noreferrer">
                  <img src={photo.url} alt={photo.alt ?? t("photos.alt", { n: index + 1 })} width={photo.width ?? 240} height={photo.height ?? 180} loading="lazy" />
                </a>
              ) : (
                <span className="type-caption text-ink-2">{photo.artKey ? t("unit.catalogPhoto") : "—"}</span>
              )}
              <span className="inline-flex flex-wrap gap-1">
                <span className="dev-tag">
                  <Icon name={photo.real ? "seal-check" : "image"} size={13} />
                  {photo.real ? t("unit.realPhoto") : t("unit.illustration")}
                </span>
                {photo.published ? <span className="dev-tag">{t("unit.published")}</span> : null}
              </span>
              {unit.can.grade && photo.fileId ? (
                <span className="inline-flex flex-wrap gap-1">
                  <Key size="sm" icon={photo.real ? "image" : "seal-check"} loading={mark.pending} onClick={() => mark.fetcher.submit({ intent: "photo-real", mediaId: photo.mediaId, real: photo.real ? "" : "1" }, { method: "post" })}>
                    {photo.real ? t("unit.markIllustration") : t("unit.markReal")}
                  </Key>
                  <Key size="sm" icon="trash" loading={remove.pending} onClick={() => remove.fetcher.submit({ intent: "photo-remove", mediaId: photo.mediaId }, { method: "post" })} aria-label={t("unit.removePhoto", { n: index + 1 })}>
                    <span className="text-red-ink">{t("unit.remove")}</span>
                  </Key>
                </span>
              ) : null}
            </li>
          ))}
        </ul>
      )}
      <Failure message={mark.message ?? remove.message} />
      {unit.can.photo ? (
        <upload.fetcher.Form method="post" encType="multipart/form-data" className="flex flex-wrap items-end gap-2">
          <input type="hidden" name="intent" value="photo" />
          <div className="grid gap-1">
            <label htmlFor="unit-photo" className="type-label">
              {t("photos.add")}
            </label>
            <input id="unit-photo" name="file" type="file" accept="image/jpeg,image/png,image/webp" required className="type-body" aria-describedby="unit-photo-hint" />
            <p id="unit-photo-hint" className="type-caption text-ink-2">
              {t("unit.photoHint")}
            </p>
          </div>
          <TextField name="alt" label={t("unit.photoAlt")} optional className="min-w-[12rem]" />
          <Key type="submit" size="sm" icon="upload-simple" loading={upload.pending}>
            {t("photos.upload")}
          </Key>
          <Failure message={upload.message} />
        </upload.fetcher.Form>
      ) : null}
    </Section>
  );
}

// ───────────────────────────────────────────────────────────────── games (13.05) and history

export function GameSection({ unit }: Props) {
  const t = useDevicesT();
  if (!unit.game) return null;
  return (
    <Section id="unit-game" title={t("unit.game")}>
      <Facts
        rows={[
          { label: t("unit.region"), value: unit.game.region ?? t("unit.regionUnknown") },
          { label: t("unit.platform"), value: unit.game.platform ?? "—" },
          { label: t("unit.format"), value: unit.game.mediaFormat ? t(`format.${unit.game.mediaFormat}`) : t("unit.formatUnknown") },
        ]}
      />
      {unit.game.compatibility.length > 0 ? (
        <ul className="grid gap-1">
          {unit.game.compatibility.map((rule, index) => (
            <li key={index} className="flex items-center gap-2 type-body">
              <span className="dev-tag">{t(`compat.${rule.status}`)}</span>
              {rule.target}
            </li>
          ))}
        </ul>
      ) : (
        <p className="type-caption text-ink-2">{t("unit.noCompat")}</p>
      )}
      <p className="type-caption text-ink-2">{t("unit.gameNote")}</p>
    </Section>
  );
}

/** The words of an audit action ("devices.used.list" → audit.devices_used_list); the action itself when there are none. */
function auditWords(t: (key: string) => string, action: string): string {
  const key = `audit.${action.replace(/\./g, "_")}`;
  const words = t(key);
  return words === key ? action : words;
}

export function UnitHistorySection({ unit }: Props) {
  const t = useDevicesT();
  if (unit.history.length === 0) return null;
  return (
    <Section id="unit-history" title={t("history.title")}>
      <ol className="dev-timeline">
        {unit.history.map((entry) => (
          <li key={entry.id} data-actor={entry.actorKind}>
            <p className="type-body">{auditWords(t, entry.kind)}</p>
            <p className="type-caption text-ink-2">
              <When at={entry.at} /> · {entry.actor ?? t(`actor.${entry.actorKind}`)}
            </p>
            {typeof entry.data.reason === "string" ? <p className="type-caption">{entry.data.reason}</p> : null}
          </li>
        ))}
      </ol>
    </Section>
  );
}
