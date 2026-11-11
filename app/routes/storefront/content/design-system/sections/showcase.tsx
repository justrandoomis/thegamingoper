// lint-design: allow primary-count — each showcase band carries its own action; the page is a reference, not a view.
import { LocaleLink, useT } from "~/i18n/react";
import type { ImageRef } from "~/lib/dto";
import { Band } from "~/ui/Band";
import { CategoryTile, CategoryTiles } from "~/ui/CategoryTile";
import { CompatList } from "~/ui/CompatBadge";
import { ContactCard } from "~/ui/ContactCard";
import { DemoNote } from "~/ui/DemoNote";
import { EntryCard } from "~/ui/EntryCard";
import { FactList } from "~/ui/FactList";
import { Key } from "~/ui/Key";
import { PLATFORMS, type Platform } from "~/ui/PlatformLed";
import { PlatformTile, PlatformTiles } from "~/ui/PlatformTile";
import { Price } from "~/ui/Price";
import { ReleaseBand } from "~/ui/ReleaseBand";
import { SectionHead } from "~/ui/SectionHead";
import { Render } from "~/ui/Stage";
import { TextLink } from "~/ui/TextLink";
import { TrustStrip } from "~/ui/TrustStrip";
import { DsBlock, defineCopy, Specimen, SpecimenGrid, useCopy, type DsSectionMeta } from "../kit";

/**
 * Showcases — Design System v2 §4.18–§4.25: the bands, the platform tiles, the trust strip and fact rows, the release
 * band, the section head, the entry and category tiles, the contact card and compatibility rows. Switch the theme at
 * the top: in the dark theme the bands and tiles become lit cabinets.
 */
export const section: DsSectionMeta = {
  id: "showcase",
  order: 4,
  title: { ar: "الواجهات والأبواب", en: "Showcases and doors", ckb: "پیشانگا و دەرگاکان" },
  owner: "app/ui — Band, PlatformTile, TrustStrip, FactList, ReleaseBand, SectionHead, EntryCard, CategoryTile, ContactCard",
};

const COPY = defineCopy({
  ar: {
    bands: "الأشرطة",
    bandsNote: "الضوء الملوّن للواجهات وحدها: شريط قرمزي مع ضوء واحد خلف المنتج في الوضع الفاتح، وخزانة مضاءة في الداكن. النص لا يجلس على قلب الضوء، والعنوان العربي والاسم اللاتيني على حافة واحدة.",
    playOn: "العب على",
    heroLine: "شاشة 7.9 بوصة · 256GB · حتى 4K على التلفاز",
    buy: "اشترِ Nintendo Switch 2",
    details: "تفاصيل الجهاز",
    hubLine: "التوصيل 5,000 د.ع لكل المحافظات · الدفع عند الاستلام",
    deviceLine: "17 لعبة له في المتجر",
    walletLabel: "رصيد المحفظة",
    topup: "اشحن الرصيد",
    history: "سجل الحركات",
    tiles: "بلاطات المنصات",
    tilesNote: "أبواب المتجر الأربعة: طين على سطح المنصة، والجهاز يقف فوق حافة البلاطة. الضوء خلف الجهاز وحده، فالنص الأبيض يبقى بين 4.8 و6.6 إلى 1. والصغيرة لصفيحة التصنيفات وصفحة 404.",
    tilesLabel: "تسوّق حسب المنصّة",
    trust: "شريط الثقة وصفوف الحقائق",
    trustNote: "أربع حقائق صادقة يظهر كل منها فقط حين تكون صحيحة في إعدادات الإدارة. السطر المختصر تحت مفتاح الإتمام. صفوف الحقائق لصفحة المنتج والسلة.",
    deliveryFact: "التوصيل 5,000 د.ع لكل المحافظات",
    deliveryFactText: "تختار المحافظة والوقت المفضّل عند إتمام الطلب.",
    returnsFact: "الإرجاع خلال 7 أيام من الاستلام",
    returnsFactText: "وفق سياسة الإرجاع.",
    returnsLink: "سياسة الإرجاع",
    warrantyFact: "ضمان الشركة المصنّعة",
    warrantyFactText: "اسألنا عن شروط الضمان.",
    release: "شريط الإصدارات",
    releaseNote: "الشريط الداكن الوحيد في الصفحة: أرقام الأيام الكبيرة، و«بعد 8 أيام» خلال 30 يوماً فقط، والطلب يفتح عند الوصول. لا عدّاد تنازلي ولا طلب مسبق.",
    sectionHead: "رأس القسم",
    sectionHeadNote: "عنوان وسبب صادق في البداية، و«عرض الكل» في النهاية.",
    newTitle: "وصل حديثاً",
    newReason: "أحدث ما أضفناه، والمتوفر الآن",
    entries: "بطاقات الخدمات والتصنيفات",
    entriesNote: "بطاقة الخدمة كلها رابط واحد بصورة على أرضية المنتج أو الشعار. بلاطة التصنيف بئر مربع وعنوان وعدد من البيانات.",
    used: "المستعمل والمفحوص",
    usedLine: "أجهزة فحصناها، بتقرير وصور لكل جهاز.",
    usedCta: "تصفّح المستعمل",
    support: "الدعم",
    supportLine: "تتبّع طلبك، والصيانة، وتحدّث مع موظف.",
    supportCta: "افتح مركز الدعم",
    controllers: "أيدي التحكم",
    headsets: "سماعات الرأس",
    storage: "التخزين",
    cards: "بطاقات الشحن",
    games: "الألعاب",
    accessories: "الإكسسوارات",
    contact: "بطاقة التواصل",
    contactNote: "قنوات حقيقية فقط من الإعدادات. هذا مثال للعرض. بلا قناة مضبوطة لا تظهر البطاقة أبداً، ويظهر «اكتب لموظف» مكانها.",
    address: "بغداد، الكرادة — مثال للعرض",
    hours: "السبت – الخميس، 10 صباحاً – 10 مساءً (مثال)",
    reply: "خلال ساعة (مثال)",
    compatTitle: "صفوف التوافق",
    compatNote: "أيقونة وكلمة حالة لكل جهاز: يعمل · يعمل جزئياً · لا يعمل · لم نتحقق.",
    partialNote: "يحتاج تحديث البرنامج",
    sample: "الأسعار والأرقام في هذا القسم أمثلة للعرض.",
  },
  en: {
    bands: "Bands",
    bandsNote: "Colour light belongs to showcases: a crimson band with one light behind the product in the light theme, a lit cabinet in the dark. Copy never sits on the light core; the Arabic line and the Latin name share one edge.",
    playOn: "Play on",
    heroLine: "7.9-inch screen · 256GB · up to 4K on the TV",
    buy: "Buy Nintendo Switch 2",
    details: "Device details",
    hubLine: "Delivery 5,000 IQD to every governorate · Cash on delivery",
    deviceLine: "17 games for it in the store",
    walletLabel: "Wallet balance",
    topup: "Top up",
    history: "Activity",
    tiles: "Platform tiles",
    tilesNote: "The store's four doors: clay on the platform's surface, the hardware standing above the tile's edge. The light sits behind the hardware only, so white text stays at 4.8 to 6.6:1. The compact tiles are for the categories sheet and the 404 page.",
    tilesLabel: "Shop by platform",
    trust: "Trust strip and fact rows",
    trustNote: "Four honest facts, each shown only when it is true in the admin settings. The short line goes under the checkout button. Fact rows for the product page and the cart.",
    deliveryFact: "Delivery 5,000 IQD to every governorate",
    deliveryFactText: "You choose the governorate and a preferred time at checkout.",
    returnsFact: "Returns within 7 days of delivery",
    returnsFactText: "Under the returns policy.",
    returnsLink: "Returns policy",
    warrantyFact: "Manufacturer warranty",
    warrantyFactText: "Ask us about the warranty terms.",
    release: "Release band",
    releaseNote: "The page's one dark band: large day numerals, «In 8 days» only within 30 days, orders open on arrival. No countdowns, no pre-orders.",
    sectionHead: "Section head",
    sectionHeadNote: "A title and an honest reason at the start, «View all» at the end.",
    newTitle: "New arrivals",
    newReason: "The newest we added, in stock now",
    entries: "Service and category cards",
    entriesNote: "A service card is one link with a picture on the product ground or the mascot. A category tile is a square well, a label and a count from data.",
    used: "Used & inspected",
    usedLine: "Devices we inspected, with a report and photos of each one.",
    usedCta: "Browse used devices",
    support: "Support",
    supportLine: "Track an order, repairs, and talk to a person.",
    supportCta: "Open the support centre",
    controllers: "Controllers",
    headsets: "Headsets",
    storage: "Storage",
    cards: "Gift cards",
    games: "Games",
    accessories: "Accessories",
    contact: "Contact card",
    contactNote: "Real channels from the settings only. This one is a display example. With no channel configured the card never renders; «Write to a person» takes its place.",
    address: "Baghdad, Karrada — display example",
    hours: "Saturday – Thursday, 10 am – 10 pm (example)",
    reply: "within an hour (example)",
    compatTitle: "Compatibility rows",
    compatNote: "An icon and a state word per device: works · works partly · does not work · not checked.",
    partialNote: "Needs a software update",
    sample: "Prices and numbers in this section are display examples.",
  },
  ckb: {
    bands: "شریتەکان",
    bandsNote: "ڕووناکیی ڕەنگاوڕەنگ تەنها بۆ پیشانگاکانە: شریتێکی قرمزی بە یەک ڕووناکی لە پشت کاڵاکەوە لە ڕووکاری ڕووندا، و کابینەیەکی ڕووناک لە تاریکدا.",
    playOn: "یاری بکە لەسەر",
    heroLine: "شاشەی 7.9 ئینج · 256GB · تا 4K لەسەر تەلەفزیۆن",
    buy: "Nintendo Switch 2 بکڕە",
    details: "وردەکاریی ئامێرەکە",
    hubLine: "گەیاندن 5,000 دینار بۆ هەموو پارێزگاکان · پارەدان لە کاتی وەرگرتن",
    deviceLine: "17 یاری بۆی لە فرۆشگادا",
    walletLabel: "باڵانسی جزدان",
    topup: "باڵانس پڕ بکەرەوە",
    history: "جووڵەکان",
    tiles: "تایلەکانی پلاتفۆرم",
    tilesNote: "چوار دەرگای فرۆشگاکە: قوڕ لەسەر ڕووی پلاتفۆرمەکە، ئامێرەکە لە سەرووی لێواری تایلەکەوە وەستاوە. تایلە بچووکەکان بۆ پەڕەی پۆلەکان و پەڕەی 404ن.",
    tilesLabel: "بەپێی پلاتفۆرم بکڕە",
    trust: "شریتی متمانە و ڕیزی ڕاستییەکان",
    trustNote: "چوار ڕاستیی ڕاستگۆ، هەر یەکەیان تەنها کاتێک دەردەکەوێت کە لە ڕێکخستنەکانی بەڕێوەبردندا ڕاست بێت.",
    deliveryFact: "گەیاندن 5,000 دینار بۆ هەموو پارێزگاکان",
    deliveryFactText: "لە کاتی تەواوکردنی داواکاریدا پارێزگا و کاتی دڵخواز هەڵدەبژێریت.",
    returnsFact: "گەڕاندنەوە لە ماوەی 7 ڕۆژدا",
    returnsFactText: "بەپێی سیاسەتی گەڕاندنەوە.",
    returnsLink: "سیاسەتی گەڕاندنەوە",
    warrantyFact: "گەرەنتیی کۆمپانیای بەرهەمهێنەر",
    warrantyFactText: "دەربارەی مەرجەکانی گەرەنتی پرسیارمان لێ بکە.",
    release: "شریتی دەرچوون",
    releaseNote: "تاکە شریتی تاریکی پەڕەکە: ژمارەی گەورەی ڕۆژ، «دوای 8 ڕۆژ» تەنها لە ماوەی 30 ڕۆژدا. بێ ژمێرەری پێچەوانە و بێ داواکاریی پێشوەختە.",
    sectionHead: "سەری بەش",
    sectionHeadNote: "ناونیشان و هۆیەکی ڕاستگۆ لە سەرەتا، «هەمووی ببینە» لە کۆتایی.",
    newTitle: "تازە گەیشتوو",
    newReason: "نوێترین ئەوەی زیادمان کرد، ئێستا بەردەستە",
    entries: "کارتی خزمەتگوزاری و پۆلەکان",
    entriesNote: "کارتی خزمەتگوزاری یەک بەستەرە بە وێنەیەک لەسەر زەوی کاڵا یان دروشمەکە. تایلی پۆل بیرێکی چوارگۆشە و ناو و ژمارەیەکە.",
    used: "بەکارهاتوو و پشکنراو",
    usedLine: "ئامێرێک کە پشکنیمان، بە ڕاپۆرت و وێنەی هەر یەکەیان.",
    usedCta: "بەکارهاتووەکان ببینە",
    support: "پشتگیری",
    supportLine: "بەدواداچوونی داواکاری، چاککردنەوە، و قسەکردن لەگەڵ کارمەندێک.",
    supportCta: "ناوەندی پشتگیری بکەرەوە",
    controllers: "دەستەکان",
    headsets: "هێدسێتەکان",
    storage: "بیرگە",
    cards: "کارتی پڕکردنەوە",
    games: "یارییەکان",
    accessories: "پاشکۆکان",
    contact: "کارتی پەیوەندی",
    contactNote: "تەنها کەناڵی ڕاستەقینە لە ڕێکخستنەکانەوە. ئەمە نموونەیەکی پیشاندانە. بەبێ کەناڵ کارتەکە هەرگیز دەرناکەوێت.",
    address: "بەغدا، کەڕادە — نموونەی پیشاندان",
    hours: "شەممە – پێنجشەممە، 10ی بەیانی – 10ی شەو (نموونە)",
    reply: "لە ماوەی کاتژمێرێکدا (نموونە)",
    compatTitle: "ڕیزی گونجاندن",
    compatNote: "ئایکۆن و وشەی دۆخ بۆ هەر ئامێرێک: کار دەکات · بەشێکی کار دەکات · کار ناکات · نەپشکنراوە.",
    partialNote: "پێویستی بە نوێکردنەوەی نەرمەکاڵا هەیە",
    sample: "نرخ و ژمارەکانی ئەم بەشە نموونەی پیشاندانن.",
  },
});

type C = (typeof COPY)["ar"];

const TILE_ART: Record<Platform, string> = {
  nintendo: "nintendo-switch-2--1",
  playstation: "playstation-5-slim--1",
  xbox: "xbox-series-x--1",
  handheld: "lenovo-legion-go-2--1",
};
const TILE_COUNT: Record<Platform, number> = { nintendo: 39, playstation: 42, xbox: 28, handheld: 15 };

const photo = (artKey: string): ImageRef => ({ artKey, mediaKey: null, alt: "", isIllustration: false });
const DAY = 86_400_000;
const NOW_SAMPLE = Date.UTC(2026, 10, 11, 9); // fixed, so server and client count the same days

export default function ShowcaseSection() {
  const c = useCopy(COPY);
  return (
    <>
      <p className="ds-note">{c.sample}</p>
      <Bands c={c} />
      <Tiles c={c} />
      <Trust c={c} />
      <Release c={c} />
      <Entries c={c} />
      <Contact c={c} />
    </>
  );
}

function Bands({ c }: { c: C }) {
  const t = useT("ui");
  return (
    <DsBlock id="showcase-bands" title={c.bands} note={c.bandsNote}>
      <SpecimenGrid wide>
        <Specimen label='<Band kind="hero" media contact> + <Key variant="onBand">' wide>
          <Band kind="hero" media={<Render name="nintendo-switch-2--1" alt="" sizes="(min-width: 768px) 50vw, 90vw" />} contact className="min-h-[420px] md:min-h-[360px]">
            <div className="grid max-w-full gap-3 p-6 md:max-w-[50%] md:p-10 max-md:pt-[230px]">
              <span className="pill self-start justify-self-start" data-gel="nintendo">
                <i className="led" aria-hidden="true" />
                Nintendo
              </span>
              <h3 className="type-display">
                {c.playOn}
                <br />
                <bdi>Nintendo&nbsp;Switch&nbsp;2</bdi>
              </h3>
              <p className="type-lead">{c.heroLine}</p>
              <span className="flex flex-wrap items-center gap-3">
                <Price amountIqd={667_750} size="xl" tone="onColor" approx="off" as="span" />
                <DemoNote variant="tag" what="price" onColor />
              </span>
              <span className="flex flex-wrap items-center gap-x-5 gap-y-2">
                <Key variant="onBand">{c.buy}</Key>
                <TextLink as={LocaleLink} to="/p/nintendo-switch-2">
                  {c.details}
                </TextLink>
              </span>
              <p className="type-sm">{c.hubLine}</p>
            </div>
          </Band>
        </Specimen>
        <Specimen label='<Band kind="platform" platform> (hub band: 104 → 160)' wide>
          <Band kind="platform" platform="playstation" media={<Render name="playstation-5-pro--1" alt="" sizes="320px" />} className="min-h-[104px] lg:min-h-[160px]">
            <div className="grid max-w-[60%] gap-1 p-5 lg:p-7">
              <h3 className="type-h1">PlayStation</h3>
              <p className="type-sm-strong">{c.hubLine}</p>
            </div>
          </Band>
        </Specimen>
        <Specimen label='<Band kind="device" platform> (device-hub head: 200 → 280)' wide>
          <Band kind="device" platform="handheld" media={<Render name="steam-deck-oled--1" alt="" sizes="400px" />} className="min-h-[200px] lg:min-h-[280px]">
            <div className="grid max-w-[55%] gap-2 p-6 lg:p-10">
              <span className="pill self-start justify-self-start" data-gel="handheld">
                <i className="led" aria-hidden="true" />
                {t("platform.handheld")}
              </span>
              <h3 className="type-h1">
                <bdi>Steam Deck OLED</bdi>
              </h3>
              <p className="type-sm-strong">{c.deviceLine}</p>
            </div>
          </Band>
        </Specimen>
        <Specimen label='<Band kind="wallet"> (WalletBalance builds on it)'>
          <Band kind="wallet" as="div" className="p-5" contentClassName="grid justify-items-start gap-1">
            <p className="wallet__label">{c.walletLabel}</p>
            <Price amountIqd={180_000} size="xl" tone="onColor" approx="off" />
            <span className="mt-3 flex flex-wrap items-center gap-x-5 gap-y-2">
              <Key variant="onBand" icon="plus">
                {c.topup}
              </Key>
              <TextLink as={LocaleLink} to="/account/wallet">
                {c.history}
              </TextLink>
            </span>
          </Band>
        </Specimen>
      </SpecimenGrid>
    </DsBlock>
  );
}

function Tiles({ c }: { c: C }) {
  const t = useT("ui");
  return (
    <DsBlock id="showcase-tiles" title={c.tiles} note={c.tilesNote}>
      <PlatformTiles label={c.tilesLabel}>
        {PLATFORMS.map((p) => (
          <PlatformTile key={p} platform={p} to={`/platform/${p}`} count={TILE_COUNT[p]} art={TILE_ART[p]} />
        ))}
      </PlatformTiles>
      <Specimen label="<PlatformTile compact>" wide>
        <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
          {PLATFORMS.map((p) => (
            <PlatformTile key={p} compact platform={p} to={`/platform/${p}`} name={t(`platform.${p}`)} count={TILE_COUNT[p]} art={TILE_ART[p]} />
          ))}
        </div>
      </Specimen>
    </DsBlock>
  );
}

function Trust({ c }: { c: C }) {
  return (
    <DsBlock id="showcase-trust" title={c.trust} note={c.trustNote}>
      <Specimen label="<TrustStrip deliveryIqd cod transfer guest>" wide>
        <TrustStrip deliveryIqd={5_000} cod transfer guest />
      </Specimen>
      <SpecimenGrid wide>
        <Specimen label='<TrustStrip variant="line" cod returnsTo>'>
          <TrustStrip variant="line" cod transfer returnsTo="/policies/returns" />
        </Specimen>
        <Specimen label="<FactList facts>">
          <FactList
            facts={[
              { icon: "truck", title: c.deliveryFact, text: c.deliveryFactText },
              { icon: "arrow-counter-clockwise", title: c.returnsFact, text: c.returnsFactText, link: { label: c.returnsLink, to: "/policies/returns" } },
              { icon: "shield-check", title: c.warrantyFact, text: c.warrantyFactText },
            ]}
          />
        </Specimen>
        <Specimen label="<FactList plain>">
          <FactList
            plain
            facts={[
              { icon: "truck", title: c.deliveryFact },
              { icon: "money", title: c.warrantyFact, text: c.warrantyFactText },
            ]}
          />
        </Specimen>
      </SpecimenGrid>
    </DsBlock>
  );
}

function Release({ c }: { c: C }) {
  return (
    <DsBlock id="showcase-release" title={c.release} note={c.releaseNote}>
      <ReleaseBand
        now={NOW_SAMPLE}
        items={[
          { id: "r1", to: "/p/donkey-kong-bananza", name: "Donkey Kong Bananza", releaseAt: NOW_SAMPLE + 8 * DAY, platform: "nintendo", platformLabel: "Nintendo Switch 2", priceIqd: 79_000, image: photo("donkey-kong-bananza--1") },
          { id: "r2", to: "/p/ghost-of-yotei", name: "Ghost of Yōtei", releaseAt: NOW_SAMPLE + 23 * DAY, platform: "playstation", priceIqd: 89_000, image: photo("ghost-of-yotei--1") },
          { id: "r3", to: "/p/dualsense-edge", name: "DualSense Edge", releaseAt: NOW_SAMPLE + 45 * DAY, platform: "playstation", priceIqd: null, image: photo("dualsense-edge--1") },
          { id: "r4", to: "/p/joy-con-2", name: "Joy-Con 2", releaseAt: NOW_SAMPLE + 60 * DAY, platform: "nintendo", priceIqd: 105_000, image: photo("joy-con-2--1") },
        ]}
      />
      <Specimen label={`<SectionHead title reason href> · ${c.sectionHeadNote}`} wide className="mt-8">
        <SectionHead title={c.newTitle} reason={c.newReason} href="/c/new" />
      </Specimen>
    </DsBlock>
  );
}

function Entries({ c }: { c: C }) {
  const cats: [string, string, number][] = [
    [c.controllers, "dualsense--1", 18],
    [c.headsets, "pulse-elite--1", 9],
    [c.storage, "seagate-storage-expansion-card--1", 6],
    [c.cards, "nintendo-eshop-card--1", 4],
    [c.games, "mario-kart-world--1", 64],
    [c.accessories, "joy-con-2--1", 23],
  ];
  return (
    <DsBlock id="showcase-entries" title={c.entries} note={c.entriesNote}>
      <SpecimenGrid wide>
        <Specimen label="<EntryCard art>">
          <EntryCard to="/used" title={c.used} text={c.usedLine} cta={c.usedCta} art="playstation-5-slim--1" />
        </Specimen>
        <Specimen label='<EntryCard art="mascot">'>
          <EntryCard to="/support" title={c.support} text={c.supportLine} cta={c.supportCta} art="mascot" />
        </Specimen>
      </SpecimenGrid>
      <Specimen label="<CategoryTiles> · <CategoryTile label count art>" wide>
        <CategoryTiles label={c.accessories}>
          {cats.map(([label, art, count]) => (
            <CategoryTile key={art} to="/c/accessories" label={label} count={count} art={art} />
          ))}
        </CategoryTiles>
      </Specimen>
    </DsBlock>
  );
}

function Contact({ c }: { c: C }) {
  return (
    <DsBlock id="showcase-contact" title={c.contact} note={c.contactNote}>
      <SpecimenGrid wide>
        <Specimen label="<ContactCard channels primary> (an example)">
          <ContactCard
            primary
            now={NOW_SAMPLE}
            channels={{
              whatsapp: "9647700000000",
              phone: "+9647700000000",
              address: c.address,
              hoursText: c.hours,
              hours: [{ days: [6, 0, 1, 2, 3, 4], open: "10:00", close: "22:00" }],
              replyTime: c.reply,
            }}
          />
        </Specimen>
        <Specimen label="<ContactCard channels={null}> renders nothing">
          <span className="block min-h-11 rounded-sm border border-dashed border-line-2">
            <ContactCard channels={null} />
          </span>
        </Specimen>
        <Specimen label={`<CompatList rows> · ${c.compatNote}`}>
          <CompatList
            rows={[
              { status: "verified", device: "PlayStation 5 Slim" },
              { status: "partial", device: "PlayStation 5", note: c.partialNote },
              { status: "incompatible", device: "PlayStation 4" },
              { status: "unverified", device: "PlayStation 5 Pro" },
            ]}
          />
        </Specimen>
      </SpecimenGrid>
    </DsBlock>
  );
}
