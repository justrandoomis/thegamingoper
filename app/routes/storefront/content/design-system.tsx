// lint-design: allow commit-count — the reference page shows every key variant side by side; it is not a shopping view.
import { useEffect, useState, type ReactNode } from "react";

import type { Route } from "./+types/design-system";
import { useLocale } from "~/i18n/react";
import { LOCALE_CODES, LOCALES, type Locale } from "~/lib/locales";
import { setPrefs, usePrefs, type Theme } from "~/lib/prefs";
import { MotionRoot, setMotionOverride, themeMorph, useDirectionMorph, useMotionTier, getMotionOverride } from "~/motion";
import { getCtx } from "~/server/context.server";
import { KeyBank } from "~/ui/KeyBank";
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
    lede: "طين وعدسة 1.0: الطين لليد، والزجاج للعين، والضوء للمنصة، والأحمر للالتزام، والمسطّح للقراءة. كل ما هنا مكوّنات حقيقية من app/ui.",
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
    lede: "Lens & Clay 1.0: clay is for the hand, glass for the eye, light for the platform, red for the commit, flat for reading. Everything here is a real component from app/ui.",
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
    lede: "قوڕ و هاوێنە 1.0: قوڕ بۆ دەستە، شووشە بۆ چاوە، ڕووناکی بۆ پلاتفۆرمە، سوور بۆ پابەندبوونە، تەخت بۆ خوێندنەوەیە. هەموو ئەوەی لێرەیە پێکهاتەی ڕاستەقینەیە لە app/ui.",
    demo: "ناوی کاڵا و نرخەکانی ئەم پەڕەیە نموونەن، نرخی فرۆشگا نین.",
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

export function loader({ context }: Route.LoaderArgs) {
  const ctx = getCtx(context);
  return { title: `${COPY[ctx.locale].title} — TamTam` };
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
            <KeyBank
              kind="segment"
              aria-label={c.theme}
              items={[
                { value: "light", label: c.light, icon: "sun" },
                { value: "dark", label: c.dark, icon: "moon" },
                { value: "system", label: c.system },
              ]}
              value={prefs.theme}
              onChange={(value) => void themeMorph(value as Theme)}
            />
          </Control>
          <Control label={c.language}>
            <KeyBank
              kind="segment"
              aria-label={c.language}
              items={LOCALE_CODES.map((code) => ({ value: code, label: <span lang={LOCALES[code].bcp47}>{LOCALES[code].label}</span> }))}
              value={locale}
              onChange={(value) => switchLanguage(value as Locale)}
            />
          </Control>
          <Control label={c.currency}>
            <KeyBank
              kind="segment"
              aria-label={c.currency}
              items={[
                { value: "IQD", label: "IQD" },
                { value: "USD", label: "USD" },
              ]}
              value={prefs.currency}
              onChange={(value) => setPrefs({ currency: value as "IQD" | "USD" })}
            />
          </Control>
          <Control label={c.density}>
            <KeyBank
              kind="segment"
              aria-label={c.density}
              items={[
                { value: "store", label: c.store },
                { value: "admin", label: c.admin },
              ]}
              value={density}
              onChange={(value) => setDensity(value as "store" | "admin")}
            />
          </Control>
          <Control label={`${c.motion} (${c[tier]})`}>
            <KeyBank
              kind="segment"
              aria-label={c.motion}
              items={[
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
          <a key={section.id} href={`#${section.id}`} className="link">
            <span className="link__text">{section.title[locale]}</span>
          </a>
        ))}
      </nav>
      <main className="page">
        {SECTIONS.map(({ default: Section, section }) => (
          <section key={section.id} id={section.id} className="ds-section" aria-labelledby={`${section.id}-title`}>
            <h2 className="ds-h2" id={`${section.id}-title`}>
              {section.title[locale]}
            </h2>
            {section.owner ? <p className="ds-owner">{section.owner}</p> : null}
            <Section />
          </section>
        ))}
      </main>
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
