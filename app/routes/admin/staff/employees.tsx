import { useCallback, useEffect, useRef, useState } from "react";
import { Form, Link, useFetcher, useSearchParams } from "react-router";

import type { Route } from "./+types/employees";
import { Icon } from "~/art/Icon";
import { useFormat } from "~/i18n/react";
import { invalid } from "~/server/errors";
import { hireEmployee, hireOptions, listEmployees } from "~/server/services/admin/staff/employees.server";
import { employeeSearch, parseEmployeeFilters, type EmployeeFilters, type EmployeeRow, type HandedLink, type HireOptions } from "~/server/services/admin/staff/types";
import type { DataColumn } from "~/ui/DataTable";
import { Dialog } from "~/ui/Dialog";
import { EmptyState } from "~/ui/EmptyState";
import { Checkbox, FieldGroup, Select, TextField } from "~/ui/Field";
import { Key } from "~/ui/Key";
import { Pagination } from "~/ui/Pagination";
import { toast } from "~/ui/toast-store";
import { staffMeta } from "./meta";
import { all, failed, handedLink, ok, openStaff, optional, orRespond, staffT, text } from "./staff.server";
import { DemoTag, LinkChips, LinkOnce, Note, PageHead, Pair, ResponsiveTable, Section, StateTag, When, useListSep, useStaffLayout, useStaffT, type ActionData } from "./ui";

/**
 * /admin/staff/employees — 15.01: the directory (staff.employee.read or staff.manage). Filters, sort and page in the
 * URL (a GET form, works without script). Each employee's file — what their roles grant, read-only; roles are edited
 * in module 20 — is /admin/staff/employees/:id.
 *
 * «Add an employee» (staff.manage; `?add=1` opens it — module 20's staff list links here): the auth core's
 * createEmployee through hireEmployee — the account has no password; the answer carries the one-time password-set link,
 * shown ONCE on this page (LinkOnce) for the person to hand over, never stored and never put in a URL.
 */
export async function loader({ context, request }: Route.LoaderArgs) {
  const { db, actor, locale } = await openStaff(context);
  const filters = parseEmployeeFilters(new URL(request.url).searchParams);
  const [page, hire] = await Promise.all([orRespond(() => listEmployees(db, actor, filters, locale)), hireOptions(db, actor, locale)]);
  return { page, filters, hire };
}

export async function action({ request, context }: Route.ActionArgs) {
  const req = await openStaff(context);
  const form = await request.formData();
  const intent = text(form, "intent");
  const t = staffT(req.locale);
  try {
    if (intent !== "create") throw invalid({ intent: "invalid" });
    const hired = await hireEmployee(
      req.db,
      req.actor,
      { name: text(form, "name"), email: text(form, "email"), phone: optional(form, "phone"), jobTitle: optional(form, "jobTitle"), roleIds: all(form, "roleId"), branchId: optional(form, "branchId"), reason: text(form, "reason") },
      req.now,
      { demo: req.ctx.storeMode === "demo" },
    );
    // the name isolated (FIRST STRONG ISOLATE … POP DIRECTIONAL ISOLATE): a Latin name never reorders the sentence
    return ok(intent, { message: t("hire.created", { name: `⁨${hired.name}⁩` }), employee: { id: hired.employeeId, name: hired.name }, link: handedLink(req.ctx.origin, hired.link) });
  } catch (error) {
    return failed(error, req.locale, intent);
  }
}

export const meta: Route.MetaFunction = (args) => staffMeta(args, "employees.title");

type Handed = { link: HandedLink; employee: { id: string; name: string } };

export default function EmployeesPage({ loaderData }: Route.ComponentProps) {
  const t = useStaffT();
  const f = useFormat();
  const sep = useListSep();
  const layout = useStaffLayout();
  const { page, filters, hire } = loaderData;
  const [adding, setAdding] = useState(false);
  const [handed, setHanded] = useState<Handed | null>(null);
  const [searchParams, setSearchParams] = useSearchParams();
  const askedToAdd = searchParams.get("add") === "1";
  // `?add=1` (the security section's staff list) opens the form once the page runs in the browser
  useEffect(() => {
    if (askedToAdd && hire) setAdding(true);
  }, [askedToAdd, hire]);
  const closeAdding = useCallback(() => {
    setAdding(false);
    if (askedToAdd)
      setSearchParams(
        (current) => {
          current.delete("add");
          return current;
        },
        { replace: true, preventScrollReset: true },
      );
  }, [askedToAdd, setSearchParams]);
  const href = (patch: Partial<EmployeeFilters>) => `/admin/staff/employees${employeeSearch({ ...filters, ...patch, page: 1 })}`;
  const columns: DataColumn<EmployeeRow>[] = [
    {
      key: "name",
      header: t("employees.col.name"),
      cell: (row) => (
        <span className="grid py-1">
          <Link to={`/admin/staff/employees/${row.id}`} className="adm-link">
            {row.name}
          </Link>
          <bdi dir="ltr" className="type-caption text-ink-2">
            {row.email}
          </bdi>
        </span>
      ),
    },
    { key: "title", header: t("employees.col.jobTitle"), cell: (row) => row.jobTitle ?? <span className="text-ink-2">—</span> },
    { key: "roles", header: t("employees.col.roles"), cell: (row) => (row.roles.length ? row.roles.map((role) => role.name).join(sep) : <span className="text-ink-2">{t("employees.noRole")}</span>) },
    {
      key: "status",
      header: t("employees.col.status"),
      cell: (row) => (
        <span className="inline-flex flex-wrap items-center gap-1">
          <StateTag group="employee" value={row.status} label={t(`employeeStatus.${row.status}`)} />
          <DemoTag show={row.isDemo} />
        </span>
      ),
    },
    { key: "branch", header: t("employees.col.branch"), cell: (row) => row.branch ?? <span className="text-ink-2">{t("employees.allBranches")}</span> },
    { key: "login", header: t("employees.col.lastLogin"), cell: (row) => <When at={row.lastLoginAt} /> },
  ];
  return (
    <>
      <PageHead
        title={t("employees.title")}
        lead={t("employees.lead")}
        actions={
          hire ? (
            <Key icon="plus" variant="ink" onClick={() => setAdding(true)}>
              {t("employees.add")}
            </Key>
          ) : null
        }
      />
      {handed ? (
        <div className="mb-5">
          <LinkOnce link={handed.link} name={handed.employee.name} employeeId={handed.employee.id} onDismiss={() => setHanded(null)} />
        </div>
      ) : null}
      <div className="stf-kpis mb-5">
        <Link to={href({ status: "active" })} className="adm-card content-start no-underline">
          <span className="type-caption text-ink-2">{t("employeeStatus.active")}</span>
          <span className="type-kpi nums">{f.number(page.counts.active)}</span>
        </Link>
        <Link to={href({ status: "disabled" })} className="adm-card content-start no-underline">
          <span className="type-caption text-ink-2">{t("employeeStatus.disabled")}</span>
          <span className="type-kpi nums">{f.number(page.counts.disabled)}</span>
        </Link>
        <Link to={href({ demo: "demo" })} className="adm-card content-start no-underline">
          <span className="type-caption text-ink-2">{t("employees.demoCount")}</span>
          <span className="type-kpi nums">{f.number(page.counts.demo)}</span>
        </Link>
      </div>

      <Section id="list" title={t("employees.list")} aside={<span className="type-caption text-ink-2">{t("common.countOf", { count: page.total })}</span>}>
        <div className="grid gap-3">
          <LinkChips
            label={t("employees.statusFilter")}
            items={[
              { value: "all", label: t("common.all"), href: href({ status: null }), selected: filters.status === null },
              { value: "active", label: t("employeeStatus.active"), href: href({ status: "active" }), selected: filters.status === "active" },
              { value: "disabled", label: t("employeeStatus.disabled"), href: href({ status: "disabled" }), selected: filters.status === "disabled" },
            ]}
          />
          <Form method="get" action="/admin/staff/employees" className="stf-filters stf-noprint">
            {filters.status ? <input type="hidden" name="status" value={filters.status} /> : null}
            <TextField name="q" type="search" label={t("employees.search")} defaultValue={filters.q} />
            <Select name="role" label={t("employees.col.roles")} defaultValue={filters.role ?? ""} options={[{ value: "", label: t("common.any") }, ...page.roles.map((role) => ({ value: role.id, label: role.name }))]} />
            <Select
              name="demo"
              label={t("employees.demoFilter")}
              defaultValue={filters.demo}
              options={[
                { value: "all", label: t("common.all") },
                { value: "real", label: t("employees.realOnly") },
                { value: "demo", label: t("employees.demoOnly") },
              ]}
            />
            <Select
              name="sort"
              label={t("common.sort")}
              defaultValue={filters.sort}
              options={[
                { value: "name", label: t("employees.sortName") },
                { value: "newest", label: t("employees.sortNewest") },
                { value: "last_login", label: t("employees.sortLogin") },
              ]}
            />
            {/* two tracks for the two keys: in one 11rem track their words were cut («ط…», "Clear fil…") */}
            <div className="flex flex-wrap items-end gap-2 md:col-span-2">
              <Key type="submit" size="sm" icon="funnel">
                {t("common.apply")}
              </Key>
              <Key as={Link} to="/admin/staff/employees" size="sm" variant="ghost">
                {t("common.clear")}
              </Key>
            </div>
          </Form>
          <ResponsiveTable
            caption={t("employees.list")}
            columns={columns}
            rows={page.rows}
            rowKey={(row) => row.id}
            empty={<EmptyState title={t("employees.empty")} text={t("employees.emptyHint")} icon="users" />}
            footer={<Pagination page={page.page} pageCount={page.pageCount} href={(n) => `/admin/staff/employees${employeeSearch(filters, n)}` || "?"} />}
            card={(row) => (
              <>
                <div className="flex items-start justify-between gap-2">
                  <Link to={`/admin/staff/employees/${row.id}`} className="adm-link type-strong">
                    {row.name}
                  </Link>
                  <StateTag group="employee" value={row.status} label={t(`employeeStatus.${row.status}`)} />
                </div>
                {row.jobTitle ? <Pair label={t("employees.col.jobTitle")}>{row.jobTitle}</Pair> : null}
                <Pair label={t("employees.col.roles")}>{row.roles.length ? row.roles.map((role) => role.name).join(sep) : t("employees.noRole")}</Pair>
                <Pair label={t("employees.col.lastLogin")}>
                  <When at={row.lastLoginAt} />
                </Pair>
                <DemoTag show={row.isDemo} />
              </>
            )}
          />
        </div>
      </Section>
      <Note>
        <p>
          {t("employees.addNote")}
          {layout?.access.manage ? (
            <>
              {" "}
              <Link to="/admin/security/roles" className="adm-link">
                {t("employees.roleEditor")}
              </Link>
            </>
          ) : null}
        </p>
      </Note>
      {hire && adding ? (
        <HireDialog
          hire={hire}
          onClose={closeAdding}
          onCreated={(answer) => {
            setHanded(answer);
            closeAdding();
          }}
        />
      ) : null}
    </>
  );
}

type HireAnswer = (ActionData & { ok: false }) | { ok: true; intent: string; message: string; employee: { id: string; name: string }; link: HandedLink };

/**
 * The form of a new employee, in a dialog: name, email, phone, job title, the roles (those this person may not give
 * shown but not offered), the branch (fixed for a branch-limited person) and the reason. Posts through a fetcher and
 * stays open while it runs; every field error comes back at once beside its field; on success the page shows the link.
 */
function HireDialog({ hire, onClose, onCreated }: { hire: HireOptions; onClose: () => void; onCreated: (answer: Handed) => void }) {
  const t = useStaffT();
  const fetcher = useFetcher<HireAnswer>();
  const handled = useRef<unknown>(undefined);
  const form = useRef<HTMLFormElement | null>(null);
  // one request at a time, even for a double press inside one frame: a second one would only meet email_taken, and the
  // first one's link — shown once — would be lost with the aborted answer
  const sending = useRef(false);
  const busy = fetcher.state !== "idle";
  useEffect(() => {
    if (fetcher.state === "idle") sending.current = false;
    const answer = fetcher.data;
    if (fetcher.state !== "idle" || !answer || handled.current === answer) return;
    handled.current = answer;
    if (answer.ok) {
      toast.success(answer.message);
      onCreated({ link: answer.link, employee: answer.employee });
      return;
    }
    // refused: the first field in error (or the first role of the roles group) takes the focus, so it is seen and heard
    requestAnimationFrame(() => form.current?.querySelector<HTMLElement>('[aria-invalid="true"], fieldset[data-invalid] input:not(:disabled)')?.focus());
  }, [fetcher.data, fetcher.state, onCreated]);
  const failure = fetcher.data && !fetcher.data.ok ? fetcher.data : null;
  const fields = failure?.fields ?? {};
  const someNotYours = hire.roles.some((role) => !role.assignable);
  return (
    <Dialog
      open
      onClose={onClose}
      title={t("hire.title")}
      description={t("hire.lead")}
      dismissible={!busy}
      scrimDismiss={false}
      onSubmit={(event) => {
        event.preventDefault();
        if (sending.current) return;
        sending.current = true;
        form.current = event.currentTarget;
        fetcher.submit(new FormData(event.currentTarget), { method: "post", action: "/admin/staff/employees" });
      }}
      footer={
        <>
          <Key onClick={onClose} disabled={busy} className="flex-1 sm:flex-none">
            {t("common.back")}
          </Key>
          <Key type="submit" variant="primary" loading={busy} className="flex-1 sm:flex-none">
            {t("hire.submit")}
          </Key>
        </>
      }
    >
      <div className="grid gap-4 pt-2">
        <input type="hidden" name="intent" value="create" />
        <TextField name="name" label={t("hire.name")} required minLength={2} maxLength={80} autoComplete="off" error={fields.name} />
        <TextField name="email" type="email" label={t("hire.email")} hint={t("hire.emailHint")} required maxLength={200} autoComplete="off" spellCheck={false} error={fields.email} />
        <TextField name="phone" type="tel" label={t("employee.phone")} hint={t("hire.phoneHint")} optional maxLength={30} autoComplete="off" error={fields.phone} />
        <TextField name="jobTitle" label={t("employees.col.jobTitle")} optional maxLength={80} error={fields.jobTitle} />
        <FieldGroup legend={t("employees.col.roles")} hint={t("hire.rolesHint")} required error={fields.roleIds}>
          {hire.roles.map((role) => (
            <Checkbox
              key={role.id}
              name="roleId"
              value={role.id}
              label={role.name}
              disabled={!role.assignable}
              hint={[role.description, role.twoStep ? t("hire.twoStep") : null, role.assignable ? null : t("hire.notYours")].filter(Boolean).join(" · ") || undefined}
            />
          ))}
        </FieldGroup>
        {someNotYours ? (
          <p className="flex items-start gap-1.5 type-caption text-ink-2">
            <Icon name="lock" size={14} className="mt-0.5 shrink-0" />
            <span>{t("hire.notYoursNote")}</span>
          </p>
        ) : null}
        {hire.branch ? (
          <div className="grid gap-1">
            <input type="hidden" name="branchId" value={hire.branch.id} />
            <Pair label={t("employees.col.branch")}>{hire.branch.name}</Pair>
            <p className="type-caption text-ink-2">{t("hire.ownBranch")}</p>
          </div>
        ) : hire.branches.length ? (
          <Select
            name="branchId"
            label={t("employees.col.branch")}
            hint={t("hire.branchHint")}
            defaultValue=""
            error={fields.branchId}
            options={[{ value: "", label: t("employees.allBranches") }, ...hire.branches.map((branch) => ({ value: branch.id, label: branch.name }))]}
          />
        ) : null}
        <TextField name="reason" label={t("common.reason")} hint={t("hire.reasonHint")} required minLength={3} maxLength={500} error={fields.reason} />
        {failure ? (
          <p role="alert" className="flex items-start gap-1 type-label text-red-ink">
            <Icon name="warning-circle" size={16} className="mt-0.5 flex-none" />
            <span>{failure.fields && Object.keys(failure.fields).length ? t("common.checkFields") : (failure.message ?? t("common.checkFields"))}</span>
          </p>
        ) : null}
      </div>
    </Dialog>
  );
}
