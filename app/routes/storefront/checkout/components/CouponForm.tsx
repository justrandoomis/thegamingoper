import { useId, useState, type FormEvent } from "react";

import { useT } from "~/i18n/react";
import type { CartView } from "~/lib/dto";
import type { Locale } from "~/lib/locales";
import { cartRequest } from "~/ui/cart-client";
import { TextField } from "~/ui/Field";
import { Key } from "~/ui/Key";
import { TextLink } from "~/ui/TextLink";

/** CartView as /api/cart sends it: plus the stored coupon that does not apply right now, and why. */
export type CartWithIssue = CartView & { couponIssue?: { code: string; reason: string } | null };

/**
 * The discount-code field of the cart (DESIGN.md §8.5): a paper field and a small key. The code is checked by the
 * server (POST /api/cart intent=coupon → applyCoupon); a refusal says exactly why, under the field, from the errors
 * namespace (`errors.coupon_<reason>`: not found, expired, not started, minimum not reached, used up, already used,
 * not for these items) — the cart is left as it was. An applied code shows its label and a "remove" text action. A
 * stored code that stopped applying (`couponIssue`) is explained the same way.
 */
export function CouponForm({ cart, locale, onCart }: { cart: CartWithIssue; locale: Locale; onCart: (cart: CartWithIssue) => void }) {
  const t = useT("checkout");
  const errorsT = useT("errors");
  const inputId = useId();
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState<"apply" | "remove" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [said, setSaid] = useState("");

  const send = async (value: string | null, kind: "apply" | "remove") => {
    setBusy(kind);
    setError(null);
    const answer = await cartRequest({ intent: "coupon", code: value ?? "", locale });
    setBusy(null);
    if (answer.ok) {
      onCart(answer.cart as CartWithIssue);
      setCode("");
      setSaid(kind === "apply" && answer.cart.coupon ? t("coupon.applied", { code: answer.cart.coupon.code }) : t("coupon.removed"));
      return;
    }
    // Field codes (coupon_not_found …) and transport failures (network, timeout) each have their own sentence.
    const key = answer.code === "network" || answer.code === "timeout" ? `coupon.${answer.code}` : null;
    setError(key ? t(key) : errorsT(`errors.${answer.code}`));
  };

  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (busy) return;
    if (code.trim() === "") {
      setError(t("coupon.empty"));
      return;
    }
    void send(code, "apply");
  };

  const applied = cart.coupon;
  const issue = !applied && cart.couponIssue ? cart.couponIssue : null;

  return (
    <div className="grid gap-2 border-t border-line pt-3">
      {applied ? (
        <div className="flex flex-wrap items-center justify-between gap-2">
          {/* The coupon's own description is already under the discount row of the summary. */}
          <p className="type-caption text-ink">{t("coupon.appliedLine", { code: "⁦" + applied.code + "⁩" })}</p>
          <TextLink as="button" type="button" arrow={false} onClick={() => void send(null, "remove")} disabled={busy !== null}>
            {busy === "remove" ? t("coupon.removing") : t("coupon.remove")}
          </TextLink>
        </div>
      ) : (
        <form onSubmit={submit} noValidate className="grid gap-2">
          <TextField
            id={inputId}
            label={t("coupon.label")}
            name="code"
            ltr
            autoComplete="off"
            autoCapitalize="characters"
            spellCheck={false}
            maxLength={64}
            value={code}
            onChange={(event) => {
              setCode(event.currentTarget.value);
              if (error) setError(null);
            }}
            error={error ?? undefined}
            // The code reads left to right; the key sits at the page's inline end, so reserve room on that side.
            inputClassName="pe-28 rtl:ps-28 rtl:pe-4"
            end={
              <Key type="submit" size="sm" loading={busy === "apply"}>
                {t("coupon.apply")}
              </Key>
            }
          />
          {issue ? (
            <p className="type-caption text-warn">
              {t("coupon.issue", { code: issue.code })} {errorsT(`errors.coupon_${issue.reason}`)}
            </p>
          ) : null}
        </form>
      )}
      <p className="sr-only" role="status" aria-live="polite">
        {said}
      </p>
    </div>
  );
}
