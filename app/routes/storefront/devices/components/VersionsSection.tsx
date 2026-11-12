import { useId } from "react";

import { Icon } from "~/art/Icon";
import { LocaleLink, useFormat, useT } from "~/i18n/react";
import type { DeviceHub } from "~/server/services/devices.server";
import { Blocks } from "~/ui/Blocks";
import { Disclosure } from "~/ui/Disclosure";
import { SectionHead } from "~/ui/SectionHead";
import { Status } from "~/ui/Tag";
import { CardGrid } from "./CardGrid";
import { deviceIn, researchDate } from "./format";

/**
 * Editions of the device — v2 §6.6 "versions (cards)": the products that ARE this device as the kit's cards (prices
 * and stock are demo placeholders under the shell's demo marking; one edition → a row card), then the versions with
 * the maker's model numbers and later release dates (a paper table), the research note a buyer should read first as
 * a «قبل أن تشتري» callout (a 3px warn bar), and, folded, the notes of the other editions and the device's highlights.
 * A device the store does not sell new keeps the table and the note; with none of these the section is not drawn.
 *
 * Version titles mix Arabic and Latin ("حزمة 2026: Switch 2 + Mario Kart World + …"): they are left to the Unicode
 * bidi algorithm as one text, which keeps "Switch 2 + Mario Kart World" in order (isolating each Latin run would
 * leave the "+" between two isolates and swap them in RTL).
 */
export function VersionsSection({ hub }: { hub: DeviceHub }) {
  const t = useT("devices");
  const f = useFormat();
  const titleId = useId();
  const tableId = useId();
  const device = deviceIn(hub.model.name);
  const sold = hub.editions.length > 0;
  // the device's own product note first and open; the notes of bundles and editions fold away with the version notes
  const [mainNote, ...otherNotes] = hub.notes;
  const versionNotes = hub.versions.filter((version) => version.note);
  if (!sold && hub.versions.length === 0 && !mainNote) return null;

  return (
    <section id="versions" aria-labelledby={titleId} className="min-w-0">
      <SectionHead id={titleId} title={t("versions.title", { device })} reason={sold ? t("versions.reason") : t("versions.reasonNone")} />
      {sold ? (
        <div data-shelf="versions">
          <CardGrid items={hub.editions.map((card) => ({ card }))} slot="versions" anchor="versions" allLabel={t("versions.all", { n: f.number(hub.editions.length) })} />
        </div>
      ) : null}

      {hub.versions.length > 0 || mainNote ? (
        <div className="mt-8 grid items-start gap-card lg:grid-cols-2">
          {hub.versions.length > 0 ? (
            <section aria-labelledby={tableId} className="grid min-w-0 gap-3">
              <h3 id={tableId} className="type-h3 text-ink">
                {t("versions.table")}
              </h3>
              <div className="panel min-w-0 overflow-x-auto">
                <table className="devhub-table devhub-table--rows">
                  <thead>
                    <tr>
                      <th scope="col">{t("versions.version")}</th>
                      <th scope="col">{t("versions.model")}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {hub.versions.map((version) => {
                      const later = researchDate(version.releaseDate, f);
                      return (
                        <tr key={version.variantId}>
                          <td>
                            <LocaleLink to={`/p/${version.productSlug}`} className="devhub-table__link">
                              {version.title}
                            </LocaleLink>
                            {later ? (
                              <Status tone="soon" className="pb-2">
                                {t("versions.comesOut", { date: later.text })}
                              </Status>
                            ) : null}
                          </td>
                          <td>
                            <span className="flex min-h-11 items-center">
                              {version.modelNumber ? (
                                <bdi dir="ltr" className="nums whitespace-nowrap text-ink">
                                  {version.modelNumber}
                                </bdi>
                              ) : (
                                <span className="text-ink-2">{t("versions.noModel")}</span>
                              )}
                            </span>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </section>
          ) : null}
          {mainNote ? <Blocks blocks={[{ type: "callout", tone: "warning", title: t("versions.notes"), text: mainNote.text }]} /> : null}
        </div>
      ) : null}

      {otherNotes.length + versionNotes.length > 0 || hub.highlights.length > 0 ? (
        <div className="mt-(--gap-card) grid items-start gap-card lg:grid-cols-2">
          {otherNotes.length + versionNotes.length > 0 ? (
            <Disclosure summary={t("versions.versionNotes")} icon="info" variant="panel">
              <ul role="list" className="devhub-rows grid">
                {otherNotes.map((note) => (
                  <li key={note.productSlug} className="grid gap-0.5 py-3">
                    <span className="type-sm-strong text-ink">{note.productName}</span>
                    <span className="type-sm text-ink-2">{note.text}</span>
                  </li>
                ))}
                {versionNotes.map((version) => (
                  <li key={version.variantId} className="grid gap-0.5 py-3">
                    <span className="type-sm-strong text-ink">{version.title}</span>
                    <span className="type-sm text-ink-2">{version.note}</span>
                  </li>
                ))}
              </ul>
            </Disclosure>
          ) : null}
          {hub.highlights.length > 0 ? (
            <Disclosure summary={t("versions.highlights")} icon="sparkle" variant="panel">
              <ul role="list" className="grid gap-2">
                {hub.highlights.map((item, index) => (
                  <li key={index} className="flex items-start gap-2 type-sm text-ink">
                    <Icon name="check" size={16} className="mt-0.5 text-ok" />
                    <span>{item}</span>
                  </li>
                ))}
              </ul>
            </Disclosure>
          ) : null}
        </div>
      ) : null}
    </section>
  );
}
