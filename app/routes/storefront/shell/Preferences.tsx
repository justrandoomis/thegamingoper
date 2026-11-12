/**
 * The shopper's switches, in the forms the shell needs (Design System v2 §4.6, §5.3, §5.9, §5.10):
 *
 *   <LanguageBank />     العربية · English · کوردی as a segmented row of REAL links (each name in its own script; they
 *                        work without script; with script the switch keeps the page, its scroll and its form state
 *                        and plays the direction morph). Footer, categories sheet, the accessibility page.
 *   <LanguageMenu />     the desktop header's globe button → a menu of the three languages
 *   <ThemeBank />        النظام · فاتح · داكن (segmented; themeMorph: the prefs cookie + a 200 ms cross-fade)
 *   <CurrencyPanel />    الدينار · الدولار (segmented) with the rate, its source and date, "you pay in dinars", and — when
 *                        the rate is the demo seed's placeholder — that it is a demo rate (its source then in the
 *                        shopper's language: the seed stores one Arabic sentence; an owner's real source shows as typed)
 *   <PreferenceGroup />  a labelled group for the footer and the sheet
 *
 * Display currency and theme are preferences (cookie `tt_prefs`, no request); the language is the URL prefix.
 */
import { useId, useSyncExternalStore, type MouseEvent, type ReactNode } from "react";
import { useLocation, useRouteLoaderData } from "react-router";

import { Icon } from "~/art/Icon";
import { useFormat, useLocale } from "~/i18n/react";
import { LOCALE_CODES, LOCALES, switchLocalePath, type Locale } from "~/lib/locales";
import { CURRENCIES, type CurrencyCode, type FxSnapshot } from "~/lib/money";
import { setPrefs, usePrefs, type Theme } from "~/lib/prefs";
import { themeMorph, useDirectionMorph } from "~/motion";
import { cx } from "~/ui/cx";
import { IconKey } from "~/ui/IconKey";
import { Menu } from "~/ui/Menu";
import { Segmented } from "~/ui/Segmented";
import { canonicalSearch } from "./chrome";
import { useShellT } from "./i18n";

/** Locales in the order every language switch shows them (v2 §5.3): العربية · English · کوردی. */
const LANGUAGE_ORDER: Locale[] = ["ar", "en", "ckb"];
const languages = () => LANGUAGE_ORDER.filter((code) => LOCALE_CODES.includes(code));

function isPlainClick(event: MouseEvent<HTMLAnchorElement>): boolean {
  return event.button === 0 && !event.metaKey && !event.ctrlKey && !event.shiftKey && !event.altKey;
}

/**
 * Offline, a language switch cannot load the other language (React Router cannot even fetch the route manifest): it
 * would leave the address in the new language over the old page. So it waits — the page stays as it is, and the
 * offline banner under the header says why.
 */
const canSwitch = () => typeof navigator === "undefined" || navigator.onLine !== false;

// ───────────────────────────────────────────────────────────────── language

/**
 * The three languages as a segmented row of links (`.seg` look; the current one `aria-current`). No #fragment in the
 * href (the server never sees one, so it would not hydrate; the switch keeps it anyway); the query in the server's
 * spelling ("%20" → "+", "," → "%2C"), the same before and after hydration.
 */
export function LanguageBank({ onSwitch, className }: { onSwitch?: () => void; className?: string }) {
  const t = useShellT();
  const locale = useLocale();
  const location = useLocation();
  const switchLanguage = useDirectionMorph();
  return (
    <nav aria-label={t("language.label")} className={cx("seg seg--inline", className)}>
      {languages().map((code) => (
        <a
          key={code}
          href={switchLocalePath(location.pathname, canonicalSearch(location.search), "", code)}
          lang={LOCALES[code].bcp47}
          hrefLang={LOCALES[code].bcp47}
          aria-current={code === locale ? "true" : undefined}
          className="seg__opt"
          data-press="soft"
          onClick={(event) => {
            if (!isPlainClick(event)) return;
            event.preventDefault();
            if (!canSwitch()) return;
            onSwitch?.();
            if (code !== locale) switchLanguage(code);
          }}
        >
          {LOCALES[code].label}
        </a>
      ))}
    </nav>
  );
}

/** The desktop header's language button: the globe, and a menu of the three languages (each in its own script). */
export function LanguageMenu({ className }: { className?: string }) {
  const t = useShellT();
  const locale = useLocale();
  const switchLanguage = useDirectionMorph();
  const label = t("tools.language", { name: LOCALES[locale].label });
  return (
    <Menu
      label={t("language.label")}
      align="end"
      className={className}
      items={languages().map((code) => ({
        id: code,
        kind: "radio" as const,
        label: LOCALES[code].label,
        checked: code === locale,
        onSelect: () => {
          if (code !== locale && canSwitch()) switchLanguage(code);
        },
      }))}
      trigger={(props) => <IconKey {...props} variant="plain" icon={<Icon name="globe" size={24} />} label={label} />}
    />
  );
}

// ───────────────────────────────────────────────────────────────── currency

type RootFx = { fx?: FxSnapshot | null; fxIsDemo?: boolean };

/** IQD / USD, then what the conversion means: rate, source, date, demo note — or that there is no rate. */
export function CurrencyPanel({ className }: { className?: string }) {
  const t = useShellT();
  const f = useFormat();
  const prefs = usePrefs();
  const root = useRouteLoaderData("root") as RootFx | undefined;
  const fx = root?.fx ?? null;
  const usdRate = fx?.iqdPerUnit.USD;
  return (
    <div className={cx("grid gap-2", className)}>
      <Segmented
        inline
        aria-label={t("currency.label")}
        options={(["IQD", "USD"] as const).map((code) => ({
          value: code,
          label: `${t(`currency.${code}`)} · ${CURRENCIES[code].symbol[f.locale]}`,
          disabled: code === "USD" && !usdRate,
        }))}
        value={prefs.currency}
        onChange={(value) => setPrefs({ currency: value as CurrencyCode })}
      />
      <div className="shell-pref__note grid gap-0.5">
        <p>{t("currency.payIqd")}</p>
        {fx && usdRate ? (
          <>
            <p>{t("currency.rate", { rate: "⁦" + `1 USD = ${f.number(usdRate)} ${CURRENCIES.IQD.symbol[f.locale]}` + "⁩" })}</p>
            <p>{t("currency.source", { source: "⁨" + (root?.fxIsDemo ? t("currency.demoSource") : fx.source) + "⁩", date: f.date(fx.updatedAt, "long") })}</p>
            {root?.fxIsDemo ? <p className="text-ink">{t("currency.demoRate")}</p> : null}
          </>
        ) : (
          <p>{t("currency.noRate")}</p>
        )}
      </div>
    </div>
  );
}

// ───────────────────────────────────────────────────────────────── theme

function subscribeTheme(listener: () => void): () => void {
  const observer = new MutationObserver(listener);
  observer.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
  return () => observer.disconnect();
}
const readTheme = (): "light" | "dark" => (document.documentElement.dataset.theme === "dark" ? "dark" : "light");

/**
 * The theme the page is showing right now: <html data-theme> (resolved before paint, kept by the root's ThemeSync).
 * The server cannot know what "system" resolves to, so it guesses from the cookie and the client corrects it.
 */
export function useShownTheme(): "light" | "dark" {
  const { theme } = usePrefs();
  return useSyncExternalStore(subscribeTheme, readTheme, () => (theme === "dark" ? "dark" : "light"));
}

/** النظام · فاتح · داكن. */
export function ThemeBank({ className }: { className?: string }) {
  const t = useShellT();
  const prefs = usePrefs();
  return (
    <Segmented
      inline
      aria-label={t("theme.label")}
      className={className}
      options={[
        { value: "system", label: t("theme.system") },
        { value: "light", label: t("theme.light"), icon: "sun" },
        { value: "dark", label: t("theme.dark"), icon: "moon" },
      ]}
      value={prefs.theme}
      onChange={(value) => void themeMorph(value as Theme)}
    />
  );
}

/** A labelled group (footer, categories sheet): the label above, the control under it. */
export function PreferenceGroup({ label, children, className }: { label: string; children: ReactNode; className?: string }) {
  const id = useId();
  return (
    <div role="group" aria-labelledby={id} className={cx("shell-pref", className)}>
      <span id={id} className="shell-pref__label">
        {label}
      </span>
      {children}
    </div>
  );
}
