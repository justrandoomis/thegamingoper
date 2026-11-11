import { useEffect, useState } from "react";

import { useT } from "~/i18n/react";
import { getMotionOverride, setMotionOverride, useMotionTier } from "~/motion";
import { KeyBank } from "~/ui/KeyBank";

type Choice = "system" | "reduced";

/**
 * "Reduce motion" for this browser: the motion engine's own override (localStorage `tt:motion`, applied at once
 * everywhere, no reload — docs/MOTION.md). "Follow my device" removes the override again. The server cannot know the
 * stored choice, so the bank renders "follow my device" first and corrects itself after hydration.
 */
export function MotionChoice() {
  const t = useT("content");
  const tier = useMotionTier();
  const [choice, setChoice] = useState<Choice>("system");

  useEffect(() => {
    setChoice(getMotionOverride() === "reduced" ? "reduced" : "system");
  }, []);

  const deviceReduces = choice === "system" && tier === "reduced";
  return (
    <div className="grid gap-2">
      <KeyBank
        kind="segment"
        aria-label={t("a11y.motionLabel")}
        items={[
          { value: "system", label: t("a11y.motionSystem") },
          { value: "reduced", label: t("a11y.motionReduced") },
        ]}
        value={choice}
        onChange={(value) => {
          const next: Choice = value === "reduced" ? "reduced" : "system";
          setChoice(next);
          setMotionOverride(next === "reduced" ? "reduced" : null);
        }}
      />
      <p className="type-caption text-ink-2" aria-live="polite">
        {deviceReduces ? t("a11y.motionDevice") : t("a11y.motionHint")}
      </p>
    </div>
  );
}
