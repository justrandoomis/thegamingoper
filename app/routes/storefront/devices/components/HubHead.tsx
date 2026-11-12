import { Suspense, type CSSProperties, type ReactNode } from "react";
import { Await, useRouteLoaderData } from "react-router";

import { artAspect, getArt, isPhoto } from "~/art";
import { Icon, type IconName } from "~/art/Icon";
import { useFormat, useT } from "~/i18n/react";
import { SharedElement } from "~/motion";
import type { DeviceHub } from "~/server/services/devices.server";
import { Band } from "~/ui/Band";
import { BidiText } from "~/ui/BidiText";
import { DemoNote } from "~/ui/DemoNote";
import { Key } from "~/ui/Key";
import { PlatformLabel, type Platform } from "~/ui/PlatformLed";
import { Price } from "~/ui/Price";
import { fillNodes } from "~/ui/PriceTag";
import { ProductImage } from "~/ui/ProductCard";
import { headPrice, isolateName, keepTogether, researchDate, type FromOutcome } from "./format";

type RootStore = { storeMode?: string };

/**
 * The head of a device hub — Design System v2 §6.6, §4.18: the kit's `Band kind="device"` (the platform's colour
 * surface with one light behind the hardware; a lit cabinet in the dark theme), 200px on phones and 280 from 1024.
 * The device large at the inline end (its photo is the page's LCP image, preloaded; on phones beside the title, rising
 * above the band's top edge), and at the inline start: the platform pill, the h1 «كل شيء عن / PlayStation 5 Slim»
 * (the name on its own line, sharing the headline's edge — the headline bidi rule; its Latin runs isolated by the
 * kit's BidiText, so «PlayStation 5 (الطراز الأصلي 2020)» reads name first), the facts row (release date, generation,
 * «17 لعبة له في المتجر», «18 إكسسواراً له في المتجر» — verified records only), the price «من 756,500 د.ع» of the
 * cheapest version a shopper can order now (streamed: the line keeps its place) with the demo tag in demo mode — or,
 * when nothing of this device can be ordered now, «نفد حالياً» / «قريباً · الطلب يفتح عند وصوله» — and the page's one
 * action, the on-band key «تسوّق إصدارات الجهاز» (it jumps to the editions; in the dark theme it renders as the red
 * primary). A device the store does not sell new says so instead.
 *
 * The photo is the target of `<SharedElement name="device-image:<slug>">`, so a device link elsewhere (the platform
 * hub's device row, `DeviceHubLink` on product, used and support pages) grows into it. An opaque photo (not cut out
 * yet, v2 §7.5) never floats on the colour: it stands on a plate of its OWN background colour (the art manifest's), so
 * no box shows inside the plate in either theme — whatever the blend does (a white plate, as §7.5 asks in dark).
 */
export function HubHead({ hub, gel, platformName, from }: { hub: DeviceHub; gel: Platform | null; platformName: string; from: Promise<FromOutcome> }) {
  const t = useT("devices");
  const card = useT("ui-card");
  const f = useFormat();
  const root = useRouteLoaderData("root") as RootStore | undefined;
  const demo = root?.storeMode === "demo";
  const { model, counts } = hub;
  const released = researchDate(model.releasedOn, f);
  const generation = model.generation && model.generation.name !== model.name ? model.generation.name : null;
  const games = counts.games.verified;
  const accessories = counts.accessories.verified;
  const image = model.images[0] ?? null;

  const facts: { icon: IconName; text: string }[] = [];
  if (released) facts.push({ icon: "calendar-blank", text: released.kind === "year" ? t("hero.releasedYear", { year: released.text }) : t("hero.released", { date: released.text }) });
  if (generation) facts.push({ icon: "stack", text: t("hero.generation", { generation: isolateName(generation) }) });
  if (games > 0) facts.push({ icon: "game-controller", text: t("hero.games", { count: games, n: f.number(games) }) });
  if (accessories > 0) facts.push({ icon: "plug", text: t("hero.accessories", { count: accessories, n: f.number(accessories) }) });

  // «كل شيء عن» / «PlayStation 5 Slim»: the name on its own line when the sentence ends with it (every language today)
  const template = t("hero.title", { device: "{device}" });
  const title = fillNodes(template, {
    device: (
      <>
        {/\{device\}\s*$/.test(template) ? <br /> : null}
        <BidiText text={keepTogether(model.name)} />
      </>
    ),
  });

  const art = image?.artKey ? getArt(image.artKey) : undefined;
  const opaque = image ? (image.opaque !== undefined ? image.opaque !== null : isPhoto(art) && !art.transparent && art.kind !== "box-art" && art.kind !== "screenshot") : false;
  // the plate takes the colour the photo kept (the ImageRef's, else the manifest's), so the photo's own frame melts into it
  const plate = opaque ? (image?.opaque?.background ?? (isPhoto(art) ? art.background : null)) : null;
  // phones: the hardware box beside the title is as wide as the picture needs at its 176px height (a tall console
  // takes a third of the band, a handheld up to 44%), so the title keeps the rest — devices.css reads --hw-cap
  const aspect = image?.artKey ? (artAspect(image.artKey) ?? 1) : 1;
  const style = { "--hw-cap": `${Math.round((opaque ? 1 : aspect) * 176) + (opaque ? 48 : 16)}px` } as CSSProperties;
  const media = image ? (
    <SharedElement
      name={`device-image:${model.slug}`}
      target
      as="span"
      className={opaque ? "devhub-head__plate" : "render-slot absolute inset-0"}
      style={plate ? ({ "--plate": plate } as CSSProperties) : undefined}
    >
      {opaque ? (
        <span className="render-slot absolute inset-[8%]">
          <ProductImage image={image} sizes="(min-width: 1280px) 520px, (min-width: 768px) 42vw, 40vw" priority />
        </span>
      ) : (
        <ProductImage image={image} sizes="(min-width: 1280px) 600px, (min-width: 768px) 48vw, 44vw" priority />
      )}
    </SharedElement>
  ) : null;

  const line = (outcome: FromOutcome): ReactNode => {
    const state = headPrice(outcome, hub.editions);
    if (state.kind === "from") return fromPrice(t("hero.from", { price: "{price}" }), state.amount, demo);
    if (state.kind === "soon") return `${card("soon")} · ${card("soonNote")}`;
    if (state.kind === "out") return card("outNow");
    return null;
  };

  return (
    <Band kind="device" platform={gel ?? undefined} as="header" media={media} mediaClassName="devhub-head__media" className="devhub-head" style={style}>
      <div className="devhub-head__copy">
        <div className="devhub-head__top">
          {gel ? <PlatformLabel platform={gel} label={platformName} className="pill text-ink" /> : <span className="pill">{platformName}</span>}
          <h1 className="devhub-head__title type-h1">{title}</h1>
        </div>
        {facts.length > 0 ? (
          <ul role="list" className="devhub-head__facts">
            {facts.map((fact) => (
              <li key={fact.icon}>
                <Icon name={fact.icon} size={16} />
                <span>{fact.text}</span>
              </li>
            ))}
          </ul>
        ) : null}
        <div className="devhub-head__buy">
          {hub.editions.length > 0 ? (
            <>
              {/* keyed by device: a move to a sibling hub mounts a NEW boundary, which shows the reserved line at once —
                  a boundary already on screen would hold the whole navigation until the new price has streamed in */}
              <Suspense key={model.slug} fallback={<FromLine />}>
                <Await resolve={from} errorElement={<FromLine />}>
                  {(outcome) => <FromLine>{line(outcome)}</FromLine>}
                </Await>
              </Suspense>
              <Key variant="onBand" as="a" href="#versions" icon="shopping-bag">
                {t("hero.shop")}
              </Key>
            </>
          ) : (
            <p className="type-sm-strong">{t("hero.notSold")}</p>
          )}
        </div>
      </div>
    </Band>
  );
}

/** The price line's place: kept while the price streams in; the state in words when nothing can be ordered now. */
function FromLine({ children }: { children?: ReactNode }) {
  return (
    <p className="devhub-head__from" aria-hidden={children ? undefined : true}>
      {children}
    </p>
  );
}

/** «من 756,500 د.ع» (the figure in Kufi, white on the colour) + «سعر تجريبي» while the store is in demo mode. */
function fromPrice(template: string, amount: number, demo: boolean): ReactNode {
  return (
    <>
      <span>{fillNodes(template, { price: <Price amountIqd={amount} size="lg" tone="onColor" as="span" approx="off" /> })}</span>
      {demo ? <DemoNote variant="tag" what="price" onColor /> : null}
    </>
  );
}
