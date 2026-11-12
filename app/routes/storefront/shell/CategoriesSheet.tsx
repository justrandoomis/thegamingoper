/**
 * «التصنيفات» on phones and tablets (Design v2.1 — the client's reference «التصنيفات» screens; v2 §5.10): a
 * full-height sheet —
 *   1. the four platforms as the kit's vivid compact platform tiles (2 × 2: colour, name, count, the hardware photo);
 *   2. «الأقسام»: the departments as glass icon tiles, three to a row (four in a sheet 520px wide or more; a short
 *      last row centred) — a red kind icon, the name and the
 *      count (controllers, headsets, storage, VR, gift cards, accessories, games — consoles and handheld PCs live inside
 *      their platforms: the handheld platform is «الأجهزة المحمولة», its category «حواسيب الألعاب المحمولة» is shown
 *      inside it);
 *   3. «خدمات»: the same tiles for المستعمل (with how many units are listed), استبدل جهازك, تتبّع طلبك, الدعم, الصيانة;
 *   4. language, theme and the display currency.
 * The tiles arrive 30ms apart as the sheet rises (CSS; none under reduced motion). Every link closes the sheet as it
 * navigates. Client only (a <Sheet> renders nothing on the server); without script the tab leads to the footer's shop
 * column instead.
 */
import type { CSSProperties, ReactNode } from "react";

import { Icon, type IconName } from "~/art/Icon";
import { LocaleLink, useFormat } from "~/i18n/react";
import { cx } from "~/ui/cx";
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

/** Each department's kind icon (the kit's `kind-*` glyphs, v2.1 G4; VR has no kind glyph: the sprite's eye). */
const CATEGORY_GLYPH: Record<(typeof SHEET_CATEGORY_KINDS)[number], IconName> = {
  controllers: "kind-controller",
  headsets: "kind-headset",
  storage: "kind-storage",
  vr: "eye",
  digital: "kind-topup",
  accessories: "kind-accessory",
  games: "kind-game",
};
const glyphOf = (kind: string): IconName => (kind in CATEGORY_GLYPH ? CATEGORY_GLYPH[kind as keyof typeof CATEGORY_GLYPH] : "squares-four");

export function CategoriesSheet({ open, onClose, shell }: CategoriesSheetProps) {
  const t = useShellT();
  const nav = shell?.nav;
  const platforms = nav?.platforms ?? [];
  const categories = sheetCategories(nav?.categories ?? []);
  let order = 0;
  const next = () => order++;

  return (
    <Sheet open={open} onClose={onClose} title={t("sheet.title")} description={t("sheet.description")} snapPoints={[0.62, 1]} initialSnap={1}>
      <div className="shell-csheet">
        {platforms.length > 0 ? (
          <nav aria-label={t("sheet.platforms")}>
            <PlatformTilesCompact platforms={platforms} onPick={onClose} />
          </nav>
        ) : null}

        {categories.length > 0 ? (
          <nav aria-labelledby="shell-csheet-departments">
            <h3 id="shell-csheet-departments" className="shell-csheet__head">
              {t("sheet.departments")}
            </h3>
            <ul className="shell-itiles">
              {categories.map((category) => (
                <IconTile key={category.slug} to={category.href} icon={glyphOf(category.kind)} label={category.label} count={category.count} order={next()} onPick={onClose} />
              ))}
            </ul>
          </nav>
        ) : null}

        <nav aria-labelledby="shell-csheet-services">
          <h3 id="shell-csheet-services" className="shell-csheet__head">
            {t("sheet.services")}
          </h3>
          <ul className="shell-itiles">
            <IconTile to="/used" icon="kind-used" label={t("nav.used")} count={nav && nav.usedCount > 0 ? nav.usedCount : null} countLabel={nav ? t("sheet.usedCount", { count: nav.usedCount }) : undefined} order={next()} onPick={onClose} />
            <IconTile to="/trade-in" icon="recycle" label={t("links.tradeIn")} order={next()} onPick={onClose} />
            <IconTile to="/track" icon="package" label={t("links.track")} order={next()} onPick={onClose} />
            <IconTile to="/support" icon="lifebuoy" label={t("nav.support")} order={next()} onPick={onClose} />
            <IconTile to="/support/repair" icon="kind-repair" label={t("nav.repair")} order={next()} onPick={onClose} />
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
 * A glass icon tile (the client's reference): the kit's raised card (.surface — faux glass in dark) with a red line
 * kind icon, the name (three lines at most) and, when the data has one, the count in --ink-2 («18»; «18 منتجاً» for
 * assistive technology). One link.
 */
export function IconTile({
  to,
  icon,
  label,
  count = null,
  countLabel,
  order = 0,
  onPick,
}: {
  to: string;
  icon: IconName;
  label: ReactNode;
  count?: number | null;
  /** What the count means, read aloud («3 أجهزة»); default the product count. */
  countLabel?: string;
  /** Its place in the sheet: tiles arrive one after another. */
  order?: number;
  onPick?: () => void;
}) {
  const t = useShellT();
  const f = useFormat();
  const counted = typeof count === "number" && Number.isSafeInteger(count) && count >= 0;
  return (
    <li className="grid" style={{ "--i": order } as CSSProperties}>
      <LocaleLink to={to} className="surface shell-itile" data-press="soft" onClick={onPick}>
        <span className="shell-itile__ico" aria-hidden="true">
          <Icon name={icon} size={28} />
        </span>
        <span className="shell-itile__name">{label}</span>
        {counted ? (
          <span className="shell-itile__count">
            <span aria-hidden="true">{f.number(count)}</span>
            <span className="sr-only">{` · ${countLabel ?? t("nav.count", { count })}`}</span>
          </span>
        ) : null}
      </LocaleLink>
    </li>
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
