import { useId, type CSSProperties, type ReactNode } from "react";

import { useT } from "~/i18n/react";
import { BidiLabel } from "./BidiText";
import { cx } from "./cx";
import { KeyBank } from "./KeyBank";
import { PLATFORMS, PlatformGlyph, PlatformLed, type Platform } from "./PlatformLed";

/**
 * The bank of four platform keys under the home stage (docs/DESIGN.md §2, §8.1, reference a.png): white clay keys
 * in a well, each with a neutral device pictogram, a 16×5 LED in the platform's light and the platform's name as
 * text. No logos, no platform-coloured surfaces. Press one: it goes down and stays down, its LED lights, the
 * previous one springs up. Controlled.
 *
 *   <PlatformBank value={platform} onChange={setPlatform} onIntent={prefetchHero} />     "دورك. اختر منصّتك."
 *   <PlatformBank multiple values={chosen} onToggle={toggle} />                         onboarding (aria-pressed)
 *
 * Single choice is a radiogroup with roving focus; arrows follow the reading direction (KeyBank). Multiple choice
 * is a row of toggles (each its own tab stop, aria-pressed).
 */
type Common = {
  /** Visible label above the well. Default: "دورك. اختر منصّتك." (onboarding: "اختر منصّاتك."). */
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
  const label =
    props.label ??
    (
      <>
        <b>{t("bank.turn")}</b> {t(props.multiple ? "bank.pickMany" : "bank.pick")}
      </>
    );

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
      <div role="group" aria-labelledby={labelId} className={cx("bank well", props.className)} style={{ "--bank-n": platforms.length, ...props.style } as CSSProperties}>
        {platforms.map((p) => {
          const on = props.values.includes(p);
          return (
            <button key={p} type="button" className="key key--plat" data-gel={p} data-press="clay" aria-pressed={on} onClick={() => props.onToggle(p, !on)}>
              <span className="key__cap">
                <PlatformLed />
                <PlatformGlyph platform={p} />
                <BidiLabel className="key__label">{nameOf(p)}</BidiLabel>
              </span>
            </button>
          );
        })}
      </div>
    </div>
  );
}
