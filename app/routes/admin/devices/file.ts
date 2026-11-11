import type { Route } from "./+types/file";
import { devicesFile } from "~/server/services/admin/devices/files.server";
import { DEVICES_PERMISSIONS } from "~/server/services/admin/devices/shared.server";
import { fileResponse, getFile } from "~/server/storage.server";
import { openDevices } from "./devices.server";
import { devicesBlobStore } from "./env.server";

/**
 * GET /admin/devices/files/:fileId — a PRIVATE photo of the module: a trade-in's photos (the shopper's and the
 * inspector's) for trade-in staff, a used unit's photos for used-unit staff. `private, no-store`, sandboxed
 * (fileResponse). Anything else — another module's file, a public file, an unknown id — is the same 404.
 */
const notFound = () => new Response("Not found", { status: 404, headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" } });

export async function loader({ params, request, context }: Route.LoaderArgs) {
  const { db, actor } = await openDevices(context, DEVICES_PERMISSIONS);
  const file = await devicesFile(db, actor, params.fileId);
  if (!file) return notFound();
  const stored = await getFile(db, devicesBlobStore(), file.id);
  if (!stored || stored.record.visibility !== "private") return notFound();
  return fileResponse({ mime: stored.record.mime, sha256: stored.record.sha256, visibility: "private" }, stored.bytes, request);
}
