/**
 * /used/:slug — one used unit, the product template for a single inspected device (Design System v2 §6.8, §4.12,
 * §4.14, §4.15). Phones: the full-bleed gallery (the unit's own photos first; an illustration says so once, under the
 * stage), the buy box (platform, name, the variant line, the grade with its legend, price + «● متوفر · التوصيل …»,
 * «سعره جديداً في المتجر …», the condition notes), then the inspection report straight after it, the facts (payment,
 * guest checkout, returns), the model's hub, the accessories verified on the model and other units; the task bar at the
 * bottom [price + grade | «أضف إلى السلة»]. From 1024: the gallery in 7 columns (sticky) and the buy box in 5 with the
 * buy controls. No serial number and no private data reach this page (used.server selects none).
 *
 * Buying: one unit = one add (POST /api/cart intent=add usedUnitId=…, the commerce core). After it the bar says
 * «✓ في السلة» and its key becomes «عرض السلة (n)».
 * States: listed (default) · reserved (another order holds it: no add key, other units) · sold (410, other units) ·
 * not public / unknown (404 inside the shell) · the other-units shelf failing (the page still shows, with a retry) ·
 * an add that fails (the kit rolls back and says why beside the key) · offline (the shell's banner; the add key goes
 * flat with the reason beside it, v2 §6.17).
 */
import { useRef, useState } from "react";
import { data, useRouteLoaderData } from "react-router";

import type { Route } from "./+types/used-unit";
import { productShareImage } from "~/art";
import { Icon } from "~/art/Icon";
import { messagesFor, serverT } from "~/i18n/i18n.server";
import { LocaleLink, useFormat, useT } from "~/i18n/react";
import { DeviceHubLink } from "~/routes/storefront/devices/components/DeviceHubLink";
import { RecommendationShelves } from "~/routes/storefront/devices/components/RecommendationShelves";
import { LAYOUT_ROUTE_ID, shellMeta } from "~/routes/storefront/shell/meta";
import { TaskBar } from "~/routes/storefront/shell/TabBar";
import type { ShellHandle, ShellPayments } from "~/routes/storefront/shell/types";
import { getCtx } from "~/server/context.server";
import { getDb } from "~/server/db.server";
import { getDeviceLink } from "~/server/services/devices.server";
import { recommendationsFor } from "~/server/services/recommendations.server";
import { getOtherUsedUnits, getUsedUnitDetail } from "~/server/services/used.server";
import { BuyBar, BuyControls } from "~/ui/AddToCartKey";
import { Breadcrumbs } from "~/ui/Breadcrumbs";
import { useCartCount } from "~/ui/cart-client";
import { ErrorState } from "~/ui/ErrorState";
import { FactList, type Fact } from "~/ui/FactList";
import { Gallery } from "~/ui/Gallery";
import { GradeBadge, gradeKey } from "~/ui/GradeBadge";
import { InspectionCard } from "~/ui/InspectionCard";
import { Key } from "~/ui/Key";
import { isPlatform, PlatformLabel } from "~/ui/PlatformLed";
import { fillNodes, iqdText, PriceTag, SafePrice } from "~/ui/PriceTag";
import { BidiText } from "~/ui/ProductCard";
import { ShelfRail } from "~/ui/ShelfRail";
import { TextLink } from "~/ui/TextLink";
import { UsedUnitCard } from "~/ui/UsedUnitCard";
import { USED_PATH } from "./components/UsedFilters";
import { useUsedT } from "./i18n";
import "./used.css";

export const handle = { shell: { tabBar: false, back: USED_PATH } } satisfies ShellHandle;

export async function loader({ params, context }: Route.LoaderArgs) {
  const ctx = getCtx(context);
  const db = getDb();
  const unit = await getUsedUnitDetail(db, ctx.locale, params.slug);
  if (!unit) throw data({ error: "not_found" }, { status: 404 });
  // The shelf of other units is extra: when it fails the page still shows, and says so with a retry.
  const [others, device] = await Promise.all([
    getOtherUsedUnits(db, ctx.locale, { id: unit.id, platformSlug: unit.platform?.slug ?? null }, 8).catch((error: unknown) => {
      console.error("[used] other units failed", error);
      return null;
    }),
    // the model's hub (devices area) — null when it has none; a failure only hides the link
    getDeviceLink(db, ctx.locale, unit.model?.slug).catch((error: unknown) => {
      console.error("[used] device link failed", error);
      return null;
    }),
  ]);
  // Accessories VERIFIED on this unit's model (devices area, "complete your setup" of the device) — streamed, and only
  // that shelf: the hub's fallback of new consoles is not what someone buying this unit asked for.
  const accessories = device
    ? recommendationsFor(db, { cookie: ctx.cookie, customerId: null }, { locale: ctx.locale, context: "device_hub", deviceModelId: device.id, keep: (shelf) => shelf.key.startsWith("device_hub:setup:"), now: ctx.now }, 8)
    : null;
  const t = serverT(ctx.locale, "used");
  const shop = serverT(ctx.locale, "ui-shop");
  const realPhoto = unit.photos.find((photo) => !photo.isIllustration && photo.mediaKey);
  const share = realPhoto ? `/media/${realPhoto.mediaKey}` : (productShareImage(unit.product.slug)?.src ?? null);
  const warranty = unit.warrantyDays > 0 ? shop("days", { count: unit.warrantyDays, n: String(unit.warrantyDays) }) : t("unit.noWarranty");
  const payload = {
    unit,
    others,
    device,
    accessories,
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

type LayoutData = { shell?: { deliveryFeeIqd?: number; payments?: ShellPayments } };
type RootData = { storeMode?: string };

const OTHERS_ID = "used-others";

export default function UsedUnitPage({ loaderData }: Route.ComponentProps) {
  const { unit, others, device, accessories } = loaderData;
  const t = useUsedT();
  const shop = useT("ui-shop");
  const f = useFormat();
  const layout = useRouteLoaderData(LAYOUT_ROUTE_ID) as LayoutData | undefined;
  const root = useRouteLoaderData("root") as RootData | undefined;
  const fee = layout?.shell?.deliveryFeeIqd ?? null;
  const payments = layout?.shell?.payments ?? null;
  const stage = useRef<HTMLDivElement>(null);
  const [added, setAdded] = useState(false);
  const listed = unit.status === "listed";
  const days = (n: number) => shop("days", { count: n, n: f.number(n) });
  const warranty = unit.warrantyDays > 0 ? t("unit.warranty", { days: days(unit.warrantyDays) }) : t("unit.noWarranty");
  const picture = () => stage.current?.querySelector(".stage") ?? null;
  const firstPhoto = unit.photos[0] ?? null;
  // «A+ · كالجديد» — the grade isolated left to right, so it never reads "+A" inside Arabic or Sorani.
  const gradeWords = `⁦${unit.grade}⁩ · ${shop(`grade.words.${gradeKey(unit.grade)}`)}`;
  const variantLine = unit.subtitle && addsToName(unit.subtitle, unit.name) ? unit.subtitle : null;
  // Demo price and stock are marked beside the price while the store runs in demo mode (v2 §4.7).
  const demo = unit.isDemo && root?.storeMode !== "live";
  // Offline (v2 §6.17): the kit's add key goes flat and says why itself — beside the key in the buy box, on the bar's
  // own line in the task bar — never a tap that can only fail.
  const buy = { item: { usedUnitId: unit.id }, name: unit.name, image: firstPhoto, optionsLabel: gradeWords, source: picture, onAdded: () => setAdded(true) };

  return (
    <div className="page grid grid-cols-[minmax(0,1fr)] gap-section pt-0 pb-6 md:pt-4 lg:pt-6">
      <div className="grid grid-cols-[minmax(0,1fr)] gap-6">
        <Breadcrumbs items={[{ label: t("unit.crumbs.home"), href: "/" }, { label: t("unit.crumbs.used"), href: USED_PATH }, { label: unit.name }]} />

        <div className="grid grid-cols-[minmax(0,1fr)] gap-4 md:gap-6 lg:grid-cols-12 lg:gap-10">
          {/* Phones: the stage runs edge to edge (v2 §4.14); the line under it and the thumbnails keep the gutter. */}
          <div ref={stage} className="min-w-0 max-md:-mx-(--gutter) lg:sticky lg:top-[calc(var(--shell-header-h)+var(--safe-top)+var(--s-4))] lg:col-span-7 lg:self-start">
            <Gallery
              name={unit.name}
              items={unit.photos.map((image) => ({ image }))}
              evidence="used"
              sharedName={`used-image:${unit.id}`}
              priority
              className="max-md:[&>.thumbs]:px-(--gutter) max-md:[&>[data-evidence]]:px-(--gutter)"
            />
          </div>

          <div className="grid min-w-0 content-start gap-4 lg:col-span-5">
            <div className="grid gap-2">
              {unit.platform ? isPlatform(unit.platform.slug) ? <PlatformLabel platform={unit.platform.slug} /> : <span className="type-sm-strong text-ink-2">{unit.platform.name}</span> : null}
              <h1 className="type-h1 text-ink [text-wrap:balance]">
                <BidiText text={unit.name} />
              </h1>
              {variantLine ? (
                <p className="type-sm text-ink-2">
                  <BidiText text={variantLine} />
                </p>
              ) : null}
            </div>

            {/* Phones (v2 §6.7 first screen): the price, its demo badge and «● متوفر · التوصيل …» come first so they sit
                above the buy bar at 390×844 — the bar itself shows the grade; the grade row follows the price. */}
            <div className="grid gap-4">
            <div className="flex flex-wrap items-center gap-x-3 gap-y-2 max-md:order-last">
              <GradeBadge grade={unit.grade} legend />
              <span className="type-sm text-ink-2">{shop(`grade.hints.${gradeKey(unit.grade)}`)}</span>
            </div>

            {unit.status === "reserved" || unit.status === "sold" ? (
              <div className="callout callout--warn" role="status">
                <Icon name={unit.status === "sold" ? "warning-circle" : "clock"} size={20} />
                <span className="grid gap-0.5">
                  <span className="callout__title">{unit.status === "sold" ? t("unit.sold") : t("unit.reserved")}</span>
                  <span className="callout__text">{unit.status === "sold" ? t("unit.soldText") : t("unit.reservedText")}</span>
                </span>
              </div>
            ) : null}

            {unit.status !== "sold" ? (
              <PriceTag
                size="page"
                priceIqd={unit.priceIqd}
                stock={listed ? "in_stock" : null}
                deliveryIqd={listed ? fee : null}
                demo={demo}
                approx="off"
                aside={
                  <p className="type-sm text-ink-2">
                    {t("unit.oneUnit")} · {warranty}
                  </p>
                }
              />
            ) : null}
            </div>

            {unit.newPriceIqd !== null && unit.status !== "sold" ? (
              <p className="type-sm text-ink-2">
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

            {unit.cosmeticNotes ? (
              <div className="grid gap-1 border-t border-line pt-4">
                <h2 className="type-sm-strong text-ink">{t("unit.condition")}</h2>
                <p className="type-body text-ink">{unit.cosmeticNotes}</p>
              </div>
            ) : null}

            <div className="hidden lg:grid lg:gap-2">
              {listed ? (
                added ? (
                  <InCart />
                ) : (
                  <BuyControls {...buy} />
                )
              ) : (
                <Key as="a" href={`#${OTHERS_ID}`} iconEnd="arrow-down" className="justify-self-start">
                  {t("unit.seeOthers")}
                </Key>
              )}
            </div>

            {unit.location ? (
              <p className="flex items-center gap-1.5 type-sm text-ink-2">
                <Icon name="map-pin" size={16} />
                {t("unit.location", { place: unit.location.name })}
              </p>
            ) : null}
          </div>
        </div>
      </div>

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
        // the gallery already says, under the stage, when the pictures are illustrations (v2 §6.8: once)
        illustrationNote={false}
        className="lg:max-w-[52rem]"
      />

      {listed ? <UnitFacts payments={payments} returnDays={unit.returnDays} className="lg:max-w-[52rem]" /> : null}

      {/* Devices area: the model's hub (its picture grows into the hub's stage) and the accessories verified on the model. */}
      {device ? <DeviceHubLink device={device} title={t("unit.hubTitle", { device: device.name })} text={t("unit.hubText")} className="lg:max-w-[52rem]" /> : null}
      <RecommendationShelves key={unit.id} result={accessories} source="used" />

      <div id={OTHERS_ID}>
        {others === null ? (
          // A locale-less path: the retry link adds the language prefix itself (location.pathname already has it, so
          // /en/used/… became /en/en/used/…, a 404).
          <ErrorState title={t("unit.othersFailed")} retryHref={`${USED_PATH}/${unit.slug}`} />
        ) : (
          <ShelfRail
            shelf={{ key: "used-others", title: t("unit.others"), reason: t("unit.othersReason"), items: others }}
            href={USED_PATH}
            viewAllLabel={t("unit.allUsed")}
            // the kit's rail brings a card that takes the keyboard's focus to its start
            renderItem={(item) => <UsedUnitCard unit={item} slot="used-others" />}
          />
        )}
      </div>

      <TaskBar aria-label={t("unit.buy")} className="lg:hidden">
        {listed ? (
          // the kit's bar, bare inside the shell's task bar: the price and the grade, «أضف إلى السلة» — then «✓ في
          // السلة» and «عرض السلة (n)»; offline or a failed add say so on its own line
          <BuyBar {...buy} bare priceIqd={unit.priceIqd} />
        ) : (
          // reserved or sold: no add key — the unit's state and the way to the other units
          <div className="buybar min-h-0 p-0">
            <div className="buybar__info">
              {unit.status === "sold" ? <span className="type-sm-strong text-ink-2">{t("unit.sold")}</span> : <SafePrice amountIqd={unit.priceIqd} size="lg" approx="off" as="span" />}
              <span className="buybar__var">{unit.status === "reserved" ? t("unit.reserved") : gradeWords}</span>
            </div>
            <div className="flex flex-wrap justify-end [&_.key]:min-w-[168px]">
              <Key as="a" href={`#${OTHERS_ID}`}>
                {t("unit.seeOthers")}
              </Key>
            </div>
          </div>
        )}
      </TaskBar>
    </div>
  );
}

/** After the add: the unit is in the cart (one unit = one line) — the next step is the cart. */
function InCart() {
  const t = useUsedT();
  return (
    <div className="grid justify-items-start gap-2">
      <p className="flex items-center gap-1.5 type-sm-strong text-ok" role="status">
        <Icon name="check-circle" size={20} filled />
        {t("unit.inCart")}
      </p>
      <ViewCart />
    </div>
  );
}

function ViewCart() {
  const shop = useT("ui-shop");
  const f = useFormat();
  const { count } = useCartCount();
  return (
    <Key as={LocaleLink} to="/cart" variant="primary" iconEnd="arrow-right">
      {shop("add.viewCartCount", { n: f.number(count) })}
    </Key>
  );
}

/** Payment, guest checkout and returns, in the store's own settings (only the methods that are switched on). */
function UnitFacts({ payments, returnDays, className }: { payments: ShellPayments | null; returnDays: number; className?: string }) {
  const t = useUsedT();
  const shop = useT("ui-shop");
  const f = useFormat();
  // The wallet is named only to a signed-in shopper (v2 §6.7): this page does not know who is signed in, so it is left out.
  const methods = payments ? (["cod", "zaincash", "card"] as const).filter((method) => payments[method]).map((method) => t(`unit.facts.methods.${method}`)) : [];
  const facts: Fact[] = [];
  if (methods.length > 0) facts.push({ id: "pay", icon: "money", title: t("unit.facts.payment"), text: `${methods.join(t("unit.facts.or"))}. ${payments?.card || payments?.zaincash ? t("unit.facts.transferRule") : ""}`.trim() });
  facts.push({ id: "guest", icon: "user", title: t("unit.facts.guest"), text: t("unit.facts.guestText") });
  facts.push({
    id: "returns",
    icon: "arrow-counter-clockwise",
    title: returnDays > 0 ? t("unit.facts.returns", { days: shop("days", { count: returnDays, n: f.number(returnDays) }) }) : t("unit.facts.returnsPolicy"),
    text: t("unit.facts.returnsText"),
    link: { label: t("unit.facts.returnsLink"), to: "/policies/returns" },
  });
  return (
    <section aria-label={t("unit.facts.title")} className={className}>
      <FactList facts={facts} />
    </section>
  );
}

/** True when the variant's title says something the product name does not (a word of it is missing from the name). */
function addsToName(subtitle: string, name: string): boolean {
  const words = (text: string) => text.toLocaleLowerCase("en").split(/[\s()\-–—·,،]+/).filter(Boolean);
  const inName = new Set(words(name));
  return words(subtitle).some((word) => !inName.has(word));
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
