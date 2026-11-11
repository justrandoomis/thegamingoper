/**
 * The on-demand half of the engine, bundled as one chunk: fly-to-cart, sheet physics, menus, theme cross-fade,
 * rails. Never import this file statically — go through ./lazy (functions) or the thin hooks (./sheet-hook,
 * ./rail-hook). <MotionRoot> fetches it when the browser is idle.
 */
import "./extras.css";

export { fly, receive, squish } from "./fly";
export { createSheet } from "./sheet";
export { materialize, dematerialize } from "./materialize";
export { themeCrossFade } from "./morph";
export { attachRail } from "./rail";
