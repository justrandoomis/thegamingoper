import { useState } from "react";

import { BidiText } from "~/ui/BidiText";
import { Breadcrumbs } from "~/ui/Breadcrumbs";
import { Chip, ChipGroup } from "~/ui/Chip";
import { Key } from "~/ui/Key";
import { DsBlock, defineCopy, Specimen, SpecimenGrid, useCopy, type DsSectionMeta } from "../kit";

/**
 * Mixed scripts (docs/ui/core.md "BidiText, BidiLabel"): names from the catalogue and the cases the storefront areas
 * reported, rendered by the kit. Each specimen line carries its reading units (`data-units`, logical order) so a
 * browser check can measure that they sit right to left and that every Latin unit reads left to right.
 */
export const section: DsSectionMeta = {
  id: "bidi",
  order: 5,
  title: { ar: "نصوص بخطّين", en: "Mixed scripts", ckb: "دەقی دوو ڕێنووس" },
};

type CaseKey = "thousands" | "bracketsArabic" | "numberInBrackets" | "ownedNumber" | "longTitle" | "commas" | "fullStop" | "separator" | "sign";

const COPY = defineCopy({
  ar: {
    textTitle: "BidiText — أسماء وجمل بخطّين",
    textNote:
      "كل اسم لاتيني وكل رقم معزول من اليسار إلى اليمين، والجملة تبقى باتجاه الصفحة. الأقواس حول العربية والفواصل والنقطة الأخيرة تبقى في الجملة، حيث يزاوجها المتصفح ويعكسها. الأمثلة من أسماء الكتالوج، وتُعرض من اليمين إلى اليسار في كل لغة.",
    thousands: "رقم بفواصل الآلاف يبقى رقماً واحداً.",
    bracketsArabic: "الأقواس حول نص عربي تبقى في الجملة، فتُزاوَج وتُعكس صحيحاً.",
    numberInBrackets: "رقم داخل قوسين حول العربية يُعزل وحده.",
    ownedNumber: "الرقم بعد العربية يتبعها، والاسم اللاتيني يبقى كاملاً عبر « + ».",
    longTitle: "عنوان لاتيني طويل بروابطه (: – +) عزلةٌ واحدة.",
    commas: "الفاصلة العربية تفصل البنود بترتيب الجملة.",
    fullStop: "النقطة الأخيرة تُنهي الجملة العربية.",
    separator: "فاصل القائمة « · » يبقى في الجملة.",
    sign: "العلامة التي تخصّ الاسم تبقى معه: AI+",
    labelsTitle: "BidiLabel — تسميات المفاتيح والرقائق ومسار الصفحة",
    labelsNote:
      "تسمية فيها حروف عربية تأخذ اتجاه الصفحة ولو بدأت بكلمة لاتينية؛ وتسمية بلا حروف عربية (PS5، 1 TB، A+) عزلةٌ من اليسار إلى اليمين. كان عنصر bdi العادي يخمّن الاتجاه من أول حرف، فيقلب «PlayStation 5 Slim (نسخة الأقراص)».",
    edition: "النسخة",
  },
  en: {
    textTitle: "BidiText — names and sentences in two scripts",
    textNote:
      "Every Latin name and every number is a left-to-right isolate; the sentence keeps the page's direction. Brackets around Arabic, separators and a final full stop stay in the sentence, where the browser pairs and mirrors them. The examples are catalogue names, shown right to left in every language.",
    thousands: "A number with thousands separators stays one number.",
    bracketsArabic: "Brackets around Arabic stay in the sentence, so they pair and mirror correctly.",
    numberInBrackets: "A number inside brackets around Arabic is isolated on its own.",
    ownedNumber: "A number after Arabic belongs to it; a Latin name stays whole across “ + ”.",
    longTitle: "A long Latin title with its own joiners (: – +) is one isolate.",
    commas: "Arabic commas separate the items in the sentence's order.",
    fullStop: "A final full stop ends the Arabic sentence.",
    separator: "A list separator “ · ” stays in the sentence.",
    sign: "A sign that belongs to the name stays with it: AI+",
    labelsTitle: "BidiLabel — labels of keys, chips and breadcrumbs",
    labelsNote:
      "A label with Arabic letters takes the page's direction even when it starts with a Latin word; a label without Arabic letters (PS5, 1 TB, A+) is a left-to-right isolate. A bare bdi element guessed the direction from the first letter and turned “PlayStation 5 Slim (نسخة الأقراص)” around.",
    edition: "Edition",
  },
  ckb: {
    textTitle: "BidiText — ناو و ڕستە بە دوو ڕێنووس",
    textNote:
      "هەر ناوێکی لاتینی و هەر ژمارەیەک لە چەپەوە بۆ ڕاست جیا دەکرێتەوە؛ ڕستەکە ئاڕاستەی پەڕەکە دەپارێزێت. کەوانە لە دەوری عەرەبی و جیاکەرەوەکان و خاڵی کۆتایی لە ڕستەکەدا دەمێننەوە، کە وێبگەڕ جووتیان دەکات و پێچەوانەیان دەکاتەوە. نموونەکان ناوی کاتالۆگن و لە هەموو زمانێکدا لە ڕاستەوە بۆ چەپ پیشان دەدرێن.",
    thousands: "ژمارەیەک بە جیاکەرەوەی هەزاران وەک یەک ژمارە دەمێنێتەوە.",
    bracketsArabic: "کەوانە لە دەوری دەقی عەرەبی لە ڕستەکەدا دەمێنێتەوە، بۆیە بە دروستی جووت و پێچەوانە دەبنەوە.",
    numberInBrackets: "ژمارەیەک لە ناو کەوانەی دەوری عەرەبیدا بە تەنها جیا دەکرێتەوە.",
    ownedNumber: "ژمارە دوای عەرەبی سەر بەوە؛ ناوی لاتینی بە « + » تەواو دەمێنێتەوە.",
    longTitle: "ناونیشانێکی لاتینیی درێژ بە پەیوەندکەرەکانی خۆیەوە (: – +) یەک جیاکراوەیە.",
    commas: "کۆمای عەرەبی بڕگەکان بە ڕیزبەندیی ڕستەکە جیا دەکاتەوە.",
    fullStop: "خاڵی کۆتایی ڕستە عەرەبییەکە تەواو دەکات.",
    separator: "جیاکەرەوەی لیست « · » لە ڕستەکەدا دەمێنێتەوە.",
    sign: "نیشانەیەک کە سەر بە ناوەکەیە لەگەڵیدا دەمێنێتەوە: AI+",
    labelsTitle: "BidiLabel — ناوی دوگمە و چیپ و ڕێڕەوی پەڕە",
    labelsNote:
      "ناوێک کە پیتی عەرەبیی تێدایە ئاڕاستەی پەڕەکە وەردەگرێت، تەنانەت ئەگەر بە وشەیەکی لاتینی دەست پێبکات؛ ناوێک بێ پیتی عەرەبی (PS5، 1 TB، A+) لە چەپەوە بۆ ڕاست جیا دەکرێتەوە. توخمی bdi ی ئاسایی ئاڕاستەکەی لە یەکەم پیتەوە مەزەندە دەکرد و «PlayStation 5 Slim (نسخة الأقراص)» ی هەڵدەگێڕایەوە.",
    edition: "وەشان",
  },
});

/** Text, its language, and its reading units in logical order (measured by the browser check). */
const CASES: { key: CaseKey; text: string; lang: "ar" | "ckb"; units: string[] }[] = [
  { key: "thousands", text: "أكثر من 25,000 لعبة", lang: "ar", units: ["أكثر", "25,000", "لعبة"] },
  { key: "bracketsArabic", text: "PlayStation 5 Slim (نسخة الأقراص) – 1TB", lang: "ar", units: ["PlayStation 5 Slim", "(", "نسخة", ")", "–", "1TB"] },
  { key: "numberInBrackets", text: "PlayStation 5 (الطراز الأصلي 2020)", lang: "ar", units: ["PlayStation 5", "(", "الطراز", "2020", ")"] },
  { key: "ownedNumber", text: "حزمة الإطلاق 2025: Switch 2 + Mario Kart World", lang: "ar", units: ["حزمة", "2025", ":", "Switch 2 + Mario Kart World"] },
  {
    key: "longTitle",
    text: "Pokémon Legends: Z-A – Nintendo Switch 2 Edition + Mega Dimension (نسخة فيزيائية)",
    lang: "ar",
    units: ["Pokémon Legends: Z-A – Nintendo Switch 2 Edition + Mega Dimension", "(", "نسخة", ")"],
  },
  { key: "commas", text: "Legion Go S بە SteamOS، Z1 Extreme 32GB / 1TB، Nebula Nocturne", lang: "ckb", units: ["Legion Go S", "بە", "SteamOS", "Z1 Extreme 32GB / 1TB", "Nebula Nocturne"] },
  { key: "fullStop", text: "يد التحكم الأصلية لجهاز PS5.", lang: "ar", units: ["لجهاز", "PS5", "."] },
  { key: "separator", text: "اهتزاز Haptic · Adaptive triggers", lang: "ar", units: ["اهتزاز", "Haptic", "·", "Adaptive triggers"] },
  { key: "sign", text: "MSI Claw 8 EX AI+ لجهاز محمول", lang: "ar", units: ["MSI Claw 8 EX AI+", "لجهاز"] },
];

export default function BidiSection() {
  const c = useCopy(COPY);
  return (
    <>
      <DsBlock id="bidi-text" title={c.textTitle} note={c.textNote}>
        <ul className="grid gap-2">
          {CASES.map((item) => (
            <li key={item.key} className="grid gap-1 rounded-md bg-niche px-4 py-3">
              <p dir="rtl" lang={item.lang} className="type-body text-ink" data-units={JSON.stringify(item.units)}>
                <BidiText text={item.text} />
              </p>
              <p className="type-caption text-ink-2">
                <BidiText text={c[item.key]} />
              </p>
            </li>
          ))}
        </ul>
      </DsBlock>
      <Labels c={c} />
    </>
  );
}

function Labels({ c }: { c: (typeof COPY)["ar"] }) {
  const [model, setModel] = useState("slim");
  const [filters, setFilters] = useState(["Nintendo Switch 2 (أوروبا)", "Xbox Series X — أسود"]);
  return (
    <DsBlock id="bidi-labels" title={c.labelsTitle} note={<BidiText text={c.labelsNote} />}>
      <SpecimenGrid wide>
        <Specimen label="<ChipGroup options> — Latin-first labels with Arabic">
          <div dir="rtl" lang="ar">
            <ChipGroup
              aria-label={c.edition}
              options={[
                { value: "slim", label: "PlayStation 5 Slim (نسخة الأقراص)" },
                { value: "digital", label: "PS5 Slim Digital Edition – 1TB" },
                { value: "pro", label: "PS5 Pro" },
              ]}
              value={model}
              onChange={setModel}
            />
          </div>
        </Specimen>
        <Specimen label="<Chip onRemove> · <Key>">
          <div dir="rtl" lang="ar" className="chips">
            {filters.map((label) => (
              <Chip key={label} onRemove={() => setFilters((list) => list.filter((value) => value !== label))}>
                {label}
              </Chip>
            ))}
            <Key size="sm">{"PlayStation Plus (رمز رقمي)"}</Key>
          </div>
        </Specimen>
        <Specimen label="<Breadcrumbs items>" wide>
          <div dir="rtl" lang="ar">
            <Breadcrumbs
              items={[
                { label: "الرئيسية", href: "/" },
                { label: "PlayStation", href: "/platform/playstation" },
                { label: "PlayStation 5 Slim (نسخة الأقراص) – 1TB" },
              ]}
            />
          </div>
        </Specimen>
      </SpecimenGrid>
    </DsBlock>
  );
}
