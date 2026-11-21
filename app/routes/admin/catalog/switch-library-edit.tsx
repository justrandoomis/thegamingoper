import { useEffect, useId, useState, type ReactNode } from "react";
import { Link, useFetcher } from "react-router";

import type { Route } from "./+types/switch-library-edit";
import { Icon } from "~/art/Icon";
import { messagesFor, serverT } from "~/i18n/i18n.server";
import { useFormat } from "~/i18n/react";
import { can } from "~/server/actor";
import { MAX_UPLOAD_BODY_BYTES, readFormData } from "~/server/body.server";
import { getLibraryEntry, removeLibraryImage, saveLibraryEntry, SWITCH_LIBRARY_MANAGE, uploadLibraryImage } from "~/server/services/admin/switch-library.server";
import { ConfirmDialog } from "~/ui/Dialog";
import { Checkbox, TextArea, TextField } from "~/ui/Field";
import { Key } from "~/ui/Key";
import { Status } from "~/ui/Tag";
import { adminMeta } from "../shell/meta";
import { answered, blobStore, catalogRequest, enforceUploadLimit, failed, formObject, runIntent } from "./catalog.server";
import { Thumb } from "./components/ui";
import {
  isoDayToEpoch,
  MAX_DESCRIPTION,
  MIN_AS_OF,
  MIN_METACRITIC_REVIEWS,
  parseSizeInput,
  parseUsdInput,
  parseYouTubeId,
  sameSize,
  sizeLabel,
  usdLabel,
  youTubeWatchUrl,
} from "./switch-library-input";
import { GameName, LIBRARY_PATH, LibraryFailure, isLibraryFailure, useLibraryErrors, useLibraryFieldError, useLibraryList, useLibraryT, useLibraryToast } from "./switch-library-ui";

/**
 * /admin/catalog/switch-library/:gameId — TamTam's data for one game of the Switch builder's library
 * (docs/switch-builder.md §7): the sizes measured on a TamTam console (GB as the console shows them), the eShop
 * price staff checked (USD), as-of days (today by default), the official trailer (a YouTube link or id), a picture
 * through the public upload path, descriptions in ar/en/ckb, a Metacritic score only under TamTam's licence, and
 * "hidden". The game's title and facts come from the open list (Wikidata) on the client. Any lower-case slug ending in
 * "-switch" opens — also a game the list does not have yet; anything else is a 404. Reading needs
 * catalog.product.read; saving, the picture and its removal need catalog.switch_library.manage. Every save is guarded
 * by the row's version and audited (service).
 */
export async function loader({ context, params }: Route.LoaderArgs) {
  const { db, actor, locale, now } = await catalogRequest(context, "catalog.product.read");
  const entry = await answered(getLibraryEntry(db, actor, params.gameId, now));
  return {
    entry,
    can: { manage: can(actor, SWITCH_LIBRARY_MANAGE) },
    title: serverT(locale, "admin-switch-library")("edit.metaTitle", { id: entry.gameId }),
    i18n: messagesFor(locale, "admin-switch-library"),
  };
}

/**
 * Only the picture form sends a file (multipart/form-data): its upload limit is counted BEFORE its body is read. Any
 * body is read only up to one picture and its fields, never to the end of an oversized or chunked body
 * (body.server readFormData). A save stays under that by far; a text pasted far over its own limit still reaches the
 * service and is answered under its field.
 */
export async function action({ request, context, params }: Route.ActionArgs) {
  const req = await catalogRequest(context, SWITCH_LIBRARY_MANAGE);
  const multipart = /^multipart\/form-data/i.test(request.headers.get("Content-Type") ?? "");
  let raw: FormData;
  try {
    if (multipart) await enforceUploadLimit(req);
    raw = await readFormData(request, MAX_UPLOAD_BODY_BYTES);
  } catch (error) {
    return failed(error, req.locale);
  }
  const form = formObject(raw);
  const base = { ...form, gameId: params.gameId };
  return runIntent(req, form.intent, {
    save: async () => saveLibraryEntry(req.db, req.actor, base, req.now),
    // counted above: a file only travels in a multipart body (anything else has no picture to store)
    upload: async () => uploadLibraryImage(req.db, blobStore(), req.actor, base, raw.get("file"), req.now),
    remove_image: async () => removeLibraryImage(req.db, blobStore(), req.actor, base, req.now),
  });
}

export const meta: Route.MetaFunction = (args) => adminMeta(args, args.loaderData?.title);

type Entry = Route.ComponentProps["loaderData"]["entry"];

/**
 * The form starts again from the stored VALUES when they change (after a save), not when only the row's version
 * moves: a picture upload or removal bumps updated_at without touching a field, and remounting then threw away what
 * staff had typed but not saved yet. The hidden version field follows the row either way.
 */
const formVersion = (entry: Entry) => JSON.stringify(entry.values);

/** The text fields of a form as it is submitted. */
const sentText = (form: HTMLFormElement): Record<string, string> =>
  Object.fromEntries([...new FormData(form)].flatMap(([name, value]) => (typeof value === "string" ? [[name, value]] : [])));

export default function SwitchLibraryEdit({ loaderData }: Route.ComponentProps) {
  const t = useLibraryT();
  const f = useFormat();
  const { entry, can: allowed } = loaderData;
  const { status, byId } = useLibraryList();
  const game = byId.get(entry.gameId) ?? null;

  return (
    <>
      <header className="adm-page-head">
        <Link to={LIBRARY_PATH} className="adm-link inline-flex w-fit items-center gap-1 type-caption">
          <Icon name="arrow-left" size={16} />
          {t("title")}
        </Link>
        <div className="flex flex-wrap items-start gap-4">
          <Thumb image={entry.image ? { artKey: null, mediaKey: entry.image.key, alt: "", isIllustration: false, width: entry.image.width ?? undefined, height: entry.image.height ?? undefined } : null} size={72} />
          <div className="grid min-w-0 flex-1 gap-1">
            <h1 className="adm-title">
              <GameName game={game} gameId={entry.gameId} wrap />
            </h1>
            <p className="flex flex-wrap items-center gap-x-3 gap-y-1 type-caption text-ink-2">
              <bdi dir="ltr">{entry.gameId}</bdi>
              {game?.year ? <bdi className="nums">{game.year}</bdi> : null}
              {game?.publishers?.length ? <bdi dir="ltr">{game.publishers.slice(0, 3).join(", ")}</bdi> : null}
              {game?.qid ? (
                <a className="adm-link inline-flex items-center gap-1" href={`https://www.wikidata.org/wiki/${encodeURIComponent(game.qid)}`} target="_blank" rel="noopener noreferrer">
                  {t("edit.wikidata")}
                  <Icon name="arrow-square-out" size={14} />
                </a>
              ) : null}
            </p>
            <p className="flex flex-wrap items-center gap-x-3 gap-y-1">
              {entry.values.isHidden ? <Status tone="warn">{t("edit.hiddenBadge")}</Status> : null}
              {!entry.exists ? <Status tone="neutral">{t("edit.noDataBadge")}</Status> : null}
              {entry.updatedAt ? (
                <span className="type-caption text-ink-2">{entry.updatedByName ? t("edit.lastSaved", { time: f.dateTime(entry.updatedAt), name: entry.updatedByName }) : t("edit.lastSavedAt", { time: f.dateTime(entry.updatedAt) })}</span>
              ) : null}
            </p>
          </div>
        </div>
      </header>

      {status === "ready" && !game ? (
        <p className="adm-notice adm-notice--warn mb-4">
          <Icon name="warning" size={18} />
          <span>{t("edit.notInList")}</span>
        </p>
      ) : null}
      {!allowed.manage ? (
        <p className="adm-notice mb-4">
          <Icon name="info" size={18} />
          <span>{t("edit.readOnly")}</span>
        </p>
      ) : null}

      <div className="grid gap-6 xl:grid-cols-[minmax(0,2fr)_minmax(18rem,1fr)]">
        <EntryForm key={formVersion(entry)} entry={entry} canManage={allowed.manage} metacriticSlug={game?.metacriticSlug} />
        <PictureCard entry={entry} canManage={allowed.manage} />
      </div>
    </>
  );
}

/** A form section with its heading. */
function Part({ id, title, lead, children }: { id: string; title: string; lead?: ReactNode; children: ReactNode }) {
  return (
    <section className="adm-card content-start" aria-labelledby={id}>
      <div className="grid gap-1">
        <h2 id={id} className="adm-h3">
          {title}
        </h2>
        {lead ? <p className="max-w-[70ch] type-caption text-ink-2">{lead}</p> : null}
      </div>
      {children}
    </section>
  );
}

/** A preview line under a field: what the builder will show, or nothing while the field is empty. */
function Preview({ children, tone = "ok" }: { children: ReactNode; tone?: "ok" | "bad" }) {
  return (
    <p className={tone === "bad" ? "type-caption text-red-ink" : "type-caption text-ink-2"} aria-live="polite">
      {children}
    </p>
  );
}

/**
 * An as-of day that follows its value: while staff have not touched the day, a changed value shows today (the
 * server applies the same rule), an unchanged one keeps the stored day.
 */
function useAsOf(stored: string, today: string, valueChanged: boolean) {
  const [touched, setTouched] = useState<string | null>(null);
  return { value: touched ?? (valueChanged ? today : stored), onChange: (next: string) => setTouched(next) };
}

function EntryForm({ entry, canManage, metacriticSlug }: { entry: Entry; canManage: boolean; metacriticSlug?: string }) {
  const t = useLibraryT();
  const f = useFormat();
  const errorText = useLibraryErrors();
  const save = useFetcher<typeof action>({ key: `switch-library-save-${entry.gameId}` });
  const fieldError = useLibraryFieldError(save.data);
  useLibraryToast(save, (data) => (data.changed ? t("common.saved") : t("common.unchanged")));
  const { form, values, today } = entry;
  // The fields checked while staff type (sizes, price, trailer) use the server's own rules: the server's error stays
  // under such a field only while it still holds the text that was sent — once staff edit it, the live line takes
  // over (a stale "type the size as…" under a size that now reads fine), and the same sentence never shows twice.
  const [sent, setSent] = useState<Record<string, string>>({});
  const liveError = (name: string, current: string) => (sent[name] === current ? fieldError(name) : undefined);

  const [size, setSize] = useState(form.size);
  const [cartridge, setCartridge] = useState(form.cartridge);
  const [price, setPrice] = useState(form.price);
  const [trailer, setTrailer] = useState(form.trailer);
  const [score, setScore] = useState(form.metacritic.score);
  const [reviews, setReviews] = useState(form.metacritic.reviews);

  const sizeParsed = size.trim() ? parseSizeInput(size) : null;
  const cartridgeParsed = cartridge.trim() ? parseSizeInput(cartridge, { allowZero: true }) : null;
  const priceParsed = price.trim() ? parseUsdInput(price) : null;
  const trailerId = trailer.trim() ? parseYouTubeId(trailer) : null;

  // What the save would store (an unreadable entry counts as unchanged until it reads): it decides the as-of days.
  const willStore = <T,>(parsed: { ok: true; value: T } | { ok: false } | null, stored: T | null): T | null => (parsed === null ? null : parsed.ok ? parsed.value : stored);
  const sizesChanged = !sameSize(values.sizeBytes, willStore(sizeParsed, values.sizeBytes)) || !sameSize(values.cartridgeBytes, willStore(cartridgeParsed, values.cartridgeBytes));
  const priceChanged = willStore(priceParsed, values.priceUsdCents) !== values.priceUsdCents;
  const scoreChanged = score.trim() !== form.metacritic.score || reviews.trim() !== form.metacritic.reviews;
  const sizeAsOf = useAsOf(form.sizeAsOf, today, sizesChanged);
  const priceAsOf = useAsOf(form.priceAsOf, today, priceChanged);
  const scoreAsOf = useAsOf(form.metacritic.asOf, today, scoreChanged);

  const dateProps = { type: "date", min: MIN_AS_OF, max: today, ltr: true } as const;
  const priceDate = priceAsOf.value || today;
  const live: Record<string, string> = { size, cartridge, price, trailer };
  const sizeError = liveError("size", size);
  const cartridgeError = liveError("cartridge", cartridge);
  const priceError = liveError("price", price);
  const trailerError = liveError("trailer", trailer);

  return (
    <save.Form method="post" className="grid content-start gap-4" noValidate onSubmit={(event) => setSent(sentText(event.currentTarget))}>
      <input type="hidden" name="intent" value="save" />
      <input type="hidden" name="updatedAt" value={entry.updatedAt ?? ""} />
      <fieldset disabled={!canManage} className="grid min-w-0 gap-4">
        <Part id="library-size" title={t("edit.sizeTitle")} lead={t("edit.sizeLead")}>
          <div className="grid gap-3 md:grid-cols-2">
            <div className="grid content-start gap-1">
              <TextField name="size" label={t("edit.size")} hint={t("edit.sizeHint")} value={size} onChange={(event) => setSize(event.currentTarget.value)} inputMode="decimal" autoComplete="off" error={sizeError} />
              {sizeParsed ? sizeParsed.ok ? <Preview>{t("edit.sizePreview", { size: sizeLabel(sizeParsed.value), bytes: f.number(sizeParsed.value) })}</Preview> : sizeError ? null : <Preview tone="bad">{errorText(sizeParsed.error)}</Preview> : null}
            </div>
            <div className="grid content-start gap-1">
              <TextField name="cartridge" label={t("edit.cartridge")} hint={t("edit.cartridgeHint")} value={cartridge} onChange={(event) => setCartridge(event.currentTarget.value)} inputMode="decimal" autoComplete="off" error={cartridgeError} />
              {cartridgeParsed ? cartridgeParsed.ok ? <Preview>{t("edit.sizePreview", { size: sizeLabel(cartridgeParsed.value), bytes: f.number(cartridgeParsed.value) })}</Preview> : cartridgeError ? null : <Preview tone="bad">{errorText(cartridgeParsed.error)}</Preview> : null}
            </div>
          </div>
          <TextField name="sizeAsOf" label={t("edit.sizeAsOf")} {...dateProps} value={sizeAsOf.value} onChange={(event) => sizeAsOf.onChange(event.currentTarget.value)} error={fieldError("sizeAsOf")} className="max-w-[14rem]" />
        </Part>

        <Part id="library-price" title={t("edit.priceTitle")}>
          <div className="grid gap-3 md:grid-cols-2">
            <div className="grid content-start gap-1">
              <TextField name="price" label={t("edit.price")} hint={t("edit.priceHint")} value={price} onChange={(event) => setPrice(event.currentTarget.value)} inputMode="decimal" autoComplete="off" error={priceError} />
              {priceParsed ? priceParsed.ok ? <Preview>{t("edit.pricePreview", { price: usdLabel(priceParsed.value), date: f.date(isoDayToEpoch(priceDate), "medium") })}</Preview> : priceError ? null : <Preview tone="bad">{errorText(priceParsed.error)}</Preview> : null}
            </div>
            <TextField name="priceAsOf" label={t("edit.priceAsOf")} {...dateProps} value={priceAsOf.value} onChange={(event) => priceAsOf.onChange(event.currentTarget.value)} error={fieldError("priceAsOf")} className="max-w-[14rem]" />
          </div>
        </Part>

        <Part id="library-trailer" title={t("edit.trailerTitle")}>
          <div className="grid gap-1">
            <TextField name="trailer" label={t("edit.trailer")} hint={t("edit.trailerHint")} value={trailer} onChange={(event) => setTrailer(event.currentTarget.value)} ltr autoComplete="off" spellCheck={false} error={trailerError} />
            {trailer.trim() && !(trailerError && !trailerId) ? (
              trailerId ? (
                <Preview>
                  <span className="inline-flex flex-wrap items-center gap-x-3 gap-y-1">
                    <span>
                      {t("edit.trailerPreview")} <bdi dir="ltr" className="font-semibold text-ink">{trailerId}</bdi>
                    </span>
                    <a className="adm-link inline-flex items-center gap-1" href={youTubeWatchUrl(trailerId)} target="_blank" rel="noopener noreferrer">
                      {t("common.openOnYouTube")}
                      <Icon name="arrow-square-out" size={14} />
                    </a>
                  </span>
                </Preview>
              ) : (
                <Preview tone="bad">{errorText("trailer_invalid")}</Preview>
              )
            ) : null}
          </div>
        </Part>

        <Part id="library-description" title={t("edit.descriptionTitle")} lead={t("edit.descriptionLead", { max: f.number(MAX_DESCRIPTION) })}>
          <div className="grid gap-3">
            {(["ar", "en", "ckb"] as const).map((lang) => (
              <TextArea
                key={lang}
                name={`description.${lang}`}
                label={t(`common.${lang}`)}
                defaultValue={form.description[lang]}
                lang={lang}
                dir={lang === "en" ? "ltr" : "rtl"}
                rows={4}
                error={fieldError(`description.${lang}`)}
              />
            ))}
          </div>
        </Part>

        <Part id="library-metacritic" title={t("edit.metacriticTitle")}>
          <p className="adm-notice adm-notice--warn">
            <Icon name="warning" size={18} />
            <span>{t("edit.metacriticNote")}</span>
          </p>
          <div className="grid gap-3 md:grid-cols-3">
            <TextField name="metacritic.score" label={t("edit.score")} value={score} onChange={(event) => setScore(event.currentTarget.value)} inputMode="numeric" autoComplete="off" error={fieldError("metacritic.score")} />
            <TextField name="metacritic.reviews" label={t("edit.reviews")} hint={t("edit.reviewsHint", { min: f.number(MIN_METACRITIC_REVIEWS) })} value={reviews} onChange={(event) => setReviews(event.currentTarget.value)} inputMode="numeric" autoComplete="off" error={fieldError("metacritic.reviews")} />
            <TextField name="metacritic.asOf" label={t("edit.scoreAsOf")} {...dateProps} value={scoreAsOf.value} onChange={(event) => scoreAsOf.onChange(event.currentTarget.value)} error={fieldError("metacritic.asOf")} />
          </div>
          {metacriticSlug ? (
            <a className="adm-link inline-flex w-fit items-center gap-1 type-caption" href={`https://www.metacritic.com/game/${encodeURIComponent(metacriticSlug)}/`} target="_blank" rel="noopener noreferrer">
              {t("edit.metacriticPage")}
              <Icon name="arrow-square-out" size={14} />
            </a>
          ) : null}
        </Part>

        <Part id="library-visibility" title={t("edit.visibilityTitle")}>
          <Checkbox name="hidden" label={t("edit.hidden")} hint={t("edit.hiddenHint")} defaultChecked={form.hidden} />
        </Part>
      </fieldset>

      {isLibraryFailure(save.data) && !save.data.fields ? <LibraryFailure answer={save.data} /> : null}
      {isLibraryFailure(save.data) && save.data.fields && Object.keys(save.data.fields).some((name) => !(name in live) || sent[name] === live[name]) ? (
        <LibraryFailure answer={{ ...save.data, code: "invalid" }} />
      ) : null}
      {canManage ? (
        <div className="flex flex-wrap items-center gap-3">
          <Key type="submit" variant="ink" icon="floppy-disk" loading={save.state !== "idle"}>
            {t("common.save")}
          </Key>
          {isLibraryFailure(save.data) && save.data.code === "entry_changed" ? (
            <Key as="a" href={`${LIBRARY_PATH}/${encodeURIComponent(entry.gameId)}`} icon="arrows-clockwise">
              {t("edit.reload")}
            </Key>
          ) : null}
        </div>
      ) : null}
    </save.Form>
  );
}

function PictureCard({ entry, canManage }: { entry: Entry; canManage: boolean }) {
  const t = useLibraryT();
  const upload = useFetcher<typeof action>({ key: `switch-library-upload-${entry.gameId}` });
  const remove = useFetcher<typeof action>({ key: `switch-library-remove-${entry.gameId}` });
  const fieldError = useLibraryFieldError(upload.data);
  useLibraryToast(upload, (data) => (data.replayed ? t("edit.duplicate") : t("edit.uploaded")));
  useLibraryToast(remove, (data) => (data.removed ? t("edit.removed") : null));
  const [confirm, setConfirm] = useState(false);
  // A fresh, empty file field after each successful upload.
  const [round, setRound] = useState(0);
  useEffect(() => {
    if (upload.state === "idle" && upload.data && !isLibraryFailure(upload.data)) setRound((value) => value + 1);
  }, [upload.state, upload.data]);
  useEffect(() => {
    if (remove.state === "idle" && remove.data && !isLibraryFailure(remove.data)) setConfirm(false);
  }, [remove.state, remove.data]);

  return (
    <section className="adm-card content-start self-start" aria-labelledby="library-picture">
      <div className="grid gap-1">
        <h2 id="library-picture" className="adm-h3">
          {t("edit.pictureTitle")}
        </h2>
        <p className="type-caption text-ink-2">{t("edit.pictureLead")}</p>
      </div>
      <div className="grid aspect-[4/3] place-items-center overflow-hidden rounded-xs bg-niche">
        {entry.image ? (
          <Thumb image={{ artKey: null, mediaKey: entry.image.key, alt: "", isIllustration: false, width: entry.image.width ?? undefined, height: entry.image.height ?? undefined }} size={220} />
        ) : (
          <span className="grid max-w-[28ch] place-items-center gap-2 p-4 text-center type-caption text-ink-2">
            <Icon name={entry.imageBroken ? "warning-circle" : "image"} size={28} className={entry.imageBroken ? "text-red-ink" : "text-ink-3"} />
            {entry.imageBroken ? t("edit.pictureBroken") : t("edit.pictureNone")}
          </span>
        )}
      </div>
      {entry.image?.width && entry.image.height ? (
        <p className="type-caption text-ink-2">
          <bdi dir="ltr" className="nums">
            {entry.image.width}×{entry.image.height}
          </bdi>
        </p>
      ) : null}
      {canManage ? (
        <>
          <upload.Form method="post" encType="multipart/form-data" className="grid gap-3" key={round}>
            <input type="hidden" name="intent" value="upload" />
            <PictureInput label={t("edit.file")} hint={t("edit.fileHint")} error={fieldError("file")} />
            <div className="flex flex-wrap gap-2">
              <Key type="submit" variant="ink" icon="upload-simple" loading={upload.state !== "idle"}>
                {entry.image ? t("edit.replace") : t("edit.upload")}
              </Key>
              {entry.image ? (
                <Key icon="trash" className="[--on:var(--red-ink)]" onClick={() => setConfirm(true)}>
                  {t("edit.removeImage")}
                </Key>
              ) : null}
            </div>
            {isLibraryFailure(upload.data) && !upload.data.fields ? <LibraryFailure answer={upload.data} /> : null}
          </upload.Form>
          <ConfirmDialog
            open={confirm}
            onClose={() => setConfirm(false)}
            tone="destructive"
            title={t("edit.removeQ")}
            consequence={t("edit.removeDo")}
            confirmLabel={t("edit.removeImage")}
            cancelLabel={t("common.cancel")}
            pending={remove.state !== "idle"}
            error={isLibraryFailure(remove.data) ? <LibraryFailure answer={remove.data} /> : undefined}
            onConfirm={() => remove.submit({ intent: "remove_image" }, { method: "post" })}
          />
        </>
      ) : null}
    </section>
  );
}

/**
 * The picture's file field in the admin's language (the native picker's words follow the browser, not the page): a
 * visually hidden real input behind a labelled key, with the chosen file's name.
 */
function PictureInput({ label, hint, error }: { label: string; hint: string; error?: string }) {
  const t = useLibraryT();
  const id = useId();
  const [name, setName] = useState<string | null>(null);
  return (
    <div className="grid gap-1">
      <span className="type-label text-ink" id={`${id}-label`}>
        {label}
      </span>
      <div className="flex flex-wrap items-center gap-3">
        <input
          id={id}
          name="file"
          type="file"
          accept="image/jpeg,image/png,image/webp"
          required
          className="peer sr-only"
          aria-labelledby={`${id}-label`}
          aria-describedby={`${id}-hint`}
          aria-invalid={error ? true : undefined}
          onChange={(event) => setName(event.currentTarget.files?.[0]?.name ?? null)}
        />
        <Key as="label" htmlFor={id} icon="paperclip" className="cursor-pointer peer-focus-visible:outline-[2.5px] peer-focus-visible:outline-offset-[3px] peer-focus-visible:outline-ink">
          {t("common.chooseFile")}
        </Key>
        <bdi className="min-w-0 truncate type-caption text-ink-2">{name ?? t("common.noFile")}</bdi>
      </div>
      <span id={`${id}-hint`} className="type-caption text-ink-2">
        {hint}
      </span>
      {error ? (
        <span role="alert" className="type-caption text-red-ink">
          {error}
        </span>
      ) : null}
    </div>
  );
}
