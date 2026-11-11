import { Icon } from "~/art/Icon";
import { useFormat, useT } from "~/i18n/react";
import { SharedElement } from "~/motion";
import type { DeviceHub } from "~/server/services/devices.server";
import { Key } from "~/ui/Key";
import { PlatformLabel, type Platform } from "~/ui/PlatformLed";
import { ProductImage } from "~/ui/ProductCard";
import { Stage } from "~/ui/Stage";
import { isolate, researchDate } from "./format";

/**
 * The top of a device hub (DESIGN.md §8.7, §8.9): the device floating on its platform's lit stage (the one stage of
 * the page, its photo the LCP image) and, beside it from 768px (6 + 6 on tablets, 5 + 7 from 1024: copy at the inline
 * start, stage at the inline end — DESIGN.md §8.9, §8.11),
 * the platform LED and name, "Everything about …", the summary and the facts the store holds: release date,
 * generation, how many games and accessories are VERIFIED to work with it. Two keys jump to the editions and to
 * setup and repair. No price here: the editions below carry theirs.
 *
 * The stage is the target of `<SharedElement name="device-image:<slug>">`, so a device row link elsewhere (the
 * platform hub's "Everything about PS5" row, DESIGN.md §8.2) can grow into it.
 */
export function HubHero({ hub, gel, platformName }: { hub: DeviceHub; gel: Platform | null; platformName: string }) {
  const t = useT("devices");
  const f = useFormat();
  const { model, counts } = hub;
  const device = isolate(model.name);
  const released = researchDate(model.releasedOn, f);
  const image = model.images[0] ?? null;
  const games = counts.games.verified;
  const accessories = counts.accessories.verified;
  const generation = model.generation && model.generation.name !== model.name ? model.generation.name : null;

  return (
    <header className="grid items-center gap-x-8 gap-y-5 md:grid-cols-12 lg:gap-x-10">
      <div className="grid min-w-0 content-start gap-3 md:col-span-6 lg:col-span-5">
        {gel ? <PlatformLabel platform={gel} label={platformName} /> : <p className="type-caption text-ink-2">{platformName}</p>}
        <h1 className="type-title text-ink">{t("hero.title", { device })}</h1>
        {model.summary ? <p className="type-body max-w-[60ch] text-ink-2">{model.summary}</p> : null}
        <ul role="list" className="flex flex-wrap gap-x-5 gap-y-2 type-caption text-ink-2">
          {released ? (
            <li className="inline-flex items-center gap-1.5">
              <Icon name="calendar-blank" size={16} />
              {released.kind === "year" ? t("hero.releasedYear", { year: released.text }) : t("hero.released", { date: released.text })}
            </li>
          ) : null}
          {generation ? (
            <li className="inline-flex items-center gap-1.5">
              <Icon name="stack" size={16} />
              {t("hero.generation", { generation: isolate(generation) })}
            </li>
          ) : null}
          {games > 0 ? (
            <li className="inline-flex items-center gap-1.5">
              <Icon name="game-controller" size={16} />
              {t("hero.games", { count: games, n: f.number(games) })}
            </li>
          ) : null}
          {accessories > 0 ? (
            <li className="inline-flex items-center gap-1.5">
              <Icon name="plug" size={16} />
              {t("hero.accessories", { count: accessories, n: f.number(accessories) })}
            </li>
          ) : null}
        </ul>
        <div className="flex flex-wrap gap-2 pt-1">
          {hub.editions.length > 0 ? (
            <Key as="a" href="#versions" icon="shopping-bag">
              {t("hero.shop")}
            </Key>
          ) : null}
          <Key as="a" href="#help" variant="quiet" icon="wrench">
            {t("hero.help")}
          </Key>
        </div>
      </div>
      <div className="order-first min-w-0 md:order-none md:col-span-6 lg:col-span-7">
        <SharedElement name={`device-image:${model.slug}`} target>
          <Stage size="hero" gel={gel}>
            {image ? <ProductImage image={image} sizes="(min-width: 1280px) 620px, (min-width: 768px) 50vw, 86vw" priority /> : null}
          </Stage>
        </SharedElement>
      </div>
    </header>
  );
}
