/**
 * /used/:slug — one used unit (brief §5, DESIGN.md §8.4/§8.10 product page, §9.6 used gallery, §9.20 inspection
 * card). The gallery is never lit and labels every picture: a real photo of this unit, or — for the demo units, which
 * only carry the maker's photo of the model — "صورة توضيحية — ليست صورة الجهاز نفسه". The inspection card shows the
 * grade, the checklist, battery health when measurable, the defects in words, what is included, the store warranty
 * and the return window. No serial number and no private data reach this page (used.server selects none).
 *
 * Buying: one unit = one add (POST /api/cart intent=add usedUnitId=…, the commerce core) — the task bar on phones and
 * tablets (the tab bar gives way), the buy controls in the info column from 1024px.
 * States: listed (default) · reserved (another order holds it: no add key, other units) · sold (410, other units) ·
 * not public / unknown (404 inside the shell) · the other-units shelf failing (the page still shows, with a retry).
 */
import { useRef } from "react";
import { data, useLocation, useRouteLoaderData } from "react-router";

import type { Route } from "./+types/used-unit";
import { productShareImage } from "~/art";
import { Icon } from "~/art/Icon";
import { messagesFor, serverT } from "~/i18n/i18n.server";
import { LocaleLink, useFormat, useT } from "~/i18n/react";
import { LAYOUT_ROUTE_ID, shellMeta } from "~/routes/storefront/shell/meta";
import { TaskBar } from "~/routes/storefront/shell/TabBar";
import type { ShellHandle } from "~/routes/storefront/shell/types";
import { getCtx } from "~/server/context.server";
import { getDb } from "~/server/db.server";
import { getOtherUsedUnits, getUsedUnitDetail } from "~/server/services/used.server";
import { AddToCartKey, BuyControls } from "~/ui/AddToCartKey";
import { Breadcrumbs } from "~/ui/Breadcrumbs";
import { ErrorState } from "~/ui/ErrorState";
import { Gallery } from "~/ui/Gallery";
import { GradeBadge, gradeKey } from "~/ui/GradeBadge";
import { InspectionCard } from "~/ui/InspectionCard";
import { Key } from "~/ui/Key";
import { isPlatform, PlatformLabel } from "~/ui/PlatformLed";
import { Price } from "~/ui/Price";
import { fillNodes, iqdText, PriceTag } from "~/ui/PriceTag";
import { BidiText } from "~/ui/ProductCard";
import { ShelfRail } from "~/ui/ShelfRail";
import { Status } from "~/ui/Tag";
import { TextLink } from "~/ui/TextLink";
import { UsedUnitCard } from "~/ui/UsedUnitCard";
import { USED_PATH } from "./components/UsedFilters";
import { useUsedT } from "./i18n";

export const handle = { shell: { tabBar: false } } satisfies ShellHandle;

export async function loader({ params, context }: Route.LoaderArgs) {
  const ctx = getCtx(context);
  const db = getDb();
  const unit = await getUsedUnitDetail(db, ctx.locale, params.slug);
  if (!unit) throw data({ error: "not_found" }, { status: 404 });
  // The shelf of other units is extra: when it fails the page still shows, and says so with a retry.
  const others = await getOtherUsedUnits(db, ctx.locale, { id: unit.id, platformSlug: unit.platform?.slug ?? null }, 8).catch((error: unknown) => {
    console.error("[used] other units failed", error);
    return null;
  });
  const t = serverT(ctx.locale, "used");
  const shop = serverT(ctx.locale, "ui-shop");
  const realPhoto = unit.photos.find((photo) => !photo.isIllustration && photo.mediaKey);
  const share = realPhoto ? `/media/${realPhoto.mediaKey}` : (productShareImage(unit.product.slug)?.src ?? null);
  const warranty = unit.warrantyDays > 0 ? shop("days", { count: unit.warrantyDays, n: String(unit.warrantyDays) }) : t("unit.noWarranty");
  const payload = {
    unit,
    others,
    meta: {
      title: t("unit.metaTitle", { name: unit.name }),
      description: t("unit.metaDescription", { name: unit.name, grade: shop(`grade.words.${gradeKey(unit.grade)}`), warranty }),
      image: share,
    },
    i18n: messagesFor(ctx.locale, "used", "errors"),
  };
  // A sold unit's page still explains itself (and offers others) — with 410 so search engines drop it.
  return unit.status === "sold" ? data(payload, { status: 410 }) : payload;
}

export const meta: Route.MetaFunction = (args) =>
  shellMeta(args, { title: args.loaderData?.meta.title, description: args.loaderData?.meta.description, image: args.loaderData?.meta.image, type: "product" });

type LayoutData = { shell?: { deliveryFeeIqd?: number } };

export default function UsedUnitPage({ loaderData }: Route.ComponentProps) {
  const { unit, others } = loaderData;
  const t = useUsedT();
  const shop = useT("ui-shop");
  const f = useFormat();
  const location = useLocation();
  const layout = useRouteLoaderData(LAYOUT_ROUTE_ID) as LayoutData | undefined;
  const fee = layout?.shell?.deliveryFeeIqd ?? null;
  const stage = useRef<HTMLDivElement>(null);
  const listed = unit.status === "listed";
  const days = (n: number) => shop("days", { count: n, n: f.number(n) });
  const warranty = unit.warrantyDays > 0 ? t("unit.warranty", { days: days(unit.warrantyDays) }) : t("unit.noWarranty");
  const picture = () => stage.current?.querySelector(".stage") ?? null;
  const firstPhoto = unit.photos[0] ?? null;

  return (
    <div className="page grid grid-cols-[minmax(0,1fr)] gap-section pt-3 pb-12 lg:pt-6">
      <Breadcrumbs items={[{ label: t("unit.crumbs.home"), href: "/" }, { label: t("unit.crumbs.used"), href: USED_PATH }, { label: unit.name }]} />

      <div className="grid gap-6 lg:grid-cols-12 lg:gap-10">
        <div ref={stage} className="min-w-0 lg:sticky lg:top-[calc(var(--shell-header-h)+var(--s-4))] lg:col-span-7 lg:self-start">
          <Gallery name={unit.name} items={unit.photos.map((image) => ({ image }))} evidence="used" sharedName={`used-image:${unit.id}`} priority />
        </div>

        <div className="grid min-w-0 content-start gap-5 lg:col-span-5">
          <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
            <GradeBadge grade={unit.grade} legend />
            {unit.platform && isPlatform(unit.platform.slug) ? <PlatformLabel platform={unit.platform.slug} /> : unit.platform ? <span className="type-label text-ink-2">{unit.platform.name}</span> : null}
          </div>

          <div className="grid gap-1">
            <h1 className="type-title text-ink">
              <BidiText text={unit.name} />
            </h1>
            {unit.subtitle ? (
              <p className="type-body text-ink-2">
                <BidiText text={unit.subtitle} />
              </p>
            ) : null}
          </div>

          {unit.status === "reserved" ? (
            <div className="grid gap-1 rounded-md bg-niche p-3" role="status">
              <Status tone="warn" className="font-semibold">
                {t("unit.reserved")}
              </Status>
              <p className="type-caption text-ink-2">{t("unit.reservedText")}</p>
            </div>
          ) : unit.status === "sold" ? (
            <div className="grid gap-1 rounded-md bg-niche p-3" role="status">
              <Status tone="bad" className="font-semibold">
                {t("unit.sold")}
              </Status>
              <p className="type-caption text-ink-2">{t("unit.soldText")}</p>
            </div>
          ) : null}

          {unit.status !== "sold" ? (
            <PriceTag
              size="page"
              priceIqd={unit.priceIqd}
              deliveryIqd={listed ? fee : null}
              aside={
                <span className="type-caption text-ink-2">
                  {t("unit.oneUnit")} · {warranty}
                </span>
              }
            />
          ) : null}

          {unit.newPriceIqd !== null && unit.status !== "sold" ? (
            <p className="type-caption text-ink-2">
              {fillNodes(t("unit.newPrice"), { price: <bdi className="nums">{iqdText(f, unit.newPriceIqd)}</bdi> })}
              {unit.product.published ? (
                <>
                  {" · "}
                  <TextLink as={LocaleLink} to={`/p/${unit.product.slug}`} inline>
                    {t("unit.newPage")}
                  </TextLink>
                </>
              ) : null}
            </p>
          ) : null}

          {listed ? (
            <div className="hidden lg:block">
              <BuyControls item={{ usedUnitId: unit.id }} name={unit.name} image={firstPhoto} optionsLabel={unit.subtitle} source={picture} />
            </div>
          ) : (
            <Key as={LocaleLink} to={USED_PATH} iconEnd="arrow-right" className="hidden justify-self-start lg:inline-flex">
              {t("unit.browse")}
            </Key>
          )}

          {unit.location ? (
            <p className="flex items-center gap-1.5 type-caption text-ink-2">
              <Icon name="map-pin" size={16} />
              {t("unit.location", { place: unit.location.name })}
            </p>
          ) : null}

          {!unit.hasRealPhotos ? (
            <p className="flex items-start gap-2 rounded-md bg-niche px-3 py-2 type-caption font-medium text-warn">
              <Icon name="image" size={16} className="mt-0.5 shrink-0" />
              <span>{t("unit.illustrationNote")}</span>
            </p>
          ) : null}
        </div>
      </div>

      {unit.cosmeticNotes ? (
        <section aria-labelledby="unit-condition" className="grid max-w-[70ch] gap-2">
          <h2 id="unit-condition" className="type-section text-ink">
            {t("unit.condition")}
          </h2>
          <p className="type-body text-ink">{unit.cosmeticNotes}</p>
        </section>
      ) : null}

      <InspectionCard
        grade={unit.grade}
        inspectedAt={unit.inspectedAt}
        batteryHealthPct={unit.batteryHealthPct}
        checklist={unit.checklist}
        defects={unit.defects.map((defect) => ({ text: t("unit.defect", { text: defect.text, severity: t(`unit.severity.${defect.severity}`) }) }))}
        included={unit.included.map((item) => item.label ?? t(`unit.included.${item.key in INCLUDED_KEYS ? item.key : "extra"}`))}
        photos={unit.photos}
        warrantyDays={unit.warrantyDays}
        returnDays={unit.returnDays}
        ownershipChecked={unit.ownershipChecked}
        dataWiped={unit.dataWiped}
        isDemo={unit.isDemo}
        className="lg:max-w-[52rem]"
      />

      {/* Integration slot (devices area): accessories that fit this unit's model — getRecommendations(db, { context: "device_hub",
          deviceModelId }) — and the device hub link (/device/<unit.model.slug>). Wired by the integration pass. */}

      {others === null ? (
        <ErrorState title={t("unit.othersFailed")} retryHref={location.pathname} />
      ) : (
        <ShelfRail
          shelf={{ key: "used-others", title: t("unit.others"), reason: t("unit.othersReason"), items: others }}
          href={USED_PATH}
          renderItem={(item) => <UsedUnitCard unit={item} slot="used-others" />}
        />
      )}

      <TaskBar aria-label={t("unit.buy")} className="lg:hidden">
        {listed ? (
          <div className="mx-auto flex max-w-[40rem] items-center gap-3">
            <Price amountIqd={unit.priceIqd} size="lg" approx="off" className="shrink-0" />
            <div className="flex min-w-0 flex-1 flex-wrap gap-y-1.5">
              <AddToCartKey variant="key" item={{ usedUnitId: unit.id }} name={unit.name} image={firstPhoto} optionsLabel={unit.subtitle} source={picture} block className="w-full [--h:52px] [--px:14px]" />
            </div>
          </div>
        ) : (
          <div className="mx-auto max-w-[40rem]">
            <Key as={LocaleLink} to={USED_PATH} block iconEnd="arrow-right">
              {t("unit.browse")}
            </Key>
          </div>
        )}
      </TaskBar>
    </div>
  );
}

/** Keys of what-is-included that have their own words in this namespace (others use "ملحق آخر" when unlabelled). */
const INCLUDED_KEYS = {
  controller: 1,
  controllers: 1,
  power_cable: 1,
  hdmi_cable: 1,
  original_box: 1,
  dock: 1,
  joy_con_pair: 1,
  joy_con_grip: 1,
  ac_adapter: 1,
  charger: 1,
  carrying_case: 1,
} as const;
