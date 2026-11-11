import type { ReactNode } from "react";

import { Icon } from "~/art/Icon";
import { useT } from "~/i18n/react";
import { MotionLink } from "~/motion";
import { cx } from "~/ui/cx";

/**
 * The head of an account page: on phones a back link to the account (or to `back`), then the page's h1 and one line
 * that says what the page is for. The shell owns <main>; this is the first thing in it.
 */
export function PageHead({
  title,
  lead,
  back,
  aside,
  className,
}: {
  title: ReactNode;
  lead?: ReactNode;
  /**
   * Where "back" goes (default: the account overview, phones only). `false` hides it (the overview itself).
   * `nav: "rise"` for a child page that rose over its list (the link plays the drop-away).
   */
  back?: { to: string; label: string; order?: number; nav?: "push" | "rise" } | false;
  /** Something at the inline end of the title row (a key). */
  aside?: ReactNode;
  className?: string;
}) {
  const t = useT("account");
  const target = back === false ? null : (back ?? { to: "/account", label: t("nav.back"), order: 0 });
  return (
    <header className={cx("grid gap-2", className)}>
      {target ? (
        // The design system's link look (.link) with the back caret BEFORE the words: drawn as in a left-to-right layout,
        // it mirrors in Arabic and Kurdish by the icon rules.
        <MotionLink
          nav={target.nav ?? "push"}
          back={target.nav === "rise" ? true : undefined}
          order={target.order ?? 0}
          to={target.to}
          className={cx("link -ms-1 justify-self-start", target.to === "/account" && "lg:hidden")}
        >
          <Icon name="caret-left" size={18} />
          <span className="link__text">{target.label}</span>
        </MotionLink>
      ) : null}
      <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
        <h1 className="type-title text-ink">{title}</h1>
        {aside}
      </div>
      {lead ? <p className="max-w-[62ch] type-body text-ink-2">{lead}</p> : null}
    </header>
  );
}

/** A section of an account page: an h2 and its content, flat on the floor. */
export function Section({ id, title, aside, children, className }: { id?: string; title: ReactNode; aside?: ReactNode; children: ReactNode; className?: string }) {
  return (
    <section id={id} aria-labelledby={id ? `${id}-title` : undefined} className={cx("grid gap-3", className)}>
      <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1">
        <h2 id={id ? `${id}-title` : undefined} className="type-section text-ink">
          {title}
        </h2>
        {aside}
      </div>
      {children}
    </section>
  );
}
