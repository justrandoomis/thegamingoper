import { useState } from "react";

import { Checkbox, FieldGroup, FormErrorSummary, OptionCard, Radio, Select, Switch, TextArea, TextField } from "~/ui/Field";
import { GovernoratePicker } from "~/ui/GovernoratePicker";
import { PreferencePicker, type Period } from "~/ui/PreferencePicker";
import { Price } from "~/ui/Price";
import { Render } from "~/ui/Stage";
import { Stepper } from "~/ui/Stepper";
import { Swatches } from "~/ui/Swatch";
import { DsBlock, defineCopy, Specimen, SpecimenGrid, SpecimenRow, useCopy, type DsSectionMeta } from "../kit";

/**
 * Forms — Design System v2 §4.9–§4.10: fields, option cards, the governorate picker, the delivery-time preference,
 * colour swatches, the error summary and the stepper, in every state.
 */
export const section: DsSectionMeta = {
  id: "forms",
  order: 2,
  title: { ar: "النماذج والعدّاد", en: "Forms and stepper", ckb: "فۆڕم و ژمێرەر" },
  owner: "app/ui/Field · GovernoratePicker · PreferencePicker · Swatch · Stepper",
};

const COPY = defineCopy({
  ar: {
    fields: "الحقول",
    fieldsNote: "52 بكسل على ورق بحد تحكم حقيقي، والنص 16 بكسل. العنوان فوق الحقل، والتلميح تحته، والخطأ يحلّ محل التلميح بأيقونة وكلمات بلون الخطر، لا بالأحمر.",
    phone: "رقم الموبايل",
    phoneHint: "نستخدمه للتواصل بخصوص طلبك فقط. مثل 0770 123 4567.",
    phoneError: "ينقص الرقم 4 أرقام. اكتبه مثل 0770 123 4567.",
    name: "الاسم الكامل",
    notes: "ملاحظات للمندوب",
    address: "العنوان بالتفصيل",
    addressHint: "الحي، الشارع، أقرب نقطة دالة.",
    addressError: "اكتب العنوان.",
    amount: "المبلغ المحوَّل",
    orderRef: "رقم الطلب",
    city: "المدينة",
    choose: "اختر",
    baghdad: "بغداد",
    basra: "البصرة",
    erbil: "أربيل",
    disabledReason: "يُملأ من طلبك.",
    choices: "الاختيارات",
    choicesNote: "مربع 20 بكسل بزاوية 6، ودائرة 20 بكسل، ومفتاح 44×26 يتحرك مع اتجاه القراءة. بطاقات الخيار للنسخة والدفع؛ المختارة بحد حبر 2 بكسل.",
    offers: "أرسلوا لي العروض على هذا الرقم",
    returnsRead: "قرأت سياسة الإرجاع",
    tick: "علّم المربع لتتابع.",
    selectAll: "اختر كل الطلبات",
    inStockOnly: "المتوفر الآن فقط",
    version: "النسخة",
    intl: "النسخة الدولية",
    intlHint: "ضمان الشركة المصنّعة. تعمل بكل الألعاب.",
    gulf: "نسخة الخليج",
    gulfHint: "مخصّصة لأسواق الخليج.",
    payment: "طريقة الدفع",
    cod: "الدفع عند الاستلام",
    codHint: "نقداً للمندوب عند استلام الطلب.",
    cash: "نقداً",
    zain: "زين كاش",
    zainHint: "ترفع صورة الحوالة، ونراجعها قبل تأكيد الطلب.",
    governorate: "المحافظة",
    governorateNote: "يبدو مثل القائمة ويفتح صفيحة بصفوف 52 بكسل وسطر الرسوم في أعلاها. محافظة لا نوصل إليها تبقى في القائمة مع سببها.",
    governorateError: "اختر المحافظة.",
    preference: "الوقت المفضّل",
    preferenceNote: "اختياري. فترات اليوم فقط حتى يحدد المالك أيام التوصيل في الإدارة؛ وتحتها دائماً: وقت مفضّل وليس موعداً مؤكداً.",
    swatches: "الألوان",
    swatchesNote: "دائرة 36 بكسل أو صورة 56 بكسل، ومساحة لمس 44. غير المتوفر عليه خط مائل وسببه في اسمه.",
    colour: "اللون",
    white: "أبيض",
    black: "أسود",
    red: "أحمر · Cosmic Red",
    summary: "ملخص الأخطاء",
    summaryNote: "عند الإرسال: كتلة واحدة role=alert فوق النموذج، وكل بند رابط إلى حقله، والتركيز ينتقل إلى أول حقل خاطئ.",
    stepper: "العدّاد",
    stepperNote: "صينية طينية مضغوطة 48 بكسل (40 مضغوط): الناقص مسطّح في البداية، والعدد بخط Kufam، والزائد زر دائري بارز في النهاية بكل اللغات. «بقي 2 فقط» من المخزون الحقيقي وحده، ولا يظهر في الوضع التجريبي.",
    readOnly: "معطّل ومحدد: العلامة تبقى ظاهرة (صلاحية لا يغيّرها المراجع)",
    grantOrders: "يرى الطلبات",
    grantRefunds: "يصرف المبالغ المسترجعة",
    counted: "صفوف بعدد في نهايتها (فلتر)",
    govKeys: "الأسهم تتنقل بين الصفوف ولا تغلق الصفيحة؛ النقر أو المسافة أو Enter يختار ويغلق",
    preferenceLabel: "label: الوقت لغير التوصيل، والكلمة «(اختياري)» من المكوّن",
    handover: "الوقت المفضّل لتسليم الجهاز",
    swatchReasons: "غير متاح بسببه: نفد حالياً · قريباً · غير متوفر في هذه النسخة",
    green: "أخضر · Sterling Silver",
    groupId: "id على المجموعة: عنصر في ملخص الأخطاء يرسل إليها",
  },
  en: {
    fields: "Fields",
    fieldsNote: "52px on paper with a real control line, 16px text. The label above, the hint below; an error replaces the hint with an icon and words in the danger colour, never brand red.",
    phone: "Mobile number",
    phoneHint: "We use it only about your order. Like 0770 123 4567.",
    phoneError: "The number is 4 digits short. Write it like 0770 123 4567.",
    name: "Full name",
    notes: "Notes for the courier",
    address: "Full address",
    addressHint: "District, street, the nearest landmark.",
    addressError: "Write the address.",
    amount: "Amount transferred",
    orderRef: "Order number",
    city: "City",
    choose: "Choose",
    baghdad: "Baghdad",
    basra: "Basra",
    erbil: "Erbil",
    disabledReason: "Filled from your order.",
    choices: "Choices",
    choicesNote: "A 20px box with a 6px radius, a 20px circle, and a 44×26 switch whose knob follows the reading direction. Option cards for versions and payment; the chosen one has a 2px ink border.",
    offers: "Send me offers on this number",
    returnsRead: "I have read the returns policy",
    tick: "Tick the box to continue.",
    selectAll: "Select every order",
    inStockOnly: "In stock only",
    version: "Version",
    intl: "International version",
    intlHint: "Manufacturer warranty. Plays every game.",
    gulf: "Gulf version",
    gulfHint: "Made for the Gulf markets.",
    payment: "Payment method",
    cod: "Cash on delivery",
    codHint: "Pay the courier in cash when your order arrives.",
    cash: "Cash",
    zain: "Zain Cash",
    zainHint: "Upload a photo of the transfer; we review it before confirming the order.",
    governorate: "Governorate",
    governorateNote: "It looks like a select and opens a sheet with 52px rows and the fee line at the top. A governorate we do not deliver to stays in the list with its reason.",
    governorateError: "Choose your governorate.",
    preference: "Preferred time",
    preferenceNote: "Optional. Times of day only until the owner sets delivery days in the admin; always under it: a preference, not a confirmed time.",
    swatches: "Colours",
    swatchesNote: "A 36px dot or a 56px picture, a 44px hit area. An unavailable colour is struck through and says why in its name.",
    colour: "Colour",
    white: "White",
    black: "Black",
    red: "Red · Cosmic Red",
    summary: "Error summary",
    summaryNote: "On submit: one role=alert block above the form; every item links to its field and focus moves to the first wrong field.",
    stepper: "Stepper",
    stepperNote: "A 48px pressed-in clay tray (40 compact): a flat minus at the start, the count in Kufam, a raised round plus at the end in every language. «Only 2 left» from real stock only, never in demo mode.",
    readOnly: "Disabled and checked: the mark stays visible (a permission the reviewer cannot change)",
    grantOrders: "Sees orders",
    grantRefunds: "Pays out refunds",
    counted: "Rows with a count at their end (a filter)",
    govKeys: "The arrow keys move through the rows and never close the sheet; a click, Space or Enter chooses and closes",
    preferenceLabel: "label: the time for something other than a delivery; «(optional)» comes from the component",
    handover: "Preferred time to hand over the device",
    swatchReasons: "Not available, and why: sold out · coming soon · not made in this version",
    green: "Green · Sterling Silver",
    groupId: "id on the group: an error summary item takes you there",
  },
  ckb: {
    fields: "خانەکان",
    fieldsNote: "52 پیکسڵ لەسەر کاغەز بە سنووری ڕاستەقینە، نووسینی 16 پیکسڵ. ناونیشان لە سەرەوە و ڕێنمایی لە خوارەوە؛ هەڵە جێگەی ڕێنمایی دەگرێتەوە بە ئایکۆن و وشە.",
    phone: "ژمارەی مۆبایل",
    phoneHint: "تەنها بۆ داواکارییەکەت بەکاری دەهێنین. وەک 0770 123 4567.",
    phoneError: "ژمارەکە 4 ژمارەی کەمە. وەک 0770 123 4567 بینووسە.",
    name: "ناوی تەواو",
    notes: "تێبینی بۆ گەیەنەر",
    address: "ناونیشانی تەواو",
    addressHint: "گەڕەک، شەقام، نزیکترین نیشانە.",
    addressError: "ناونیشانەکە بنووسە.",
    amount: "بڕی گواستراوە",
    orderRef: "ژمارەی داواکاری",
    city: "شار",
    choose: "هەڵبژێرە",
    baghdad: "بەغدا",
    basra: "بەسرە",
    erbil: "هەولێر",
    disabledReason: "لە داواکارییەکەتەوە پڕ دەکرێتەوە.",
    choices: "هەڵبژاردنەکان",
    choicesNote: "چوارگۆشەیەکی 20 پیکسڵی، بازنەیەکی 20 پیکسڵی، و سویچێکی 44×26 کە دوگمەکەی ئاراستەی خوێندنەوە دەگرێت. کارتی هەڵبژاردن بۆ وەشان و پارەدان.",
    offers: "ئۆفەرەکانم بۆ ئەم ژمارەیە بنێرن",
    returnsRead: "سیاسەتی گەڕاندنەوەم خوێندەوە",
    tick: "بۆ بەردەوامبوون نیشانەی بکە.",
    selectAll: "هەموو داواکارییەکان هەڵبژێرە",
    inStockOnly: "تەنها ئەوەی ئێستا بەردەستە",
    version: "وەشان",
    intl: "وەشانی نێودەوڵەتی",
    intlHint: "گەرەنتیی کۆمپانیا. هەموو یارییەکان کار دەکەن.",
    gulf: "وەشانی کەنداو",
    gulfHint: "بۆ بازاڕەکانی کەنداو.",
    payment: "شێوازی پارەدان",
    cod: "پارەدان لە کاتی وەرگرتن",
    codHint: "بە نەختینە بە گەیەنەر دەدەیت کاتێک داواکارییەکە گەیشت.",
    cash: "نەختینە",
    zain: "زەین کاش",
    zainHint: "وێنەی گواستنەوەکە بار دەکەیت، پێش دووپاتکردنەوە دەیپشکنین.",
    governorate: "پارێزگا",
    governorateNote: "وەک لیست دەردەکەوێت و پەڕەیەک دەکاتەوە بە ڕیزی 52 پیکسڵی و هێڵی کرێی گەیاندن لە سەرەوە.",
    governorateError: "پارێزگاکەت هەڵبژێرە.",
    preference: "کاتی دڵخواز",
    preferenceNote: "ئارەزوومەندانە. تەنها کاتەکانی ڕۆژ تا خاوەنەکە ڕۆژانی گەیاندن لە بەڕێوەبردندا دیاری دەکات.",
    swatches: "ڕەنگەکان",
    swatchesNote: "خاڵێکی 36 پیکسڵی یان وێنەیەکی 56 پیکسڵی، ڕووبەری دەستلێدانی 44. ڕەنگی بەردەست نەبوو هێڵێکی لار پێدا هاتووە.",
    colour: "ڕەنگ",
    white: "سپی",
    black: "ڕەش",
    red: "سوور · Cosmic Red",
    summary: "پوختەی هەڵەکان",
    summaryNote: "لە کاتی ناردندا: یەک بلۆکی role=alert لە سەرەوەی فۆڕمەکە؛ هەر بڕگەیەک بەستەرە بۆ خانەکەی.",
    stepper: "ژمێرەر",
    stepperNote: "سینییەکی قوڕی پەستێنراوی 48 پیکسڵی (40 بچووک): کەمکردنەوەی تەخت لە سەرەتا، ژمارەکە بە Kufam، و زیادکردنی خڕی بەرز لە کۆتایی. «تەنها 2 ماوە» تەنها لە کۆگای ڕاستەقینەوە.",
    readOnly: "ناچالاک و هەڵبژێردراو: نیشانەکە دیار دەمێنێت (مۆڵەتێک کە پشکنەر ناتوانێت بیگۆڕێت)",
    grantOrders: "داواکارییەکان دەبینێت",
    grantRefunds: "پارەی گەڕاوە دەدات",
    counted: "ڕیز بە ژمارەیەک لە کۆتاییدا (فلتەر)",
    govKeys: "تیرەکان لە نێوان ڕیزەکاندا دەجووڵێن و پەڕەکە دانادەخەن؛ کرتە، Space یان Enter هەڵدەبژێرێت و دادەخات",
    preferenceLabel: "label: کات بۆ شتێک جگە لە گەیاندن؛ «(ئارەزوومەندانە)» لە پێکهاتەکەوە دێت",
    handover: "کاتی دڵخواز بۆ ڕادەستکردنی ئامێرەکە",
    swatchReasons: "بەردەست نییە، و هۆکارەکەی: ئێستا نەماوە · بەم زووانە · لەم وەشانەدا نییە",
    green: "سەوز · Sterling Silver",
    groupId: "id لەسەر کۆمەڵەکە: بڕگەیەک لە پوختەی هەڵەکاندا دەتباتە ئەوێ",
  },
});

type C = (typeof COPY)["ar"];

const GOVERNORATES = (c: C) => [
  { id: "baghdad", name: c.baghdad },
  { id: "basra", name: c.basra },
  { id: "erbil", name: c.erbil, unserved: true },
];

export default function FormsSection() {
  const c = useCopy(COPY);
  return (
    <>
      <Fields c={c} />
      <Choices c={c} />
      <Pickers c={c} />
      <Steppers c={c} />
    </>
  );
}

function Fields({ c }: { c: C }) {
  return (
    <DsBlock id="forms-fields" title={c.fields} note={c.fieldsNote}>
      <SpecimenGrid wide>
        <Specimen label='TextField type="tel" required hint'>
          <TextField label={c.phone} type="tel" autoComplete="tel-national" required hint={c.phoneHint} defaultValue="0770 123 4567" name="ds-phone" />
        </Specimen>
        <Specimen label="error (replaces the hint; aria-invalid)">
          <TextField label={c.phone} type="tel" required hint={c.phoneHint} error={c.phoneError} defaultValue="0770 123" name="ds-phone-bad" />
        </Specimen>
        <Specimen label="optional">
          <TextField label={c.notes} optional name="ds-notes" />
        </Specimen>
        <Specimen label='inputMode="numeric" end (a unit)'>
          <TextField label={c.amount} inputMode="numeric" defaultValue="1,239,000" end={<span className="type-xs">IQD</span>} name="ds-amount" />
        </Specimen>
        <Specimen label="disabled (+ the reason) · readOnly">
          <span className="grid gap-3">
            <TextField label={c.name} disabled hint={c.disabledReason} name="ds-name" />
            <TextField label={c.orderRef} readOnly defaultValue="TT-7K4M2Q9X" ltr name="ds-ref" />
          </span>
        </Specimen>
        <Specimen label="TextArea required hint · error">
          <span className="grid gap-3">
            <TextArea label={c.address} required hint={c.addressHint} name="ds-address" />
            <TextArea label={c.address} required error={c.addressError} name="ds-address-bad" />
          </span>
        </Specimen>
        <Specimen label="Select placeholder">
          <Select
            label={c.city}
            placeholder={c.choose}
            name="ds-city"
            options={[
              { value: "baghdad", label: c.baghdad },
              { value: "basra", label: c.basra },
            ]}
          />
        </Specimen>
      </SpecimenGrid>
      <Specimen label={`<FormErrorSummary> · ${c.summaryNote}`} wide>
        <FormErrorSummary
          errors={[
            { id: "ds-phone-bad", label: c.phone },
            { id: "ds-address-bad", label: c.address },
          ]}
        />
      </Specimen>
    </DsBlock>
  );
}

function Choices({ c }: { c: C }) {
  return (
    <DsBlock id="forms-choices" title={c.choices} note={c.choicesNote}>
      <SpecimenGrid wide>
        <Specimen label="Checkbox · checked · indeterminate · error · disabled">
          <div className="grid">
            <Checkbox label={c.offers} name="ds-offers" />
            <Checkbox label={c.returnsRead} name="ds-returns" defaultChecked />
            <Checkbox label={c.selectAll} name="ds-all" indeterminate />
            <Checkbox label={c.returnsRead} name="ds-returns-bad" error={c.tick} />
            <Checkbox label={c.offers} name="ds-offers-off" disabled />
          </div>
        </Specimen>
        <Specimen label="Switch (role=switch; the knob follows the reading direction)">
          <div className="grid">
            <Switch label={c.inStockOnly} name="ds-switch-on" defaultChecked />
            <Switch label={c.offers} name="ds-switch-off" />
          </div>
        </Specimen>
        <Specimen label='<FieldGroup> + <OptionCard> (version, with its price)'>
          <FieldGroup legend={`${c.version} · ${c.intl}`} required>
            <OptionCard name="ds-version" value="intl" label={c.intl} hint={c.intlHint} defaultChecked end={<Price amountIqd={667_750} size="sm" as="span" approx="off" />} />
            <OptionCard name="ds-version" value="gulf" label={c.gulf} hint={c.gulfHint} end={<Price amountIqd={667_500} size="sm" as="span" approx="off" />} />
          </FieldGroup>
        </Specimen>
        <Specimen label="<OptionCard pay mark> (payment: 72px, words, no logos)">
          <FieldGroup legend={c.payment} required>
            <OptionCard pay name="ds-pay" value="cod" label={c.cod} hint={c.codHint} mark={c.cash} />
            <OptionCard pay name="ds-pay" value="zain" label={c.zain} hint={c.zainHint} mark={c.zain} />
          </FieldGroup>
        </Specimen>
        <Specimen label="Radio (a group with nothing chosen shows every circle empty)">
          <FieldGroup legend={c.city}>
            <Radio name="ds-radio" value="baghdad" label={c.baghdad} />
            <Radio name="ds-radio" value="basra" label={c.basra} />
          </FieldGroup>
        </Specimen>
        <Specimen label={`Checkbox · Radio — disabled checked · ${c.readOnly}`}>
          <div className="grid">
            <Checkbox label={c.grantOrders} name="ds-grant-orders" defaultChecked disabled />
            <Checkbox label={c.grantRefunds} name="ds-grant-refunds" disabled />
            <Radio name="ds-radio-ro" value="baghdad" label={c.baghdad} defaultChecked disabled />
          </div>
        </Specimen>
        <Specimen label={`<Checkbox count> · ${c.counted}`}>
          <div className="grid">
            <Checkbox label="Nintendo" name="ds-count-n" count={39} defaultChecked />
            <Checkbox label="PlayStation" name="ds-count-p" count={42} />
            <Checkbox label="Xbox" name="ds-count-x" count={28} />
          </div>
        </Specimen>
        <Specimen label={`<FieldGroup id error> · ${c.groupId}`}>
          <FieldGroup id="ds-group-city" legend={c.city} error={c.governorateError}>
            <Radio name="ds-radio-err" value="baghdad" label={c.baghdad} />
            <Radio name="ds-radio-err" value="basra" label={c.basra} />
          </FieldGroup>
        </Specimen>
      </SpecimenGrid>
    </DsBlock>
  );
}

function Pickers({ c }: { c: C }) {
  const [gov, setGov] = useState<string | null>(null);
  const [period, setPeriod] = useState<Period>("any");
  const [colour, setColour] = useState<string | null>("white");
  return (
    <>
      <DsBlock id="forms-governorate" title={c.governorate} note={`${c.governorateNote} ${c.govKeys}`}>
        <SpecimenGrid wide>
          <Specimen label="<GovernoratePicker feeIqd governorates>">
            <GovernoratePicker label={c.governorate} required name="ds-gov" feeIqd={5_000} governorates={GOVERNORATES(c)} value={gov} onChange={setGov} />
          </Specimen>
          <Specimen label="error">
            <GovernoratePicker label={c.governorate} required feeIqd={5_000} governorates={GOVERNORATES(c)} error={c.governorateError} />
          </Specimen>
        </SpecimenGrid>
      </DsBlock>
      <DsBlock id="forms-preference" title={c.preference} note={c.preferenceNote}>
        <SpecimenGrid wide>
          <Specimen label="<PreferencePicker> (periods only)" wide>
            <PreferencePicker name="ds-period" value={period} onChange={setPeriod} />
          </Specimen>
          <Specimen label={`<PreferencePicker label id> · ${c.preferenceLabel}`} wide>
            <PreferencePicker id="ds-handover" name="ds-handover" label={c.handover} />
          </Specimen>
        </SpecimenGrid>
      </DsBlock>
      <DsBlock id="forms-swatches" title={c.swatches} note={c.swatchesNote}>
        <SpecimenGrid wide>
          <Specimen label="<Swatches> dots · unavailable">
            <Swatches
              label={c.colour}
              value={colour}
              onChange={setColour}
              options={[
                { value: "white", name: c.white, color: "var(--paper)" },
                { value: "black", name: c.black, color: "var(--ink)" },
                { value: "red", name: c.red, color: "var(--red-ink)", unavailable: true },
              ]}
            />
          </Specimen>
          <Specimen label={`<Swatches> unavailable="soldOut" | "soon" | true · ${c.swatchReasons}`}>
            <Swatches
              label={c.colour}
              defaultValue="red"
              options={[
                { value: "red", name: c.red, color: "var(--red-ink)", unavailable: "soldOut" },
                { value: "green", name: c.green, color: "var(--ok)", unavailable: "soon" },
                { value: "black", name: c.black, color: "var(--ink)", unavailable: true },
              ]}
            />
          </Specimen>
          <Specimen label="<Swatches> thumbnails (56px on the product ground)">
            <Swatches
              label={c.colour}
              defaultValue="white"
              options={[
                { value: "white", name: c.white, thumb: <Render name="dualsense--1" alt="" sizes="56px" /> },
                { value: "black", name: c.black, thumb: <Render name="dualsense-edge--1" alt="" sizes="56px" /> },
              ]}
            />
          </Specimen>
        </SpecimenGrid>
      </DsBlock>
    </>
  );
}

function Steppers({ c }: { c: C }) {
  const [qty, setQty] = useState(2);
  return (
    <DsBlock id="forms-stepper" title={c.stepper} note={c.stepperNote}>
      <SpecimenRow className="gap-8">
        <Specimen label='max={3} maxReason="stock" (hidden in demo mode)'>
          <Stepper value={qty} onChange={setQty} max={3} maxReason="stock" />
        </Specimen>
        <Specimen label="at the minimum (minus flat, still focusable)">
          <Stepper defaultValue={1} />
        </Specimen>
        <Specimen label='size="sm" (40)'>
          <Stepper size="sm" defaultValue={4} />
        </Specimen>
        <Specimen label="disabled">
          <Stepper defaultValue={1} disabled />
        </Specimen>
      </SpecimenRow>
    </DsBlock>
  );
}
