import { data, redirect } from "react-router";

import type { Route } from "./+types/module";
import { requireEmployee } from "~/server/auth/admin.server";
import { getCtx } from "~/server/context.server";
import { getDb } from "~/server/db.server";
import { canSeeModule } from "./access.server";
import { adminMeta } from "./meta";
import { ModuleLanding } from "./ModuleLanding";
import { moduleBySlug } from "./modules";

/**
 * /admin/:module — the landing page of a module that has no page of its own yet. Exists for every module the employee
 * may see; a module their role cannot see answers 403 (rendered inside the shell), an unknown name 404. As soon as a
 * module registers its own /admin/<slug> route, that route wins and this one is never matched for it.
 */
export async function loader({ params, context }: Route.LoaderArgs) {
  const { actor } = await requireEmployee(getCtx(context), getDb());
  const slug = params.module;
  if (slug === "dashboard") throw redirect("/admin");
  const module = moduleBySlug(slug);
  if (!module) throw data({ error: "not_found" }, { status: 404 });
  if (!canSeeModule(actor, module.slug)) throw data({ error: "forbidden", module: module.slug }, { status: 403 });
  return { slug: module.slug, moduleId: module.id };
}

export const meta: Route.MetaFunction = (args) => adminMeta(args, args.loaderData ? (t) => t(`modules.${args.loaderData!.slug}`) : null);

export default function ModuleLandingRoute({ loaderData }: Route.ComponentProps) {
  return <ModuleLanding moduleId={loaderData.moduleId} />;
}
