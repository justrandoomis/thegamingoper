import { useEffect, useState, type ReactNode } from "react";

import type { Route } from "./+types/design-system";
import { useLocale } from "~/i18n/react";
import { LOCALE_CODES, LOCALES, type Locale } from "~/lib/locales";
import { setPrefs, usePrefs, type Theme } from "~/lib/prefs";
import { MotionRoot, setMotionOverride, themeMorph, useDirectionMorph, useMotionTier, getMotionOverride } from "~/motion";
import { getCtx } from "~/server/context.server";
import { Segmented } from "~/ui/Segmented";
import { defineCopy, useCopy, type DsSectionModule } from "./design-system/kit";
import "./design-system/ds.css";

/**
 * /design-system (noindex) — the live reference for app/ui and app/styles (docs/UI.md).
 * Every file in ./design-system/sections/*.tsx is a section (see kit.tsx): owners add theirs without editing this page.
 */
const modules = import.meta.glob<DsSectionModule>("./design-system/sections/*.tsx", { eager: true });
const SECTIONS = Object.values(modules)
  .filter((mod) => mod.section && typeof mod.default === "function")
  .sort((a, b) => a.section.order - b.section.order);

const COPY = defineCopy({
  ar: {
    title: "نظام التصميم",
    lede: "نظام التصميم 2.1 «الطين والزجاج»: الأحمر والأبيض هوية المتجر وألوان المنصات أبوابه الحيّة، وخط المتجر الأول، وأزرار طينية بارزة، وبطاقات ناعمة وزجاج حقيقي، وزر أحمر لامع واحد في كل شاشة. كل ما هنا مكوّنات حقيقية من app/ui بكل حالاتها.",
    demo: "أسماء المنتجات والأسعار في هذه الصفحة أمثلة للعرض، وليست أسعار المتجر.",
    theme: "المظهر",
    light: "فاتح",
    dark: "داكن",
    system: "النظام",
    language: "اللغة",
    currency: "عملة العرض",
    density: "الكثافة",
    store: "المتجر",
    admin: "الإدارة",
    motion: "الحركة",
    full: "كاملة",
    lite: "خفيفة",
    reduced: "مخفّضة",
    device: "الجهاز",
    sections: "الأقسام",
  },
  en: {
    title: "Design system",
    lede: "Design System 2.1 \"Clay & Glass\": red and white is the brand and the vivid platform colours are the doors; the store's original type, raised clay keys, soft cards and real glass; one glossy red primary per view. Everything here is a real component from app/ui, in every state.",
    demo: "Product names and prices on this page are display examples, not the shop's prices.",
    theme: "Theme",
    light: "Light",
    dark: "Dark",
    system: "System",
    language: "Language",
    currency: "Display currency",
    density: "Density",
    store: "Storefront",
    admin: "Admin",
    motion: "Motion",
    full: "Full",
    lite: "Lite",
    reduced: "Reduced",
    device: "Device",
    sections: "Sections",
  },
  ckb: {
    title: "سیستەمی دیزاین",
    lede: "سیستەمی دیزاین 2.1 «قوڕ و شووشە»: سوور و سپی ناسنامەی فرۆشگایە و ڕەنگە زیندووەکانی پلاتفۆرمەکان دەرگاکانین؛ فۆنتی سەرەتای فرۆشگا، دوگمەی قوڕی بەرز، کارتی نەرم و شووشەی ڕاستەقینە؛ یەک دوگمەی سووری بریقەدار لە هەر شاشەیەکدا. هەموو ئەوەی لێرەیە پێکهاتەی ڕاستەقینەی app/ui یە.",
    demo: "ناوی بەرهەم و نرخەکانی ئەم پەڕەیە نموونەن، نرخی فرۆشگا نین.",
    theme: "ڕووکار",
    light: "ڕوون",
    dark: "تاریک",
    system: "سیستەم",
    language: "زمان",
    currency: "دراوی پیشاندان",
    density: "چڕی",
    store: "فرۆشگا",
    admin: "بەڕێوەبردن",
    motion: "جووڵە",
    full: "تەواو",
    lite: "سووک",
    reduced: "کەمکراوە",
    device: "ئامێر",
    sections: "بەشەکان",
  },
});

/** How long the streamed specimen (sections/reveal.tsx) waits: long enough that the page's shell is sent first. */
const REVEAL_AFTER_MS = 450;

export function loader({ context }: Route.LoaderArgs) {
  const ctx = getCtx(context);
  // Not awaited: React Router streams it, so "content that arrives" is shown with real Suspense + hydration.
  const reveal = new Promise<number>((resolve) => setTimeout(() => resolve(REVEAL_AFTER_MS), REVEAL_AFTER_MS));
  return { title: `${COPY[ctx.locale].title} — TamTam`, reveal };
}

export function meta({ loaderData }: Route.MetaArgs) {
  return [{ title: loaderData?.title }, { name: "robots", content: "noindex, nofollow" }];
}

export default function DesignSystem() {
  const c = useCopy(COPY);
  const locale = useLocale();
  const prefs = usePrefs();
  const switchLanguage = useDirectionMorph();
  const tier = useMotionTier();
  const [density, setDensity] = useState<"store" | "admin">("store");
  const [motion, setMotion] = useState<string>("device");
  useEffect(() => setMotion(getMotionOverride() ?? "device"), []);

  return (
    <div className="ds" data-density={density === "admin" ? "admin" : undefined}>
      <MotionRoot />
      <header className="ds-head page">
        <h1 className="ds-title">{c.title}</h1>
        <p className="ds-lede">{c.lede}</p>
        <p className="ds-demo-note">{c.demo}</p>
        <div className="ds-controls">
          <Control label={c.theme}>
            <Segmented
              inline
              aria-label={c.theme}
              options={[
                { value: "light", label: c.light, icon: "sun" },
                { value: "dark", label: c.dark, icon: "moon" },
                { value: "system", label: c.system },
              ]}
              value={prefs.theme}
              onChange={(value) => void themeMorph(value as Theme)}
            />
          </Control>
          <Control label={c.language}>
            <Segmented
              inline
              aria-label={c.language}
              options={LOCALE_CODES.map((code) => ({ value: code, label: LOCALES[code].label, lang: LOCALES[code].bcp47 }))}
              value={locale}
              onChange={(value) => switchLanguage(value as Locale)}
            />
          </Control>
          <Control label={c.currency}>
            <Segmented
              inline
              aria-label={c.currency}
              options={[
                { value: "IQD", label: "IQD" },
                { value: "USD", label: "USD" },
              ]}
              value={prefs.currency}
              onChange={(value) => setPrefs({ currency: value as "IQD" | "USD" })}
            />
          </Control>
          <Control label={c.density}>
            <Segmented
              inline
              aria-label={c.density}
              options={[
                { value: "store", label: c.store },
                { value: "admin", label: c.admin },
              ]}
              value={density}
              onChange={(value) => setDensity(value as "store" | "admin")}
            />
          </Control>
          <Control label={`${c.motion} (${c[tier]})`}>
            <Segmented
              inline
              aria-label={c.motion}
              options={[
                { value: "device", label: c.device },
                { value: "full", label: c.full },
                { value: "lite", label: c.lite },
                { value: "reduced", label: c.reduced },
              ]}
              value={motion}
              onChange={(value) => {
                setMotion(value);
                setMotionOverride(value === "device" ? null : (value as "full" | "lite" | "reduced"));
              }}
            />
          </Control>
        </div>
      </header>
      <nav className="ds-toc page" aria-label={c.sections}>
        {SECTIONS.map(({ section }) => (
          <a key={section.id} href={`#${section.id}`} className="link min-w-11 justify-center">
            <span className="link__text">{section.title[locale]}</span>
          </a>
        ))}
      </nav>
      <div className="page">
        {SECTIONS.map(({ default: Section, section }) => (
          <section key={section.id} id={section.id} className="ds-section" aria-labelledby={`${section.id}-title`}>
            <h2 className="ds-h2" id={`${section.id}-title`}>
              {section.title[locale]}
            </h2>
            {section.owner ? <p className="ds-owner">{section.owner}</p> : null}
            <Section />
          </section>
        ))}
      </div>
    </div>
  );
}

function Control({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="ds-control">
      <span className="bank__label" aria-hidden="true">
        {label}
      </span>
      {children}
    </div>
  );
}
