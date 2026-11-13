/**
 * The maintenance assistant's conversation (Design System v2 §6.13; v2.1): the shopper's messages are --niche bubbles
 * at the inline end, the assistant's sit on the soft raised card at the inline start; --r-lg corners with an 8px
 * corner on the speaker's side. No glass, no clay on bubbles. Uncertainty is stated in words at the top of an answer;
 * safety warnings come first, as the kit's calm note (never dismissible). Replies are the kit's clay chips (links: the
 * conversation is the URL); a device is chosen from 88×88 image chips. New turns inflate in (Bubble), never under
 * reduced motion.
 */
import { useLayoutEffect, useRef, type RefObject } from "react";
import { useLocation, useNavigation } from "react-router";

import { useT } from "~/i18n/react";
import { Bubble } from "~/motion";
import type { AssistantBotTurn, AssistantPrompt, AssistantTurn, AssistantView } from "~/server/services/support/types";
import { Chip } from "~/ui/Chip";
import { cx } from "~/ui/cx";
import { Niche } from "~/ui/Niche";
import { HrefLink } from "~/ui/Pagination";
import { isPlatform } from "~/ui/PlatformLed";
import { Render } from "~/ui/Stage";
import { Status } from "~/ui/Tag";
import { TextLink } from "~/ui/TextLink";
import { VisuallyHidden } from "~/ui/VisuallyHidden";
import { deviceFit, GuideList, Name, SafetyNote } from "./parts";

const turnKey = (turn: AssistantTurn) => `${turn.id}:${turn.role}:${turn.role === "user" ? turn.text || turn.i18n : turn.text || turn.kind}`;

/** `replies`: false while the shopper writes to a person or has just done so — a reply would leave that form or receipt. */
export function Conversation({ view, replies = true }: { view: AssistantView; replies?: boolean }) {
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
  }, [location.search, location.hash]);

  const botTurns = view.turns.filter((turn): turn is AssistantBotTurn => turn.role === "assistant");
  const newest = botTurns[botTurns.length - 1];
  return (
    <div className="grid gap-4">
      {/* Not a live region: the newest answer takes focus instead, so it is read once. */}
      <ol aria-label={t("assistant.log")} className="sup-chat">
        {view.turns.map((turn) =>
          turn.role === "user" ? (
            <Bubble as="li" key={turnKey(turn)} always className="sup-chat__turn sup-chat__turn--me">
              <p className="sup-bubble sup-bubble--me">
                <VisuallyHidden>{t("assistant.you")}: </VisuallyHidden>
                {turn.typed ? <span dir="auto">{turn.text}</span> : turn.i18n ? t(turn.i18n) : turn.platform && isPlatform(turn.platform) ? ui(`platform.${turn.platform}`) : <Name>{turn.text}</Name>}
              </p>
            </Bubble>
          ) : (
            <Bubble as="li" key={turnKey(turn)} always className="sup-chat__turn">
              <BotBubble turn={turn} focusRef={turn === newest ? lastBot : undefined} />
            </Bubble>
          ),
        )}
      </ol>
      {view.prompt && replies ? (
        <div ref={promptRef} aria-busy={pending || undefined} className={cx("sup-prompt", pending && "opacity-60")}>
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
    <div ref={focusRef} tabIndex={focusRef ? -1 : undefined} className="sup-bubble sup-bubble--bot">
      <VisuallyHidden>{t("assistant.bot")}: </VisuallyHidden>
      {turn.confidence || turn.stepNumber ? (
        <p className="flex flex-wrap items-center gap-x-3 gap-y-1">
          {turn.stepNumber ? <span className="type-sm-strong text-ink">{t("assistant.stepNumber", { n: turn.stepNumber })}</span> : null}
          {turn.confidence ? <Status tone="info">{t(`assistant.confidence.${turn.confidence}`)}</Status> : null}
        </p>
      ) : null}
      {warning ? (
        <SafetyNote title={t("assistant.safety.title")} tone={turn.kind === "danger" ? "danger" : "warn"} flat>
          {warning}
        </SafetyNote>
      ) : null}
      {/* v2.1 G7: short bold titles, never a bold paragraph — a danger stop is marked by the safety note above it (the
          danger tone: its disc and title in --danger), the words stay easy to read */}
      <p className="type-body text-ink">
        <BidiParagraph text={text} />
      </p>
      {turn.articles.length > 0 ? <GuideList articles={turn.articles} showScope plain /> : null}
    </div>
  );
}

/** Approved text may quote a Latin product or a code inside Arabic: isolated runs, the page's direction around them. */
function BidiParagraph({ text }: { text: string }) {
  return <Name>{text}</Name>;
}

function Prompt({ prompt }: { prompt: AssistantPrompt }) {
  const t = useT("support");
  if (prompt.kind === "platforms") {
    return (
      <div className="grid gap-3">
        <p className="type-sm-strong text-ink-2">{t("assistant.platforms")}</p>
        <ul role="list" className="chips">
          {prompt.platforms.map((platform) => (
            <li key={platform.id}>
              <Chip as={HrefLink} to={platform.href} platform={isPlatform(platform.slug) ? platform.slug : undefined}>
                {isPlatform(platform.slug) ? <PlatformWord slug={platform.slug} /> : platform.name}
              </Chip>
            </li>
          ))}
        </ul>
        <TextLink as={HrefLink} to={prompt.otherHref} className="justify-self-start">
          {t("assistant.deviceOther")}
        </TextLink>
      </div>
    );
  }
  if (prompt.kind === "models") {
    return (
      <div className="grid gap-3">
        <p className="type-sm-strong text-ink-2">{t("assistant.models")}</p>
        <ul role="list" className="sup-devchips">
          {prompt.devices.map((device) => (
            <li key={device.id}>
              <HrefLink to={device.href} className="sup-devchip group" data-press="soft">
                <Niche as="span" size="sm" kind={deviceFit(device.kind)} className="sup-devchip__art" aria-hidden="true">
                  {device.artKey ? <Render name={device.artKey} alt="" sizes="88px" className="group-hover:scale-103" /> : null}
                </Niche>
                <span className="sup-devchip__name">
                  <Name>{device.name}</Name>
                </span>
              </HrefLink>
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
      <div className="grid gap-4">
        {prompt.symptoms.length > 0 ? (
          <div className="grid gap-3">
            <p className="type-sm-strong text-ink-2">{t("assistant.problems")}</p>
            <ul role="list" className="chips">
              {prompt.symptoms.map((choice) => (
                <li key={choice.href}>
                  <Chip as={HrefLink} to={choice.href}>
                    {choice.label}
                  </Chip>
                </li>
              ))}
            </ul>
          </div>
        ) : null}
        {prompt.guides.length > 0 ? (
          <div className="grid gap-2">
            <p className="type-sm-strong text-ink-2">{t("assistant.readGuide")}</p>
            <GuideList articles={prompt.guides} showScope />
          </div>
        ) : null}
      </div>
    );
  }
  return (
    <ul role="list" className="chips">
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

function PlatformWord({ slug }: { slug: string }) {
  const ui = useT("ui");
  return <>{ui(`platform.${slug}`)}</>;
}
