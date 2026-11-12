/**
 * «التصنيفات» on phones and tablets (Design System v2 §5.10): a full-height sheet —
 *   1. the four platforms as compact platform tiles (2 × 2: colour, name, count, the hardware photo);
 *   2. two wide entry cards, «المستعمل والمفحوص» and «الدعم» (used and support stay prominent);
 *   3. the departments as category tiles in three columns, with their counts (controllers, headsets, storage, VR,
 *      gift cards, accessories, games — consoles and handheld PCs live inside their platforms: the handheld platform
 *      is «الأجهزة المحمولة», its category «حواسيب الألعاب المحمولة» is shown inside it);
 *   4. rows: استبدل جهازك · تتبّع طلبك;
 *   5. language, theme and the display currency.
 * Every link closes the sheet as it navigates. Client only (a <Sheet> renders nothing on the server); without script
 * the tab leads to the footer's shop column instead.
 */
import type { ReactNode } from "react";

import { Icon, type IconName } from "~/art/Icon";
import { LocaleLink } from "~/i18n/react";
import { CategoryTile } from "~/ui/CategoryTile";
import { cx } from "~/ui/cx";
import { EntryCard } from "~/ui/EntryCard";
import { isPlatform } from "~/ui/PlatformLed";
import { PlatformTile } from "~/ui/PlatformTile";
import { Sheet } from "~/ui/Sheet";
import { SHEET_CATEGORY_KINDS, sheetCategories } from "./chrome";
import { usePlatformName } from "./MegaMenu";
import { CurrencyPanel, LanguageBank, PreferenceGroup, ThemeBank } from "./Preferences";
import { useShellT } from "./i18n";
import type { NavPlatform, ShellData } from "./types";

export type CategoriesSheetProps = {
  open: boolean;
  onClose: () => void;
  shell: ShellData | null;
};

/** The glyph that stands in for a department's photo until the navigation data carries one. */
const CATEGORY_GLYPH: Record<(typeof SHEET_CATEGORY_KINDS)[number], IconName> = {
  controllers: "game-controller",
  headsets: "headphones",
  storage: "hard-drives",
  vr: "eye",
  digital: "gift",
  accessories: "plug",
  games: "disc",
};
const glyphOf = (kind: string): IconName => (kind in CATEGORY_GLYPH ? CATEGORY_GLYPH[kind as keyof typeof CATEGORY_GLYPH] : "squares-four");

export function CategoriesSheet({ open, onClose, shell }: CategoriesSheetProps) {
  const t = useShellT();
  const nav = shell?.nav;
  const platforms = nav?.platforms ?? [];
  const categories = sheetCategories(nav?.categories ?? []);
  const usedArt = platforms.find((platform) => platform.artKey)?.artKey ?? null;

  return (
    <Sheet open={open} onClose={onClose} title={t("sheet.title")} description={t("sheet.description")} snapPoints={[0.62, 1]} initialSnap={1}>
      <div className="shell-csheet">
        {platforms.length > 0 ? (
          <nav aria-label={t("sheet.platforms")}>
            <PlatformTilesCompact platforms={platforms} onPick={onClose} />
          </nav>
        ) : null}

        <div className="shell-csheet__entries">
          <EntryCard
            to="/used"
            title={t("sheet.usedTitle")}
            text={nav && nav.usedCount > 0 ? `${t("sheet.usedText")} · ${t("sheet.usedCount", { count: nav.usedCount })}` : t("sheet.usedText")}
            art={usedArt ?? undefined}
            onClick={onClose}
          />
          <EntryCard to="/support" title={t("sheet.supportTitle")} text={t("sheet.supportText")} art="mascot" onClick={onClose} />
        </div>

        {categories.length > 0 ? (
          <nav aria-labelledby="shell-csheet-departments">
            <h3 id="shell-csheet-departments" className="shell-csheet__head">
              {t("sheet.departments")}
            </h3>
            <ul className="cats">
              {categories.map((category) => (
                <li key={category.slug} className="grid">
                  <CategoryTile
                    to={category.href}
                    label={category.label}
                    count={category.count}
                    art={
                      <span className="absolute inset-0 grid place-items-center text-ink-2">
                        <Icon name={glyphOf(category.kind)} size={32} />
                      </span>
                    }
                    onClick={onClose}
                  />
                </li>
              ))}
            </ul>
          </nav>
        ) : null}

        <nav aria-label={t("sheet.services")}>
          <ul className="shell-csheet__rows">
            <ShellRow to="/trade-in" icon="recycle" title={t("links.tradeIn")} onPick={onClose} />
            <ShellRow to="/track" icon="package" title={t("links.track")} onPick={onClose} />
          </ul>
        </nav>

        <div className="shell-csheet__prefs">
          <h3 className="sr-only">{t("sheet.preferences")}</h3>
          <PreferenceGroup label={t("language.label")}>
            <LanguageBank onSwitch={onClose} />
          </PreferenceGroup>
          <PreferenceGroup label={t("theme.label")}>
            <ThemeBank />
          </PreferenceGroup>
          <PreferenceGroup label={t("currency.label")}>
            <CurrencyPanel />
          </PreferenceGroup>
        </div>
      </div>
    </Sheet>
  );
}

/**
 * The four platforms as the kit's compact platform tiles (v2 §4.19 `compact`: 96px, the hardware inside the tile):
 * colour, name, how many products, the lead device's photo, 2 × 2 (four in a row from 768 on the 404 page). The
 * categories sheet and the 404 page. A platform without one of the four colours is left out (no invented surface).
 */
export function PlatformTilesCompact({ platforms, onPick, className }: { platforms: NavPlatform[]; onPick?: () => void; className?: string }) {
  const nameOf = usePlatformName();
  return (
    <ul className={cx("shell-csheet__tiles", className)}>
      {platforms.map((platform) =>
        isPlatform(platform.accent) ? (
          <li key={platform.slug} className="grid">
            <PlatformTile compact platform={platform.accent} to={platform.href} name={nameOf(platform)} count={platform.productCount} art={platform.artKey ?? undefined} onClick={onPick} />
          </li>
        ) : null,
      )}
    </ul>
  );
}

/** A 56px row link (icon · words · caret) for a `.shell-csheet__rows` list: the categories sheet and the 404 page. */
export function ShellRow({ to, icon, title, onPick }: { to: string; icon: IconName; title: ReactNode; onPick?: () => void }) {
  return (
    <li>
      <LocaleLink to={to} className="shell-row" onClick={onPick}>
        <Icon name={icon} size={24} />
        <span className="shell-row__text">{title}</span>
        <Icon name="caret-right" size={16} className="shell-row__end" />
      </LocaleLink>
    </li>
  );
}
