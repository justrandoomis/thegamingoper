import { useId, type ReactNode } from "react";

import { Logo } from "~/art/Logo";
import { LocaleLink, useT } from "~/i18n/react";
import { cx } from "~/ui/cx";
import { Key } from "~/ui/Key";
import { HANDOFF_PATH } from "../content-model";

/**
 * «اكتب لموظف» — the hand-off door (Design System v2 §4.25, §6.13, §6.15): what a content page shows where the store's
 * contact card would be while the owner has published no channel, and the way to report a problem. A paper card with
 * the mascot (the supplied logo artwork) on a red-tint disc, a title, one sentence of what happens, and ONE key to the
 * support area's hand-off form (`HANDOFF_PATH`, «تحدّث مع موظف»). `primary`: that key is the view's one red key
 * (/contact, /accessibility); otherwise it is a secondary key. `stack` keeps the key on its own row under the art and
 * the words at every width (a narrow aside); below 768 every card does, so a long label never leaves the card.
 */
export function HandoffCard({
  title,
  text,
  action,
  headingLevel = 2,
  primary = false,
  stack = false,
  id,
  className,
}: {
  title?: ReactNode;
  text?: ReactNode;
  action?: ReactNode;
  headingLevel?: 2 | 3;
  primary?: boolean;
  stack?: boolean;
  id?: string;
  className?: string;
}) {
  const t = useT("content");
  const autoId = useId();
  const headingId = id ?? autoId;
  const Heading = `h${headingLevel}` as const;
  return (
    <section aria-labelledby={headingId} className={cx("chandoff", stack && "chandoff--stack", className)}>
      <span className="chandoff__art text-logo" aria-hidden="true">
        <Logo variant="mark" height="62%" />
      </span>
      <div className="chandoff__copy">
        <Heading id={headingId} className="chandoff__title">
          {title ?? t("handoff.title")}
        </Heading>
        <p className="chandoff__text">{text ?? t("handoff.text")}</p>
      </div>
      <Key as={LocaleLink} to={HANDOFF_PATH} variant={primary ? "primary" : "secondary"} icon="chat-circle" className="chandoff__action">
        {action ?? t("handoff.action")}
      </Key>
    </section>
  );
}
