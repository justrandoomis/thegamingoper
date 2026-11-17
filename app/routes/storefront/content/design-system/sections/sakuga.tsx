import { useState } from "react";

import { Icon } from "~/art/Icon";
import { Checkbox, Switch } from "~/ui/Field";
import { Key } from "~/ui/Key";
import { sakuga } from "~/ui/sakuga/fx";
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
  },
});

const STARS = [1, 2, 3, 4, 5] as const;

export default function MomentsSection() {
  const c = useCopy(COPY);
  const [rating, setRating] = useState(0);
  const [mark, setMark] = useState(0);
  return (
    <DsBlock id="moments-six" title={c.title} note={c.note}>
      <Toaster fallback />
      <SpecimenGrid>
        <Specimen label="sakuga.added(keyEl) · AddToCartKey, CardAddButton">
          {/* the real moment follows a server-confirmed add; this key plays it without touching a cart */}
          <Key icon="bag-plus" onClick={(event) => sakuga.added(event.currentTarget)} data-fx-demo="added">
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
          <Key size="sm" icon="check-circle" onClick={() => toast.success(c.toastSaved)} data-fx-demo="toast">
            {c.toastKey}
          </Key>
        </Specimen>
        <Specimen label="sakuga.complete(el) · <SuccessMark>, <ProofUploader> at 100%">
          <div className="flex flex-wrap items-center gap-4">
            <SuccessMark key={mark} size={56} label={c.complete} />
            <Key size="sm" variant="ghost" icon="arrow-counter-clockwise" onClick={() => setMark((n) => n + 1)} data-fx-demo="complete">
              {c.replay}
            </Key>
          </div>
        </Specimen>
      </SpecimenGrid>
    </DsBlock>
  );
}
