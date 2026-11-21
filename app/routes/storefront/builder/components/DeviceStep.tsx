/**
 * Step 1 — the console (docs/switch-builder.md §6.2): «أشتري جهازاً من طمطم» or «عندي جهاز Switch».
 *
 * Buy: the models TamTam sells now, each with its catalogue photo, its price and its stock state in words, and the
 * chosen model's colours (the kit's swatches; a colour that cannot be bought now says why). Have: the three Switch 1
 * models, to plan the space on the shopper's own console — no console line in the cart. Each model says how much of
 * its memory is left for games; the Lite says it is played in the hand only.
 *
 * A plan kept from an earlier visit may name a console TamTam no longer sells (the Lite, sold then, archived since): the
 * buy list then has no model checked, so a note says why and what to do — it never sits in the plan unexplained (QA
 * 2026-11-21).
 *
 * The choices are native radios (arrow keys, the dot's drawn moment) in a group named by the list's title (WCAG 1.3.1:
 * entering the list says «أجهزة Switch في طمطم»); the plan changes at once.
 */
import { useId, type ReactNode } from "react";

import { useFormat } from "~/i18n/react";
import { capacityOf } from "~/lib/switch-builder/storage";
import { suggestedVariant } from "~/lib/switch-builder/plan";
import type { BuilderCatalog, BuilderPlan, CapacityConfig, CatalogOption, SwitchModel } from "~/lib/switch-builder/types";
import { SWITCH_MODELS } from "~/lib/switch-builder/types";
import { Art } from "~/art/Art";
import { Icon } from "~/art/Icon";
import { BidiText, isolate } from "~/ui/BidiText";
import { cx } from "~/ui/cx";
import { FieldGroup, OptionCard } from "~/ui/Field";
import { Niche } from "~/ui/Niche";
import { Note } from "~/ui/Note";
import { Price } from "~/ui/Price";
import { Render } from "~/ui/Stage";
import { Swatches } from "~/ui/Swatch";
import { Status } from "~/ui/Tag";
import { approxGbText, useBuilderT } from "../lib/format";

/** Each model's system memory as printed on the box (GB, decimal), for the model's fact line. */
export const INTERNAL_LABEL: Record<SwitchModel, string> = { "switch-oled": "64 GB", switch: "32 GB", "switch-lite": "32 GB" };
/** Catalogue photos of the three models (art keys), for a model TamTam does not sell now. */
export const MODEL_ART: Record<SwitchModel, string> = { "switch-oled": "nintendo-switch-oled--1", switch: "nintendo-switch--1", "switch-lite": "nintendo-switch-lite--1" };

/** «Nintendo Switch – OLED Model»: the dash stays at the end of the first line when the name wraps (no-break space). */
export function keepDashes(name: string): string {
  return name.replace(/ ([\u2013\u2014]) /g, "\u00A0$1 ");
}

/** The models TamTam sells now (with at least one variant), OLED first. */
export function soldModels(catalog: Pick<BuilderCatalog, "devices">): SwitchModel[] {
  return SWITCH_MODELS.filter((model) => (catalog.devices[model]?.variants.length ?? 0) > 0);
}

export type DeviceStepProps = {
  catalog: BuilderCatalog;
  plan: BuilderPlan;
  capacity: CapacityConfig;
  onDevice: (device: BuilderPlan["device"]) => void;
};

export function DeviceStep({ catalog, plan, capacity, onDevice }: DeviceStepProps) {
  const t = useBuilderT();
  const name = useId();
  const sold = soldModels(catalog);
  const mode = plan.device.owned ? "have" : "buy";
  // a console to buy that TamTam no longer sells (a plan from an earlier visit)
  const stale = !plan.device.owned && !sold.includes(plan.device.model);

  const choose = (next: "buy" | "have") => {
    if (next === mode) return;
    if (next === "have") {
      onDevice({ model: plan.device.model, owned: true });
      return;
    }
    const model = sold.includes(plan.device.model) ? plan.device.model : sold[0];
    if (!model) return;
    onDevice({ model, owned: false, variantId: suggestedVariant(catalog.devices, model)?.variantId });
  };

  return (
    <div className="sb-step">
      <div data-tour="device-mode">
        <FieldGroup legend={<h2 className="sb-h2">{t("device.question")}</h2>}>
          <OptionCard
            clay
            icon="storefront"
            name={`${name}-mode`}
            value="buy"
            label={t("device.buy")}
            hint={sold.length > 0 ? t("device.buyHint") : t("device.noneSold")}
            checked={mode === "buy"}
            disabled={sold.length === 0}
            onChange={() => choose("buy")}
          />
          <OptionCard clay icon="device-nintendo" name={`${name}-mode`} value="have" label={t("device.have")} hint={t("device.haveHint")} checked={mode === "have"} onChange={() => choose("have")} />
        </FieldGroup>
      </div>

      {stale ? (
        <Note tone="warning" icon="storefront">
          {t(sold.length > 0 ? "device.stale" : "device.staleNone", { name: t(`device.models.${plan.device.model}`) })}
        </Note>
      ) : null}

      {mode === "buy" ? (
        <BuyList catalog={catalog} plan={plan} capacity={capacity} sold={sold} onDevice={onDevice} />
      ) : (
        <OwnedList plan={plan} capacity={capacity} onDevice={onDevice} catalog={catalog} />
      )}
    </div>
  );
}

function stockOf(option: CatalogOption | null): { tone: "ok" | "out" | "neutral"; key: string } {
  if (!option) return { tone: "neutral", key: "device.stock.unavailable" };
  if (option.orderable) return { tone: "ok", key: "device.stock.in" };
  return option.reason === "out_of_stock" ? { tone: "out", key: "device.stock.out" } : { tone: "neutral", key: "device.stock.unavailable" };
}

/** A model's memory fact: «ذاكرة داخلية 64 GB · ≈ 52 GB للألعاب». */
function useInternalFact(capacity: CapacityConfig) {
  const t = useBuilderT();
  const f = useFormat();
  return (model: SwitchModel) => t("device.internal", { label: isolate(INTERNAL_LABEL[model]), usable: approxGbText(f, capacityOf(model, 0, capacity).plannableBytes) });
}

function BuyList({ catalog, plan, capacity, sold, onDevice }: { catalog: BuilderCatalog; plan: BuilderPlan; capacity: CapacityConfig; sold: SwitchModel[]; onDevice: DeviceStepProps["onDevice"] }) {
  const t = useBuilderT();
  const name = useId();
  const fact = useInternalFact(capacity);
  if (sold.length === 0) return null;
  return (
    <div className="sb-models" data-tour="device-list" role="group" aria-labelledby={`${name}-title`}>
      <h3 id={`${name}-title`} className="sb-h3">
        {t("device.soldTitle")}
      </h3>
      <ul className="sb-models__list">
        {sold.map((model) => {
          const device = catalog.devices[model]!;
          const checked = plan.device.model === model;
          const variant = (checked ? device.variants.find((option) => option.variantId === plan.device.variantId) : null) ?? suggestedVariant(catalog.devices, model);
          const stock = stockOf(variant);
          const art = variant?.art ?? device.art ?? MODEL_ART[model];
          return (
            <li key={model} className="min-w-0">
              <ModelCard
                name={`${name}-model`}
                model={model}
                title={device.name}
                art={art}
                checked={checked}
                fact={fact(model)}
                lite={model === "switch-lite"}
                onChoose={() => onDevice({ model, owned: false, variantId: suggestedVariant(catalog.devices, model)?.variantId })}
              >
                <span className="sb-model__buy">
                  {variant && variant.priceIqd > 0 ? <Price amountIqd={variant.priceIqd} size="sm" as="span" approx="off" /> : null}
                  <Status tone={stock.tone}>{t(stock.key)}</Status>
                </span>
              </ModelCard>
              {checked && device.variants.length > 1 ? (
                <Swatches
                  className="sb-model__colours"
                  label={t("device.colour")}
                  value={plan.device.variantId ?? null}
                  onChange={(variantId) => onDevice({ model, owned: false, variantId })}
                  options={device.variants.map((option) => ({
                    value: option.variantId,
                    name: option.variantTitle ?? option.name,
                    thumb: option.art ? <Art name={option.art} alt="" sizes="56px" /> : undefined,
                    unavailable: option.orderable ? undefined : option.reason === "out_of_stock" ? ("soldOut" as const) : true,
                  }))}
                />
              ) : null}
            </li>
          );
        })}
      </ul>
    </div>
  );
}

function OwnedList({ catalog, plan, capacity, onDevice }: { catalog: BuilderCatalog; plan: BuilderPlan; capacity: CapacityConfig; onDevice: DeviceStepProps["onDevice"] }) {
  const t = useBuilderT();
  const name = useId();
  const fact = useInternalFact(capacity);
  return (
    <div className="sb-models" data-tour="device-list" role="group" aria-labelledby={`${name}-title`}>
      <h3 id={`${name}-title`} className="sb-h3">
        {t("device.ownedTitle")}
      </h3>
      <ul className="sb-models__list">
        {SWITCH_MODELS.map((model) => (
          <li key={model} className="min-w-0">
            <ModelCard
              name={`${name}-model`}
              model={model}
              title={t(`device.models.${model}`)}
              art={catalog.devices[model]?.art ?? MODEL_ART[model]}
              checked={plan.device.model === model}
              fact={fact(model)}
              lite={model === "switch-lite"}
              onChoose={() => onDevice({ model, owned: true })}
            />
          </li>
        ))}
      </ul>
    </div>
  );
}

function ModelCard({
  name,
  model,
  title,
  art,
  checked,
  fact,
  lite,
  onChoose,
  children,
}: {
  name: string;
  model: SwitchModel;
  title: string;
  art: string;
  checked: boolean;
  fact: string;
  lite: boolean;
  onChoose: () => void;
  children?: ReactNode;
}) {
  const t = useBuilderT();
  return (
    <label className={cx("sb-model surface", checked && "sb-model--checked")}>
      <input type="radio" name={name} value={model} checked={checked} onChange={onChoose} className="sb-model__input" />
      <Niche as="span" size="sm" className="sb-model__art">
        <Render name={art} alt="" sizes="96px" />
      </Niche>
      <span className="sb-model__text">
        <span className="sb-model__name">
          <BidiText text={keepDashes(title)} />
        </span>
        <span className="sb-model__fact nums">{fact}</span>
        {lite ? <span className="sb-model__note">{t("device.liteNote")}</span> : null}
        {children}
      </span>
      <span className="sb-model__mark" aria-hidden="true">
        {checked ? <Icon name="check" size={16} /> : null}
      </span>
    </label>
  );
}
