/**
 * Onboarding and the shopper's control over personalisation (brief §2 "Onboarding", §6 privacy; Design System v2
 * §6.1). Nothing personal is kept before the shopper says yes, saying no is one press away and exactly as prominent as
 * yes, and every answer can be changed later from the home page.
 *
 *   <ConsentRow>       after the intro, when platforms were picked and consent was never asked: a NON-BLOCKING row
 *                      under the hero — «نحفظ اختيارك على هذا الجهاز؟» with two equal keys «احفظ» / «لا، شكراً» (the
 *                      1.0 consent sheet is gone: the page stays usable while it waits)
 *   <PlatformsSheet>   «منصّاتك»: platform chips (several may be chosen) and the plain-language explanation; saving =
 *                      consent + the platforms; two equal keys
 *   <PersonalPanel>    at the bottom of the home page: what is remembered on this device, change it, stop and delete
 *                      it, watch the intro again
 */
import { useEffect, useId, useRef, useState } from "react";

import { Icon } from "~/art/Icon";
import { useT } from "~/i18n/react";
import { Bubble } from "~/motion";
import { Chip } from "~/ui/Chip";
import { Key } from "~/ui/Key";
import { PLATFORMS, type Platform } from "~/ui/PlatformLed";
import { revealProps } from "~/ui/reveal";
import { Sheet } from "~/ui/Sheet";
import { TextLink } from "~/ui/TextLink";
import { isolate } from "./view";

export function ConsentRow({ platforms, onAnswer }: { platforms: readonly Platform[]; onAnswer: (granted: boolean) => void }) {
  const t = useT("home");
  const names = useNames();
  const id = useId();
  const row = useRef<HTMLDivElement>(null);
  // the question arrives after the intro has left: it takes the focus (no ring for a pointer user), so a keyboard
  // or screen-reader user meets it at once instead of tabbing through the page to find it — and the browser brings
  // it into view when a long translation would leave its keys under the tab bar
  useEffect(() => {
    row.current?.focus();
  }, []);
  return (
    <Bubble always className="min-w-0">
      <div ref={row} role="region" aria-labelledby={id} tabIndex={-1} className="panel home-consent">
        <div className="home-consent__text">
          <h2 id={id} className="home-consent__question">
            {t("consent.question")}
          </h2>
          <p className="home-consent__detail">{t("consent.text", { platforms: names(platforms) })}</p>
        </div>
        <div className="home-consent__keys">
          <Key size="sm" onClick={() => onAnswer(true)}>
            {t("consent.yes")}
          </Key>
          <Key size="sm" onClick={() => onAnswer(false)}>
            {t("consent.no")}
          </Key>
        </div>
      </div>
    </Bubble>
  );
}

export function PlatformsSheet({ open, initial, onSave, onClose }: { open: boolean; initial: readonly Platform[]; onSave: (platforms: Platform[]) => void; onClose: () => void }) {
  const t = useT("home");
  const ui = useT("ui");
  const errorId = useId();
  const groupId = useId();
  const [chosen, setChosen] = useState<Platform[]>([...initial]);
  const [error, setError] = useState(false);
  useEffect(() => {
    if (open) {
      setChosen([...initial]);
      setError(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- reset only when it opens
  }, [open]);
  const toggle = (platform: Platform) => {
    setError(false);
    setChosen((list) => (list.includes(platform) ? list.filter((slug) => slug !== platform) : [...list, platform]));
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
          <Key onClick={save} aria-describedby={error ? errorId : undefined}>
            {t("personal.save")}
          </Key>
        </>
      }
    >
      <div className="grid gap-3">
        <div role="group" aria-labelledby={groupId} className="chips">
          <span id={groupId} className="sr-only">
            {t("intro.tiles")}
          </span>
          {PLATFORMS.map((platform) => (
            <Chip key={platform} platform={platform} selected={chosen.includes(platform)} onClick={() => toggle(platform)}>
              {ui(`platform.${platform}`)}
            </Chip>
          ))}
        </div>
        {error ? (
          <p id={errorId} role="alert" className="flex items-center gap-1.5 type-xs-strong text-danger">
            <Icon name="warning-circle" size={16} />
            {t("personal.noneChosen")}
          </p>
        ) : null}
        {/* what saving keeps is reading text (v2.1 G7: 16px, line height 1.7 — it was 14 / 1.5) */}
        <p className="type-body text-ink-2">{t("personal.sheetText")}</p>
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
    <section id="personal" aria-labelledby={id} className="panel home-personal" {...revealProps()}>
      <h2 id={id} className="type-h3 text-ink">
        {t("personal.title")}
      </h2>
      <p className="type-body text-ink-2" aria-live="polite">
        {status}
      </p>
      <div className="home-personal__actions">
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
