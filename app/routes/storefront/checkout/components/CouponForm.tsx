import { useState } from "react";

import { useT } from "~/i18n/react";
import type { CartView } from "~/lib/dto";
import type { Locale } from "~/lib/locales";
import type { CartViewData } from "~/server/services/cart.server";
import { isolate } from "~/ui/BidiText";
import { cartRequest } from "~/ui/cart-client";
import { CouponField } from "~/ui/OrderSummary";
import { TextLink } from "~/ui/TextLink";

/**
 * CartView as /api/cart sends it (CartViewData of the commerce core, the kit editors typing it as the kit's CartView):
 * plus the stored coupon that does not apply right now and why, every discount as charged, the delivery waiver, the
 * points, the referral code asked about.
 */
export type CartWithIssue = CartView & Partial<Pick<CartViewData, "discounts" | "shippingWaiver" | "points" | "referral">> & { couponIssue?: { code: string; reason: string; rule?: string } | null };

/** The sentence for a stored coupon that does not apply right now. */
export function couponIssueText(issue: { code: string; reason: string; rule?: string }, t: (key: string, vars?: Record<string, string | number>) => string, errorsT: (key: string) => string): string {
  if (issue.reason === "not_combinable") return t("coupon.notCombinable", { code: isolate(issue.code), rule: isolate(issue.rule ?? "") });
  return `${t("coupon.issue", { code: "⁦" + issue.code + "⁩" })} ${errorsT(`errors.coupon_${issue.reason}`)}`;
}

/**
 * The discount code inside the order summary's «لديك رمز خصم؟» disclosure (Design System v2 §4.13): the kit's
 * <CouponField> — a field and a SEPARATE 40px «طبّق». The code is checked by the server (POST /api/cart
 * intent=coupon → applyCoupon); a refusal says exactly why, under the field, from the errors namespace
 * (`errors.coupon_<reason>`: «هذا الرمز غير موجود. تحقق من كتابته.» …) and the cart is left as it was. An applied code
 * shows one line and «أزل الرمز» (the summary's discount row already names it). A stored code that stopped applying
 * (`couponIssue`) is explained the same way. In the checkout the answer is priced for the chosen governorate.
 */
export function CouponForm({ cart, locale, governorateId = null, pricing, onCart }: { cart: CartWithIssue; locale: Locale; governorateId?: string | null; pricing?: { points: number; referral: string }; onCart: (cart: CartWithIssue) => void }) {
  const t = useT("checkout");
  const errorsT = useT("errors");
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState<"apply" | "remove" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [said, setSaid] = useState("");

  const send = async (value: string | null, kind: "apply" | "remove") => {
    setBusy(kind);
    setError(null);
    // the checkout's choices ride along, so the answer is priced as the page shows it (points, a referral code)
    const answer = await cartRequest({ intent: "coupon", code: value ?? "", locale, governorateId: governorateId ?? undefined, points: pricing?.points || undefined, referral: pricing?.referral || undefined });
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

  const apply = (value: string) => {
    if (busy) return;
    if (value.trim() === "") {
      setError(t("coupon.empty"));
      return;
    }
    void send(value, "apply");
  };

  const applied = cart.coupon;
  const issue = !applied && cart.couponIssue ? cart.couponIssue : null;

  return (
    <div className="grid gap-2">
      {applied ? (
        <div className="flex flex-wrap items-center justify-between gap-x-3">
          <p className="type-xs text-ink">{t("coupon.appliedLine", { code: "⁦" + applied.code + "⁩" })}</p>
          <TextLink as="button" type="button" arrow={false} onClick={() => void send(null, "remove")} disabled={busy !== null}>
            {busy === "remove" ? t("coupon.removing") : t("coupon.remove")}
          </TextLink>
        </div>
      ) : (
        <CouponField
          name="code"
          value={code}
          onChange={(value) => {
            setCode(value);
            if (error) setError(null);
          }}
          onApply={apply}
          error={error ?? undefined}
          pending={busy === "apply"}
        />
      )}
      {issue ? <p className={issue.reason === "not_combinable" ? "type-xs text-ink-2" : "type-xs text-warn"}>{couponIssueText(issue, t, errorsT)}</p> : null}
      <p className="sr-only" role="status" aria-live="polite">
        {said}
      </p>
    </div>
  );
}
