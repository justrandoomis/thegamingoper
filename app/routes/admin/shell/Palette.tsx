/**
 * The command palette (DESIGN.md §10): Ctrl/⌘ K anywhere in the admin, or the search field / search tab. A modal
 * layer with a glass strip holding one paper search field, and an opaque paper body of 36px result rows grouped as
 * sections, actions and blueprint functions — only what the employee may use (their visible modules come from the
 * server). The highlighted row has a niche fill and an ink start-edge bar; it opens with opacity and 8px of travel and
 * nothing else moves.
 *
 * WAI-ARIA combobox with a listbox: focus stays in the field, ↑ ↓ Home End move the active option
 * (aria-activedescendant), Enter opens it, Escape / the scrim / Android back close the layer (shared modal layer:
 * focus trapped and returned, page inert). Records (orders, customers, SKUs, serials, tickets) are not searchable yet —
 * that is module 01's global search (blueprint 01.06).
 */
import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from "react";
import { createPortal } from "react-dom";

import { Icon, type IconName } from "~/art/Icon";
import { useLocale } from "~/i18n/react";
import { resolveTheme, usePrefs } from "~/lib/prefs";
import { dematerialize, materialize } from "~/motion";
import { fadeElement, OverlayHostContext, useModalLayer, useOverlayRoot, usePresence, usePrimeLayers } from "~/ui/Dialog";
import { Glass } from "~/ui/Glass";
import { IconKey } from "~/ui/IconKey";
import { Status } from "~/ui/Tag";
import { VisuallyHidden } from "~/ui/VisuallyHidden";
import { useShellActions } from "./actions";
import { BLUEPRINT_MODULES } from "./blueprint-catalog";
import { functionAnchor, STATUS_TONE } from "./FunctionList";
import { useAdminT } from "./i18n";
import { ADMIN_MODULES, compareModules, type AdminModule } from "./modules";
import { filterGrouped, normalizeSearch } from "./search";
import type { AdminShellData } from "./shell.server";

type Group = "modules" | "actions" | "functions";
type FnStatus = "implemented" | "partial" | "boundary" | "planned";

export type PaletteItem = {
  id: string;
  group: Group;
  label: string;
  sub?: string;
  icon: IconName;
  /** Normalized text the query is matched against. */
  haystack: string;
  status?: FnStatus;
  run: () => void;
};

export type PaletteProps = {
  open: boolean;
  onClose: () => void;
  data: AdminShellData;
  /** Status of every blueprint function (from ../blueprint-status; passed in so this file does not import it). */
  statuses: Readonly<Record<string, { status: FnStatus; route?: string }>>;
  rail: "expanded" | "collapsed";
  onToggleRail: () => void;
};

const GROUPS = ["modules", "actions", "functions"] as const satisfies readonly Group[];
const LIMIT: Record<Group, number> = { modules: 23, actions: 10, functions: 30 };

export function Palette(props: PaletteProps) {
  usePrimeLayers();
  const [present, exited] = usePresence(props.open);
  if (!present) return null;
  return <PaletteLayer {...props} leaving={!props.open} onExited={exited} />;
}

function usePaletteItems({ data, statuses, rail, onToggleRail, onClose }: Omit<PaletteProps, "open">): PaletteItem[] {
  const t = useAdminT();
  const locale = useLocale();
  const { theme } = usePrefs();
  const actions = useShellActions();
  const lang = locale === "en" ? "en" : "ar";

  return useMemo(() => {
    const items: PaletteItem[] = [];
    const visible = new Set<string>(data.modules);
    const modules: AdminModule[] = ADMIN_MODULES.filter((module) => module.slug === "dashboard" || visible.has(module.slug)).sort((a, b) =>
      a.slug === "dashboard" ? -1 : b.slug === "dashboard" ? 1 : compareModules(a, b),
    );

    for (const module of modules) {
      const blueprint = BLUEPRINT_MODULES.find((entry) => entry.id === module.id);
      const label = t(`modules.${module.slug}`);
      items.push({
        id: `module-${module.slug}`,
        group: "modules",
        label,
        sub: blueprint ? `${module.id} · ${blueprint[lang]}` : module.id,
        icon: module.icon,
        haystack: normalizeSearch(`${label} ${blueprint?.ar ?? ""} ${blueprint?.en ?? ""} ${module.slug} ${module.id}`),
        run: () => actions.go(module.href),
      });
    }

    const action = (id: string, label: string, icon: IconName, run: () => void, extra = "") =>
      items.push({ id: `action-${id}`, group: "actions", label, icon, haystack: normalizeSearch(`${label} ${extra}`), run });
    action("me", t("actions.me"), "shield-check", () => actions.go("/admin/me"), "security password sessions mfa أمان كلمة المرور جلسات");
    action("blueprint", t("actions.blueprint"), "kanban", () => actions.go("/admin/blueprint"), "blueprint status مخطط حالة");
    if (!data.employee.totpEnabled) action("mfa", t("actions.mfa"), "lock", () => actions.go("/admin/me#two-step"), "2fa totp mfa two-step تحقق");
    if (data.locale === "ar") action("english", t("actions.toEnglish"), "translate", () => actions.setLocale("en"), "english language لغة انجليزي");
    else action("arabic", t("actions.toArabic"), "translate", () => actions.setLocale("ar"), "arabic language لغة عربي");
    const dark = resolveTheme(theme) === "dark";
    action("theme", dark ? t("actions.themeLight") : t("actions.themeDark"), dark ? "sun" : "moon", () => actions.setTheme(dark ? "light" : "dark"), "theme dark light مظهر داكن فاتح");
    // the rail exists from 1200px only (the palette renders in the browser, so matchMedia is there)
    if (typeof matchMedia === "function" && matchMedia("(min-width: 75rem)").matches) {
      action("rail", rail === "collapsed" ? t("actions.railExpand") : t("actions.railCollapse"), "sliders-horizontal", onToggleRail, "sidebar rail menu قائمة");
    }
    action("sign-out", t("actions.signOut"), "sign-out", () => actions.signOut("one"), "logout sign out خروج");
    action("sign-out-all", t("actions.signOutAll"), "sign-out", () => actions.signOut("all"), "logout everywhere all devices خروج كل الأجهزة");

    for (const module of modules) {
      const blueprint = BLUEPRINT_MODULES.find((entry) => entry.id === module.id);
      if (!blueprint) continue;
      const moduleLabel = t(`modules.${module.slug}`);
      for (const fn of blueprint.functions) {
        const entry = statuses[fn.id] ?? { status: "planned" as const };
        const target = entry.route ?? `${module.href}#${functionAnchor(fn.id)}`;
        items.push({
          id: `fn-${fn.id}`,
          group: "functions",
          label: fn[lang],
          sub: `${fn.id} · ${moduleLabel}`,
          icon: module.icon,
          status: entry.status,
          haystack: normalizeSearch(`${fn.ar} ${fn.en} ${fn.id} ${moduleLabel}`),
          run: () => actions.go(target),
        });
      }
    }
    // Every row closes the palette first, then acts: focus returns to the opener before the page changes.
    return items.map((item) => ({ ...item, run: () => (onClose(), item.run()) }));
  }, [data, statuses, rail, onToggleRail, onClose, t, lang, theme, actions]);
}

function PaletteLayer({ onClose, leaving, onExited, ...rest }: Omit<PaletteProps, "open"> & { leaving: boolean; onExited: () => void }) {
  const t = useAdminT();
  const root = useOverlayRoot();
  const [host, setHost] = useState<HTMLDivElement | null>(null);
  const panel = useRef<HTMLDivElement | null>(null);
  const scrim = useRef<HTMLDivElement | null>(null);
  const input = useRef<HTMLInputElement | null>(null);
  const exitedRef = useRef(onExited);
  useLayoutEffect(() => {
    exitedRef.current = onExited;
  });
  const listId = useId();
  const titleId = useId();
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);

  const items = usePaletteItems({ ...rest, onClose });
  const results = useMemo(() => filterGrouped(items, query, GROUPS, LIMIT, ["functions"]), [items, query]);
  const current = results[Math.min(active, results.length - 1)] ?? null;
  const optionId = (item: PaletteItem) => `${listId}-${item.id}`;

  useModalLayer({ root, host, active: !leaving, onEscape: onClose, initialFocus: () => input.current });

  useLayoutEffect(() => {
    const element = panel.current;
    const backdrop = scrim.current;
    if (!host || !element || !backdrop) return;
    if (!leaving) {
      void materialize(element, { from: { x: window.innerWidth / 2, y: 0 } });
      void fadeElement(backdrop, 1);
      return;
    }
    let cancelled = false;
    void Promise.all([dematerialize(element), fadeElement(backdrop, 0)]).then(() => {
      if (!cancelled) exitedRef.current();
    });
    return () => {
      cancelled = true;
    };
  }, [host, leaving]);

  useEffect(() => setActive(0), [query]);
  useEffect(() => {
    if (current) document.getElementById(optionId(current))?.scrollIntoView({ block: "nearest" });
  }, [current]);

  const onKeyDown = (event: ReactKeyboardEvent<HTMLInputElement>) => {
    if (event.nativeEvent.isComposing) return;
    const last = results.length - 1;
    if (event.key === "ArrowDown") {
      event.preventDefault();
      setActive((index) => (index >= last ? 0 : index + 1));
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      setActive((index) => (index <= 0 ? last : index - 1));
    } else if (event.key === "Home" && (event.ctrlKey || event.metaKey)) {
      event.preventDefault();
      setActive(0);
    } else if (event.key === "End" && (event.ctrlKey || event.metaKey)) {
      event.preventDefault();
      setActive(last);
    } else if (event.key === "Enter") {
      event.preventDefault();
      current?.run();
    }
  };

  if (!root) return null;
  const groups = GROUPS.map((group) => ({ group, rows: results.filter((item) => item.group === group) })).filter((entry) => entry.rows.length > 0);

  return createPortal(
    <OverlayHostContext value={host}>
      <div ref={setHost} className="adm-palette" inert={leaving || undefined}>
        <div ref={scrim} className="adm-palette__scrim" aria-hidden="true" onClick={onClose} />
        <div ref={panel} role="dialog" aria-modal="true" aria-labelledby={titleId} className="adm-palette__panel" data-layer-panel="" tabIndex={-1}>
          <VisuallyHidden as="h2" id={titleId}>
            {t("palette.title")}
          </VisuallyHidden>
          <Glass variant="static" className="adm-palette__strip">
            <label className="adm-palette__field">
              <Icon name="magnifying-glass" size={18} />
              <VisuallyHidden>{t("palette.label")}</VisuallyHidden>
              <input
                ref={input}
                className="adm-palette__input"
                type="search"
                role="combobox"
                aria-expanded="true"
                aria-controls={listId}
                aria-autocomplete="list"
                aria-activedescendant={current ? optionId(current) : undefined}
                autoComplete="off"
                autoCorrect="off"
                spellCheck={false}
                enterKeyHint="go"
                placeholder={t("palette.placeholder")}
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                onKeyDown={onKeyDown}
              />
            </label>
            <IconKey icon="x" label={t("palette.close")} size="sm" variant="quiet" onClick={onClose} />
          </Glass>
          <div id={listId} role="listbox" aria-label={t("palette.label")} className="adm-palette__list">
            {groups.map(({ group, rows }) => (
              <div key={group} role="group" aria-labelledby={`${listId}-${group}`}>
                <div id={`${listId}-${group}`} role="presentation" className="adm-palette__group-head">
                  {t(`palette.groups.${group}`)}
                </div>
                {rows.map((item) => (
                  <div
                    key={item.id}
                    id={optionId(item)}
                    role="option"
                    aria-selected={item === current}
                    className="adm-palette__row"
                    onPointerMove={() => item !== current && setActive(results.indexOf(item))}
                    onClick={() => item.run()}
                  >
                    <Icon name={item.icon} size={18} />
                    <span className="adm-palette__text">
                      <bdi className="line-clamp-2">{item.label}</bdi>
                      {item.sub ? <bdi className="adm-palette__sub">{item.sub}</bdi> : null}
                    </span>
                    {item.status ? <Status tone={STATUS_TONE[item.status]}>{t(`status.${item.status}`)}</Status> : null}
                  </div>
                ))}
              </div>
            ))}
            {results.length === 0 ? <p className="px-2 py-6 text-center type-body text-ink-2">{t("palette.empty", { query: query.trim() })}</p> : null}
          </div>
          <p className="sr-only" aria-live="polite">
            {query.trim() ? t("palette.results", { count: results.length }) : ""}
          </p>
          <div className="adm-palette__foot" aria-hidden="true">
            <span>{t("palette.hintMove")}</span>
            <span>{t("palette.hintOpen")}</span>
            <span>{t("palette.hintClose")}</span>
          </div>
        </div>
      </div>
    </OverlayHostContext>,
    root,
  );
}
