/**
 * Where to send an employee after signing in (`?next=`). Only a same-origin path inside the admin is accepted:
 *
 *   adminNextPath("/admin/orders?status=new")   → "/admin/orders?status=new"
 *   adminNextPath("//evil.example")             → "/admin"      (scheme-relative: another site)
 *   adminNextPath("/\\evil.example")            → "/admin"      (browsers read "\" as "/")
 *   adminNextPath("https://evil.example/admin") → "/admin"      (absolute URL, any scheme)
 *   adminNextPath("/admin/../..//evil.example") → "/admin"      (dot segments resolve outside /admin)
 *   adminNextPath("/admin%2F..%2F..%2Fx")       → "/admin"      (an encoded path that is not under /admin)
 *   adminNextPath("/admin/login")               → "/admin"      (never back to the sign-in or setup pages, in any case)
 *   adminNextPath("/admin/x/../orders")         → "/admin/orders"            (returned as the URL parser writes it:
 *   adminNextPath("/admin/طلبات")               → "/admin/%D8%B7%D9%84…"      dot segments resolved, non-ASCII encoded)
 *
 * `raw` is the decoded query value (URLSearchParams decodes once). Built on safeNextPath (~/server/auth/common.server),
 * which refuses anything that does not start with a single "/", backslashes, control characters and over-long values,
 * and checks that the resolved pathname stays under the prefix; this adds the admin's own rules on top. A value that
 * decodes a second time into something outside the admin is refused too, so a double-encoded path cannot be turned
 * into another one by a component that decodes again. What comes back is always the canonical, ASCII-only form, so it
 * can go into a Location header as it is (a raw "/admin/أ" is not a valid header value outside workerd).
 */
import { safeNextPath } from "~/server/auth/common.server";

export const ADMIN_HOME = "/admin";

const BASE = "https://local.invalid";

/** Pages a sign-in must never return to (they would loop or start another bootstrap). Route matching ignores case. */
const NOT_A_DESTINATION = /^\/admin\/(login|setup|logout|locale)(?:[/?#.]|$)/i;

/** An /admin path that passed every check, in canonical form; null when it did not pass. */
function checkedAdminPath(raw: unknown): { path: string; decoded: string } | null {
  const safe = safeNextPath(raw, "", ADMIN_HOME);
  if (!safe) return null;
  let decoded: string;
  try {
    decoded = decodeURIComponent(safe);
  } catch {
    return null;
  }
  // The decoded form must pass the same checks (no "%2F%2F", "%5C" or "%0A" smuggling).
  if (decoded !== safe && !safeNextPath(decoded, "", ADMIN_HOME)) return null;
  // As the URL parser writes it: dot segments resolved, anything outside ASCII percent-encoded.
  const url = new URL(safe, BASE);
  if (url.origin !== BASE) return null;
  const path = `${url.pathname}${url.search}${url.hash}`;
  // The canonical form must still be an admin path (belt and braces: it is what the browser will request).
  if (safeNextPath(path, "", ADMIN_HOME) !== path) return null;
  return { path, decoded };
}

export function adminNextPath(raw: unknown, fallback: string = ADMIN_HOME): string {
  const checked = checkedAdminPath(raw);
  if (!checked) return fallback;
  const pathname = new URL(checked.path, BASE).pathname;
  if (NOT_A_DESTINATION.test(pathname) || NOT_A_DESTINATION.test(checked.decoded)) return fallback;
  return checked.path;
}

/**
 * Where the language switch sends the browser back to: any /admin path, the sign-in and setup pages included (the
 * language can be changed there), in the same canonical form; anything else becomes /admin.
 */
export function adminBackPath(raw: unknown, fallback: string = ADMIN_HOME): string {
  return checkedAdminPath(raw)?.path ?? fallback;
}

/** The login URL that returns to `next` (when it is a valid admin path other than the home). */
export function loginPathFor(next: string | null | undefined): string {
  const target = adminNextPath(next ?? "", "");
  return target && target !== ADMIN_HOME ? `/admin/login?next=${encodeURIComponent(target)}` : "/admin/login";
}
