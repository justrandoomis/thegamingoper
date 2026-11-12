import { useEffect, useRef } from "react";
import { data, useFetcher } from "react-router";

import type { Route } from "./+types/devices";
import { Icon } from "~/art/Icon";
import { useT } from "~/i18n/react";
import { MotionLink, type MotionHandle } from "~/motion";
import { getCtx } from "~/server/context.server";
import { getDb } from "~/server/db.server";
import { listDeviceOptions, listSavedDevices, setSavedDevice } from "~/server/services/account/saved-devices.server";
import type { DeviceOption } from "~/server/services/account/types";
import { BidiText } from "~/ui/BidiText";
import { announce } from "~/ui/cart-client";
import { Chip } from "~/ui/Chip";
import { EmptyState } from "~/ui/EmptyState";
import { Key } from "~/ui/Key";
import { Niche } from "~/ui/Niche";
import { useOnline } from "~/ui/OfflineBanner";
import { isPlatform, PlatformLabel } from "~/ui/PlatformLed";
import { ProductImage } from "~/ui/ProductCard";
import { toast } from "~/ui/toast-store";
import { accountFailure, formFields, requireSignedIn } from "./account.server";
import { sectionOrder } from "./components/AccountNav";
import { PageHead, Section } from "./components/PageHead";
import { OfflineNote } from "./components/FormBits";
import { accountMeta } from "./components/meta";

/**
 * Saved devices (brief §3.10, §6): the models the customer owns, picked from the store's device list, each linking to
 * its hub. With personalization consent the devices area's engine reads them (saved_devices) as anchors of the
 * customer's personal shelf on home and search ("verified to work with" — never inferred); the page says exactly that.
 * «أملكه» is a chip (a state, never an action): aria-pressed, the check, saved at once.
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
          <EmptyState icon="game-controller" title={t("devices.savedEmpty")} text={t("devices.savedEmptyText")} />
        ) : (
          <ul className="acct-rows acct-narrow">
            {mine.map((device) => (
              <li key={device.id}>
                <MotionLink nav="push" to={`/device/${device.slug}`} className="acct-row" data-press="soft" aria-label={t("devices.hub", { name: device.name })}>
                  <DeviceWell device={device} />
                  <span className="acct-row__body">
                    <span className="acct-row__title">
                      <BidiText text={device.name} />
                    </span>
                    <DevicePlatform device={device} />
                  </span>
                  <Icon name="caret-right" size={20} className="acct-row__chev" />
                </MotionLink>
              </li>
            ))}
          </ul>
        )}
      </Section>
      <Section id="pick" title={t("devices.pickTitle")} reason={t("devices.pickReason")}>
        <div className="grid gap-6">
          <OfflineNote />
          {platforms.map((group) => (
            <section key={group.slug} aria-labelledby={`platform-${group.slug}`} className="grid gap-2">
              <h3 id={`platform-${group.slug}`} className="type-sm-strong text-ink">
                {isPlatform(group.slug) ? <PlatformLabel platform={group.slug} /> : <BidiText text={group.name} />}
              </h3>
              <ul className="acct-rows acct-narrow">
                {group.devices.map((device) => (
                  <li key={device.id}>
                    <DeviceRow device={device} saved={saved.has(device.id)} />
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

function DeviceWell({ device }: { device: DeviceOption }) {
  return (
    <Niche as="span" size="sm" aria-hidden="true">
      {device.artKey ? <ProductImage image={{ artKey: device.artKey, mediaKey: null, alt: "", isIllustration: true }} alt="" sizes="56px" /> : null}
    </Niche>
  );
}

function DevicePlatform({ device }: { device: DeviceOption }) {
  return isPlatform(device.platformSlug) ? (
    <PlatformLabel platform={device.platformSlug} className="acct-row__meta" />
  ) : (
    <span className="acct-row__meta">
      <BidiText text={device.platformName} />
    </span>
  );
}

/** One device to pick: its photo, its name (a link to everything about it) and the «أملكه» chip, saved at once. */
function DeviceRow({ device, saved }: { device: DeviceOption; saved: boolean }) {
  const t = useT("account");
  const online = useOnline();
  const fetcher = useFetcher<typeof action>();
  const handled = useRef<unknown>(null);
  // Optimistic: the chip shows the requested state while the request is out; a refusal puts it back and says why.
  const wanted = fetcher.formData ? fetcher.formData.get("saved") === "1" : null;
  const answer = fetcher.data as ({ ok: true; saved: boolean } | { ok: false; message?: string }) | undefined;
  const current = wanted ?? (answer?.ok ? answer.saved : saved);

  useEffect(() => {
    if (fetcher.state !== "idle" || !answer || handled.current === answer) return;
    handled.current = answer;
    if (!answer.ok) toast.error(answer.message ?? t("common.formError"));
  }, [fetcher.state, answer, t]);

  const toggle = () => {
    const next = !current;
    announce(t(next ? "devices.added" : "devices.removed", { name: device.name }));
    fetcher.submit({ deviceModelId: device.id, saved: next ? "1" : "0" }, { method: "post" });
  };

  return (
    <div className="acct-row">
      <DeviceWell device={device} />
      <span className="acct-row__body">
        <MotionLink nav="push" to={`/device/${device.slug}`} className="acct-row__title inline-flex min-h-11 items-center justify-self-start underline-offset-4 hover:underline" aria-label={t("devices.hub", { name: device.name })}>
          <span>
            <BidiText text={device.name} />
          </span>
        </MotionLink>
      </span>
      <Chip selected={current} onClick={toggle} disabled={!online} aria-label={t("devices.ownNamed", { name: device.name })} className="noscript:hidden">
        {t("devices.own")}
      </Chip>
      {/* The chip needs script. Without it (hidden then, `noscript:` is `@media (scripting: none)`) the same choice is a
          plain form with a toggle key, as before the v2 rebuild: the page reloads with the device saved or removed. */}
      <noscript>
        <form method="post">
          <input type="hidden" name="deviceModelId" value={device.id} />
          <input type="hidden" name="saved" value={saved ? "0" : "1"} />
          <Key type="submit" size="sm" held={saved} icon={saved ? "check" : "plus"} aria-label={t("devices.ownNamed", { name: device.name })}>
            {t("devices.own")}
          </Key>
        </form>
      </noscript>
    </div>
  );
}
