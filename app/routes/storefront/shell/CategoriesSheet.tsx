/**
 * "التصنيفات" on phones and tablets (docs/DESIGN.md §9.3): a bottom sheet whose first rows are Used devices and
 * Support, then the platforms (LED + name + how many products), the departments with their sub-categories, the
 * services (track, trade-in, help) and the preferences the desktop keeps in its utility bar (language, display
 * currency, theme). Every link closes the sheet as it navigates. Client only (a <Sheet> renders nothing on the
 * server); without script the tab leads to the same lists in the footer.
 */
import type { ReactNode } from "react";

import { Icon, type IconName } from "~/art/Icon";
import { LocaleLink } from "~/i18n/react";
import { PlatformLed, isPlatform } from "~/ui/PlatformLed";
import { Sheet } from "~/ui/Sheet";
import { usePlatformName } from "./MegaMenu";
import { CurrencyPanel, LanguageBank, PreferenceGroup, ThemeBank } from "./Preferences";
import { useShellT } from "./i18n";
import type { ShellData } from "./types";

export type CategoriesSheetProps = {
  open: boolean;
  onClose: () => void;
  shell: ShellData | null;
};

export function CategoriesSheet({ open, onClose, shell }: CategoriesSheetProps) {
  const t = useShellT();
  const nameOf = usePlatformName();
  const nav = shell?.nav;

  return (
    <Sheet open={open} onClose={onClose} title={t("sheet.title")} description={t("sheet.description")} snapPoints={[0.62, 1]} initialSnap={1}>
      <nav aria-label={t("sheet.title")}>
        <ul className="shell-rows">
          <Row to="/used" icon="recycle" title={t("sheet.used")} hint={t("sheet.usedHint")} count={nav && nav.usedCount > 0 ? t("sheet.usedCount", { count: nav.usedCount }) : null} onPick={onClose} />
          <Row to="/support" icon="wrench" title={t("sheet.support")} hint={t("sheet.supportHint")} onPick={onClose} />
        </ul>

        {nav && nav.platforms.length > 0 ? (
          <>
            <h3 className="shell-sheet__head">{t("sheet.platforms")}</h3>
            <ul className="shell-rows">
              {nav.platforms.map((platform) => (
                <li key={platform.slug} data-gel={isPlatform(platform.accent) ? platform.accent : undefined}>
                  <LocaleLink to={platform.href} className="shell-row" onClick={onClose}>
                    {isPlatform(platform.accent) ? <PlatformLed solid /> : null}
                    <span className="shell-row__text type-strong">
                      <span>{nameOf(platform)}</span>
                    </span>
                    <span className="shell-row__count">{t("nav.count", { count: platform.productCount })}</span>
                    <Icon name="caret-right" size={16} />
                  </LocaleLink>
                </li>
              ))}
            </ul>
          </>
        ) : null}

        {nav && nav.categories.length > 0 ? (
          <>
            <h3 className="shell-sheet__head">{t("sheet.departments")}</h3>
            <ul className="shell-rows">
              {nav.categories.map((category) => (
                <li key={category.slug} className="shell-group">
                  <LocaleLink to={category.href} className="shell-row shell-row--plain" onClick={onClose}>
                    <span className="shell-row__text type-strong">
                      <span>{category.label}</span>
                    </span>
                    <span className="shell-row__count">{t("nav.count", { count: category.count })}</span>
                    <Icon name="caret-right" size={16} />
                  </LocaleLink>
                  {category.children.length > 0 ? (
                    <div className="shell-sublinks">
                      {category.children.map((child) => (
                        <LocaleLink key={child.slug} to={child.href} onClick={onClose}>
                          <span>{child.label}</span>
                        </LocaleLink>
                      ))}
                    </div>
                  ) : null}
                </li>
              ))}
            </ul>
          </>
        ) : null}

        <h3 className="shell-sheet__head">{t("sheet.services")}</h3>
        <ul className="shell-rows">
          <Row to="/track" icon="package" title={t("utility.track")} onPick={onClose} />
          <Row to="/trade-in" icon="swap" title={t("utility.tradeIn")} onPick={onClose} />
          <Row to="/support" icon="lifebuoy" title={t("utility.help")} onPick={onClose} />
        </ul>
      </nav>

      <h3 className="shell-sheet__head">{t("sheet.preferences")}</h3>
      <div className="flex flex-col gap-5 pb-4">
        <PreferenceGroup label={t("language.label")}>
          <LanguageBank onSwitch={onClose} />
        </PreferenceGroup>
        <PreferenceGroup label={t("currency.label")}>
          <CurrencyPanel />
        </PreferenceGroup>
        <PreferenceGroup label={t("theme.label")}>
          <ThemeBank />
        </PreferenceGroup>
      </div>
    </Sheet>
  );
}

function Row({ to, icon, title, hint, count, onPick }: { to: string; icon: IconName; title: string; hint?: string; count?: ReactNode; onPick: () => void }) {
  return (
    <li>
      <LocaleLink to={to} className="shell-row" onClick={onPick}>
        <Icon name={icon} size={22} />
        <span className="shell-row__text">
          <span className="type-strong">{title}</span>
          {hint ? <span className="shell-row__hint">{hint}</span> : null}
        </span>
        {count ? <span className="shell-row__count">{count}</span> : null}
        <Icon name="caret-right" size={16} />
      </LocaleLink>
    </li>
  );
}
