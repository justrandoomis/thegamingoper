/**
 * The maintenance assistant's conversation (DESIGN.md §9.22): the shopper's messages are flat niche bubbles at the
 * inline end, the assistant's are paper bubbles with a hairline at the inline start; the corner nearest the speaker
 * is small. No glass, no clay on bubbles. Uncertainty is stated in words at the top of an answer with an info dot;
 * safety warnings come first, as a flat warn panel that cannot be dismissed. Suggested replies are chips (links: the
 * conversation is the URL). New turns inflate in (Bubble), never under reduced motion.
 */
import { useLayoutEffect, useRef, type RefObject } from "react";
import { useLocation, useNavigation } from "react-router";

import { useT } from "~/i18n/react";
import { Bubble } from "~/motion";
import type { AssistantBotTurn, AssistantPrompt, AssistantTurn, AssistantView } from "~/server/services/support/types";
import { Chip } from "~/ui/Chip";
import { cx } from "~/ui/cx";
import { Key } from "~/ui/Key";
import { HrefLink } from "~/ui/Pagination";
import { isPlatform, PlatformGlyph, PlatformLabel } from "~/ui/PlatformLed";
import { Status } from "~/ui/Tag";
import { TextLink } from "~/ui/TextLink";
import { VisuallyHidden } from "~/ui/VisuallyHidden";
import { DeviceTile, GuideList, SafetyNote } from "./parts";

const turnKey = (turn: AssistantTurn) => `${turn.id}:${turn.role}:${turn.role === "user" ? turn.text || turn.i18n : turn.text || turn.kind}`;

export function Conversation({ view }: { view: AssistantView }) {
  const t = useT("support");
  const ui = useT("ui");
  const location = useLocation();
  const navigation = useNavigation();
  // The next answer is on its way: the replies dim (opacity only) and say they are busy; nothing else waits.
  const pending = navigation.state === "loading" && navigation.location?.pathname === location.pathname && navigation.location.search !== location.search;
  const lastBot = useRef<HTMLDivElement>(null);
  const promptRef = useRef<HTMLDivElement>(null);
  const handled = useRef(location.search);

  // After each answer (a new query string), the newest answer takes focus — screen readers read it, the keyboard
  // continues from there — and the replies are scrolled into view above the composer. Not when the page loads (the
  // query the page opened with counts as handled, which also survives effects being run twice in development).
  useLayoutEffect(() => {
    if (handled.current === location.search) return;
    handled.current = location.search;
    if (location.hash) return; // a link to a part of the page (#handoff) owns focus and scroll
    lastBot.current?.focus({ preventScroll: true });
    (promptRef.current ?? lastBot.current)?.scrollIntoView({ block: "nearest" });
  }, [location.search]);

  const botTurns = view.turns.filter((turn): turn is AssistantBotTurn => turn.role === "assistant");
  const newest = botTurns[botTurns.length - 1];
  return (
    <div className="grid gap-4">
      {/* Not a live region: the newest answer takes focus instead, so it is read once. */}
      <ol aria-label={t("assistant.log")} className="grid gap-3">
        {view.turns.map((turn) =>
          turn.role === "user" ? (
            <Bubble as="li" key={turnKey(turn)} always className="flex justify-end">
              <p className="max-w-[85%] rounded-lg rounded-ee-xs bg-niche px-4 py-2.5 type-body text-ink">
                <VisuallyHidden>{t("assistant.you")}: </VisuallyHidden>
                {turn.typed ? <span dir="auto">{turn.text}</span> : turn.i18n ? t(turn.i18n) : turn.platform && isPlatform(turn.platform) ? ui(`platform.${turn.platform}`) : turn.text}
              </p>
            </Bubble>
          ) : (
            <Bubble as="li" key={turnKey(turn)} always className="flex justify-start">
              <BotBubble turn={turn} focusRef={turn === newest ? lastBot : undefined} />
            </Bubble>
          ),
        )}
      </ol>
      {view.prompt ? (
        <div ref={promptRef} aria-busy={pending || undefined} className={cx("scroll-mb-[calc(var(--shell-bottom)+var(--s-6))] transition-opacity duration-(--t-micro)", pending && "opacity-60")}>
          <Prompt prompt={view.prompt} />
        </div>
      ) : null}
    </div>
  );
}

function BotBubble({ turn, focusRef }: { turn: AssistantBotTurn; focusRef?: RefObject<HTMLDivElement | null> }) {
  const t = useT("support");
  const ui = useT("ui");
  // Platform names as the design system writes them (ui:platform.*); the catalogue name for any other platform.
  const slug = turn.params.platformSlug;
  const params = slug && isPlatform(slug) ? { ...turn.params, platform: ui(`platform.${slug}`) } : turn.params;
  const text = turn.text || t(`assistant.turn.${turn.kind}`, params);
  const warning = turn.warning ?? (turn.warningKey ? t(turn.warningKey) : null);
  return (
    <div
      ref={focusRef}
      tabIndex={focusRef ? -1 : undefined}
      className="grid max-w-[92%] scroll-mb-[calc(var(--shell-bottom)+var(--s-6))] gap-3 rounded-lg rounded-es-xs border border-line bg-paper px-4 py-3 outline-offset-4 md:max-w-[85%]"
    >
      <VisuallyHidden>{t("assistant.bot")}: </VisuallyHidden>
      {turn.confidence || turn.stepNumber ? (
        <p className="flex flex-wrap items-center gap-x-3 gap-y-1">
          {turn.stepNumber ? <span className="type-label text-ink">{t("assistant.stepNumber", { n: turn.stepNumber })}</span> : null}
          {turn.confidence ? <Status tone="info">{t(`assistant.confidence.${turn.confidence}`)}</Status> : null}
        </p>
      ) : null}
      {warning ? <SafetyNote title={t("assistant.safety.title")} tone={turn.kind === "danger" ? "danger" : "warn"}>{warning}</SafetyNote> : null}
      <p className={cx("type-body text-ink", turn.kind === "danger" && "font-semibold")}>{text}</p>
      {turn.articles.length > 0 ? <GuideList articles={turn.articles} showScope className="-mb-2" /> : null}
    </div>
  );
}

function Prompt({ prompt }: { prompt: AssistantPrompt }) {
  const t = useT("support");
  if (prompt.kind === "platforms") {
    return (
      <div className="grid gap-3">
        <p className="type-label text-ink-2">{t("assistant.platforms")}</p>
        <ul role="list" className="grid grid-cols-2 gap-2 md:grid-cols-4">
          {prompt.platforms.map((platform) => (
            <li key={platform.id} className="flex">
              <Key as={HrefLink} to={platform.href} block className="justify-start">
                <span className="flex items-center gap-2">
                  {isPlatform(platform.slug) ? <PlatformGlyph platform={platform.slug} size={20} /> : null}
                  {isPlatform(platform.slug) ? <PlatformLabel platform={platform.slug} /> : <bdi>{platform.name}</bdi>}
                </span>
              </Key>
            </li>
          ))}
        </ul>
        <TextLink as={HrefLink} to={prompt.otherHref}>
          {t("assistant.deviceOther")}
        </TextLink>
      </div>
    );
  }
  if (prompt.kind === "models") {
    return (
      <div className="grid gap-3">
        <p className="type-label text-ink-2">{t("assistant.models")}</p>
        <ul role="list" className="grid grid-cols-3 gap-card sm:grid-cols-4 lg:grid-cols-5">
          {prompt.devices.map((device) => (
            <li key={device.id} className="flex">
              <DeviceTile name={device.name} artKey={device.artKey} platform={device.platform.slug} href={device.href} sizes="(min-width: 1024px) 140px, 28vw" />
            </li>
          ))}
        </ul>
        <div className="flex flex-wrap gap-x-6">
          <TextLink as={HrefLink} to={prompt.otherHref}>
            {t("assistant.deviceOther")}
          </TextLink>
          <TextLink as={HrefLink} to={prompt.backHref}>
            {t("assistant.otherPlatform")}
          </TextLink>
        </div>
      </div>
    );
  }
  if (prompt.kind === "problems") {
    return (
      <div className="grid gap-3">
        {prompt.symptoms.length > 0 ? (
          <>
            <p className="type-label text-ink-2">{t("assistant.problems")}</p>
            <ul role="list" className="flex flex-wrap gap-2">
              {prompt.symptoms.map((choice) => (
                <li key={choice.href}>
                  <Chip as={HrefLink} to={choice.href}>
                    {choice.label}
                  </Chip>
                </li>
              ))}
            </ul>
          </>
        ) : null}
        {prompt.guides.length > 0 ? (
          <div className="grid gap-1">
            <p className="type-label text-ink-2">{t("assistant.readGuide")}</p>
            <GuideList articles={prompt.guides} showScope />
          </div>
        ) : null}
      </div>
    );
  }
  return (
    <ul role="list" className="flex flex-wrap gap-2">
      {prompt.choices.map((choice) => (
        <li key={choice.href}>
          <Chip as={HrefLink} to={choice.href}>
            {choice.label}
          </Chip>
        </li>
      ))}
    </ul>
  );
}
