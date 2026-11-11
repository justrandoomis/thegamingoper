/**
 * The admin's error pages, inside the shell: 403 (a module the role cannot open, or a page that needs a permission
 * the employee lacks — requireEmployee says which), 404 and everything else. Words and one way out, never a stack
 * trace outside development, never a fake zero.
 */
import { isRouteErrorResponse, Link, useRevalidator } from "react-router";

import { Icon } from "~/art/Icon";
import { Key } from "~/ui/Key";
import { useAdminT } from "./i18n";
import { isAdminModuleSlug } from "./modules";

type ErrorData = { error?: string; permission?: string; module?: string } | null;

export function AdminErrorPage({ error }: { error: unknown }) {
  const t = useAdminT();
  const revalidator = useRevalidator();
  const status = isRouteErrorResponse(error) ? error.status : 500;
  const payload: ErrorData = isRouteErrorResponse(error) && typeof error.data === "object" ? (error.data as ErrorData) : null;

  let title: string;
  let text: string;
  let detail: string | null = null;
  if (status === 403) {
    title = t("errors.forbiddenTitle");
    const module = payload?.module && isAdminModuleSlug(payload.module) ? t(`modules.${payload.module}`) : null;
    text = module ? t("errors.forbiddenModule", { module }) : t("errors.forbiddenPermission");
    detail = module ? null : (payload?.permission ?? null);
  } else if (status === 404) {
    title = t("errors.notFoundTitle");
    text = t("errors.notFoundText");
  } else {
    title = t("errors.serverTitle");
    text = t("errors.serverText");
  }
  const devMessage = import.meta.env.DEV && error instanceof Error ? error.message : null;

  return (
    <section className="grid max-w-[40rem] gap-4 py-6" aria-labelledby="adm-error-title">
      <p className="adm-eyebrow nums">{t("errors.code", { status })}</p>
      <h1 id="adm-error-title" className="adm-title">
        {title}
      </h1>
      <p className="type-body text-ink">{text}</p>
      {detail ? (
        <p className="type-data">
          <code dir="ltr">{detail}</code>
        </p>
      ) : null}
      {devMessage ? (
        <pre dir="ltr" className="overflow-x-auto rounded-xs bg-niche p-3 type-data-sm">
          {devMessage}
        </pre>
      ) : null}
      <div className="flex flex-wrap gap-3 pt-2">
        <Key as={Link} to="/admin" icon={<Icon name="squares-four" size={18} />}>
          {t("errors.home")}
        </Key>
        {status >= 500 ? (
          <Key onClick={() => revalidator.revalidate()} loading={revalidator.state === "loading"}>
            {t("errors.retry")}
          </Key>
        ) : null}
      </div>
    </section>
  );
}
