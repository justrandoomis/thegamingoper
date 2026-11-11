import { route, type RouteConfigEntry } from "@react-router/dev/routes";

/**
 * About, policies, contact, accessibility, design-system and motion reference pages, 404.
 * Paths are relative to the storefront layout (":locale?"); route files live in routes/storefront/content/.
 * The splat route must stay last.
 */
export const contentRoutes: RouteConfigEntry[] = [
  // Motion lab (owner: motion): /motion and its list → detail demo route /motion/item/:id.
  route("motion", "routes/storefront/content/motion-lab.tsx", [route("item/:id", "routes/storefront/content/motion-lab-item.tsx")]),
  route("*", "routes/storefront/content/not-found.tsx"),
];
