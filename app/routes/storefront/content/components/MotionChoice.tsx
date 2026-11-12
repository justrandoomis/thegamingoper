import { useEffect, useState } from "react";

import { useT } from "~/i18n/react";
import { getMotionOverride, setMotionOverride, useMotionTier } from "~/motion";
import { Segmented } from "~/ui/Segmented";

type Choice = "system" | "reduced";

/**
 * "Reduce motion" for this browser: the motion engine's own override (localStorage `tt:motion`, applied at once
 * everywhere, no reload — docs/MOTION.md), as the kit's segmented control (v2 §4.6). "Follow my device" removes the
 * override again. The server cannot know the stored choice, so the control renders "follow my device" first and
 * corrects itself after hydration. The hint under it is a polite live region.
 */
export function MotionChoice({ hintClassName }: { hintClassName?: string }) {
  const t = useT("content");
  const tier = useMotionTier();
  const [choice, setChoice] = useState<Choice>("system");

  useEffect(() => {
    setChoice(getMotionOverride() === "reduced" ? "reduced" : "system");
  }, []);

  const deviceReduces = choice === "system" && tier === "reduced";
  return (
    <>
      <Segmented
        inline
        aria-label={t("a11y.motionLabel")}
        options={[
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
      <p className={hintClassName} aria-live="polite">
        {deviceReduces ? t("a11y.motionDevice") : t("a11y.motionHint")}
      </p>
    </>
  );
}
