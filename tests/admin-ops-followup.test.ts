/**
 * Admin module 23 "ops" — module follow-up (2026-11-12). Each test failed on the code before the follow-up:
 *
 *   · two "run now" clicks with different form keys (two tabs, two people) both passed the "is it running?" check
 *     made before the claim, and both started the job. The check now runs INSIDE the claim's batch and also counts a
 *     claim whose run has not finished (it may not have started yet)
 *   · a wallet finding (wallet.negative_balance) hid its amount from readers without a wallet permission but still
 *     named the customer — who has a wallet problem is wallet information
 */
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { newId } from "~/lib/ids";
import type { EmployeeActor } from "~/server/actor";
import { auditRow } from "~/server/audit.server";
import { seedRoles } from "~/server/auth/seed-roles";
import { auditEvents, consistencyFindings, employeeRoles, jobRuns, rolePermissions, roles } from "~/server/db/schema";
import { toAppError } from "~/server/errors";
import type { Permission } from "~/server/permissions";
import { getFinding, listFindings } from "~/server/services/admin/ops/consistency.server";
import { RUN_JOB_ACTION, runJobNow } from "~/server/services/admin/ops/job-monitor.server";
import { HOUR_MS, MINUTE_MS, parseFindingFilters } from "~/server/services/admin/ops/types";
import { TEST_NOW, createTestDb, type TestDb } from "./helpers/db";
import { fixtures, type Fixtures } from "./helpers/factories";

const NOW = TEST_NOW;
let t: TestDb;
let make: Fixtures;

beforeAll(async () => {
  t = await createTestDb();
  make = fixtures(t.db, NOW);
  await seedRoles(t.db, NOW);
}, 120_000);
afterAll(async () => {
  await t?.dispose();
});

async function person(permissions: Permission[], name: string): Promise<EmployeeActor> {
  const id = await make.employee({ name });
  const custom = `role_${make.next("opsfu").replace(/-/g, "_")}`;
  await t.db.insert(roles).values({ id: custom, key: custom.slice(5), name: { ar: "دور اختبار", en: "Test role" }, isSystem: false, createdAt: NOW });
  await t.db.insert(rolePermissions).values(permissions.map((permission) => ({ roleId: custom, permission })));
  await t.db.insert(employeeRoles).values({ employeeId: id, roleId: custom });
  return { kind: "employee", id, permissions: new Set<string>(permissions), label: name };
}
const key = () => `${make.next("key")}-0123456789abcdef`;
const eqJob = (job: string) => eq(jobRuns.job, job);

describe("admin 23 ops — follow-up", () => {
  test("run now: a claim by someone else whose run has not finished keeps a second run from starting", async () => {
    const first = await person(["ops.job.read", "ops.job.run"], "first");
    const second = await person(["ops.job.read", "ops.job.run"], "second");
    const at = NOW + 2 * HOUR_MS;
    // the first click claimed the job (its audit event) and its run has not been written yet
    await t.db.insert(auditEvents).values(auditRow({ id: `aud_job_${newId("x").slice(-20)}`, actor: first, action: RUN_JOB_ACTION, entityType: "job", entityId: "audit.seal", summary: "audit.seal run by hand", after: { job: "audit.seal", origin: "manual" }, reason: "seal before the audit", at }));
    const refused = await runJobNow(t.db, second, { job: "audit.seal", reason: "seal now please", idempotencyKey: key() }, at + 1_000).catch((error: unknown) => toAppError(error)?.code);
    expect(refused).toBe("job_running");
    expect(await t.db.select().from(jobRuns).where(eqJob("audit.seal"))).toHaveLength(0);
    // once that run finished, the job may run again
    await t.db.insert(jobRuns).values({ id: newId("job"), job: "audit.seal", status: "succeeded", origin: "manual", startedAt: at, finishedAt: at + 10, durationMs: 10, stats: {}, triggeredBy: first.id } as never);
    const ran = await runJobNow(t.db, second, { job: "audit.seal", reason: "seal now please", idempotencyKey: key() }, at + 2 * MINUTE_MS);
    expect(ran.replayed).toBe(false);
    expect(ran.status).not.toBeNull();
  });

  test("a wallet finding names its customer only to someone with a wallet permission", async () => {
    const reader = await person(["ops.consistency.read"], "reader");
    const walletReader = await person(["ops.consistency.read", "customers.wallet.read"], "wallet reader");
    const customerId = await make.customer({ name: "Wallet Followup Customer" });
    const id = newId("cfd");
    await t.db.insert(consistencyFindings).values({ id, fingerprint: `wallet.negative_balance|customer|${customerId}`, checkKey: "wallet.negative_balance", severity: "critical", entityType: "customer", entityId: customerId, message: "Wallet balance is negative (-1000 IQD).", details: { balanceIqd: -1_000 }, status: "open", detectedAt: NOW - HOUR_MS, lastSeenAt: NOW - HOUR_MS });
    const page = await listFindings(t.db, reader, parseFindingFilters(new URLSearchParams("view=all&check=wallet.negative_balance")));
    const json = JSON.stringify([page, await getFinding(t.db, reader, id)]);
    expect(json).not.toContain("Wallet Followup Customer");
    expect(page.rows.find((row) => row.id === id)?.entity).toMatchObject({ id: customerId, label: customerId });
    expect((await getFinding(t.db, walletReader, id)).finding.entity.label).toBe("Wallet Followup Customer");
  });
});

