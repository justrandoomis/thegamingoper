/**
 * The codes page's action (/admin/devices/digital/:variantId): import (encrypted), reveal (audited, rate-limited,
 * never for an unpaid order), revoke. Each intent checks its permission at the route first, then in its service.
 *
 *   import   importCodes   devices.digital_code.manage (a unit cost only with cost.read)
 *   reveal   revealCode    devices.digital_code.manage + digital_code.reveal
 *   revoke   revokeCode    devices.digital_code.manage
 */
import { canAll } from "~/server/actor";
import type { AuthCtx, EmployeeSession } from "~/server/auth/admin.server";
import type { Db } from "~/server/db/drizzle.server";
import { forbidden } from "~/server/errors";
import type { Permission } from "~/server/permissions";
import { importCodes, revealCode, revokeCode } from "~/server/services/admin/devices/codes.server";
import { failure, text, type Failure } from "./devices.server";

export const CODE_INTENTS = ["import", "reveal", "revoke"] as const;
export type CodeIntent = (typeof CODE_INTENTS)[number];

const NEEDS: Record<CodeIntent, readonly Permission[]> = {
  import: ["devices.digital_code.manage"],
  reveal: ["devices.digital_code.manage", "digital_code.reveal"],
  revoke: ["devices.digital_code.manage"],
};

export type CodeActionResult = { ok: true; intent: CodeIntent; replayed?: boolean; added?: number; duplicates?: number; code?: string; codeId?: string } | Failure;

export async function codesAction(ctx: Pick<AuthCtx, "locale" | "now">, db: Db, session: EmployeeSession, variantId: string, form: FormData, dataKey: string | undefined, options: { demo: boolean }): Promise<CodeActionResult> {
  const raw = text(form, "intent");
  const intent = (CODE_INTENTS as readonly string[]).includes(raw) ? (raw as CodeIntent) : null;
  const { actor } = session;
  try {
    if (!intent) return { ok: false, intent: null, code: "invalid", status: 400 };
    if (!canAll(actor, NEEDS[intent])) throw forbidden(NEEDS[intent].find((permission) => !canAll(actor, [permission])));
    switch (intent) {
      case "import": {
        const cost = text(form, "unitCostIqd");
        const result = await importCodes(db, actor, dataKey, { variantId, codes: String(form.get("codes") ?? ""), expiresOn: text(form, "expiresOn"), ...(cost ? { unitCostIqd: cost } : {}) }, ctx.now, { demo: options.demo });
        return { ok: true, intent, added: result.added, duplicates: result.duplicates };
      }
      case "reveal": {
        const codeId = text(form, "codeId");
        const result = await revealCode(db, actor, dataKey, { codeId, variantId, reason: text(form, "reason") }, ctx.now);
        return { ok: true, intent, code: result.code, codeId };
      }
      case "revoke": {
        const result = await revokeCode(db, actor, { codeId: text(form, "codeId"), variantId, reason: text(form, "reason") }, ctx.now);
        return { ok: true, intent, replayed: result.replayed };
      }
    }
  } catch (error) {
    return failure(error, ctx.locale, intent);
  }
}
