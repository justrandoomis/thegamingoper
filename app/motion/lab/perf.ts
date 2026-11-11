/**
 * Frame-rate and long-task sampler for the lab's readout. One requestAnimationFrame loop while at least one
 * readout is mounted; it stops with the last one, and the browser already stops calling it in a hidden tab.
 */
export type PerfReading = { fps: number; worst: number; longTasks: number };

type Listener = (reading: PerfReading) => void;

const listeners = new Set<Listener>();
let frame = 0;
let last = 0;
let frames: number[] = [];
let slow: Array<{ t: number; ms: number }> = [];
let longTasks = 0;
let observer: PerformanceObserver | null = null;
let lastEmit = 0;

function tick(now: number): void {
  if (last) {
    const delta = now - last;
    // A gap of seconds is a hidden tab or a paused debugger, not a slow frame.
    if (delta < 1000) {
      frames.push(now);
      if (delta > 20) slow.push({ t: now, ms: delta });
    }
  }
  last = now;
  while (frames.length && now - frames[0] > 1000) frames.shift();
  while (slow.length && now - slow[0].t > 5000) slow.shift();
  if (now - lastEmit > 500) {
    lastEmit = now;
    const reading = { fps: frames.length, worst: slow.reduce((max, s) => Math.max(max, s.ms), 0), longTasks };
    for (const listener of listeners) listener(reading);
  }
  frame = requestAnimationFrame(tick);
}

export function resetPerf(): void {
  longTasks = 0;
  slow = [];
}

export function watchPerf(listener: Listener): () => void {
  listeners.add(listener);
  if (listeners.size === 1) {
    last = 0;
    frames = [];
    frame = requestAnimationFrame(tick);
    if (typeof PerformanceObserver === "function" && PerformanceObserver.supportedEntryTypes?.includes("longtask")) {
      observer = new PerformanceObserver((list) => {
        longTasks += list.getEntries().length;
      });
      observer.observe({ entryTypes: ["longtask"] });
    }
  }
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0) {
      cancelAnimationFrame(frame);
      observer?.disconnect();
      observer = null;
    }
  };
}
