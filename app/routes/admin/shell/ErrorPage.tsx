/**
 * The admin's error pages, inside the shell: 403 (a module the role cannot open, or a page that needs a permission
 * the employee lacks — requireEmployee says which), 404 and everything else. Words and one way out, never a stack
 * trace outside development, never a fake zero.
 *
 * A refusal of the admin gate for a page the browser opened itself arrives here through the shell's refusal page
 * (shell/denied.tsx, polish 2026-11-13) and carries `from`, the page that was asked for: it is shown (an admin path,
 * left to right) with "try again" next to the way home — so the employee can ask for the right section, or retry once
 * a role was given.
 */
import { isRouteErrorResponse, Link, useRevalidator } from "react-router";

import { Icon } from "~/art/Icon";
import { Key } from "~/ui/Key";
import { useAdminT } from "./i18n";
import { isAdminModuleSlug } from "./modules";

type ErrorData = { error?: string; permission?: string; module?: string; from?: string } | null;

/** The page a refusal was for, when it is an admin path (shell/denied.tsx checked it; checked again before linking). */
function askedFor(payload: ErrorData): string | null {
  const from = payload?.from;
  return typeof from === "string" && /^\/admin(?:[/?#]|$)/.test(from) && !from.startsWith("//") ? from : null;
}

export function AdminErrorPage({ error }: { error: unknown }) {
  const t = useAdminT();
  const revalidator = useRevalidator();
  const status = isRouteErrorResponse(error) ? error.status : 500;
  const payload: ErrorData = isRouteErrorResponse(error) && typeof error.data === "object" ? (error.data as ErrorData) : null;

  let title: string;
  let text: string;
  let detail: string | null = null;
  let from: string | null = null;
  if (status === 403) {
    title = t("errors.forbiddenTitle");
    const module = payload?.module && isAdminModuleSlug(payload.module) ? t(`modules.${payload.module}`) : null;
    // a section the role lacks; a permission a page needs (named below); or a page no role opens (outside every section)
    text = module ? t("errors.forbiddenModule", { module }) : payload?.permission ? t("errors.forbiddenPermission") : t("errors.forbiddenPage");
    detail = module ? null : (payload?.permission ?? null);
    from = askedFor(payload);
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
      {from ? (
        <p className="grid gap-1">
          <span className="type-caption text-ink-2">{t("errors.askedFor")}</span>
          <code dir="ltr" className="type-data justify-self-start break-all">
            {from}
          </code>
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
        {from ? (
          <Key as={Link} to={from} variant="ghost" icon={<Icon name="arrows-clockwise" size={18} />}>
            {t("errors.retry")}
          </Key>
        ) : null}
        {status >= 500 ? (
          <Key onClick={() => revalidator.revalidate()} loading={revalidator.state === "loading"}>
            {t("errors.retry")}
          </Key>
        ) : null}
      </div>
    </section>
  );
}
