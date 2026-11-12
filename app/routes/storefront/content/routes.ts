import { route, type RouteConfigEntry } from "@react-router/dev/routes";

/**
 * About, policies, contact, accessibility, design-system and motion reference pages, 404.
 * Paths are relative to the storefront layout (":locale?"); route files live in routes/storefront/content/.
 * The splat route must stay last.
 */
export const contentRoutes: RouteConfigEntry[] = [
  // Motion lab (owner: motion): /motion and its list → detail demo route /motion/item/:id.
  route("motion", "routes/storefront/content/motion-lab.tsx", [route("item/:id", "routes/storefront/content/motion-lab-item.tsx")]),
  route("design-system", "routes/storefront/content/design-system.tsx"),
  // Store pages (owner: content): docs/areas/content.md.
  route("about", "routes/storefront/content/about.tsx"),
  route("contact", "routes/storefront/content/contact.tsx"),
  route("accessibility", "routes/storefront/content/accessibility.tsx"),
  route("policies", "routes/storefront/content/policies.tsx"),
  route("policies/:slug", "routes/storefront/content/policy.tsx"),
  // Landing pages staff publish in the content module (admin 17.01, LANDING_PATH_PREFIX "/pages").
  route("pages/:slug", "routes/storefront/content/landing.tsx"),
  route("*", "routes/storefront/content/not-found.tsx"),
];
