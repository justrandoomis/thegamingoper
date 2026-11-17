import { useEffect, useRef, useState } from "react";
import { useFetcher } from "react-router";

import { useFormat, useT, type Formatters } from "~/i18n/react";
import type { CartView } from "~/lib/dto";
import { localePath, type Locale } from "~/lib/locales";
import type { CartViewData } from "~/server/services/cart.server";
import { isolate } from "~/ui/BidiText";
import { cartRequest } from "~/ui/cart-client";
import { CouponField } from "~/ui/OrderSummary";
import { iqdText } from "~/ui/PriceTag";
import { TextLink } from "~/ui/TextLink";
import { COUPON_MINIMUM_INTENT, couponIssueShortfall, couponMinimumOf, type CouponShortfall } from "../checkout-form";
import type { CouponMinimumAnswer } from "../checkout.server";

/** A stored coupon that does not apply right now and why — below its minimum with the core's two figures (C-fix-core). */
type CouponIssue = { code: string; reason: string; rule?: string; minimumIqd?: number; moreIqd?: number };

/**
 * CartView as /api/cart sends it (CartViewData of the commerce core, the kit editors typing it as the kit's CartView):
 * plus the stored coupon that does not apply right now and why (below its minimum: the minimum and what is missing),
 * every discount as charged, the delivery waiver, the points, the referral code asked about.
 */
export type CartWithIssue = CartView & Partial<Pick<CartViewData, "discounts" | "shippingWaiver" | "points" | "referral" | "payableCount">> & { couponIssue?: CouponIssue | null };

/**
 * «الرمز DEMO5000 للطلبات من 100,000 د.ع فأكثر: أضف منتجات بقيمة 20,000 د.ع لتستخدمه.» (client round 1, QA: a code
 * below its minimum must say how much more is needed).
 */
export function couponMinimumText(shortfall: CouponShortfall, t: (key: string, vars?: Record<string, string | number>) => string, f: Pick<Formatters, "iqd">): string {
  return t("coupon.minimum", { code: "⁦" + shortfall.code + "⁩", min: isolate(iqdText(f, shortfall.minimumIqd)), more: isolate(iqdText(f, shortfall.moreIqd)) });
}

/**
 * The sentence for a stored coupon that does not apply right now. Below its minimum it says how much more: from the
 * issue's own figures (the core's, in every cart view), else from `shortfall` for the same code (an older answer: the
 * page's read) — `f` is needed for the amounts.
 */
export function couponIssueText(issue: CouponIssue, t: (key: string, vars?: Record<string, string | number>) => string, errorsT: (key: string) => string, shortfall?: CouponShortfall | null, f?: Pick<Formatters, "iqd">): string {
  if (issue.reason === "not_combinable") return t("coupon.notCombinable", { code: isolate(issue.code), rule: isolate(issue.rule ?? "") });
  if (issue.reason === "min_subtotal" && f) {
    const gap = couponIssueShortfall(issue) ?? (shortfall && shortfall.code === issue.code.toUpperCase() ? shortfall : null);
    if (gap) return couponMinimumText(gap, t, f);
  }
  return `${t("coupon.issue", { code: "⁦" + issue.code + "⁩" })} ${errorsT(`errors.coupon_${issue.reason}`)}`;
}

/**
 * The discount code inside the order summary's «لديك رمز خصم؟» disclosure (Design System v2 §4.13): the kit's
 * <CouponField> — a field and a SEPARATE 40px «طبّق». The code is checked by the server (POST /api/cart
 * intent=coupon → applyCoupon); a refusal says exactly why, under the field, from the errors namespace
 * (`errors.coupon_<reason>`: «هذا الرمز غير موجود. تحقق من كتابته.» …) and the cart is left as it was. A code below its
 * minimum says how much more is needed (client round 1): the 409 itself carries the minimum and what is missing (the
 * commerce core's count, C-fix-core) and the sentence takes the generic one's place at once. An applied code shows one
 * line and «أزل الرمز» (the summary's discount row already names it). A stored code that stopped applying
 * (`couponIssue`) is explained the same way, from the view's own figures. Only an answer without the figures (an older
 * one) asks the page's action `intent=coupon-minimum` (checkout.server couponShortfall). In the checkout the answer is
 * priced for the chosen governorate.
 */
export function CouponForm({
  cart,
  locale,
  governorateId = null,
  pricing,
  shortfall = null,
  onCart,
}: {
  cart: CartWithIssue;
  locale: Locale;
  governorateId?: string | null;
  pricing?: { points: number; referral: string };
  /** A stored code below its minimum: how much more (the loader's answer — the same figures the view carries). */
  shortfall?: CouponShortfall | null;
  onCart: (cart: CartWithIssue) => void;
}) {
  const t = useT("checkout");
  const errorsT = useT("errors");
  const f = useFormat();
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState<"apply" | "remove" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [said, setSaid] = useState("");
  // the fallback read, for an answer without the core's figures: how much more, asked of the cart route's action
  const minimum = useFetcher<CouponMinimumAnswer>();
  const asked = useRef<string | null>(null);
  const [askedShortfall, setAskedShortfall] = useState<CouponShortfall | null>(null);

  useEffect(() => {
    const answer = minimum.data;
    if (minimum.state !== "idle" || !answer || !asked.current) return;
    const wanted = asked.current;
    asked.current = null;
    if (!answer.ok || !answer.shortfall) return;
    if (wanted === "stored") setAskedShortfall(answer.shortfall);
    else setError(couponMinimumText(answer.shortfall, t, f));
    // eslint-disable-next-line react-hooks/exhaustive-deps -- reacts to the fetcher's answer only
  }, [minimum.state, minimum.data]);

  const askMinimum = (value: string, kind: "typed" | "stored") => {
    asked.current = kind;
    // always the cart route's action, from the cart and from the checkout: its clientAction turns a failed request into
    // an answer, so a dropped read never puts the error boundary in place of the page (the refusal's words stay)
    void minimum.submit({ intent: COUPON_MINIMUM_INTENT, code: value }, { method: "post", action: localePath("/cart", locale) });
  };

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
    if (answer.code === "coupon_min_subtotal" && value) {
      // below its minimum: how much more — the refusal's own figures (the core's count); only an answer without them
      // asks the page (the generic sentence stays until that answer is here)
      const gap = couponMinimumOf(value, answer);
      if (gap) setError(couponMinimumText(gap, t, f));
      else askMinimum(value, "typed");
    }
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
  // the coupon's own words (its terms, «قسيمة تجريبية: خصم 10% بحد أقصى …») — the admin writes them once, in the
  // store's language: said under the applied code on Arabic pages only (an English or Kurdish page never shows a stray
  // Arabic paragraph), and never in the summary's rows (one line per discount there)
  const terms = applied && locale === "ar" && applied.label.trim() !== "" && applied.label.trim().toUpperCase() !== applied.code.toUpperCase() ? applied.label.trim() : null;
  const issue = !applied && cart.couponIssue ? cart.couponIssue : null;
  // a stored code below its minimum: the view's own figures (every cart view — the loader's, the editor's, a pricing
  // answer — carries them); only a view without them asks the page, once per code and cart
  const viewGap = couponIssueShortfall(issue);
  const storedKey = issue?.reason === "min_subtotal" && !viewGap ? `${issue.code}|${cart.subtotalIqd}` : null;
  const storedAsked = useRef<string | null>(shortfall && storedKey ? storedKey : null);
  useEffect(() => {
    if (!storedKey || !issue || storedAsked.current === storedKey) return;
    storedAsked.current = storedKey;
    askMinimum(issue.code, "stored");
    // eslint-disable-next-line react-hooks/exhaustive-deps -- asked when the stored code's case changes
  }, [storedKey]);
  const storedGap = viewGap ?? (issue ? ([askedShortfall, shortfall].find((gap) => gap !== null && gap.code === issue.code.toUpperCase()) ?? null) : null);

  return (
    <div className="grid gap-2">
      {applied ? (
        <div className="grid gap-1">
          <div className="flex flex-wrap items-center justify-between gap-x-3">
            <p className="type-xs text-ink">{t("coupon.appliedLine", { code: "⁦" + applied.code + "⁩" })}</p>
            <TextLink as="button" type="button" arrow={false} onClick={() => void send(null, "remove")} disabled={busy !== null}>
              {busy === "remove" ? t("coupon.removing") : t("coupon.remove")}
            </TextLink>
          </div>
          {terms ? <p className="type-xs text-ink-2">{terms}</p> : null}
        </div>
      ) : (
        <CouponField
          name="code"
          value={code}
          onChange={(value) => {
            setCode(value);
            if (error) setError(null);
            // an answer about the code before this edit no longer applies to the field
            if (asked.current === "typed") asked.current = null;
          }}
          onApply={apply}
          error={error ?? undefined}
          pending={busy === "apply"}
        />
      )}
      {issue ? (
        <p className={issue.reason === "not_combinable" ? "type-xs text-ink-2" : "type-xs text-warn"}>
          {couponIssueText(issue, t, errorsT, storedGap, f)}
        </p>
      ) : null}
      <p className="sr-only" role="status" aria-live="polite">
        {said}
      </p>
    </div>
  );
}
