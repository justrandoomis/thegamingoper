import { index, route, type RouteConfigEntry } from "@react-router/dev/routes";

/**
 * Admin module 22 — Settings and system administration (docs/areas/admin-settings.md).
 * Paths are relative to "/admin" (inside the authenticated admin layout); route files live in routes/admin/settings/.
 *
 *   /admin/settings                       every setting by group, requests waiting, blueprint status        22.*
 *   /admin/settings/keys/:key             one setting: value, history, change (or request / decide)        22.01–22.06
 *   /admin/settings/changes               requests waiting for a second person, the change log             22.06
 *   /admin/settings/currency              base currency, the USD rate and its dates (changed in pricing)    22.01
 *   /admin/settings/policies              tax and shipping, return window, the policy texts                22.02
 *   /admin/settings/policies/:slug        the returns / warranty text: draft, edit, approve                 22.02
 *   /admin/settings/fields                custom fields per product kind                                    22.03
 *   /admin/settings/fields/:fieldId       one field ("new" to add one)                                     22.03
 *   /admin/settings/templates             message templates                                                 22.04
 *   /admin/settings/templates/:key        one template per language                                         22.04
 *   /admin/settings/files                 the file store: counts, sizes, unreferenced uploads               22.04
 *   /admin/settings/locale                Iraq time, date formats, languages and numerals                   22.05
 *   /admin/settings/environment           STORE_MODE / APP_ENV and the demo data                            22.06
 */
export const settingsAdminRoutes: RouteConfigEntry[] = [
  route("settings", "routes/admin/settings/layout.tsx", [
    index("routes/admin/settings/home.tsx"),
    route("keys/:key", "routes/admin/settings/key.tsx"),
    route("changes", "routes/admin/settings/changes.tsx"),
    route("currency", "routes/admin/settings/currency.tsx"),
    route("policies", "routes/admin/settings/policies.tsx"),
    route("policies/:slug", "routes/admin/settings/policy.tsx"),
    route("fields", "routes/admin/settings/fields.tsx"),
    route("fields/:fieldId", "routes/admin/settings/field.tsx"),
    route("templates", "routes/admin/settings/templates.tsx"),
    route("templates/:key", "routes/admin/settings/template.tsx"),
    route("files", "routes/admin/settings/files.tsx"),
    route("locale", "routes/admin/settings/locale.tsx"),
    route("environment", "routes/admin/settings/environment.tsx"),
  ]),
];
