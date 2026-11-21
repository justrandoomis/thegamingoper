/**
 * A game's official trailer in the details sheet (docs/switch-builder.md §6.6) — click to load.
 *
 *   <TrailerEmbed videoId={extras.trailerYouTubeId} title={game.title} />
 *
 * Before the tap NOTHING is fetched from YouTube: no iframe, no thumbnail, no preconnect. The poster is TamTam's own:
 * a 16:9 well on the product ground with a clay play disc and the words «شغّل العرض الدعائي», and a line that says the
 * video loads from YouTube only when pressed (the privacy policy says the same). The tap swaps in the privacy-enhanced
 * player `https://www.youtube-nocookie.com/embed/<id>` (it plays at once: the tap is the shopper's gesture), titled for
 * screen readers, and moves the focus into it so the keyboard does not fall back to the page. Production's CSP allows
 * exactly that origin as `frame-src` (integration owner, app/server/security.server.ts). The frame is sandboxed
 * (TRAILER_SANDBOX): the player runs its scripts on its own origin and may open YouTube in a new tab, but it cannot
 * navigate this page, submit forms, open dialogs or start downloads. Offline, the play key rests with the reason
 * beside it. An id that is not a YouTube video id renders nothing.
 */
import { useEffect, useId, useRef, useState } from "react";

import { Icon } from "~/art/Icon";
import { useT } from "~/i18n/react";
import { cx } from "~/ui/cx";
import { useOnline } from "~/ui/OfflineBanner";
import "../builder-sheet.css";

export type TrailerEmbedProps = {
  /** The YouTube video id (11 characters), as staff entered it in /admin/catalog/switch-library. */
  videoId: string;
  /** The game's title (names the player for screen readers). */
  title: string;
  className?: string;
};

/** A YouTube video id: 11 characters of A–Z, a–z, 0–9, "-" and "_". */
export const YOUTUBE_VIDEO_ID = /^[A-Za-z0-9_-]{11}$/;

export const TRAILER_ORIGIN = "https://www.youtube-nocookie.com";

/**
 * What the player frame may do: run its scripts on its own (cross-site) origin — `allow-same-origin` keeps YouTube's
 * origin, never this page's —, go full screen / present, and open "Watch on YouTube" in a new tab that is not
 * sandboxed itself. Nothing else: no navigating this page, no forms, no modal dialogs, no downloads.
 */
export const TRAILER_SANDBOX = "allow-scripts allow-same-origin allow-presentation allow-popups allow-popups-to-escape-sandbox";

/** The player's address for a checked id (null for anything else). Pure. */
export function trailerSrc(videoId: string): string | null {
  if (!YOUTUBE_VIDEO_ID.test(videoId)) return null;
  return `${TRAILER_ORIGIN}/embed/${videoId}?autoplay=1&rel=0&playsinline=1`;
}

export function TrailerEmbed({ videoId, title, className }: TrailerEmbedProps) {
  const t = useT("switch-builder-sheet");
  const online = useOnline();
  const noteId = useId();
  const [playing, setPlaying] = useState<string | null>(null);
  const frame = useRef<HTMLIFrameElement | null>(null);
  const src = trailerSrc(videoId);
  const shown = playing === videoId && src !== null;

  // the poster key is gone: the focus goes into the player, never back to <body>
  useEffect(() => {
    if (shown) frame.current?.focus({ preventScroll: true });
  }, [shown]);

  if (src === null) return null;
  return (
    <div className={cx("sbs-trailer", className)}>
      <div className="sbs-trailer__box">
        {shown ? (
          <iframe
            ref={frame}
            className="sbs-trailer__frame"
            src={src}
            title={t("trailer.frame", { title })}
            width={560}
            height={315}
            allow="autoplay; encrypted-media; picture-in-picture; fullscreen"
            allowFullScreen
            sandbox={TRAILER_SANDBOX}
            // YouTube's player refuses to start without the embedding origin; only the origin is sent
            referrerPolicy="strict-origin-when-cross-origin"
          />
        ) : (
          <button
            type="button"
            className="sbs-trailer__poster"
            onClick={() => setPlaying(videoId)}
            disabled={!online}
            aria-describedby={noteId}
            data-press="soft"
          >
            <span className="sbs-trailer__disc" aria-hidden="true">
              <Icon name="media-play" size={28} />
            </span>
            <span className="sbs-trailer__label">{t("trailer.play")}</span>
          </button>
        )}
      </div>
      {shown ? null : (
        <p id={noteId} className="sbs-note">
          {online ? t("trailer.privacy") : t("trailer.offline")}
        </p>
      )}
    </div>
  );
}
