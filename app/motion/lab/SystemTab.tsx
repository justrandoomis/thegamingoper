import { useEffect, useState } from "react";
import { useLocale, useT } from "~/i18n/react";
import { LOCALE_CODES, LOCALES } from "~/lib/locales";
import { usePrefs, type Theme } from "~/lib/prefs";
import { getMotionOverride, setMotionOverride, useMotionTier, type MotionTier } from "../env";
import { themeMorph } from "../lazy";
import { useDirectionMorph } from "../nav";
import { LAB_ITEMS, labArt } from "./items";
import { PerfReadout } from "./LabBar";

type Choice = "auto" | MotionTier;
const CHOICES: Choice[] = ["auto", "full", "lite", "reduced"];

function TierSection() {
  const t = useT("motion");
  const tier = useMotionTier();
  // The stored override lives in localStorage: read it after mount so server and client render the same markup.
  const [choice, setChoice] = useState<Choice>("auto");
  useEffect(() => setChoice(getMotionOverride() ?? "auto"), []);

  const choose = (next: Choice) => {
    setChoice(next);
    setMotionOverride(next === "auto" ? null : next);
  };

  return (
    <section className="lab-card" aria-labelledby="lab-tier">
      <h2 id="lab-tier">{t("tier.title")}</h2>
      <p>{t("tier.body")}</p>
      <div className="lab-segment" role="radiogroup" aria-labelledby="lab-tier">
        {CHOICES.map((value) => (
          <button key={value} type="button" role="radio" aria-checked={choice === value} className="lab-segment__option" data-press="soft" data-testid={`tier-${value}`} onClick={() => choose(value)}>
            {t(`tier.${value}`)}
          </button>
        ))}
      </div>
      <p className="lab-note" aria-live="polite" data-testid="tier-current">
        {t("tier.current", { tier: t(`tier.${tier}`) })}
      </p>
    </section>
  );
}

const THEMES: Theme[] = ["light", "dark", "system"];

function ThemeSection() {
  const t = useT("motion");
  const { theme } = usePrefs();
  return (
    <section className="lab-card" aria-labelledby="lab-theme">
      <h2 id="lab-theme">{t("theme.title")}</h2>
      <p>{t("theme.body")}</p>
      <div className="lab-segment" role="radiogroup" aria-labelledby="lab-theme">
        {THEMES.map((value) => (
          <button
            key={value}
            type="button"
            role="radio"
            aria-checked={theme === value}
            className="lab-segment__option"
            data-press="soft"
            data-testid={`theme-${value}`}
            onClick={(event) => void themeMorph(value, event.currentTarget)}
          >
            {t(`theme.${value}`)}
          </button>
        ))}
      </div>
    </section>
  );
}

function LanguageSection() {
  const t = useT("motion");
  const locale = useLocale();
  const switchLanguage = useDirectionMorph();
  return (
    <section className="lab-card" aria-labelledby="lab-language">
      <h2 id="lab-language">{t("language.title")}</h2>
      <p>{t("language.body")}</p>
      <label className="lab-field">
        <span>{t("language.field")}</span>
        <input type="text" name="lab-demo" placeholder={t("language.placeholder")} autoComplete="off" data-testid="language-field" />
      </label>
      {/* An anchor (DESIGN.md: "the stage and its render stay exactly where they are"): it does not slide with the page. */}
      <div className="lab-anchor-art" data-motion-anchor="" data-testid="language-anchor">
        <img src={labArt(LAB_ITEMS[0].hue)} alt={t("language.anchor")} width={400} height={400} />
      </div>
      <div className="lab-segment" role="group" aria-labelledby="lab-language">
        {LOCALE_CODES.map((code) => (
          <button
            key={code}
            type="button"
            lang={LOCALES[code].bcp47}
            dir={LOCALES[code].dir}
            aria-pressed={locale === code}
            className="lab-segment__option"
            data-press="soft"
            data-testid={`lang-${code}`}
            onClick={() => {
              if (code !== locale) switchLanguage(code);
            }}
          >
            {LOCALES[code].label}
          </button>
        ))}
      </div>
    </section>
  );
}

function PerfSection() {
  const t = useT("motion");
  return (
    <section className="lab-card" aria-labelledby="lab-perf">
      <h2 id="lab-perf">{t("perf.title")}</h2>
      <p>{t("perf.body")}</p>
      <PerfReadout detailed />
    </section>
  );
}

export function SystemTab() {
  return (
    <>
      <TierSection />
      <ThemeSection />
      <LanguageSection />
      <PerfSection />
    </>
  );
}
