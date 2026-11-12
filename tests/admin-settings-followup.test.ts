/**
 * Admin module 22 "settings" — module follow-up (2026-11-12). Each test failed on the code before the follow-up:
 *
 *   · the support module queues every written ticket reply as `support_reply`, but no template of that name was
 *     registered: its text could not be written in ar/en/ckb like every other message
 *   · the policies page said "approved in the content module" for shipping, payment, privacy and terms without a way
 *     there: each now links to /admin/cms/pages/<slug> for whoever may open it
 *   · a new draft of an approved returns or warranty policy could only start from the code's text, redoing every
 *     edit — the editor promised «or from the approved text» (module 17 had the same gap, fixed in its review)
 *   · numbered lines typed with Persian digits ("۱. ...") were read as paragraphs
 */
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import messages from "~/i18n/messages/admin-settings";
import type { EmployeeActor } from "~/server/actor";
import { seedRoles } from "~/server/auth/seed-roles";
import { employeeRoles } from "~/server/db/schema";
import { toAppError } from "~/server/errors";
import { defaultRolePermissions, roleId, type DefaultRoleKey } from "~/server/permissions";
import { TEMPLATE_CATALOG } from "~/server/services/admin/settings/catalog";
import { getPolicyEditor, policiesView, publishPolicy, savePolicyDraft, startPolicyDraft } from "~/server/services/admin/settings/policies.server";
import { textToBlocks } from "~/server/services/admin/settings/policy-text";
import { getTemplate, saveTemplate } from "~/server/services/admin/settings/templates.server";
import { TEST_NOW, createTestDb, type TestDb } from "./helpers/db";
import { fixtures, type Fixtures } from "./helpers/factories";

const NOW = TEST_NOW;
let t: TestDb;
let make: Fixtures;
const people: Partial<Record<DefaultRoleKey | "owner2", EmployeeActor>> = {};

beforeAll(async () => {
  t = await createTestDb();
  make = fixtures(t.db, NOW);
  await seedRoles(t.db, NOW);
  for (const role of ["owner", "manager", "content", "finance"] as const) people[role] = await person(role);
}, 90_000);
afterAll(async () => {
  await t?.dispose();
});

async function person(role: DefaultRoleKey): Promise<EmployeeActor> {
  const id = await make.employee({ name: role });
  await t.db.insert(employeeRoles).values({ employeeId: id, roleId: roleId(role) });
  return { kind: "employee", id, permissions: role === "owner" ? new Set<string>(["*"]) : defaultRolePermissions(role), label: role };
}
const as = (key: keyof typeof people): EmployeeActor => {
  const actor = people[key];
  if (!actor) throw new Error(`no ${key}`);
  return actor;
};
const code = async (run: () => Promise<unknown>) => {
  try {
    await run();
  } catch (error) {
    return toAppError(error)?.code ?? "unexpected";
  }
  return "no error";
};

describe("admin 22 settings — follow-up", () => {
  test("support_reply is a template like the others: its words in three languages, its variables, its reply kept", async () => {
    const entry = TEMPLATE_CATALOG.find((item) => item.key === "support_reply");
    expect(entry).toMatchObject({ variables: ["ticketRef", "body"], required: ["body"] });
    for (const locale of ["ar", "en", "ckb"] as const) expect((messages[locale].template as Record<string, string>).support_reply).toBeTruthy();
    expect(await code(() => saveTemplate(t.db, as("manager"), { key: "support_reply", locale: "ar", body: "طمطم بخصوص تذكرتك {ticketRef}", isActive: true, version: null }, NOW))).toBe("template_variable_missing");
    expect(await saveTemplate(t.db, as("manager"), { key: "support_reply", locale: "ar", body: "طمطم — تذكرتك {ticketRef}:\n{body}", isActive: true, version: null, reason: "نص الرد" }, NOW)).toEqual({ created: true });
    expect((await getTemplate(t.db, as("manager"), "support_reply", NOW)).texts.ar?.body).toContain("{body}");
  });

  test("a policy the content module approves links to its page there — for whoever may open that page", async () => {
    const forContent = await policiesView(t.db, as("manager"), "ar", NOW);
    expect(forContent.policies.find((policy) => policy.slug === "privacy")?.contentHref).toBe("/admin/cms/pages/privacy");
    expect(forContent.policies.find((policy) => policy.slug === "returns")?.contentHref).toBeNull();
    // someone who reads settings but cannot open the content module's pages
    const reader: EmployeeActor = { kind: "employee", id: as("finance").id, permissions: new Set(["settings.read"]), label: "reader" };
    const forFinance = await policiesView(t.db, reader, "ar", NOW);
    expect(forFinance.policies.find((policy) => policy.slug === "privacy")?.contentHref).toBeNull();
  });

  test("a new draft of an approved policy can start from the approved text", async () => {
    expect(await code(() => startPolicyDraft(t.db, as("manager"), { slug: "warranty", reason: "من المعتمد", version: null, from: "approved" }, NOW, "demo"))).toBe("policy_no_approved");
    await startPolicyDraft(t.db, as("manager"), { slug: "warranty", reason: "بداية", version: null }, NOW, "demo");
    let editor = await getPolicyEditor(t.db, as("manager"), "warranty", "ar", NOW, "demo");
    await savePolicyDraft(t.db, as("manager"), { slug: "warranty", version: editor.version, textAr: "## ضمان المتجر\nنص عدّله المالك بعناية." }, NOW + 1);
    await publishPolicy(t.db, as("owner"), { slug: "warranty", version: NOW + 1, reason: "اعتمدها المالك" }, NOW + 2);
    editor = await getPolicyEditor(t.db, as("manager"), "warranty", "ar", NOW + 3, "demo");
    expect(editor.fromApproved).toBe(true);
    expect(await startPolicyDraft(t.db, as("manager"), { slug: "warranty", reason: "تعديل صغير", version: editor.version, from: "approved" }, NOW + 4, "demo")).toEqual({ created: false });
    editor = await getPolicyEditor(t.db, as("manager"), "warranty", "ar", NOW + 5, "demo");
    expect(editor.text.ar).toContain("نص عدّله المالك بعناية.");
  });

  test("numbered lines in Persian digits are a numbered list, as in Latin or Arabic-Indic digits", () => {
    const list = { type: "ol", items: ["أ", "ب"] };
    expect(textToBlocks("1. أ\n2. ب")).toEqual([list]);
    expect(textToBlocks("١. أ\n٢. ب")).toEqual([list]);
    expect(textToBlocks("۱. أ\n۲. ب")).toEqual([list]);
  });
});
