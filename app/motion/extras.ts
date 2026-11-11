/**
 * The on-demand half of the engine, bundled as one chunk: fly-to-cart, sheet physics, materialize, theme reveal, rails.
 * Never import this file statically — go through ./lazy (functions) or the thin hooks (./sheet-hook, ./rail-hook).
 * <MotionRoot> fetches it when the browser is idle.
 */
import "./extras.css";

export { fly, receive } from "./fly";
export { createSheet } from "./sheet";
export { materialize, dematerialize } from "./materialize";
export { themeReveal } from "./morph";
export { attachRail } from "./rail";
