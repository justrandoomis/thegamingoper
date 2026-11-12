import { useEffect, useState } from "react";
import { Form, Link, useFetcher, useNavigate, useSearchParams } from "react-router";

import type { Route } from "./+types/pin";
import { adminSecrets } from "~/routes/admin/shell/env.server";
import { discardPinChanges, getHeroPinEditor, pinProductOf, publishHeroPin, saveHeroPin, searchPinProducts, unpublishHeroPin } from "~/server/services/admin/cms/home.server";
import { previewLink } from "~/server/services/admin/cms/preview.server";
import { HERO_PLATFORMS, HERO_TEXT, baghdadLocal, isHeroPlatform, type HeroPlatform } from "~/server/services/admin/cms/rules";
import { invalid } from "~/server/errors";
import type { L10n, Locale } from "~/lib/locales";
import { Select, TextField } from "~/ui/Field";
import { Key } from "~/ui/Key";
import { Segmented } from "~/ui/Segmented";
import { Status } from "~/ui/Tag";
import { cmsMeta } from "./meta";
import { failed, l10n, ok, openCms, orRespond, text } from "./cms.server";
import { PinPreview } from "./preview-parts";
import { ActionDialog, CONTENT_LANGS, DemoTag, FormError, L10nFields, Note, PageHead, Pair, PreviewFrames, Section, StateBadge, When, useCmsT, useResult } from "./ui";

/**
 * /admin/cms/home/pins/:pinId ("new") — 17.01 / 17.02 / 17.06: pin a product and a headline to one platform's home
 * stage for a period (Iraq time). Choose the product (the catalogue's products for that platform), write the headline
 * in ar/en/ckb, preview it at phone and desktop width, save it as a draft, then publish it — after the checks of
 * home.server (the catalogue shows the product when the pin starts, it is for that platform, it has a photo, and no
 * other published pin of the platform overlaps). Changes to a published pin wait until they are published.
 */
export async function loader({ context, params, request }: Route.LoaderArgs) {
  const { db, actor, locale, now, ctx } = await openCms(context, "cms.home.manage");
  const url = new URL(request.url);
  const editor = await orRespond(() => getHeroPinEditor(db, actor, params.pinId, locale, now));
  const platformParam = url.searchParams.get("platform");
  const platform: HeroPlatform = isHeroPlatform(platformParam) ? platformParam : (editor.values?.platform ?? "playstation");
  const q = (url.searchParams.get("q") ?? "").slice(0, 80);
  const chosenId = url.searchParams.get("product");
  const [candidates, chosen] = await Promise.all([
    searchPinProducts(db, actor, { platform, q }, locale, now),
    chosenId && chosenId !== editor.values?.productId ? pinProductOf(db, actor, chosenId, locale, Math.max(now, editor.values?.startsAt ?? now), now) : Promise.resolve(null),
  ]);
  return { editor, platform, q, candidates, product: chosen ?? editor.product, demoStore: ctx.storeMode === "demo", now };
}

export async function action({ request, context, params }: Route.ActionArgs) {
  const req = await openCms(context, "cms.home.manage");
  const form = await request.formData();
  const intent = text(form, "intent");
  const pinId = params.pinId === "new" ? undefined : params.pinId;
  try {
    switch (intent) {
      case "save": {
        const result = await saveHeroPin(
          req.db,
          req.actor,
          {
            pinId,
            version: text(form, "version") || undefined,
            platform: text(form, "platform"),
            productId: text(form, "productId"),
            headline: l10n(form, "headline"),
            deck: l10n(form, "deck"),
            startsAt: text(form, "startsAt"),
            endsAt: text(form, "endsAt"),
          },
          req.now,
        );
        return ok(intent, result);
      }
      case "publish":
        return ok(intent, await publishHeroPin(req.db, req.actor, { pinId, version: text(form, "version"), reason: text(form, "reason") }, req.now));
      case "discard":
        return ok(intent, await discardPinChanges(req.db, req.actor, { pinId, version: text(form, "version"), reason: text(form, "reason") }, req.now));
      case "unpublish":
        return ok(intent, await unpublishHeroPin(req.db, req.actor, { pinId, version: text(form, "version"), reason: text(form, "reason") }, req.now));
      case "link":
        if (!pinId) throw invalid({ intent: "invalid" });
        return ok(intent, await previewLink(req.db, req.actor, { kind: "pin", id: pinId }, adminSecrets().SESSION_SECRET, req.now));
      default:
        throw invalid({ intent: "invalid" });
    }
  } catch (error) {
    return failed(error, req.locale, intent);
  }
}

export const meta: Route.MetaFunction = (args) => cmsMeta(args, args.params.pinId === "new" ? "pin.newTitle" : "pin.title");

type Dialog = "publish" | "discard" | "unpublish" | null;

export default function PinPage({ loaderData, params }: Route.ComponentProps) {
  const t = useCmsT();
  const { editor, platform, q, candidates, product, demoStore } = loaderData;
  const [search] = useSearchParams();
  const values = editor.values;
  const [headline, setHeadline] = useState<Partial<Record<Locale, string>>>(values?.headline ?? {});
  const [deck, setDeck] = useState<Partial<Record<Locale, string>>>(values?.deck ?? {});
  const [lang, setLang] = useState<Locale>("ar");
  const [dialog, setDialog] = useState<Dialog>(null);
  const save = useFetcher<Record<string, unknown>>();
  const link = useFetcher<Record<string, unknown>>();
  const saved = useResult(save, "save", (data) => (data.staged ? t("pin.staged") : t("pin.saved")));
  const made = useResult(link, "link", t("preview.linkMade"));
  const isNew = params.pinId === "new";
  const version = editor.pin ? String(editor.pin.version) : "";
  const productId = product?.id ?? "";
  const withParams = (changes: Record<string, string | null>) => {
    const next = new URLSearchParams(search);
    for (const [key, value] of Object.entries(changes)) {
      if (value === null || value === "") next.delete(key);
      else next.set(key, value);
    }
    const textValue = next.toString();
    return textValue ? `?${textValue}` : "?";
  };
  // after a new pin is saved, its own page
  const navigate = useNavigate();
  const createdId = save.data && (save.data as { created?: boolean; pinId?: string }).created ? (save.data as { pinId: string }).pinId : null;
  useEffect(() => {
    if (createdId && save.state === "idle") navigate(`/admin/cms/home/pins/${createdId}`, { replace: true });
  }, [createdId, save.state, navigate]);
  // a new version came from the server: the form follows it
  const [seen, setSeen] = useState(editor.pin?.version ?? null);
  if (seen !== (editor.pin?.version ?? null)) {
    setSeen(editor.pin?.version ?? null);
    setHeadline(values?.headline ?? {});
    setDeck(values?.deck ?? {});
  }
  const previewHeadline = { ar: headline.ar ?? "", ...(headline.en ? { en: headline.en } : {}), ...(headline.ckb ? { ckb: headline.ckb } : {}) } as L10n;
  const previewDeck = deck.ar ? ({ ar: deck.ar, ...(deck.en ? { en: deck.en } : {}), ...(deck.ckb ? { ckb: deck.ckb } : {}) } as L10n) : null;
  const madePath = link.data && (link.data as { path?: string }).path ? String((link.data as { path: string }).path) : null;

  return (
    <>
      <PageHead
        eyebrow={
          <Link to="/admin/cms/home" className="adm-link">
            {t("homePage.title")}
          </Link>
        }
        title={isNew ? t("pin.newTitle") : t("pin.title")}
        lead={t("pin.lead")}
        actions={
          editor.pin ? (
            <span className="flex flex-wrap items-center gap-1.5">
              <StateBadge state={editor.pin.state} />
              {editor.pin.pending ? <Status tone="warn">{t("pins.pending")}</Status> : null}
              <DemoTag show={editor.pin.isDemo} />
            </span>
          ) : null
        }
      />

      <div className="cms-split">
        <div className="grid min-w-0 gap-5">
          <Section id="product" title={t("pin.product")}>
            <Form method="get" className="cms-filters" preventScrollReset>
              <Select name="platform" label={t("pins.platform")} defaultValue={platform} options={HERO_PLATFORMS.map((value) => ({ value, label: t(`platform.${value}`) }))} />
              <TextField name="q" label={t("pin.search")} defaultValue={q} placeholder={t("pin.searchHint")} />
              {search.get("product") ? <input type="hidden" name="product" value={search.get("product") ?? ""} /> : null}
              <Key type="submit" size="sm" icon="magnifying-glass">
                {t("common.find")}
              </Key>
            </Form>
            {candidates.length === 0 ? (
              <p className="type-body text-ink-2">{t("pin.noCandidates")}</p>
            ) : (
              <ul role="list" className="grid gap-2 md:grid-cols-2">
                {candidates.map((candidate) => (
                  <li key={candidate.id} className="adm-card gap-1">
                    <span className="type-strong">{candidate.name}</span>
                    <span className="type-caption text-ink-2">{candidate.ready ? t("pin.ready") : t(`pin.reason.${candidate.reason ?? "unknown"}`)}</span>
                    {candidate.id === productId ? (
                      <Status tone="ok">{t("pin.chosen")}</Status>
                    ) : (
                      <Link to={withParams({ product: candidate.id, platform })} className="adm-link type-label" preventScrollReset>
                        {t("pin.choose")}
                      </Link>
                    )}
                  </li>
                ))}
              </ul>
            )}
            {product ? (
              <div className="adm-card gap-1.5">
                <Pair label={t("pin.chosenProduct")}>{product.name}</Pair>
                <Pair label={t("pin.catalogue")}>{product.readiness.ok ? <Status tone="ok">{t("pin.ready")}</Status> : <Status tone="bad">{t(`pin.reason.${product.readiness.reason ?? "unknown"}`)}</Status>}</Pair>
                {product.readiness.missing.length > 0 ? <p className="type-caption text-ink-2">{t("pin.missing", { list: product.readiness.missing.join("، ") })}</p> : null}
                <Link to={`/admin/catalog/products/${product.id}`} className="adm-link type-label">
                  {t("pin.openProduct")}
                </Link>
              </div>
            ) : null}
          </Section>

          <Section id="words" title={t("pin.words")}>
            <save.Form method="post" className="grid gap-4">
              <input type="hidden" name="intent" value="save" />
              <input type="hidden" name="version" value={version} />
              <input type="hidden" name="productId" value={productId} />
              <input type="hidden" name="platform" value={platform} />
              <L10nFields name="headline" label={t("pin.headline")} values={headline} onChange={(code, value) => setHeadline({ ...headline, [code]: value })} errors={saved.fields} required maxLength={HERO_TEXT.headline} />
              <L10nFields name="deck" label={t("pin.deck")} values={deck} onChange={(code, value) => setDeck({ ...deck, [code]: value })} errors={saved.fields} maxLength={HERO_TEXT.deck} />
              <div className="grid gap-3 sm:grid-cols-2">
                <TextField name="startsAt" type="datetime-local" ltr label={t("common.startsAt")} hint={t("common.iraqTime")} defaultValue={baghdadLocal(values?.startsAt ?? null)} error={saved.fields.startsAt} required />
                <TextField name="endsAt" type="datetime-local" ltr label={t("common.endsAt")} hint={t("pin.maxDays")} defaultValue={baghdadLocal(values?.endsAt ?? null)} error={saved.fields.endsAt} required />
              </div>
              {saved.fields.productId ? <FormError message={saved.fields.productId} /> : null}
              <FormError message={saved.message && !saved.fields.productId ? saved.message : null} />
              {editor.pin?.published ? <Note tone="warn">{t("pin.publishedNote")}</Note> : null}
              <div className="cms-actions">
                <Key type="submit" variant="ink" icon="floppy-disk" loading={saved.pending} disabled={!productId}>
                  {editor.pin?.published ? t("pin.saveChanges") : t("pin.saveDraft")}
                </Key>
                {!productId ? <span className="type-caption text-ink-2">{t("pin.chooseFirst")}</span> : null}
              </div>
            </save.Form>
          </Section>

        </div>

        <aside className="grid min-w-0 gap-3">
          {editor.pin ? (
            <div className="adm-card gap-2">
              <Pair label={t("common.state")}>
                <StateBadge state={editor.pin.state} />
              </Pair>
              {values ? (
                <>
                  <Pair label={t("common.startsAt")}>
                    <When at={values.startsAt} />
                  </Pair>
                  <Pair label={t("common.endsAt")}>
                    <When at={values.endsAt} />
                  </Pair>
                </>
              ) : null}
              {editor.overlaps.length > 0 ? (
                <Note tone="warn">
                  <p>{t("pin.overlaps", { count: editor.overlaps.length })}</p>
                  {editor.overlaps.map((other) => (
                    <Link key={other.id} to={`/admin/cms/home/pins/${other.id}`} className="adm-link type-label">
                      {other.headline || other.id}
                    </Link>
                  ))}
                </Note>
              ) : null}
              <div className="grid gap-2">
                {!editor.pin.published || editor.pin.pending ? (
                  <Key variant="ink" icon="seal-check" onClick={() => setDialog("publish")}>
                    {editor.pin.pending ? t("pin.applyChanges") : t("pin.publish")}
                  </Key>
                ) : null}
                {editor.pin.pending ? (
                  <Key size="sm" onClick={() => setDialog("discard")}>
                    {t("pin.discard")}
                  </Key>
                ) : null}
                {editor.pin.published ? (
                  <Key size="sm" variant="ghost" onClick={() => setDialog("unpublish")}>
                    {t("pin.unpublish")}
                  </Key>
                ) : null}
              </div>
            </div>
          ) : (
            <Note>
              <p>{t("pin.newNote")}</p>
            </Note>
          )}
          {editor.pin ? (
            <div className="adm-card gap-2">
              <h3 className="adm-h3">{t("preview.linkTitle")}</h3>
              <p className="type-caption text-ink-2">{t("preview.linkLead")}</p>
              <link.Form method="post">
                <input type="hidden" name="intent" value="link" />
                <Key type="submit" size="sm" icon="link" loading={made.pending}>
                  {t("preview.makeLink")}
                </Key>
              </link.Form>
              <FormError message={made.message} />
              {madePath ? (
                <Link to={madePath} className="adm-link type-label break-all">
                  {t("preview.openLink")}
                </Link>
              ) : null}
            </div>
          ) : null}
        </aside>
      </div>

      <Section
        id="preview"
        className="mt-8"
        title={t("preview.title")}
        aside={<Segmented aria-label={t("preview.language")} inline value={lang} onChange={(value) => setLang(value as Locale)} options={CONTENT_LANGS.map((entry) => ({ value: entry.code, label: entry.name, lang: entry.code }))} />}
      >
        <p className="type-caption text-ink-2">{t("preview.pinNote")}</p>
        <PreviewFrames lang={lang}>
          <PinPreview headline={previewHeadline} deck={previewDeck} card={product?.card ?? null} lang={lang} buyLabel={t("preview.buy", { name: product?.name ?? "" })} demoPrice={demoStore} />
        </PreviewFrames>
      </Section>

      <ActionDialog
        open={dialog === "publish"}
        onClose={() => setDialog(null)}
        title={editor.pin?.pending ? t("pin.applyTitle") : t("pin.publishTitle")}
        consequence={t("pin.publishConsequence")}
        confirmLabel={editor.pin?.pending ? t("pin.applyChanges") : t("pin.publish")}
        impact={[
          { label: t("pins.platform"), value: t(`platform.${values?.platform ?? platform}`) },
          { label: t("pin.chosenProduct"), value: product?.name ?? "—" },
        ]}
        fields={{ intent: "publish", version }}
        successMessage={t("pin.publishedDone")}
      />
      <ActionDialog open={dialog === "discard"} onClose={() => setDialog(null)} title={t("pin.discardTitle")} consequence={t("pin.discardConsequence")} confirmLabel={t("pin.discard")} fields={{ intent: "discard", version }} successMessage={t("pin.discarded")} />
      <ActionDialog open={dialog === "unpublish"} onClose={() => setDialog(null)} tone="destructive" title={t("pin.unpublishTitle")} consequence={t("pin.unpublishConsequence")} confirmLabel={t("pin.unpublish")} fields={{ intent: "unpublish", version }} successMessage={t("pin.unpublished")} />
    </>
  );
}
