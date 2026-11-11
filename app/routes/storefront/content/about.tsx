/**
 * /about — what TamTam is and how it works, without invented history, numbers or awards. The "how we work" lines
 * come from the store's settings (delivery fee, the payment methods switched on, manual transfer checks), the
 * platforms from the storefront navigation (only platforms with products). When the owner publishes an "about" page
 * in the CMS (`pages`, kind "about", slug "about"), its text replaces the description; the live facts stay.
 */
import type { Route } from "./+types/about";
import { Icon, type IconName } from "~/art/Icon";
import { serverT } from "~/i18n/i18n.server";
import { LocaleLink, useFormat, useLocale, useT } from "~/i18n/react";
import { LOCALES } from "~/lib/locales";
import { MotionLink } from "~/motion";
import { usePlatformName } from "~/routes/storefront/shell/MegaMenu";
import { shellMeta } from "~/routes/storefront/shell/meta";
import { getCtx } from "~/server/context.server";
import { getDb } from "~/server/db.server";
import { contentMessages, getCmsText, getStoreFacts } from "~/server/services/content.server";
import { Blocks } from "~/ui/Blocks";
import { PlatformLed, isPlatform } from "~/ui/PlatformLed";
import { ContentHeader, Section, useShellNav } from "./components/ContentHeader";
import { useMethodList } from "./components/FactPanel";
import { LinkRows } from "./components/LinkRows";

export async function loader({ context }: Route.LoaderArgs) {
  const ctx = getCtx(context);
  const db = getDb();
  const [facts, cms] = await Promise.all([getStoreFacts(db, ctx.locale), getCmsText(db, ctx.locale, "about", { now: ctx.now })]);
  const t = serverT(ctx.locale, "content");
  return { facts, cms, meta: { title: cms?.title ?? t("about.title"), description: t("about.metaDescription") }, i18n: contentMessages(ctx.locale) };
}

export const meta: Route.MetaFunction = (args) => shellMeta(args, args.loaderData?.meta);

const OFFER: { key: "new" | "used" | "tradeIn" | "support" | "track"; to: string; icon: IconName }[] = [
  { key: "new", to: "/", icon: "game-controller" },
  { key: "used", to: "/used", icon: "recycle" },
  { key: "tradeIn", to: "/trade-in", icon: "swap" },
  { key: "support", to: "/support", icon: "wrench" },
  { key: "track", to: "/track", icon: "package" },
];

export default function AboutPage({ loaderData }: Route.ComponentProps) {
  const { facts, cms } = loaderData;
  const t = useT("content");
  const f = useFormat();
  const locale = useLocale();
  const nav = useShellNav();
  const nameOf = usePlatformName();
  const methodList = useMethodList();
  const platforms = (nav?.platforms ?? []).filter((platform) => platform.productCount > 0);
  const cmsLang = cms && cms.textLocale !== locale ? { lang: LOCALES[cms.textLocale].bcp47, dir: LOCALES[cms.textLocale].dir } : {};

  const how: { icon: IconName; text: string }[] = [
    { icon: "truck", text: facts.deliveryVaries ? t("about.how.deliveryVaries") : t("about.how.delivery", { fee: `⁨${f.iqd(facts.deliveryFeeIqd)}⁩` }) },
    { icon: "user", text: t("about.how.guest") },
    ...(facts.payments.length > 0 ? [{ icon: "money" as const, text: t("about.how.payments", { methods: methodList(facts.payments) }) }] : []),
    ...(facts.transfersChecked ? [{ icon: "seal-check" as const, text: t("about.how.transfers") }] : []),
    { icon: "check-circle", text: t("about.how.compat") },
    { icon: "image", text: t("about.how.photos") },
    { icon: "star", text: t("about.how.reviews") },
    { icon: "translate", text: t("about.how.languages") },
  ];

  return (
    <div className="page grid gap-12 pb-12 pt-4 md:pt-6">
      <ContentHeader
        crumbs={[{ label: t("common.home"), href: "/" }, { label: t("about.title") }]}
        title={cms ? <span {...cmsLang}>{cms.title}</span> : t("about.title")}
        lead={cms ? undefined : t("about.lead")}
      />
      {cms ? (
        <div {...cmsLang} className="-mt-6 max-w-[44rem]">
          <Blocks blocks={cms.blocks} />
        </div>
      ) : null}

      <Section id="about-offer" title={t("about.offerTitle")}>
        <ul className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {OFFER.map((item) => (
            <li key={item.key} className="grid">
              <MotionLink to={item.to} data-press="soft" className="group panel grid content-start gap-2 p-4 md:p-5">
                <span className="flex items-center gap-3">
                  <span className="grid size-10 shrink-0 place-items-center rounded-sm bg-paper text-ink">
                    <Icon name={item.icon} size={20} />
                  </span>
                  <span className="min-w-0 flex-1 type-strong text-ink decoration-[1.5px] underline-offset-[6px] group-hover:underline">{t(`about.offer.${item.key}.title`)}</span>
                  <Icon name="caret-right" size={18} className="shrink-0 text-ink-2" />
                </span>
                <span className="type-caption text-ink-2">{t(`about.offer.${item.key}.text`)}</span>
              </MotionLink>
            </li>
          ))}
        </ul>
      </Section>

      {platforms.length > 0 ? (
        <Section id="about-platforms" title={t("about.platformsTitle")}>
          <ul className="flex flex-wrap gap-x-6 gap-y-1">
            {platforms.map((platform) => (
              <li key={platform.slug} data-gel={isPlatform(platform.accent) ? platform.accent : undefined}>
                <LocaleLink to={platform.href} className="link">
                  {isPlatform(platform.accent) ? <PlatformLed solid /> : null}
                  <span className="link__text">{nameOf(platform)}</span>
                </LocaleLink>
              </li>
            ))}
          </ul>
        </Section>
      ) : null}

      <Section id="about-how" title={t("about.howTitle")} className="max-w-[44rem]">
        <ul className="grid gap-3">
          {how.map((line) => (
            <li key={line.icon} className="flex items-start gap-3">
              <Icon name={line.icon} size={20} className="mt-1 text-ink" />
              <span className="type-body text-ink nums">{line.text}</span>
            </li>
          ))}
        </ul>
      </Section>

      <Section id="about-more" title={t("about.moreTitle")} className="max-w-[44rem]">
        <LinkRows
          rows={[
            { to: "/policies", icon: "file-text", title: t("links.policies") },
            { to: "/contact", icon: "chat-circle", title: t("links.contact"), hint: t("links.contactHint") },
            { to: "/accessibility", icon: "eye", title: t("links.accessibility") },
          ]}
        />
      </Section>
    </div>
  );
}
