import { useEffect, useRef } from "react";
import { data, useFetcher } from "react-router";

import type { Route } from "./+types/notifications";
import { LocaleLink, useFormat, useT } from "~/i18n/react";
import type { MotionHandle } from "~/motion";
import { getCtx } from "~/server/context.server";
import { getDb } from "~/server/db.server";
import { listNotifications, markNotificationsRead } from "~/server/services/account/notifications.server";
import type { NotificationView } from "~/server/services/account/types";
import { EmptyState } from "~/ui/EmptyState";
import { Key } from "~/ui/Key";
import { useOnline } from "~/ui/OfflineBanner";
import { ShowMore } from "~/ui/Pagination";
import { Status } from "~/ui/Tag";
import { TextLink } from "~/ui/TextLink";
import { toast } from "~/ui/toast-store";
import { accountFailure, formFields, requireSignedIn } from "./account.server";
import { sectionOrder } from "./components/AccountNav";
import { rescueFocus } from "./components/FormBits";
import { PageHead } from "./components/PageHead";
import { accountMeta } from "./components/meta";
import { usePagedList } from "./components/usePagedList";

/**
 * In-account notifications — the one channel that reaches the customer today. Nothing in the store writes them yet
 * (`notificationStatement` is the batch item for the services that will), so most accounts see the empty state.
 */
export const handle = { nav: "push", order: sectionOrder("notifications") } satisfies MotionHandle;

const CURSOR = /^\d{1,16}:[A-Za-z0-9_.:-]{1,128}$/;

export async function loader({ request, context }: Route.LoaderArgs) {
  const ctx = getCtx(context);
  const db = getDb();
  const { customer } = await requireSignedIn(request, ctx, db);
  const cursor = new URL(request.url).searchParams.get("cursor");
  return { notifications: await listNotifications(db, customer.id, ctx.locale, { cursor: cursor && CURSOR.test(cursor) ? cursor : null, limit: 20 }) };
}

export async function action({ request, context }: Route.ActionArgs) {
  const ctx = getCtx(context);
  const db = getDb();
  const { customer } = await requireSignedIn(request, ctx, db);
  const fields = formFields(await request.formData());
  try {
    const changed = await markNotificationsRead(db, customer.id, ctx.now, fields.intent === "readOne" ? (fields.id ?? "") : null);
    return data({ ok: true as const, done: fields.intent === "readOne" ? ("one" as const) : ("all" as const), changed });
  } catch (error) {
    const failure = accountFailure(error, ctx.locale);
    return data(failure, { status: failure.status });
  }
}

export const meta: Route.MetaFunction = (args) => accountMeta(args, "notifications");

export default function Notifications({ loaderData }: Route.ComponentProps) {
  const t = useT("account");
  const list = usePagedList(loaderData.notifications, (next: Awaited<ReturnType<typeof loader>>) => next.notifications);
  const all = useFetcher<typeof action>();
  const online = useOnline();
  const handled = useRef<unknown>(null);
  const unread = list.items.some((item) => item.readAt === null);

  useEffect(() => {
    if (all.state !== "idle" || !all.data || handled.current === all.data) return;
    handled.current = all.data;
    if (all.data.ok) {
      toast.success(t("notifications.allRead"));
      // «علّم الكل كمقروء» is gone now that nothing is unread: focus lands on the title beside it, not on <body>.
      rescueFocus("notifications-title");
    }
  }, [all.state, all.data, t]);

  return (
    <>
      <PageHead
        titleId="notifications-title"
        title={t("notifications.title")}
        lead={t("notifications.lead")}
        aside={
          unread ? (
            <all.Form method="post">
              <input type="hidden" name="intent" value="readAll" />
              <Key type="submit" size="sm" icon="check" loading={all.state !== "idle"} disabled={!online}>
                {t("notifications.markAll")}
              </Key>
            </all.Form>
          ) : null
        }
      />
      {list.items.length === 0 ? (
        <EmptyState layout="stack" panel title={t("notifications.emptyTitle")} text={t("notifications.emptyText")} />
      ) : (
        <div className="grid gap-4">
          <ol className="acct-rows">
            {list.items.map((item) => (
              <li key={item.id}>
                <NotificationRow item={item} />
              </li>
            ))}
          </ol>
          {list.more || list.items.length > loaderData.notifications.items.length ? <ShowMore shown={list.items.length} total={list.total} onMore={list.more} loading={list.loading} label={t("notifications.older")} /> : null}
        </div>
      )}
    </>
  );
}

function NotificationRow({ item }: { item: NotificationView }) {
  const t = useT("account");
  const online = useOnline();
  const f = useFormat();
  const fetcher = useFetcher<typeof action>();
  const read = item.readAt !== null || fetcher.formData !== undefined || (fetcher.data?.ok === true && fetcher.data.done === "one");
  return (
    <article id={`notification-${item.id}`} tabIndex={-1} className="acct-row items-start" data-unread={read ? undefined : ""}>
      <div className="acct-row__body">
        <div className="flex flex-wrap items-start justify-between gap-x-3 gap-y-1">
          <h2 className="acct-row__title">{item.title}</h2>
          {!read ? <Status tone="info">{t("notifications.unread")}</Status> : null}
        </div>
        {item.body ? <p className="type-sm text-ink-2">{item.body}</p> : null}
        <div className="flex flex-wrap items-center gap-x-5">
          <time className="acct-row__meta" dateTime={new Date(item.createdAt).toISOString()}>
            {f.dateTime(item.createdAt)}
          </time>
          {item.link ? (
            <TextLink as={LocaleLink} to={item.link}>
              {t("notifications.open")}
            </TextLink>
          ) : null}
          {!read ? (
            // The key goes as soon as it is pressed (the row reads as read at once): focus stays on this notification.
            <fetcher.Form method="post" onSubmit={() => rescueFocus(`notification-${item.id}`)}>
              <input type="hidden" name="intent" value="readOne" />
              <input type="hidden" name="id" value={item.id} />
              <Key type="submit" size="sm" variant="ghost" disabled={!online}>
                {t("notifications.markRead")}
              </Key>
            </fetcher.Form>
          ) : null}
        </div>
      </div>
    </article>
  );
}
