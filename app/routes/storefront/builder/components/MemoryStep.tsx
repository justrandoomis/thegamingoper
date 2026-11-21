/**
 * Step 2 — the memory card (docs/switch-builder.md §6.3): «بدون بطاقة», 64GB, 128GB, 256GB, 512GB, 1TB, each with the
 * space it really leaves for games («≈ 223 GB للألعاب على البطاقة»: the label is decimal and the console shows binary
 * GB, and part of the card is kept free for updates — ~/lib/switch-builder/storage) and TamTam's price, or «غير متوفر
 * في طمطم حالياً» — a size TamTam does not sell can still be chosen to plan with; nothing goes in the cart for it.
 * «عندي بطاقة بهذا الحجم» plans with the shopper's own card (no card line in the cart).
 *
 * A smaller card never removes chosen games: when they no longer fit, a note says by how much (and the games step's
 * meter says it again) and the shopper decides.
 */
import { useId } from "react";

import { useFormat } from "~/i18n/react";
import { planUsage } from "~/lib/switch-builder/plan";
import { capacityOf, cardHeadroomBytes, cardUsableBytes } from "~/lib/switch-builder/storage";
import type { BuilderCatalog, BuilderPlan, CapacityConfig, CardSize, LibraryExtras } from "~/lib/switch-builder/types";
import { CARD_SIZES } from "~/lib/switch-builder/types";
import { FieldGroup, OptionCard, Switch } from "~/ui/Field";
import { Note } from "~/ui/Note";
import { Price } from "~/ui/Price";
import { approxGbText, cardLabel, gbText, useBuilderT } from "../lib/format";

export type MemoryStepProps = {
  catalog: BuilderCatalog;
  plan: BuilderPlan;
  extras: Readonly<Record<string, LibraryExtras>>;
  capacity: CapacityConfig;
  onCard: (card: BuilderPlan["card"]) => void;
};

/** The card's own space for games: usable after formatting, minus the headroom kept for updates. Pure. */
export function cardPlannableBytes(sizeGB: CardSize, capacity: CapacityConfig): number {
  return Math.max(0, cardUsableBytes(sizeGB, capacity) - cardHeadroomBytes(sizeGB, capacity));
}

export function MemoryStep({ catalog, plan, extras, capacity, onCard }: MemoryStepProps) {
  const t = useBuilderT();
  const f = useFormat();
  const name = useId();
  const { card } = plan;
  const internal = capacityOf(plan.device.model, 0, capacity).plannableBytes;
  const { capacity: now, usage } = planUsage(plan, extras, capacity);
  // the note's example: the chosen card (a decimal label shown in the console's binary GB), else a 256GB one
  const example: CardSize = card.sizeGB === 0 ? 256 : card.sizeGB;

  const choose = (sizeGB: CardSize) => {
    if (sizeGB === 0) return onCard({ sizeGB: 0, owned: false });
    if (card.owned) return onCard({ sizeGB, owned: true });
    onCard({ sizeGB, owned: false, variantId: catalog.cards[sizeGB as Exclude<CardSize, 0>]?.variantId });
  };
  const setOwned = (owned: boolean) => {
    if (card.sizeGB === 0) return;
    onCard(owned ? { sizeGB: card.sizeGB, owned: true } : { sizeGB: card.sizeGB, owned: false, variantId: catalog.cards[card.sizeGB as Exclude<CardSize, 0>]?.variantId });
  };

  return (
    <div className="sb-step">
      <div data-tour="card-list">
        <FieldGroup legend={<h2 className="sb-h2">{t("memory.legend")}</h2>}>
          {CARD_SIZES.map((sizeGB) => {
            if (sizeGB === 0) {
              return (
                <OptionCard
                  key={sizeGB}
                  clay
                  name={`${name}-card`}
                  value="0"
                  label={t("memory.none")}
                  hint={<span className="nums">{t("memory.noneHint", { usable: approxGbText(f, internal) })}</span>}
                  checked={card.sizeGB === 0}
                  onChange={() => choose(0)}
                />
              );
            }
            // the card's own price at the end when TamTam can sell it now; otherwise why not, on a line of the hint (the
            // end column would squeeze the space figure onto two lines on a phone) — the shopper's own card: neither
            const sold = catalog.cards[sizeGB];
            const priced = !card.owned && sold?.orderable && sold.priceIqd > 0 ? sold : null;
            const why = card.owned || priced ? null : sold?.reason === "out_of_stock" ? t("memory.soldOut") : t("memory.notSold");
            return (
              <OptionCard
                key={sizeGB}
                clay
                name={`${name}-card`}
                value={String(sizeGB)}
                label={<span dir="ltr">{cardLabel(sizeGB)}</span>}
                hint={
                  <>
                    <span className="block nums" {...(sizeGB === CARD_SIZES[1] ? { "data-tour": "card-usable" } : {})}>
                      {t("memory.usable", { usable: approxGbText(f, cardPlannableBytes(sizeGB, capacity)) })}
                    </span>
                    {why ? <span className="sb-card__note">{why}</span> : null}
                  </>
                }
                end={priced ? <Price amountIqd={priced.priceIqd} size="sm" as="span" approx="off" /> : undefined}
                checked={card.sizeGB === sizeGB}
                onChange={() => choose(sizeGB)}
              />
            );
          })}
        </FieldGroup>
      </div>

      <div data-tour="card-owned">
        <Switch
          label={t("memory.owned")}
          hint={card.sizeGB === 0 ? t("memory.ownedNeedsSize") : t("memory.ownedHint")}
          checked={card.owned}
          disabled={card.sizeGB === 0}
          onChange={(event) => setOwned(event.currentTarget.checked)}
        />
      </div>

      <p className="sb-total nums">{t("memory.totalLine", { total: approxGbText(f, now.plannableBytes) })}</p>

      {usage.overBytes > 0 ? (
        <Note tone="warning" aria-live="polite" title={t("meter.over", { over: gbText(f, usage.overBytes) })}>
          {t("memory.over", { need: gbText(f, usage.usedBytes), plannable: gbText(f, usage.plannableBytes) })}
        </Note>
      ) : null}

      <Note icon="question" title={t("memory.why.title")}>
        {t("memory.why.text", { label: cardLabel(example), shown: gbText(f, example * 1e9) })}
      </Note>
    </div>
  );
}
