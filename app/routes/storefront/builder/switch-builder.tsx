/**
 * /build/switch — Switch bundle builder. PLACEHOLDER written by the lead so the route exists while the page is built;
 * the storefront-ui owner replaces this file (contract: docs/switch-builder.md).
 */
import type { Route } from "./+types/switch-builder";
import { shellMeta } from "~/routes/storefront/shell/meta";

export const meta: Route.MetaFunction = (args) => shellMeta(args, { title: "Nintendo Switch", noindex: true });

export default function SwitchBuilder() {
  return <h1>Nintendo Switch</h1>;
}
