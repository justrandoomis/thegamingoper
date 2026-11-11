import { Suspense, useState, useSyncExternalStore } from "react";
import { Await, useRevalidator } from "react-router";

import { useT } from "~/i18n/react";
import type { ProductCardData, Shelf } from "~/lib/dto";
import { Bubble, BubbleGroup } from "~/motion";
import { cx } from "~/ui/cx";
import { ErrorState } from "~/ui/ErrorState";
import { ProductCard, ProductCardPlaceholder } from "~/ui/ProductCard";
import { ShelfRail } from "~/ui/ShelfRail";
import { VisuallyHidden } from "~/ui/VisuallyHidden";
import { SECTION_SCROLL_MARGIN } from "./format";

/** What the hub's loader streams for the "complete your setup" shelf: never rejects — a failure is `ok: false`. */
export type SetupResult = { ok: true; shelves: Shelf<ProductCardData>[] } | { ok: false; shelves: Shelf<ProductCardData>[] };

/** Rail item widths of ~/ui/Rail, so the placeholder has the geometry of the shelf that replaces it. */
const ITEM = "flex shrink-0 w-[43%] sm:w-[30%] md:w-[23%] lg:w-[18.6%] xl:w-[15.4%]";

/**
 * "Complete your setup" (getRecommendations, context device_hub): STREAMED — the page is on screen before it is
 * ready. While it loads, the same geometry with empty niches (no grey skeleton, DESIGN.md §7.2); when it arrives
 * the cards inflate into that space (<Bubble>); if it fails, the space says so with a retry (the rest of the page
 * works). An empty answer (nothing verified and no new console of the platform) leaves nothing behind.
 */
export function SetupShelf({ result, title, reason, loading }: { result: Promise<SetupResult>; title: string; reason: string; loading: string }) {
  return (
    <div id="setup" className={SECTION_SCROLL_MARGIN}>
      <Suspense fallback={<SetupPlaceholder title={title} reason={reason} loading={loading} />}>
        <Await resolve={result}>{(value) => <SetupShelves value={value} />}</Await>
      </Suspense>
    </div>
  );
}

const subscribeNothing = () => () => undefined;

/**
 * True when this component first mounted on the client after the page was already there (the shelf arrived after a
 * client navigation); false when it is hydrating server HTML (the stream had already delivered the shelf). Decided
 * once, at mount, so the markup never switches under the shopper.
 *
 * Why: <Bubble> decides to inflate with `isMotionLive()`, which is already true while a streamed Suspense boundary
 * hydrates after <MotionRoot> mounted — it then renders animation classes the server did not, a hydration mismatch
 * (reported to the motion owner). Hydrated content is simply there; content that arrives later inflates.
 */
function useArrivedOnClient(): boolean {
  const live = useSyncExternalStore(subscribeNothing, () => true, () => false);
  const [first] = useState(live);
  return first;
}

function SetupShelves({ value }: { value: SetupResult }) {
  const t = useT("devices");
  const revalidator = useRevalidator();
  const arrived = useArrivedOnClient();
  if (!value.ok) {
    return <ErrorState alert title={t("setup.failed")} text={t("setup.failedText")} onRetry={() => void revalidator.revalidate()} retrying={revalidator.state === "loading"} />;
  }
  if (value.shelves.length === 0) return null;
  return (
    <div className="grid gap-section">
      {value.shelves.map((shelf) =>
        arrived ? (
          <BubbleGroup key={shelf.key} stagger>
            <ShelfRail
              shelf={shelf}
              renderItem={(card, index) => (
                <Bubble index={index} className="flex w-full">
                  <ProductCard card={card} slot={shelf.key} />
                </Bubble>
              )}
            />
          </BubbleGroup>
        ) : (
          <ShelfRail
            key={shelf.key}
            shelf={shelf}
            renderItem={(card) => (
              <div className="flex w-full">
                <ProductCard card={card} slot={shelf.key} />
              </div>
            )}
          />
        ),
      )}
    </div>
  );
}

function SetupPlaceholder({ title, reason, loading }: { title: string; reason: string; loading: string }) {
  return (
    <section aria-busy="true" className="grid min-w-0 gap-3">
      <div className="grid gap-0.5">
        <h2 className="type-section text-ink">{title}</h2>
        <p className="type-caption text-ink-2">{reason}</p>
      </div>
      <VisuallyHidden role="status">{loading}</VisuallyHidden>
      <div aria-hidden="true" className={cx("-mx-1 flex gap-card overflow-hidden px-1 pt-1 pb-3")}>
        {Array.from({ length: 6 }, (_, index) => (
          <div key={index} className={ITEM}>
            <ProductCardPlaceholder />
          </div>
        ))}
      </div>
    </section>
  );
}
