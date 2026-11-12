import { useRef } from "react";

import { Key } from "~/ui/Key";
import { Money, usePrintInLight, usePromotionsT } from "./ui";

/** The code of a card just issued (or approved): shown once, printable, never again without a reveal. */
export function OnceCode({ code, amountIqd }: { code: string; amountIqd: number | null }) {
  const t = usePromotionsT();
  const ref = useRef<HTMLDivElement | null>(null);
  usePrintInLight(ref);
  return (
    <div className="prm-panel prm-print" ref={ref} aria-live="polite">
      <p className="adm-h3 prm-noprint">{t("gift.once.title")}</p>
      <p className="type-body prm-noprint">{t("gift.once.what")}</p>
      <div className="prm-giftcard">
        <p className="type-caption text-ink-2">{t("gift.card.store")}</p>
        {amountIqd !== null ? (
          <p className="type-kpi">
            <Money iqd={amountIqd} />
          </p>
        ) : null}
        <span className="prm-secret">
          <bdi dir="ltr">{code}</bdi>
        </span>
        <p className="type-caption text-ink-2">{t("gift.card.howTo")}</p>
      </div>
      <div className="prm-actions prm-noprint">
        <Key size="sm" icon="printer" onClick={() => window.print()}>
          {t("gift.print")}
        </Key>
        <Key size="sm" icon="copy" variant="ghost" onClick={() => void navigator.clipboard?.writeText(code)}>
          {t("gift.copy")}
        </Key>
      </div>
    </div>
  );
}
