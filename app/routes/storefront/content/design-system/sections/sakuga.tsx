// lint-design: allow primary-count — the reference page shows the primary key's drawn press; it is not a shopping view.
import { useState } from "react";

import { Icon } from "~/art/Icon";
import { ChipGroup } from "~/ui/Chip";
import { EmptyState } from "~/ui/EmptyState";
import { Checkbox, FieldGroup, OptionCard, Switch, TextField } from "~/ui/Field";
import { IconKey } from "~/ui/IconKey";
import { Key } from "~/ui/Key";
import { Pagination } from "~/ui/Pagination";
import { sakuga } from "~/ui/sakuga/fx";
import { Segmented } from "~/ui/Segmented";
import { Stepper } from "~/ui/Stepper";
import { Tabs } from "~/ui/Tabs";
import { TextLink } from "~/ui/TextLink";
import { SuccessMark } from "~/ui/SuccessMark";
import { Toaster } from "~/ui/Toast";
import { toast } from "~/ui/toast-store";
import { DsBlock, Specimen, SpecimenGrid, defineCopy, useCopy, type DsSectionMeta } from "../kit";

/**
 * Drawn moments (docs/DESIGN.md §7.4, app/ui/sakuga): the six key moments with their sakuga-style reactions, played by
 * the real kit pieces — tick the checkbox, flip the switch, choose stars, raise a toast, replay the success mark, and
 * the add key's moment (here without a cart: the real one plays on a server-confirmed add). Nothing plays under reduced
 * motion, on the lite tier («الحركة: خفيفة / مخفّضة» above), or in the admin density.
 */
export const section: DsSectionMeta = {
  id: "moments",
  order: 7,
  title: { ar: "لحظات مرسومة", en: "Drawn moments", ckb: "ساتە وێنەکێشراوەکان" },
};

const COPY = defineCopy({
  ar: {
    title: "ردود فعل مرسومة في ست لحظات فقط",
    note: "الأزرار والحقول كما هي؛ عندما يؤكّد عنصر شيئاً — إضافة إلى السلة، مربع اختيار، مفتاح، تقييم، إشعار، اكتمال — ترتسم حوله لمسة يدوية قصيرة (أقل من 0.6 ثانية) بألوان الأحمر. لا شيء تحت «تقليل الحركة» ولا في الإدارة، ولا تمنع أي نقرة.",
    added: "تمّت الإضافة إلى السلة",
    addedKey: "جرّب لحظة الإضافة",
    check: "مربع اختيار",
    checkLabel: "أرسل لي العروض",
    toggle: "مفتاح",
    toggleLabel: "المتوفّر فقط",
    rating: "تقييم",
    ratingLegend: "قيّم المنتج",
    star: "نجمة",
    stars: "نجوم",
    toasts: "إشعار يصل",
    toastKey: "أظهر إشعاراً",
    toastSaved: "حُفظ العنوان",
    complete: "اكتمال",
    replay: "أعد العلامة",
    every: "على كل زر وفي كل صفحة",
    everyNote: "كل مفتاح في الطقم ينضغط وينبسط بنابض، ويرسم لمسة صغيرة حين يُفعَّل بالإصبع أو بالفأرة أو بـ Enter و Space: المفتاح الأحمر انفجار صغير وغبار، والمفاتيح الهادئة مروحة أسافين، ومفاتيح الأيقونات فرقعة. تنزلق مؤشرات التبويبات وتتمدّد ثم تهبط بأسافين، وتنبض نقطة الخيار، ويتطاير غبار عند المؤشر في حقول النص والبحث (لا كلمات المرور)، ويدقّ العدّاد، وتميل بطاقة المنتج نحو الفأرة مع لمعة. تنتقل الصفحات بانزلاق قصير مع اتجاه القراءة. لا شيء تحت «تقليل الحركة» أو في المستوى الخفيف أو في الإدارة أو في الطباعة.",
    keys: "المفاتيح",
    primaryKey: "أكمل الطلب",
    secondaryKey: "الفلاتر",
    ghostKey: "تراجع",
    iconKey: "مشاركة",
    wishKey: "أضف إلى المفضلة",
    textLink: "تراجع عن الحذف",
    chips: "شرائح",
    chipAll: "الكل",
    chipNew: "جديد",
    chipUsed: "مستعمل",
    tabs: "تبويبات ومقطّع",
    segLabel: "العرض",
    segGrid: "شبكة",
    segList: "قائمة",
    tabSpecs: "المواصفات",
    tabBox: "في العلبة",
    tabWorks: "يعمل مع",
    tabSpecsText: "ينزلق المؤشر ويتمدّد ثم يهبط بأسافين عند حافته الأمامية.",
    tabBoxText: "الجهاز، ذراع تحكم، كابل HDMI.",
    tabWorksText: "PlayStation 5 وPlayStation 5 Pro.",
    radios: "خيارات",
    radioLegend: "طريقة التوصيل",
    radioHome: "إلى البيت",
    radioPickup: "استلام من المتجر",
    typing: "الكتابة",
    searchLabel: "ابحث في المتجر",
    quantity: "الكمية والصفحات",
    empty: "حالة فارغة تصل",
    emptyTitle: "سلتك فارغة",
    emptyText: "أضف ما يعجبك وسيظهر هنا.",
    emptyReplay: "أعد الوصول",
  },
  en: {
    title: "Drawn reactions at six moments only",
    note: "The keys and fields stay as they are; when one confirms something — an add to the cart, a checkbox, a switch, a rating, a toast, a completion — a short hand-drawn touch (under 0.6 s) plays round it in the red family. Nothing under reduced motion or in the admin, and it never blocks a tap.",
    added: "Added to the cart",
    addedKey: "Try the add moment",
    check: "Checkbox",
    checkLabel: "Send me offers",
    toggle: "Switch",
    toggleLabel: "In stock only",
    rating: "Rating",
    ratingLegend: "Rate the product",
    star: "star",
    stars: "stars",
    toasts: "A toast arriving",
    toastKey: "Show a toast",
    toastSaved: "Address saved",
    complete: "Completion",
    replay: "Replay the mark",
    every: "On every button and every page",
    everyNote: "Every kit key squashes and springs back, and draws a small touch when it is activated — by finger, mouse, Enter or Space: the red key a small burst and dust, the quiet keys a fan of wedges, the icon keys a pop. Tab indicators stretch as they slide and land in wedges, a radio's dot springs, text and search fields throw a speck of dust at the caret (never a password), the quantity ticks, and a product card tilts toward the mouse with a glare. Pages change with a short slide in the reading direction. Nothing under reduced motion, on the lite tier, in the admin or in print.",
    keys: "Keys",
    primaryKey: "Place the order",
    secondaryKey: "Filters",
    ghostKey: "Undo",
    iconKey: "Share",
    wishKey: "Add to favourites",
    textLink: "Undo the removal",
    chips: "Chips",
    chipAll: "All",
    chipNew: "New",
    chipUsed: "Used",
    tabs: "Tabs and segmented",
    segLabel: "View",
    segGrid: "Grid",
    segList: "List",
    tabSpecs: "Specs",
    tabBox: "In the box",
    tabWorks: "Works with",
    tabSpecsText: "The indicator slides, stretches, and lands in wedges off its leading edge.",
    tabBoxText: "The console, a controller, an HDMI cable.",
    tabWorksText: "PlayStation 5 and PlayStation 5 Pro.",
    radios: "Options",
    radioLegend: "Delivery",
    radioHome: "To the door",
    radioPickup: "Pick up at the store",
    typing: "Typing",
    searchLabel: "Search the store",
    quantity: "Quantity and pages",
    empty: "An empty state arriving",
    emptyTitle: "Your cart is empty",
    emptyText: "Add what you like and it will show here.",
    emptyReplay: "Replay the arrival",
  },
  ckb: {
    title: "کاردانەوەی وێنەکێشراو تەنها لە شەش ساتدا",
    note: "دوگمە و خانەکان وەک خۆیان دەمێننەوە؛ کاتێک یەکێکیان شتێک پشتڕاست دەکاتەوە — زیادکردن بۆ سەبەتە، خانەی هەڵبژاردن، کلیل، هەڵسەنگاندن، ئاگادارکردنەوە، تەواوبوون — دەستکارییەکی کورتی دەستکرد (کەمتر لە 0.6 چرکە) بە ڕەنگی سوور لە دەوری دەکێشرێت. هیچ شتێک لە ژێر «کەمکردنەوەی جووڵە» و لە بەڕێوەبردندا نییە، و هیچ کرتەیەک ڕاناگرێت.",
    added: "زیادکرا بۆ سەبەتە",
    addedKey: "ساتی زیادکردن تاقی بکەرەوە",
    check: "خانەی هەڵبژاردن",
    checkLabel: "ئۆفەرەکانم بۆ بنێرە",
    toggle: "کلیل",
    toggleLabel: "تەنها بەردەستەکان",
    rating: "هەڵسەنگاندن",
    ratingLegend: "بەرهەمەکە هەڵبسەنگێنە",
    star: "ئەستێرە",
    stars: "ئەستێرە",
    toasts: "ئاگادارکردنەوەیەک دێت",
    toastKey: "ئاگادارکردنەوەیەک پیشان بدە",
    toastSaved: "ناونیشان پاشەکەوت کرا",
    complete: "تەواوبوون",
    replay: "نیشانەکە دووبارە بکەرەوە",
    every: "لەسەر هەموو دوگمەیەک و لە هەموو پەڕەیەک",
    everyNote: "هەموو کلیلێکی کۆمەڵەکە دەچەمێتەوە و بە سپرینگ دەگەڕێتەوە، و کاتێک چالاک دەکرێت — بە پەنجە، ماوس، Enter یان Space — دەستکارییەکی بچووک دەکێشێت: کلیلی سوور تەقینەوەیەکی بچووک و تەپوتۆز، کلیلە هێمنەکان باوەشێنێکی سێگۆشە، کلیلی ئایکۆن پەقینێک. نیشاندەری تابەکان لە کاتی خلیسکاندا درێژ دەبنەوە و بە سێگۆشە دادەنیشن، خاڵی هەڵبژاردن لێدەدات، خانەکانی دەق و گەڕان لە شوێنی نیشاندەر تەپوتۆزێک فڕێ دەدەن (هەرگیز وشەی نهێنی)، ژمارە لێدەدات، و کارتی بەرهەم بەرەو ماوس لار دەبێتەوە لەگەڵ درەوشانەوەیەک. پەڕەکان بە خلیسکانێکی کورت بە ئاراستەی خوێندنەوە دەگۆڕێن. هیچ شتێک لە ژێر «کەمکردنەوەی جووڵە»، لە ئاستی سووک، لە بەڕێوەبردن یان لە چاپدا نییە.",
    keys: "کلیلەکان",
    primaryKey: "داواکاری تەواو بکە",
    secondaryKey: "فلتەرەکان",
    ghostKey: "پاشگەزبوونەوە",
    iconKey: "هاوبەشکردن",
    wishKey: "زیادکردن بۆ دڵخوازەکان",
    textLink: "سڕینەوەکە هەڵبوەشێنەوە",
    chips: "پارچەکان",
    chipAll: "هەموو",
    chipNew: "نوێ",
    chipUsed: "بەکارهاتوو",
    tabs: "تاب و بەشکراو",
    segLabel: "پیشاندان",
    segGrid: "تۆڕ",
    segList: "لیست",
    tabSpecs: "تایبەتمەندییەکان",
    tabBox: "لە ناو قوتووەکەدا",
    tabWorks: "کار دەکات لەگەڵ",
    tabSpecsText: "نیشاندەرەکە دەخلیسکێت، درێژ دەبێتەوە و بە سێگۆشە لە لێواری پێشەوەیدا دادەنیشێت.",
    tabBoxText: "ئامێرەکە، دەستەیەک، کێبڵی HDMI.",
    tabWorksText: "PlayStation 5 و PlayStation 5 Pro.",
    radios: "هەڵبژاردنەکان",
    radioLegend: "گەیاندن",
    radioHome: "بۆ ماڵەوە",
    radioPickup: "وەرگرتن لە فرۆشگا",
    typing: "نووسین",
    searchLabel: "لە فرۆشگادا بگەڕێ",
    quantity: "بڕ و پەڕەکان",
    empty: "دۆخێکی بەتاڵ دێت",
    emptyTitle: "سەبەتەکەت بەتاڵە",
    emptyText: "ئەوەی بەدڵتە زیادی بکە و لێرە دەردەکەوێت.",
    emptyReplay: "هاتنەکە دووبارە بکەرەوە",
  },
});

const STARS = [1, 2, 3, 4, 5] as const;

export default function MomentsSection() {
  const c = useCopy(COPY);
  const [rating, setRating] = useState(0);
  const [mark, setMark] = useState(0);
  return (
    <>
      <DsBlock id="moments-six" title={c.title} note={c.note}>
        <Toaster fallback />
        <SpecimenGrid>
          <Specimen label="sakuga.added(keyEl) · AddToCartKey, CardAddButton">
            {/* the real moment follows a server-confirmed add; this key plays it without touching a cart */}
            <Key icon="bag-plus" onClick={(event) => sakuga.added(event.currentTarget)} data-fx-demo="added" data-fx="none">
              {c.addedKey}
            </Key>
          </Specimen>
          <Specimen label="sakuga.check(boxEl, checked) · <Checkbox>">
            <Checkbox label={c.checkLabel} name="ds-fx-check" data-fx-demo="check" />
          </Specimen>
          <Specimen label="sakuga.toggle(trackEl, on) · <Switch>">
            <Switch label={c.toggleLabel} name="ds-fx-switch" data-fx-demo="toggle" />
          </Specimen>
          <Specimen label="sakuga.rate(starEls, n) · «قيّم ما استلمته»">
            <fieldset className="grid gap-2">
              <legend className="type-label text-ink">{c.ratingLegend}</legend>
              <span className="ds-fx-stars inline-flex" data-fx-demo="rate">
                {STARS.map((n) => (
                  <label key={n} className="ds-fx-star relative grid size-11 cursor-pointer place-items-center text-ink">
                    <input
                      type="radio"
                      name="ds-fx-rating"
                      value={n}
                      className="peer sr-only"
                      onChange={(event) => {
                        setRating(n);
                        const row = event.currentTarget.closest(".ds-fx-stars");
                        if (row) sakuga.rate([...row.querySelectorAll(".ds-fx-star")], n);
                      }}
                    />
                    <Icon name="star" filled={n <= rating} size={28} className={n <= rating ? undefined : "text-ink-3"} />
                    <span className="sr-only">
                      {n} {n === 1 ? c.star : c.stars}
                    </span>
                    <span className="pointer-events-none absolute inset-1 rounded-full peer-focus-visible:outline-2 peer-focus-visible:outline-(--focus)" aria-hidden="true" />
                  </label>
                ))}
              </span>
            </fieldset>
          </Specimen>
          <Specimen label="sakuga.toast(cardEl) · <Toaster> (not the error kind)">
            <Key size="sm" icon="check-circle" onClick={() => toast.success(c.toastSaved)} data-fx-demo="toast" data-fx="none">
              {c.toastKey}
            </Key>
          </Specimen>
          <Specimen label="sakuga.complete(el) · <SuccessMark>, <ProofUploader> at 100%">
            <div className="flex flex-wrap items-center gap-4">
              <SuccessMark key={mark} size={56} label={c.complete} />
              <Key size="sm" variant="ghost" icon="arrow-counter-clockwise" onClick={() => setMark((n) => n + 1)} data-fx-demo="complete" data-fx="none">
                {c.replay}
              </Key>
            </div>
          </Specimen>
        </SpecimenGrid>
      </DsBlock>
      <EveryControl />
    </>
  );
}


/** Every control (DESIGN.md §7.4 "Every control"): the real kit pieces, each with the press its kit component gives it. */
function EveryControl() {
  const c = useCopy(COPY);
  const [wished, setWished] = useState(false);
  const [page, setPage] = useState(2);
  const [view, setView] = useState("grid");
  const [empty, setEmpty] = useState(0);
  return (
    <DsBlock id="moments-every" title={c.every} note={c.everyNote}>
      <SpecimenGrid>
        <Specimen label="Key data-fx = burst | fan · IconKey = pop | wish · TextLink as button = fan">
          <div className="flex flex-wrap items-center gap-3" data-fx-demo="keys">
            <Key variant="primary" icon="check-circle">
              {c.primaryKey}
            </Key>
            <Key icon="sliders-horizontal">{c.secondaryKey}</Key>
            <Key variant="ghost" size="sm">
              {c.ghostKey}
            </Key>
            <IconKey icon="share-network" label={c.iconKey} />
            <IconKey icon="heart" label={c.wishKey} held={wished} className="key--wish" data-fx="wish" onClick={() => setWished((on) => !on)} />
            <TextLink as="button" type="button" arrow={false}>
              {c.textLink}
            </TextLink>
          </div>
        </Specimen>
        <Specimen label="ChipGroup · data-fx = fan">
          <ChipGroup aria-label={c.chips} defaultValue="all" options={[{ value: "all", label: c.chipAll }, { value: "new", label: c.chipNew }, { value: "used", label: c.chipUsed }]} />
        </Specimen>
        <Specimen label="Segmented, Tabs · sakuga.land + [data-fx-spring]" wide>
          <div className="grid gap-4" data-fx-demo="tabs">
            <Segmented inline aria-label={c.segLabel} value={view} onChange={setView} options={[{ value: "grid", label: c.segGrid, icon: "squares-four" }, { value: "list", label: c.segList, icon: "list" }]} />
            <Tabs
              aria-label={c.tabs}
              defaultValue="specs"
              items={[
                { value: "specs", label: c.tabSpecs, content: <p className="type-read text-ink-2">{c.tabSpecsText}</p> },
                { value: "box", label: c.tabBox, content: <p className="type-read text-ink-2">{c.tabBoxText}</p> },
                { value: "works", label: c.tabWorks, content: <p className="type-read text-ink-2">{c.tabWorksText}</p> },
              ]}
            />
          </div>
        </Specimen>
        <Specimen label="<Radio>, <OptionCard> · data-fx = dot">
          <FieldGroup legend={c.radioLegend}>
            <OptionCard name="ds-fx-delivery" value="home" label={c.radioHome} icon="truck" defaultChecked />
            <OptionCard name="ds-fx-delivery" value="pickup" label={c.radioPickup} icon="storefront" />
          </FieldGroup>
        </Specimen>
        <Specimen label="type = search | text · sakuga.dust">
          <TextField type="search" label={c.searchLabel} name="ds-fx-search" />
        </Specimen>
        <Specimen label="<Stepper> sakuga.tick · <Pagination>">
          <div className="grid gap-4" data-fx-demo="quantity">
            <Stepper defaultValue={1} max={9} />
            <Pagination page={page} pageCount={5} onPage={setPage} />
          </div>
        </Specimen>
        <Specimen label="<EmptyState layout=stack> · sakuga.enter" wide>
          <div className="grid justify-items-center gap-3" data-fx-demo="empty">
            <EmptyState key={empty} layout="stack" icon="shopping-bag" title={c.emptyTitle} text={c.emptyText} />
            <Key size="sm" variant="ghost" icon="arrow-counter-clockwise" data-fx="none" onClick={() => setEmpty((n) => n + 1)}>
              {c.emptyReplay}
            </Key>
          </div>
        </Specimen>
      </SpecimenGrid>
    </DsBlock>
  );
}
