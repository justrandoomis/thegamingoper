/**
 * The shopper's three switches, in every form the shell needs them:
 *
 *   <LanguageLinks />          ar · ckb · en as real links (work without script); with script the switch keeps the
 *                              page, its scroll and its form state and plays the direction morph (useDirectionMorph)
 *   <LanguageBank />           the same as a key bank (categories sheet)
 *   <CurrencyMenu />           utility-bar button + popover: IQD / USD, the rate, its source and date, "you pay in
 *                              dinars", and — when the rate is the demo seed's placeholder — that it is a demo rate
 *   <CurrencyPanel />          the popover's content on its own (categories sheet)
 *   <ThemeToggle />            light ↔ dark icon key (themeMorph: the prefs cookie + a 200 ms cross-fade)
 *   <ThemeBank />              light / dark / system (categories sheet)
 *
 * Display currency and theme are preferences (cookie `tt_prefs`, no request); the language is the URL prefix.
 */
import { useEffect, useId, useLayoutEffect, useRef, useState, useSyncExternalStore, type MouseEvent, type ReactNode } from "react";
import { useLocation, useRouteLoaderData } from "react-router";

import { Icon } from "~/art/Icon";
import { useFormat, useLocale } from "~/i18n/react";
import { LOCALE_CODES, LOCALES, switchLocalePath, type Locale } from "~/lib/locales";
import { CURRENCIES, type CurrencyCode, type FxSnapshot } from "~/lib/money";
import { setPrefs, usePrefs, type Theme } from "~/lib/prefs";
import { dematerialize, materialize, themeMorph, useDirectionMorph } from "~/motion";
import { cx } from "~/ui/cx";
import { Glass } from "~/ui/Glass";
import { IconKey } from "~/ui/IconKey";
import { KeyBank } from "~/ui/KeyBank";
import { useShellT } from "./i18n";

/** Locales in the order the switch shows them (the mock's: العربية · کوردی · English). */
const LANGUAGE_ORDER: Locale[] = ["ar", "ckb", "en"];

function isPlainClick(event: MouseEvent<HTMLAnchorElement>): boolean {
  return event.button === 0 && !event.metaKey && !event.ctrlKey && !event.shiftKey && !event.altKey;
}

// ───────────────────────────────────────────────────────────────── language

export function LanguageLinks({ className, linkClassName, onSwitch }: { className?: string; linkClassName?: string; onSwitch?: () => void }) {
  const t = useShellT();
  const locale = useLocale();
  const location = useLocation();
  const switchLanguage = useDirectionMorph();
  return (
    <span className={className} role="group" aria-label={t("language.label")}>
      {LANGUAGE_ORDER.filter((code) => LOCALE_CODES.includes(code)).map((code) => (
        <a
          key={code}
          // no #fragment in the href: the server never sees one, so it would not hydrate (the switch keeps it anyway)
          href={switchLocalePath(location.pathname, location.search, "", code)}
          lang={LOCALES[code].bcp47}
          hrefLang={LOCALES[code].bcp47}
          aria-current={code === locale ? "true" : undefined}
          className={linkClassName}
          onClick={(event) => {
            if (!isPlainClick(event)) return;
            event.preventDefault();
            onSwitch?.();
            if (code !== locale) switchLanguage(code);
          }}
        >
          {LOCALES[code].label}
        </a>
      ))}
    </span>
  );
}

export function LanguageBank({ onSwitch }: { onSwitch?: () => void }) {
  const t = useShellT();
  const locale = useLocale();
  const switchLanguage = useDirectionMorph();
  return (
    <KeyBank
      kind="segment"
      aria-label={t("language.label")}
      items={LANGUAGE_ORDER.map((code) => ({ value: code, label: <span lang={LOCALES[code].bcp47}>{LOCALES[code].label}</span> }))}
      value={locale}
      onChange={(value) => {
        onSwitch?.();
        if (value !== locale) switchLanguage(value as Locale);
      }}
    />
  );
}

// ───────────────────────────────────────────────────────────────── currency

type RootFx = { fx?: FxSnapshot | null; fxIsDemo?: boolean };

/** IQD / USD as keys, then what the conversion means: rate, source, date, demo note — or that there is no rate. */
export function CurrencyPanel({ className }: { className?: string }) {
  const t = useShellT();
  const f = useFormat();
  const prefs = usePrefs();
  const root = useRouteLoaderData("root") as RootFx | undefined;
  const fx = root?.fx ?? null;
  const usdRate = fx?.iqdPerUnit.USD;
  return (
    <div className={cx("flex flex-col gap-3", className)}>
      <KeyBank
        kind="segment"
        aria-label={t("currency.label")}
        items={(["IQD", "USD"] as const).map((code) => ({
          value: code,
          label: `${t(`currency.${code}`)} · ${CURRENCIES[code].symbol[f.locale]}`,
          disabled: code === "USD" && !usdRate,
        }))}
        value={prefs.currency}
        onChange={(value) => setPrefs({ currency: value as CurrencyCode })}
      />
      <div className="type-caption flex flex-col gap-1 text-ink-2">
        <p className="text-ink">{t("currency.payIqd")}</p>
        {fx && usdRate ? (
          <>
            <p>
              {t("currency.rate", { rate: "⁦" + `1 USD = ${f.number(usdRate)} ${CURRENCIES.IQD.symbol[f.locale]}` + "⁩" })}
            </p>
            <p>{t("currency.source", { source: "⁨" + fx.source + "⁩", date: f.date(fx.updatedAt, "medium") })}</p>
            {root?.fxIsDemo ? <p className="text-ink">{t("currency.demoRate")}</p> : null}
          </>
        ) : (
          <p>{t("currency.noRate")}</p>
        )}
      </div>
    </div>
  );
}

/** The utility bar's currency button ("الدينار العراقي · د.ع") with the panel in a popover. */
export function CurrencyMenu() {
  const t = useShellT();
  const f = useFormat();
  const prefs = usePrefs();
  const [open, setOpen] = useState(false);
  const [present, setPresent] = useState(false);
  const button = useRef<HTMLButtonElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  const panelId = useId();
  const name = `${t(`currency.${prefs.currency}`)} · ${CURRENCIES[prefs.currency].symbol[f.locale]}`;

  if (open && !present) setPresent(true);

  // arrive: drop in from the button (8px and opacity); leave the same way, then unmount
  useLayoutEffect(() => {
    const element = panel.current;
    if (!element) return;
    if (open) void materialize(element, { from: button.current ?? undefined });
    else
      void dematerialize(element).then(() => {
        setPresent(false);
      });
  }, [open, present]);

  // close on Escape (focus back to the button), a press outside, or focus leaving both
  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      setOpen(false);
      button.current?.focus();
    };
    const onPointer = (event: PointerEvent) => {
      const target = event.target as Node;
      if (panel.current?.contains(target) || button.current?.contains(target)) return;
      setOpen(false);
    };
    const onFocus = (event: FocusEvent) => {
      const target = event.target as Node;
      if (panel.current?.contains(target) || button.current?.contains(target)) return;
      setOpen(false);
    };
    document.addEventListener("keydown", onKey);
    document.addEventListener("pointerdown", onPointer);
    document.addEventListener("focusin", onFocus);
    return () => {
      document.removeEventListener("keydown", onKey);
      document.removeEventListener("pointerdown", onPointer);
      document.removeEventListener("focusin", onFocus);
    };
  }, [open]);

  return (
    <span className="relative">
      <button
        ref={button}
        type="button"
        className="shell-utility__link hit-44"
        aria-expanded={open}
        aria-controls={present ? panelId : undefined}
        aria-label={t("currency.button", { name })}
        onClick={() => setOpen((value) => !value)}
      >
        <span>{name}</span>
        <Icon name="caret-down" size={14} />
      </button>
      {present ? (
        <Glass
          ref={panel}
          id={panelId}
          role="region"
          aria-label={t("currency.label")}
          className="shell-popover"
        >
          <CurrencyPanel />
        </Glass>
      ) : null}
    </span>
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

export function ThemeToggle({ className }: { className?: string }) {
  const t = useShellT();
  const shown = useShownTheme();
  const next: Theme = shown === "dark" ? "light" : "dark";
  return (
    <IconKey
      variant="quiet"
      className={className}
      icon={shown === "dark" ? "sun" : "moon"}
      label={t(next === "dark" ? "theme.toDark" : "theme.toLight")}
      onClick={() => void themeMorph(next)}
    />
  );
}

export function ThemeBank() {
  const t = useShellT();
  const prefs = usePrefs();
  return (
    <KeyBank
      kind="segment"
      aria-label={t("theme.label")}
      items={[
        { value: "light", label: t("theme.light"), icon: "sun" },
        { value: "dark", label: t("theme.dark"), icon: "moon" },
        { value: "system", label: t("theme.system") },
      ]}
      value={prefs.theme}
      onChange={(value) => void themeMorph(value as Theme)}
    />
  );
}

/** A labelled group for the sheet and the footer. */
export function PreferenceGroup({ label, children }: { label: string; children: ReactNode }) {
  const id = useId();
  return (
    <div role="group" aria-labelledby={id} className="flex flex-col gap-2">
      <span id={id} className="type-label text-ink-2">
        {label}
      </span>
      {children}
    </div>
  );
}
