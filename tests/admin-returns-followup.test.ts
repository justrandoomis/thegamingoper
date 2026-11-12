/**
 * Admin module 12 "returns" — module follow-up (2026-11-12). Each test failed on the code before the follow-up:
 *
 *   · "{days} يوماً" is Arabic for 11–99 days only. Since the service targets became settings (returns.sla, 1–365
 *     days) the warranties-ending card, the quarantine lead and the repeat-returner signal said «خلال 7 يوماً»; the
 *     general return window said «7 يوم». A span of days is now a plural message of its own (withinDays,
 *     policies.days), so the noun agrees with the number: «خلال 7 أيام», «خلال 30 يوماً», «خلال 100 يوم».
 */
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import messages from "~/i18n/messages/admin-returns";
import { translate, type MessageTree } from "~/i18n/translate";
import type { EmployeeActor } from "~/server/actor";
import { createDb } from "~/server/db/drizzle.server";
import { defaultRolePermissions } from "~/server/permissions";
import { queueCounts } from "~/server/services/admin/returns/rma.server";
import { TEST_NOW, createTestDb, type TestDb } from "./helpers/db";

let t: TestDb;
beforeAll(async () => {
  t = await createTestDb();
});
afterAll(async () => {
  await t?.dispose();
});

/** A D1 binding that counts the statements prepared through it. */
function countingD1(real: D1Database): { d1: D1Database; prepared: () => number } {
  let n = 0;
  const d1 = { prepare: (sql: string) => (n++, real.prepare(sql)), batch: (statements: D1PreparedStatement[]) => real.batch(statements), exec: (sql: string) => real.exec(sql) };
  return { d1: d1 as unknown as D1Database, prepared: () => n };
}

/** Every Arabic text of the namespace (a plural message: each of its forms), with its key. */
function texts(tree: MessageTree, prefix = ""): [string, string][] {
  const out: [string, string][] = [];
  for (const [key, value] of Object.entries(tree)) {
    const at = prefix ? `${prefix}.${key}` : key;
    if (typeof value === "string") out.push([at, value]);
    else if (value && typeof value === "object") out.push(...texts(value as MessageTree, at));
  }
  return out;
}

describe("admin 12 returns — follow-up: the bell's two counts", () => {
  test("queueCounts asked for the bell's counts reads those two and nothing else (the shell used to pay for eight and the SLA)", async () => {
    const owner: EmployeeActor = { kind: "employee", id: "emp_returns_followup_owner", permissions: defaultRolePermissions("owner") };
    const full = await queueCounts(t.db, owner, TEST_NOW);
    const recording = countingD1(t.d1);
    const two = await queueCounts(createDb(recording.d1), owner, TEST_NOW, { only: ["decide", "inspect"] });
    expect(recording.prepared()).toBe(2);
    expect(two).toEqual({ decide: full.decide, receive: null, inspect: full.inspect, refund: null, refundApproval: null, quarantine: null, repairsLate: null, warrantiesEnding: null });
    // without `only`: every count, as before
    const all = countingD1(t.d1);
    expect(await queueCounts(createDb(all.d1), owner, TEST_NOW)).toEqual(full);
    expect(all.prepared()).toBe(9);
  });
});

describe("admin 12 returns — follow-up: a number of days in Arabic", () => {
  test("no Arabic text puts a counted noun after a number it cannot agree with (only {count} selects a plural form)", () => {
    const wrong = texts(messages.ar as MessageTree).filter(([, text]) => /\{(?!count\})\w+\}\s?(يوماً|يومًا|أيام|يوم(?![ا-ي]))/.test(text));
    expect(wrong.map(([key]) => key)).toEqual([]);
  });

  test("the spans read right for 1, 2, 3–10, 11–99 and 100 days, in every language", () => {
    const within = (count: number, locale: "ar" | "en" | "ckb" = "ar") => translate(messages[locale] as MessageTree, locale, "withinDays", { count }) ?? "";
    expect([1, 2, 3, 7, 10, 11, 30, 99, 100].map((n) => within(n))).toEqual([
      "خلال يوم واحد",
      "خلال يومين",
      "خلال 3 أيام",
      "خلال 7 أيام",
      "خلال 10 أيام",
      "خلال 11 يوماً",
      "خلال 30 يوماً",
      "خلال 99 يوماً",
      "خلال 100 يوم",
    ]);
    expect(within(1, "en")).toBe("within 1 day");
    expect(within(7, "en")).toBe("within 7 days");
    const ar = messages.ar as MessageTree;
    expect(translate(ar, "ar", "queues.warrantiesEnding.none", { count: 0, days: 7, within: within(7) })).toBe("لا ضمان ينتهي خلال 7 أيام.");
    expect(translate(ar, "ar", "queues.warrantiesEnding.some", { count: 3, days: 7, within: within(7) })).toBe("3 ضمانات خلال 7 أيام");
    expect(translate(ar, "ar", "quarantine.lead", { within: within(5) })).toMatch(/الهدف قرار خلال 5 أيام\.$/);
    expect(translate(ar, "ar", "fraud.rules.repeat_returner.why", { count: 3, days: 90, within: within(90) })).toBe("فتح هذا الرقم أو العميل 3 طلبات إرجاع خلال 90 يوماً.");
    expect(translate(ar, "ar", "policies.window", { span: translate(ar, "ar", "policies.days", { count: 7 }) as string })).toBe("مدة الإرجاع العامة: 7 أيام من التسليم");
  });
});
