import { Suspense, useId } from "react";
import { Await } from "react-router";

import { useT } from "~/i18n/react";
import type { ProductCardData, Shelf } from "~/lib/dto";
import { ErrorState } from "~/ui/ErrorState";
import { SectionHead } from "~/ui/SectionHead";
import { drawableShelves } from "./format";
import { ShelfPlaceholder, ShelfStack } from "./RecommendationShelves";
import { useSafeRetry } from "./retry";

/** What the hub's loader streams for the "complete your setup" shelf: never rejects — a failure is `ok: false`. */
export type SetupResult = { ok: true; shelves: Shelf<ProductCardData>[] } | { ok: false; shelves: Shelf<ProductCardData>[] };

/**
 * "Complete your setup" (getRecommendations, context device_hub): STREAMED — the hub is on screen before it is ready
 * (Suspense + Await, so the server sends its HTML in the same response when it is quick). The four states of v2 §6.17:
 *   loading   the shelf's head and the rail's exact geometry with empty wells (no grey skeleton), aria-busy, a status
 *             line for screen readers
 *   arrived   the kit's shelf; cards that arrive after the page inflate into that space (<Bubble>), hydrated HTML is
 *             simply there
 *   failure   the head stays, the rail's place says so with a retry (revalidates the page); the rest of the page works
 *   empty     nothing at all — no element either, so the page's track keeps one section gap (nothing verified and no
 *             new console of the platform, or a shelf of fewer than three cards, which the kit does not draw)
 * The shelf is the engine's: VERIFIED add-ons that can be bought, the store's links first, kinds taking turns — or, on
 * a cold start, the platform's newest consoles, titled as alternatives. Each state is ONE element of the page's track
 * (or none): Suspense and Await draw nothing of their own.
 */
export function SetupShelf({ result, title, reason, loading }: { result: Promise<SetupResult>; title: string; reason: string; loading: string }) {
  return (
    <Suspense fallback={<ShelfPlaceholder title={title} reason={reason} loading={loading} />}>
      <Await resolve={result} errorElement={<SetupFailed title={title} reason={reason} />}>
        {(value) => <SetupAnswer value={value} title={title} reason={reason} />}
      </Await>
    </Suspense>
  );
}

function SetupAnswer({ value, title, reason }: { value: SetupResult; title: string; reason: string }) {
  if (!value.ok) return <SetupFailed title={title} reason={reason} />;
  const shelves = drawableShelves(value.shelves);
  if (shelves.length === 0) return null;
  return (
    <div id="setup" className="grid min-w-0 gap-section">
      <ShelfStack shelves={shelves} />
    </div>
  );
}

/**
 * The failure in the shelf's place: the head stays (nothing jumps), the rail's place is an error panel with a retry —
 * offline, the offline sentence, and the retry waits for the connection (./retry.ts) instead of failing the page.
 */
function SetupFailed({ title, reason }: { title: string; reason: string }) {
  const t = useT("devices");
  const id = useId();
  const { retry, retrying } = useSafeRetry();
  return (
    <section aria-labelledby={id} className="min-w-0">
      <SectionHead id={id} title={title} reason={reason} />
      <ErrorState alert title={t("setup.failed")} text={t("setup.failedText")} onRetry={retry} retrying={retrying} minHeight="220px" />
    </section>
  );
}
