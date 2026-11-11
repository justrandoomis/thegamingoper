/**
 * Onboarding and the shopper's control over personalisation (brief §2 "Onboarding", §6 privacy; DESIGN.md §7.2
 * intro step 6). Nothing personal is kept before the shopper says yes, saying no is one press away and as prominent
 * as yes, and every answer can be changed later from the home page.
 *
 *   <ConsentSheet>     right after the intro, when platforms were picked and consent was never asked:
 *                      "نتذكّر منصّاتك؟" — two equal keys: yes / no thanks
 *   <PlatformsSheet>   "اختر منصّاتك": the platform keys (several may be chosen — they press and rebound) and the
 *                      plain-language explanation; saving = consent + the platforms
 *   <PersonalPanel>    at the bottom of the home page: what is remembered on this device, change it, stop and delete
 *                      it, watch the intro again
 */
import { useEffect, useId, useState } from "react";

import { Icon } from "~/art/Icon";
import { useT } from "~/i18n/react";
import { Key } from "~/ui/Key";
import { PlatformBank } from "~/ui/PlatformBank";
import type { Platform } from "~/ui/PlatformLed";
import { Sheet } from "~/ui/Sheet";
import { TextLink } from "~/ui/TextLink";
import { isolate } from "./view";

export function ConsentSheet({ open, platforms, onAnswer, onDismiss }: { open: boolean; platforms: readonly Platform[]; onAnswer: (granted: boolean) => void; onDismiss: () => void }) {
  const t = useT("home");
  const names = useNames();
  return (
    <Sheet
      open={open}
      onClose={onDismiss}
      title={t("consent.title")}
      presentation="picker"
      footer={
        <>
          <Key onClick={() => onAnswer(false)}>{t("consent.no")}</Key>
          <Key onClick={() => onAnswer(true)}>{t("consent.yes")}</Key>
        </>
      }
    >
      <p className="type-body text-ink">{t("consent.text", { platforms: names(platforms) })}</p>
    </Sheet>
  );
}

export function PlatformsSheet({ open, initial, onSave, onClose }: { open: boolean; initial: readonly Platform[]; onSave: (platforms: Platform[]) => void; onClose: () => void }) {
  const t = useT("home");
  const errorId = useId();
  const [chosen, setChosen] = useState<Platform[]>([...initial]);
  const [error, setError] = useState(false);
  useEffect(() => {
    if (open) {
      setChosen([...initial]);
      setError(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- reset only when it opens
  }, [open]);
  const toggle = (platform: Platform, on: boolean) => {
    setError(false);
    setChosen((list) => (on ? [...list.filter((slug) => slug !== platform), platform] : list.filter((slug) => slug !== platform)));
  };
  const save = () => {
    if (chosen.length === 0) {
      setError(true);
      return;
    }
    onSave(chosen);
  };
  return (
    <Sheet
      open={open}
      onClose={onClose}
      title={t("personal.sheetTitle")}
      presentation="picker"
      footer={
        <>
          <Key onClick={onClose}>{t("personal.cancel")}</Key>
          <Key variant="ink" onClick={save} aria-describedby={error ? errorId : undefined}>
            {t("personal.save")}
          </Key>
        </>
      }
    >
      <div className="grid gap-3">
        <PlatformBank multiple values={chosen} onToggle={toggle} className="home-bubbles" />
        {error ? (
          <p id={errorId} role="alert" className="flex items-center gap-1.5 type-caption font-medium text-red-ink">
            <Icon name="warning-circle" size={16} />
            {t("personal.noneChosen")}
          </p>
        ) : null}
        <p className="type-caption text-ink-2">{t("personal.sheetText")}</p>
      </div>
    </Sheet>
  );
}

export function PersonalPanel({
  consent,
  platforms,
  signedIn = false,
  onChoose,
  onStop,
  onReplay,
}: {
  consent: boolean | null;
  platforms: readonly Platform[];
  /** Signed in: what was viewed is kept in the account, not on this device (./personal.ts, one store). */
  signedIn?: boolean;
  onChoose: () => void;
  onStop: () => void;
  onReplay: () => void;
}) {
  const t = useT("home");
  const names = useNames();
  const id = useId();
  const on = signedIn ? { list: "personal.onAccount", none: "personal.onNoPlatformsAccount" } : { list: "personal.on", none: "personal.onNoPlatforms" };
  const status = consent === true ? (platforms.length > 0 ? t(on.list, { platforms: names(platforms) }) : t(on.none)) : consent === false ? t("personal.off") : t("personal.unset");
  return (
    <section id="personal" aria-labelledby={id} className="panel home-personal">
      <h2 id={id} className="type-sub text-ink">
        {t("personal.title")}
      </h2>
      <p className="type-body text-ink-2" aria-live="polite">
        {status}
      </p>
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
        <Key size="sm" onClick={onChoose} aria-haspopup="dialog">
          {consent === true && platforms.length > 0 ? t("personal.change") : t("personal.choose")}
        </Key>
        {consent === true ? (
          <TextLink as="button" type="button" arrow={false} tone="danger" onClick={onStop}>
            {t("personal.stop")}
          </TextLink>
        ) : null}
        <TextLink as="button" type="button" arrow={false} onClick={onReplay}>
          {t("intro.replay")}
        </TextLink>
      </div>
    </section>
  );
}

/** Platform names for sentences: the design system's names ("PlayStation، Xbox"), joined in the page's language. */
export function useNames(): (list: readonly Platform[]) => string {
  const ui = useT("ui");
  const t = useT("home");
  return (list) => list.map((slug) => isolate(ui(`platform.${slug}`))).join(t("listSeparator"));
}
