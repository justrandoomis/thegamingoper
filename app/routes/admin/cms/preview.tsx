import { useState } from "react";
import { Link } from "react-router";

import type { Route } from "./+types/preview";
import { adminSecrets } from "~/routes/admin/shell/env.server";
import { openPreview } from "~/server/services/admin/cms/preview.server";
import type { Locale } from "~/lib/locales";
import { Segmented } from "~/ui/Segmented";
import { cmsMeta } from "./meta";
import { openCms, orRespond } from "./cms.server";
import { BannerPreview, PagePreview, PinPreview } from "./preview-parts";
import { CONTENT_LANGS, Note, PageHead, PreviewFrames, When, useCmsT, type FrameWidth } from "./ui";

/**
 * /admin/cms/preview/:token — 17.06: a signed preview link (staff only: the admin gate, then the content kind's own
 * permission; no-store and noindex like every admin page). It draws the unpublished version — a page's draft, a
 * banner's saved values, a pin's waiting changes — at a phone's and a desktop's width, in ar/en/ckb, and says when the
 * content changed after the link was made.
 */
export async function loader({ context, params }: Route.LoaderArgs) {
  const { db, actor, locale, now, ctx } = await openCms(context, ["cms.banner.manage", "cms.home.manage", "cms.page.manage", "cms.page.publish"]);
  return { preview: await orRespond(() => openPreview(db, actor, params.token, adminSecrets().SESSION_SECRET, locale, now)), demoStore: ctx.storeMode === "demo" };
}

export const meta: Route.MetaFunction = (args) => cmsMeta(args, "preview.pageTitle");

export default function PreviewPage({ loaderData }: Route.ComponentProps) {
  const t = useCmsT();
  const { preview, demoStore } = loaderData;
  const [lang, setLang] = useState<Locale>("ar");
  const [show, setShow] = useState<"both" | FrameWidth>("both");
  const back = preview.kind === "banner" ? `/admin/cms/banners/${preview.id}` : preview.kind === "pin" ? `/admin/cms/home/pins/${preview.id}` : `/admin/cms/pages/${preview.id}`;
  return (
    <>
      <PageHead
        eyebrow={
          <Link to={back} className="adm-link">
            {t(`preview.kind.${preview.kind}`)}
          </Link>
        }
        title={t("preview.pageTitle")}
        lead={t("preview.pageLead")}
      />
      <div className="mb-4 flex flex-wrap items-center gap-3">
        <Segmented aria-label={t("preview.language")} inline value={lang} onChange={(value) => setLang(value as Locale)} options={CONTENT_LANGS.map((entry) => ({ value: entry.code, label: entry.name, lang: entry.code }))} />
        <Segmented
          aria-label={t("preview.widths")}
          inline
          value={show}
          onChange={(value) => setShow(value as "both" | FrameWidth)}
          options={[
            { value: "both", label: t("preview.both") },
            { value: "phone", label: t("preview.phone"), icon: "device-mobile" },
            { value: "desktop", label: t("preview.desktop"), icon: "desktop" },
          ]}
        />
        <span className="type-caption text-ink-2">
          {t("preview.expires")} <When at={preview.expiresAt} />
        </span>
      </div>
      {preview.stale ? (
        <Note tone="warn" icon="warning-circle" className="mb-4">
          <p>{t("preview.stale")}</p>
        </Note>
      ) : null}
      <PreviewFrames lang={lang} show={show}>
        {preview.page ? <PagePreview title={preview.page.title} blocks={preview.page.blocks} lang={lang} emptyText={t("preview.emptyText")} /> : null}
        {preview.banner ? <BannerPreview title={preview.banner.title} subtitle={preview.banner.subtitle} ctaLabel={preview.banner.ctaLabel} artKey={preview.banner.artKey} accent={preview.banner.accent} lang={lang} /> : null}
        {preview.pin ? <PinPreview headline={preview.pin.config.headline} deck={preview.pin.config.deck} card={preview.pin.card} lang={lang} buyLabel={t("preview.buy", { name: preview.pin.card?.name ?? "" })} demoPrice={demoStore} /> : null}
      </PreviewFrames>
      <Note className="mt-4">
        <p>{preview.kind === "page" ? t("preview.pageNote") : t("preview.slotNote")}</p>
      </Note>
    </>
  );
}
