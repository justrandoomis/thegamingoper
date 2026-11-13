import { useId, type ReactNode } from "react";

import { Logo } from "~/art/Logo";
import { LocaleLink } from "~/i18n/react";
import { localePath, type Locale } from "~/lib/locales";
import { cx } from "~/ui/cx";
import { Key } from "~/ui/Key";
import type { Platform } from "~/ui/PlatformLed";
import { PlatformTile } from "~/ui/PlatformTile";
import { revealProps } from "~/ui/reveal";
import { TextLink } from "~/ui/TextLink";
import "./not-found.css";

/**
 * The 404 — Design v2.1, client note 11: the store's page before the redesign won (its big «404», its search field, its
 * clay key home), with v2's mascot and its four platform tiles ("the logo and the four stations"). One arrangement:
 *
 *   the mascot in a frosted circle over a soft brand light · a big «404» in Kufam (decorative: the h1 says what
 *   happened) · the h1 · one line · the search field · the clay «العودة إلى الرئيسية» with «مركز الدعم» beside it ·
 *   «أو ابدأ من منصّتك» · the four platform tiles (2 × 2 on phones, four in a row from 768)
 *
 * Two callers render it, so a page that is not there looks the same wherever the failure lands:
 *   - the storefront layout's boundary (../../shell/ShellError): inside the shell, in the shell's words, the shell's
 *     search form with its suggestions, the navigation's platforms with their counts and hardware photos, router links;
 *     a missing product (`/p/<slug>` that led nowhere) is the same view with its own title and line, the field starting
 *     with the slug's words, and the used devices under the tiles;
 *   - the root boundary (app/root.tsx), when something above the shells failed: no shell, so its own copied words, a
 *     plain GET search, the four platforms without counts (their device glyphs) and plain document links
 *     (`documentLocale`), as the rest of that boundary does.
 *
 * No red key: nothing here moves an order forward — the field is the way on. Motion (v2.1 G6): the circle inflates
 * and the «404» rises once on arrival (transform and opacity on the motion tokens; nothing waits for it, nothing
 * shifts); the tiles fade up as they come into view when they start below the fold (`data-reveal`). Reduced motion,
 * the lite tier and the store's reduce-motion switch: everything is simply there.
 */
export type NotFoundWords = {
  title: string;
  text: string;
  home: string;
  help: string;
  /** «أو ابدأ من منصّتك» — the tiles' heading. */
  browse: string;
};

export type NotFoundPlatform = {
  platform: Platform;
  /** A locale-less path ("/platform/xbox"). */
  to: string;
  name: string;
  /** Products it has — omitted when unknown (never invented). */
  count?: number | null;
  /** A product photo key for the hardware, or a picture node. */
  art?: string | ReactNode;
};

export type NotFoundViewProps = {
  words: NotFoundWords;
  /** The search field: the shell's search form inside the shell, a plain GET form at the root. */
  search: ReactNode;
  platforms: readonly NotFoundPlatform[];
  /** Under the tiles (a missing product: the used devices). */
  after?: ReactNode;
  /**
   * Plain document links in this language instead of the router's (the root boundary: whatever failed above the
   * shells may fail again on a client navigation; a document load starts over).
   */
  documentLocale?: Locale;
  className?: string;
};

export function NotFoundView({ words, search, platforms, after, documentLocale, className }: NotFoundViewProps) {
  const titleId = useId();
  const browseId = useId();
  const href = (path: string) => localePath(path, documentLocale ?? "ar");

  return (
    <section className={cx("page cnf", className)} aria-labelledby={titleId}>
      <div className="cnf__head">
        {/* the frosted circle shows the brand light behind it: glass with something to frost */}
        <span className="cnf__art" aria-hidden="true">
          <span className="glow-layer cnf__light" />
          <span className="cnf__disc surface--glass">
            <Logo variant="mark" className="cnf__mark text-logo" />
          </span>
        </span>
        <p className="cnf__code" dir="ltr" aria-hidden="true">
          404
        </p>
        <h1 id={titleId} className="cnf__title">
          {words.title}
        </h1>
        <p className="cnf__text">{words.text}</p>
        <div className="cnf__search">{search}</div>
        <div className="cnf__actions">
          {documentLocale ? (
            <Key as="a" href={href("/")} icon="house">
              {words.home}
            </Key>
          ) : (
            <Key as={LocaleLink} to="/" icon="house">
              {words.home}
            </Key>
          )}
          {documentLocale ? (
            <TextLink as="a" href={href("/support")}>
              {words.help}
            </TextLink>
          ) : (
            <TextLink as={LocaleLink} to="/support">
              {words.help}
            </TextLink>
          )}
        </div>
      </div>

      {platforms.length > 0 ? (
        <nav className="cnf__browse" aria-labelledby={browseId}>
          <h2 id={browseId} className="cnf__label">
            {words.browse}
          </h2>
          <ul className="cnf__tiles" {...revealProps({ stagger: true })}>
            {platforms.map((item) => (
              <li key={item.platform} className="grid">
                {documentLocale ? (
                  <PlatformTile compact as="a" href={href(item.to)} platform={item.platform} name={item.name} count={item.count} art={item.art} />
                ) : (
                  <PlatformTile compact platform={item.platform} to={item.to} name={item.name} count={item.count} art={item.art} />
                )}
              </li>
            ))}
          </ul>
          {after ? <div className="cnf__after">{after}</div> : null}
        </nav>
      ) : after ? (
        <div className="cnf__after">{after}</div>
      ) : null}
    </section>
  );
}
