/**
 * /about — what TamTam is and how it works, without invented history, numbers or awards (Design System v2 §6.15).
 *
 *   head        the h1 and the lead, in the 720px reading column (a published CMS "about" page replaces the lead)
 *   doors       «ما تجده هنا»: four kit EntryCards (new, used & inspected, trade-in, support), 2 × 2 from 768; the art is
 *               each platform's own hardware photo from the shell's navigation, the support door the mascot
 *   how we work «كيف نعمل»: the kit's fact rows from the store's settings (delivery fee, payment methods switched on,
 *               manual transfer checks) and its fixed rules (guest checkout, compatibility, photos, no invented reviews)
 *   aside       (≥1024 beside the facts) the platforms with products · the store's contact card, or «اكتب لموظف» while
 *               it has published no channel · «اعرف أكثر» rows (policies, /contact once a channel exists,
 *               accessibility — never the hand-off again under its own card: `aboutLinks`)
 *
 * No red key: the doors are the way forward. The store's photo, address and hours appear only when supplied (the
 * contact card shows the address and hours; no store photo exists yet).
 */
import type { Route } from "./+types/about";
import { serverT } from "~/i18n/i18n.server";
import { LocaleLink, useFormat, useLocale, useT } from "~/i18n/react";
import { LOCALES } from "~/lib/locales";
import { usePlatformName } from "~/routes/storefront/shell/MegaMenu";
import { shellMeta } from "~/routes/storefront/shell/meta";
import { getCtx } from "~/server/context.server";
import { getDb } from "~/server/db.server";
import { contentMessages, getCmsText, getContactDetails, getStoreFacts } from "~/server/services/content.server";
import { Blocks } from "~/ui/Blocks";
import { ContactCard } from "~/ui/ContactCard";
import { EntryCard } from "~/ui/EntryCard";
import { FactList, type Fact } from "~/ui/FactList";
import { PlatformLed, isPlatform, type Platform } from "~/ui/PlatformLed";
import { revealProps } from "~/ui/reveal";
import { aboutLinks, type AboutLink } from "./content-model";
import { ContentHeader, Section, useShellNav } from "./components/ContentHeader";
import { useMethodList } from "./components/FactPanel";
import { HandoffCard } from "./components/HandoffCard";
import { LinkRows, type LinkRow } from "./components/LinkRows";
import "./content.css";

export async function loader({ context }: Route.LoaderArgs) {
  const ctx = getCtx(context);
  const db = getDb();
  const [facts, cms, contact] = await Promise.all([getStoreFacts(db, ctx.locale), getCmsText(db, ctx.locale, "about", { now: ctx.now }), getContactDetails(db, ctx.locale)]);
  const t = serverT(ctx.locale, "content");
  return {
    facts,
    cms,
    card: contact.card,
    hasContact: !contact.isEmpty && (contact.card !== null || contact.channels.length > 0),
    meta: { title: cms?.title ?? t("about.title"), description: t("about.metaDescription") },
    i18n: contentMessages(ctx.locale),
  };
}

export const meta: Route.MetaFunction = (args) => shellMeta(args, args.loaderData?.meta);

type Door = { key: "new" | "used" | "tradeIn" | "support"; to: string; art: Platform | "mascot" };

/** Each door shows a different platform's hardware, so the four platforms appear once; support shows the mascot. */
const DOORS: Door[] = [
  { key: "new", to: "/", art: "nintendo" },
  { key: "used", to: "/used", art: "xbox" },
  { key: "tradeIn", to: "/trade-in", art: "playstation" },
  { key: "support", to: "/support", art: "mascot" },
];

export default function AboutPage({ loaderData }: Route.ComponentProps) {
  const { facts, cms, card, hasContact } = loaderData;
  const t = useT("content");
  const f = useFormat();
  const locale = useLocale();
  const nav = useShellNav();
  const nameOf = usePlatformName();
  const methodList = useMethodList();
  const platforms = (nav?.platforms ?? []).filter((platform) => platform.productCount > 0);
  const artOf = (platform: Platform) => (nav?.platforms ?? []).find((item) => item.accent === platform)?.artKey ?? null;
  const cmsLang = cms && cms.textLocale !== locale ? { lang: LOCALES[cms.textLocale].bcp47, dir: LOCALES[cms.textLocale].dir } : {};

  const fee = `⁨${f.iqd(facts.deliveryFeeIqd)}⁩`;
  const how: Fact[] = [
    facts.deliveryVaries
      ? { id: "delivery", icon: "truck", title: t("about.how.deliveryVaries.title"), text: t("about.how.deliveryVaries.text") }
      : { id: "delivery", icon: "truck", title: <span className="nums">{t("about.how.delivery.title", { fee })}</span>, text: t("about.how.delivery.text") },
    { id: "guest", icon: "user", title: t("about.how.guest.title"), text: t("about.how.guest.text") },
    ...(facts.payments.length > 0 ? [{ id: "payments", icon: "money" as const, title: t("about.how.payments.title"), text: t("about.how.payments.text", { methods: methodList(facts.payments) }) }] : []),
    ...(facts.transfersChecked ? [{ id: "transfers", icon: "seal-check" as const, title: t("about.how.transfers.title"), text: t("about.how.transfers.text") }] : []),
    { id: "compat", icon: "check-circle", title: t("about.how.compat.title"), text: t("about.how.compat.text") },
    { id: "photos", icon: "image", title: t("about.how.photos.title"), text: t("about.how.photos.text") },
    { id: "reviews", icon: "star", title: t("about.how.reviews.title") },
    { id: "languages", icon: "translate", title: t("about.how.languages.title"), text: t("about.how.languages.text") },
  ];

  const rows: Record<AboutLink, LinkRow> = {
    policies: { to: "/policies", icon: "file-text", title: t("links.policies"), hint: t("links.policiesHint") },
    contact: { to: "/contact", icon: "chat-circle", title: t("links.contact"), hint: t("links.contactHint") },
    accessibility: { to: "/accessibility", icon: "eye", title: t("links.accessibility"), hint: t("links.accessibilityHint") },
  };
  const more = aboutLinks(hasContact).map((link) => rows[link]);

  return (
    <div className="page cpage">
      <ContentHeader
        crumbs={[{ label: t("common.home"), href: "/" }, { label: cms?.title ?? t("about.title") }]}
        title={cms ? <span {...cmsLang}>{cms.title}</span> : t("about.title")}
        lead={cms ? undefined : t("about.lead")}
      />
      {cms ? (
        <div {...cmsLang} className="ccol">
          <Blocks blocks={cms.blocks} />
        </div>
      ) : null}

      <Section id="about-offer" title={t("about.offerTitle")}>
        <ul className="centries" {...revealProps({ stagger: true })}>
          {DOORS.map((door) => {
            const art = door.art === "mascot" ? "mascot" : (artOf(door.art) ?? "mascot");
            return (
              <li key={door.key} className="grid">
                <EntryCard to={door.to} title={t(`about.offer.${door.key}.title`)} text={t(`about.offer.${door.key}.text`)} cta={t(`about.offer.${door.key}.cta`)} art={art} />
              </li>
            );
          })}
        </ul>
      </Section>

      <div className="csplit">
        <Section id="about-how" title={t("about.howTitle")} reveal>
          <FactList facts={how} />
        </Section>

        <div className="csplit__aside">
          {platforms.length > 0 ? (
            <Section id="about-platforms" title={t("about.platformsTitle")} size="sm" reveal>
              <ul className="cplats">
                {platforms.map((platform) => (
                  <li key={platform.slug}>
                    <LocaleLink to={platform.href} className="link" data-gel={isPlatform(platform.accent) ? platform.accent : undefined}>
                      {isPlatform(platform.accent) ? <PlatformLed /> : null}
                      <span className="link__text">{nameOf(platform)}</span>
                    </LocaleLink>
                  </li>
                ))}
              </ul>
            </Section>
          ) : null}

          {card ? (
            <Section id="about-contact" title={t("about.contactTitle")} size="sm" reveal>
              <ContactCard channels={card} />
            </Section>
          ) : (
            <HandoffCard id="about-handoff" stack reveal />
          )}

          <Section id="about-more" title={t("about.moreTitle")} size="sm" reveal>
            <LinkRows rows={more} />
          </Section>
        </div>
      </div>
    </div>
  );
}
