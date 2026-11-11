/**
 * A rough, human name for the browser and system behind a session's User-Agent ("Chrome", "Android") — enough for a
 * customer to recognise their own devices in the settings. Brand names stay in Latin script (DESIGN §11). Pure.
 */
export function describeUserAgent(userAgent: string | null | undefined): { browser: string | null; os: string | null } {
  const ua = userAgent ?? "";
  if (!ua) return { browser: null, os: null };
  const browser = /EdgA?\//.test(ua)
    ? "Edge"
    : /SamsungBrowser\//.test(ua)
      ? "Samsung Internet"
      : /OPR\/|Opera/.test(ua)
        ? "Opera"
        : /Firefox\/|FxiOS\//.test(ua)
          ? "Firefox"
          : /CriOS\/|Chrome\//.test(ua)
            ? "Chrome"
            : /Safari\//.test(ua) && /Version\//.test(ua)
              ? "Safari"
              : null;
  const os = /Android/.test(ua)
    ? "Android"
    : /iPhone|iPod/.test(ua)
      ? "iPhone"
      : /iPad/.test(ua)
        ? "iPad"
        : /Windows NT/.test(ua)
          ? "Windows"
          : /CrOS/.test(ua)
            ? "ChromeOS"
            : /Mac OS X|Macintosh/.test(ua)
              ? "macOS"
              : /Linux/.test(ua)
                ? "Linux"
                : null;
  return { browser, os };
}
