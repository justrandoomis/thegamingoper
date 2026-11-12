import { Form, Link, redirect, useActionData, useNavigation } from "react-router";

import type { Route } from "./+types/branch-new";
import { branchFormOptions, createBranch } from "~/server/services/admin/channels/branches.server";
import { Key } from "~/ui/Key";
import { BranchFields, EMPTY_BRANCH, branchValuesFrom, type BranchValues } from "./components/BranchFields";
import { FormError, Note, PageHead, Section, failureText, useChT } from "./components/ui";
import { ch, newKey, text } from "./kit.server";
import { chMeta } from "./meta";

/**
 * /admin/channels/branches/new — 21.01: add a branch (channels.branch.manage, an employee without a branch limit). The
 * form's key makes a resubmission name the same branch; a code is used once (code_taken).
 */
export async function loader(args: Route.LoaderArgs) {
  const req = await ch.open(args, "channels.branch.manage");
  if (req.actor.branchId) throw new Response(null, { status: 403 });
  return { options: await branchFormOptions(req.db, req.locale), key: newKey() };
}

export async function action(args: Route.ActionArgs) {
  const req = await ch.open(args, "channels.branch.manage");
  const form = await ch.form(args.request).catch(() => new FormData());
  try {
    const values = branchValuesFrom(form);
    const result = await createBranch(req.db, req.actor, { ...values, reason: text(form, "reason") || undefined, idempotencyKey: text(form, "key") }, req.now);
    return redirect(`/admin/channels/branches/${result.branchId}?saved=${result.replayed ? "again" : "created"}`);
  } catch (error) {
    return ch.failed(error, req, "create", { values: branchValuesFrom(form) });
  }
}

export const meta: Route.MetaFunction = (args) => chMeta(args, "branchNew.title");

export default function NewBranchPage({ loaderData }: Route.ComponentProps) {
  const t = useChT();
  const result = useActionData<typeof action>();
  const navigation = useNavigation();
  const busy = navigation.state !== "idle" && navigation.formMethod?.toLowerCase() === "post";
  const failure = result && !result.ok ? (result.fields ? t("common.checkFields") : failureText(t, result)) : null;
  const values: BranchValues = (result && "values" in result ? (result.values as BranchValues) : null) ?? EMPTY_BRANCH;
  return (
    <div className="adm-narrow">
      <PageHead
        eyebrow={
          <Link to="/admin/channels/branches" className="adm-link">
            {t("branchNew.back")}
          </Link>
        }
        title={t("branchNew.title")}
        lead={t("branchNew.lead")}
      />
      <Form method="post" className="grid gap-5" noValidate>
        <input type="hidden" name="key" value={loaderData.key} />
        <Section id="ch-branch-fields" title={t("branchNew.details")}>
          <BranchFields values={values} options={loaderData.options} errors={(result && !result.ok ? result.fields : undefined) ?? {}} />
        </Section>
        <Note>
          <p>{t("branchNew.note")}</p>
        </Note>
        <FormError message={failure} />
        <div className="ch-actions">
          <Key type="submit" variant="ink" icon="plus" loading={busy}>
            {t("branchNew.submit")}
          </Key>
          <Key as={Link} to="/admin/channels/branches">
            {t("common.back")}
          </Key>
        </div>
      </Form>
    </div>
  );
}
