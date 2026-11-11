import { useLocation, useOutlet } from "react-router";

import type { Route } from "./+types/motion-lab";
import { messagesFor, serverT } from "~/i18n/i18n.server";
import { useT } from "~/i18n/react";
import { MotionRoot, PageTransition, type MotionHandle } from "~/motion";
import { CartTab } from "~/motion/lab/CartTab";
import { FlowTab, LabViewer } from "~/motion/lab/FlowTab";
import { LAB_TABS, labTab } from "~/motion/lab/items";
import { LabBar, LabTabs } from "~/motion/lab/LabBar";
import { RevealTab } from "~/motion/lab/RevealTab";
import { SystemTab } from "~/motion/lab/SystemTab";
import { TouchTab } from "~/motion/lab/TouchTab";
import { getCtx } from "~/server/context.server";
import "~/motion/lab.css";

/**
 * /motion — the live reference for the TamTam Motion Engine (docs/MOTION.md).
 * Every public piece of ~/motion runs here on plain neutral surfaces; all content is demo data.
 * This route is also the layout of /motion/item/:id, so the list → detail navigation is between two real routes.
 */
export function loader({ context }: Route.LoaderArgs) {
  const ctx = getCtx(context);
  return { title: serverT(ctx.locale, "motion")("meta.title"), i18n: messagesFor(ctx.locale, "motion") };
}

export function meta({ loaderData }: Route.MetaArgs) {
  return [{ title: loaderData?.title }, { name: "robots", content: "noindex" }];
}

/** The lab's tabs are siblings in `?tab=` order: moving between them pushes sideways, the right way round, on its own. */
export const handle = {
  nav: "push",
  order: ({ search }) => LAB_TABS.indexOf(labTab(search)),
} satisfies MotionHandle;

function LabHome() {
  const t = useT("motion");
  const location = useLocation();
  const tab = labTab(location.search);
  return (
    <div className="lab-main" data-testid="lab-home">
      <p className="lab-intro">{t("intro")}</p>
      <LabTabs active={tab} />
      <div className="lab-stack" data-testid={`panel-${tab}`}>
        {tab === "touch" ? <TouchTab /> : null}
        {tab === "flow" ? <FlowTab /> : null}
        {tab === "reveal" ? <RevealTab /> : null}
        {tab === "cart" ? <CartTab /> : null}
        {tab === "system" ? <SystemTab /> : null}
      </div>
      {location.hash === "#viewer" || location.hash === "#viewer-2" ? <LabViewer slide={location.hash === "#viewer" ? 0 : 1} /> : null}
    </div>
  );
}

export default function MotionLab() {
  const outlet = useOutlet();
  return (
    <div className="lab">
      {/* The storefront layout mounts these too; a second <MotionRoot> is a no-op and transitions are planned once. */}
      <MotionRoot />
      <LabBar />
      <PageTransition>{outlet ?? <LabHome />}</PageTransition>
    </div>
  );
}
