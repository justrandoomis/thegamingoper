import { useId, type CSSProperties, type ReactNode } from "react";

import { useT } from "~/i18n/react";
import { BidiLabel } from "./BidiText";
import { cx } from "./cx";
import { KeyBank } from "./KeyBank";
import { PLATFORMS, PlatformLed, type Platform } from "./PlatformLed";

/**
 * 1.0's bank of four platform keys — RETIRED (Design System v2 §4.1, §4.2; stage 4 deletes it). The platform doors are
 * ./PlatformTile now. Until the home area migrates, this keeps its API and renders the v2 look: segments with an 8px dot
 * and the name (radio semantics), or toggles (`multiple`, aria-pressed) for onboarding.
 *
 *   <PlatformBank value={platform} onChange={setPlatform} onIntent={prefetchHero} />
 *   <PlatformBank multiple values={chosen} onToggle={toggle} />
 */
type Common = {
  /** Visible label above the control. Default: "اختر منصّتك." (`multiple`, the intro: "دورك. اختر منصّاتك."). */
  label?: ReactNode;
  /** Platforms to offer, in order. Default all four. */
  platforms?: readonly Platform[];
  /** Names override (default ui:platform.*). */
  names?: Partial<Record<Platform, string>>;
  className?: string;
  style?: CSSProperties;
};

export type PlatformBankProps =
  | (Common & {
      multiple?: false;
      value: Platform | null;
      onChange: (platform: Platform) => void;
      /** Pointer-down on a key that is not chosen: start fetching what it will show. */
      onIntent?: (platform: Platform) => void;
      /** Submit the choice with a <Form>. */
      name?: string;
    })
  | (Common & {
      multiple: true;
      values: readonly Platform[];
      onToggle: (platform: Platform, on: boolean) => void;
    });

export function PlatformBank(props: PlatformBankProps) {
  const t = useT("ui-shop");
  const ui = useT("ui");
  const labelId = useId();
  const platforms = props.platforms ?? PLATFORMS;
  const nameOf = (p: Platform) => props.names?.[p] ?? ui(`platform.${p}`);
  // «دورك.» survives only in the intro line (v2 §9.1); the intro is the one caller of `multiple` with no label of its own
  const label =
    props.label ??
    (props.multiple ? (
      <>
        <b>{t("bank.turn")}</b> {t("bank.pickMany")}
      </>
    ) : (
      t("bank.pick")
    ));

  if (!props.multiple) {
    return (
      <KeyBank
        label={label}
        items={platforms.map((p) => ({ value: p, gel: p, label: nameOf(p) }))}
        value={props.value}
        onChange={(value) => props.onChange(value as Platform)}
        onIntent={props.onIntent ? (value) => props.onIntent?.(value as Platform) : undefined}
        name={props.name}
        className={props.className}
        style={props.style}
      />
    );
  }

  return (
    <div className="grid gap-0">
      <p className="bank__label" id={labelId}>
        {label}
      </p>
      <div role="group" aria-labelledby={labelId} className={cx("bank", props.className)} style={props.style}>
        {platforms.map((p) => {
          const on = props.values.includes(p);
          return (
            <button key={p} type="button" className="key key--plat" data-gel={p} data-press="soft" aria-pressed={on} onClick={() => props.onToggle(p, !on)}>
              <span className="key__cap">
                <BidiLabel className="key__label">{nameOf(p)}</BidiLabel>
                <PlatformLed />
              </span>
            </button>
          );
        })}
      </div>
    </div>
  );
}
