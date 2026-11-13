/**
 * The product stage as a soft card — design v2.1 (client note 5: "image … like", the before's Lit Stage; brief §2.4).
 * The kit's <Gallery> (zoom / full-screen viewer, swipe, ← →, thumbnails as a radiogroup, the counter «1 من 6», the
 * shared element the card's well grows into) laid out the way the before showed it:
 *
 *   phones       the card runs edge to edge under the header, its lower corners round off; the whole product with room
 *                around it (not the oversized v2 photo) over an ambient light in the platform's colour; round clay
 *                keys on it — back at the start, share at the end beside the kit's full-screen key; the counter above
 *                the thumbnails, which sit in a clay tray inside the card's foot (product.css: its corners concentric
 *                with the tiles', so the chosen ring is never cut at either end; six tiles fit a phone from 320)
 *   768–1023     the same card inside the page column, every corner round
 *   ≥ 1024       the card at the inline END of the page (the info column is at the start), sticky; no back or share
 *                keys (the breadcrumbs and the actions row are beside it)
 *
 * Motion (v2.1 G6): a new picture slides in from the side it comes from with a fade (the direction of the step; a new
 * set of pictures — another colour — inflates in place, the kit's own entrance), and the ring of the chosen thumbnail
 * slides to its new place (the kit's `useSlidingIndicator` on the tray, drawn by product.css). Both instant under
 * reduced motion and the store's reduce-motion switch.
 *
 * Back is real history Back when an earlier page of this site is in the tab (it restores that page's scroll and plays
 * the reverse zoom); on a deep link it is a link to the product's category (or home), as the before's stage key was.
 * Everything here is layout and the page's own keys: the gallery itself is the kit's.
 */
import { useLayoutEffect, useRef, useState, type MouseEvent, type ReactNode } from "react";
import { useNavigate } from "react-router";

import { MotionLink } from "~/motion";
import type { ProductDetail, VariantDetail } from "~/server/services/catalog/product-types";
import { cx } from "~/ui/cx";
import { Gallery, type GalleryItem } from "~/ui/Gallery";
import { IconKey } from "~/ui/IconKey";
import { useSlidingIndicator } from "~/ui/indicator";
import type { Gel } from "~/ui/PlatformLed";
import { useProductT } from "../i18n";
import { useShare } from "./Actions";

export type StageStep = "next" | "previous" | "swap";

/**
 * How the stage moves to a picture (pure; exported for tests): "next" / "previous" for a step within the same set of
 * pictures, "swap" for a new set (another colour) or no move at all.
 */
export function stageStep(from: number, to: number, sameSet: boolean): StageStep {
  if (!sameSet || from === to) return "swap";
  return to > from ? "next" : "previous";
}

/**
 * The colour of the stage's ambient light (v2.1 G3): the chosen version's platform, else the product's own, else the
 * first platform it is for; the brand red for a product of no platform. Pure.
 */
export function stageGel(product: Pick<ProductDetail, "platform" | "forPlatforms">, variant: Pick<VariantDetail, "gel">): Gel {
  return variant.gel ?? product.platform?.gel ?? product.forPlatforms.find((platform) => platform.gel)?.gel ?? "brand";
}

/** Where the stage's back key leads without in-site history: the product's own category, else home. Pure. */
export function stageBack(product: Pick<ProductDetail, "categories">): string {
  const category = product.categories.at(-1);
  return category ? `/c/${category.slug}` : "/";
}

export type StageCardProps = {
  /** The product's name: the gallery's alt text and the viewer's title; the share key names it. */
  name: string;
  items: readonly GalleryItem[];
  /** The shared element the card's well grows into (`product-image:<id>`). */
  sharedName: string;
  /** The ambient light's colour: the version's platform, else the brand red. */
  gel: Gel;
  /** Where back leads without in-site history (locale-less). */
  backTo: string;
  index: number;
  onIndexChange: (index: number) => void;
  /** A key for the set of pictures shown (another colour = another set). */
  pictures: string;
  /** The first picture is the page's LCP element. */
  priority?: boolean;
  /** Under the card (the «no photo of this version yet» line). */
  children?: ReactNode;
  className?: string;
};

const RING = { selector: '[aria-checked="true"]', attribute: "data-ind", x: "--ind-x", w: "--ind-w" } as const;

export function StageCard({ name, items, sharedName, gel, backTo, index, onIndexChange, pictures, priority = false, children, className }: StageCardProps) {
  const t = useProductT();
  const navigate = useNavigate();
  const share = useShare(name);
  const card = useRef<HTMLDivElement>(null);
  const tray = useRef<HTMLElement | null>(null);

  // the direction of the last move, for the picture's entrance (product.css [data-step])
  const [step, setStep] = useState<StageStep>("swap");
  const [shown, setShown] = useState(pictures);
  if (shown !== pictures) {
    setShown(pictures);
    setStep("swap");
  }
  const go = (next: number) => {
    setStep(stageStep(index, next, true));
    onIndexChange(next);
  };

  // The ring of the chosen thumbnail slides along the tray: the kit's sliding indicator, measured on the gallery's own
  // thumbnail row (found after each render: a set of one picture has none).
  useLayoutEffect(() => {
    tray.current = card.current?.querySelector<HTMLElement>(".gallery > .thumbs") ?? null;
  });
  useSlidingIndicator(tray, `${pictures}#${index}#${items.length}`, RING);

  const back = (event: MouseEvent<HTMLAnchorElement>) => {
    if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    // React Router numbers the entries it created in this tab; idx 0 = the page the shopper arrived on
    const state = window.history.state as { idx?: number } | null;
    if (typeof state?.idx === "number" && state.idx > 0) {
      event.preventDefault();
      void navigate(-1);
    }
  };

  return (
    <div ref={card} className={cx("pp-stage", className)} data-gel={gel} data-step={step} data-thumbs={items.length > 1 ? "" : undefined}>
      {/* the page's own keys over the stage, below 1024 (the kit's full-screen key stays at the top end) */}
      <div className="pp-stage__keys lg:hidden">
        <IconKey as={MotionLink} to={backTo} nav="zoom" back icon="arrow-left" label={t("stage.back")} onClick={back} />
        <IconKey icon="share-network" label={t("stage.share", { name })} onClick={() => void share()} className="pp-stage__share" />
      </div>
      <Gallery name={name} items={items} sharedName={sharedName} index={index} onIndexChange={go} priority={priority} />
      {children}
    </div>
  );
}
