import type { ReactNode } from "react";

import { Icon } from "~/art/Icon";
import { useT } from "~/i18n/react";
import { MotionLink } from "~/motion";
import { cx } from "~/ui/cx";
import { revealProps } from "~/ui/reveal";
import { SectionHead } from "~/ui/SectionHead";

/**
 * The head of an account page (Design System v2 §6.12): a back link, the page's h1 (type-h1) and one line that says what
 * the page is for. The shell owns <main>; this is the first thing in it.
 *
 * Back: by default «حسابي» → the overview, shown below 1024 only (from 1024 the grouped section list stands beside the
 * page). A child page (an order, the top-up step, the address form) passes its own `back`, shown at every width.
 */
export function PageHead({
  title,
  lead,
  back,
  aside,
  children,
  className,
  titleId,
}: {
  title: ReactNode;
  lead?: ReactNode;
  /** An id for the h1, which then takes focus from script (tabIndex -1) — where focus lands after a row went away. */
  titleId?: string;
  /**
   * Where "back" goes. `false` hides it (the overview itself). `nav: "rise"` for a child page that rose over its list
   * (the link plays the drop-away); `order` keeps the sideways push between sections in the right direction.
   */
  back?: { to: string; label: string; order?: number; nav?: "push" | "rise" } | false;
  /** At the inline end of the title row (a key). */
  aside?: ReactNode;
  /** Under the lead (a code row, a tag). */
  children?: ReactNode;
  className?: string;
}) {
  const t = useT("account");
  const section = back === undefined;
  const target = back === false ? null : (back ?? { to: "/account", label: t("nav.back"), order: 0 });
  return (
    <header className={cx("acct-head", className)}>
      {target ? (
        // The design system's link (.link) with the back arrow before the words: drawn left-to-right it mirrors in
        // Arabic and Kurdish by the icon rule (.i--dir), like every directional glyph.
        <MotionLink
          nav={target.nav ?? "push"}
          back={target.nav === "rise" ? true : undefined}
          order={target.order ?? 0}
          to={target.to}
          className="acct-head__back link justify-self-start"
          data-section={section ? "" : undefined}
        >
          <Icon name="arrow-left" size={16} />
          <span className="link__text">{target.label}</span>
        </MotionLink>
      ) : null}
      <div className="acct-head__row">
        <h1 id={titleId} tabIndex={titleId ? -1 : undefined} className="type-h1 text-ink">
          {title}
        </h1>
        {aside}
      </div>
      {lead ? <p className="acct-head__lead">{lead}</p> : null}
      {children}
    </header>
  );
}

/**
 * A section of an account page: the kit's section head (h2, an honest reason line, a link at the end) and its content.
 * `action` sits at the end of the head (a small key) when there is no «عرض الكل» link. `anchor`: the section carries
 * `id` itself (a quick tile links to it). `reveal`: it fades up as it first comes into view (v2.1 G6; below the fold
 * only — never a form).
 */
export function Section({
  id,
  title,
  reason,
  href,
  linkLabel,
  action,
  anchor = false,
  reveal = false,
  children,
  className,
}: {
  id: string;
  title: ReactNode;
  reason?: ReactNode;
  href?: string;
  linkLabel?: ReactNode;
  action?: ReactNode;
  anchor?: boolean;
  reveal?: boolean;
  children: ReactNode;
  className?: string;
}) {
  return (
    <section id={anchor ? id : undefined} aria-labelledby={`${id}-title`} className={cx("grid min-w-0", className)} {...(reveal ? revealProps() : {})}>
      {action ? (
        <div className="sechead">
          <div className="sechead__text">
            <h2 id={`${id}-title`} className="sechead__title">
              {title}
            </h2>
            {reason ? <p className="sechead__reason">{reason}</p> : null}
          </div>
          {action}
        </div>
      ) : (
        <SectionHead id={`${id}-title`} title={title} reason={reason} href={href} viewAllLabel={linkLabel} />
      )}
      {children}
    </section>
  );
}
