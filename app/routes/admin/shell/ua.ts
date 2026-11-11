/**
 * A short, readable name for a session's device from its User-Agent ("Edge · Windows", "Safari · iPhone").
 * Recognition only — never used for security decisions. Pure and client-safe.
 */
export type DeviceSummary = { browser: string | null; system: string | null };

const BROWSERS: [RegExp, string][] = [
  [/\bEdg(?:e|A|iOS)?\//, "Edge"],
  [/\bOPR\/|\bOpera\b/, "Opera"],
  [/\bSamsungBrowser\//, "Samsung Internet"],
  [/\bFirefox\/|\bFxiOS\//, "Firefox"],
  [/\bCriOS\/|\bChrome\//, "Chrome"],
  [/\bVersion\/[\d.]+.*\bSafari\//, "Safari"],
];

const SYSTEMS: [RegExp, string][] = [
  [/\biPhone\b/, "iPhone"],
  [/\biPad\b/, "iPad"],
  [/\bAndroid\b/, "Android"],
  [/\bWindows\b/, "Windows"],
  [/\bMac OS X\b|\bMacintosh\b/, "macOS"],
  [/\bCrOS\b/, "ChromeOS"],
  [/\bLinux\b/, "Linux"],
];

export function summarizeUserAgent(userAgent: string | null | undefined): DeviceSummary {
  const ua = userAgent ?? "";
  const browser = BROWSERS.find(([pattern]) => pattern.test(ua))?.[1] ?? null;
  const system = SYSTEMS.find(([pattern]) => pattern.test(ua))?.[1] ?? null;
  return { browser, system };
}
