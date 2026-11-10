import { data } from "react-router";

/**
 * Authenticated admin layout.
 * Until the admin shell (sign-in, MFA, RBAC) is in place this layout refuses every request,
 * so nothing under /admin can be reached by accident.
 */
export function loader() {
  throw data({ error: "not_found" }, { status: 404 });
}

export default function AdminLayout() {
  return null;
}
