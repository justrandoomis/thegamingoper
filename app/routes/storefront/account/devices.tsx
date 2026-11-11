import { useEffect, useRef } from "react";
import { data, useFetcher } from "react-router";

import type { Route } from "./+types/devices";
import { useT } from "~/i18n/react";
import { MotionLink, type MotionHandle } from "~/motion";
import { getCtx } from "~/server/context.server";
import { getDb } from "~/server/db.server";
import { listDeviceOptions, listSavedDevices, setSavedDevice } from "~/server/services/account/saved-devices.server";
import type { DeviceOption } from "~/server/services/account/types";
import { announce } from "~/ui/cart-client";
import { Key } from "~/ui/Key";
import { Niche } from "~/ui/Niche";
import { BidiText, ProductImage } from "~/ui/ProductCard";
import { isPlatform, PlatformLabel } from "~/ui/PlatformLed";
import { toast } from "~/ui/toast-store";
import { accountFailure, formFields, requireSignedIn } from "./account.server";
import { sectionOrder } from "./components/AccountNav";
import { PageHead, Section } from "./components/PageHead";
import { accountMeta } from "./components/meta";

/**
 * Saved devices (brief §3.10, §6): the models the customer owns, picked from the store's device list. The
 * recommendation service will read them (listSavedDeviceIds) once the integration pass wires it; until then the page
 * says only what it does today — keep the devices and link to their hubs.
 */
export const handle = { nav: "push", order: sectionOrder("devices") } satisfies MotionHandle;

export async function loader({ request, context }: Route.LoaderArgs) {
  const ctx = getCtx(context);
  const db = getDb();
  const { customer } = await requireSignedIn(request, ctx, db);
  const [options, saved] = await Promise.all([listDeviceOptions(db, ctx.locale), listSavedDevices(db, customer.id, ctx.locale)]);
  return { options, savedIds: saved.map((device) => device.id) };
}

export async function action({ request, context }: Route.ActionArgs) {
  const ctx = getCtx(context);
  const db = getDb();
  const { actor } = await requireSignedIn(request, ctx, db);
  const fields = formFields(await request.formData());
  try {
    const result = await setSavedDevice(db, actor, fields.deviceModelId ?? "", fields.saved === "1", ctx.now);
    return data({ ok: true as const, saved: result.saved, deviceModelId: fields.deviceModelId ?? "" });
  } catch (error) {
    const failure = accountFailure(error, ctx.locale);
    return data({ ...failure, deviceModelId: fields.deviceModelId ?? "" }, { status: failure.status });
  }
}

export const meta: Route.MetaFunction = (args) => accountMeta(args, "devices");

export default function Devices({ loaderData }: Route.ComponentProps) {
  const t = useT("account");
  const saved = new Set(loaderData.savedIds);
  const mine = loaderData.savedIds.map((id) => loaderData.options.find((option) => option.id === id)).filter((option): option is DeviceOption => option !== undefined);
  const platforms = groupByPlatform(loaderData.options);

  return (
    <>
      <PageHead title={t("devices.title")} lead={t("devices.lead")} />
      <Section id="mine" title={t("devices.savedTitle")}>
        {mine.length === 0 ? (
          <p className="rounded-lg bg-niche p-4 type-body text-ink-2">
            <span className="type-sub text-ink">{t("devices.savedEmpty")}</span> {t("devices.savedEmptyText")}
          </p>
        ) : (
          <ul className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-4">
            {mine.map((device) => (
              <li key={device.id}>
                <DeviceTile device={device} saved />
              </li>
            ))}
          </ul>
        )}
      </Section>
      <Section id="pick" title={t("devices.pickTitle")}>
        <div className="grid gap-6">
          {platforms.map((group) => (
            <section key={group.slug} aria-labelledby={`platform-${group.slug}`} className="grid gap-3">
              <h3 id={`platform-${group.slug}`} className="type-label font-semibold text-ink">
                {isPlatform(group.slug) ? <PlatformLabel platform={group.slug} /> : <BidiText text={group.name} />}
              </h3>
              <ul className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-4">
                {group.devices.map((device) => (
                  <li key={device.id}>
                    <DeviceTile device={device} saved={saved.has(device.id)} />
                  </li>
                ))}
              </ul>
            </section>
          ))}
        </div>
      </Section>
    </>
  );
}

function groupByPlatform(options: DeviceOption[]): { slug: string; name: string; devices: DeviceOption[] }[] {
  const groups = new Map<string, { slug: string; name: string; devices: DeviceOption[] }>();
  for (const option of options) {
    const group = groups.get(option.platformSlug) ?? { slug: option.platformSlug, name: option.platformName, devices: [] };
    group.devices.push(option);
    groups.set(option.platformSlug, group);
  }
  return [...groups.values()];
}

/** One device: its photo, its name, a link to its hub, and a key that stays down while it is saved. */
function DeviceTile({ device, saved }: { device: DeviceOption; saved: boolean }) {
  const t = useT("account");
  const fetcher = useFetcher<typeof action>();
  const handled = useRef<unknown>(null);
  // Optimistic: the key shows the requested state while the request is out; a failure puts it back and says why.
  const wanted = fetcher.formData ? fetcher.formData.get("saved") === "1" : null;
  const answer = fetcher.data as ({ ok: true; saved: boolean } | { ok: false; message?: string }) | undefined;
  const current = wanted ?? (answer?.ok ? answer.saved : saved);

  // Success is the key staying down (or coming up) — said aloud when pressed. A refusal does not reload the page, so
  // this tile is still here to say why.
  useEffect(() => {
    if (fetcher.state !== "idle" || !answer || handled.current === answer) return;
    handled.current = answer;
    if (!answer.ok) toast.error(answer.message ?? t("common.formError"));
  }, [fetcher.state, answer, t]);

  return (
    <article className="grid h-full content-start gap-2 rounded-lg bg-paper p-3">
      <div className="grid grid-cols-[3.5rem_minmax(0,1fr)] items-center gap-2 sm:grid-cols-[4.5rem_minmax(0,1fr)] sm:gap-3">
        <Niche as="span" ratio="1/1" tagZone={false} className="rounded-md" aria-hidden="true">
          {device.artKey ? <ProductImage image={{ artKey: device.artKey, mediaKey: null, alt: "", isIllustration: true }} alt="" sizes="72px" pose={0} shadow={false} /> : null}
        </Niche>
        <div className="grid min-w-0 gap-1">
          {/* The name leads to everything about the device (its hub). */}
          <h4 className="type-strong text-ink">
            <MotionLink nav="push" to={`/device/${device.slug}`} className="underline-offset-4 hover:underline" aria-label={t("devices.hub", { name: device.name })}>
              <BidiText text={device.name} />
            </MotionLink>
          </h4>
          {isPlatform(device.platformSlug) ? (
            <PlatformLabel platform={device.platformSlug} className="type-caption text-ink-2" />
          ) : (
            <span className="type-caption text-ink-2">
              <BidiText text={device.platformName} />
            </span>
          )}
        </div>
      </div>
      <fetcher.Form method="post" onSubmit={() => announce(t(current ? "devices.removed" : "devices.added", { name: device.name }))}>
        <input type="hidden" name="deviceModelId" value={device.id} />
        <input type="hidden" name="saved" value={current ? "0" : "1"} />
        {/* a toggle: one name, its state in aria-pressed (held) */}
        <Key type="submit" size="sm" block held={current} icon={current ? "check" : "plus"} aria-label={t("devices.ownNamed", { name: device.name })}>
          {t("devices.own")}
        </Key>
      </fetcher.Form>
    </article>
  );
}
