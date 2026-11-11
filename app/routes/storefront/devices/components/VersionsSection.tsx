import { useId } from "react";

import { Icon } from "~/art/Icon";
import { LocaleLink, useFormat, useT } from "~/i18n/react";
import type { DeviceHub } from "~/server/services/devices.server";
import { cx } from "~/ui/cx";
import { Disclosure } from "~/ui/Disclosure";
import { EmptyState } from "~/ui/EmptyState";
import { Key } from "~/ui/Key";
import { ShelfRail } from "~/ui/ShelfRail";
import { Status } from "~/ui/Tag";
import { isolate, researchDate, SECTION_SCROLL_MARGIN } from "./format";

/**
 * Editions of the device (DESIGN.md §8.7 "Models"): the products that ARE this device as ordinary product cards
 * (price, stock state and the add key — prices and stock are demo placeholders, the shell's ribbon says so), then
 * the versions with the maker's model numbers and later release dates, the research notes a buyer should read first
 * (regions, accounts, what a version lacks), and the device's highlights and box contents.
 *
 * Version titles mix Arabic and Latin ("حزمة 2026: Switch 2 + Mario Kart World + …"): they are left to the Unicode
 * bidi algorithm as one text, which keeps "Switch 2 + Mario Kart World" in order (isolating each Latin run would
 * leave the "+" between two isolates and swap them in RTL).
 */
export function VersionsSection({ hub }: { hub: DeviceHub }) {
  const t = useT("devices");
  const f = useFormat();
  const titleId = useId();
  const device = isolate(hub.model.name);
  const versionNotes = hub.versions.filter((version) => version.note);
  // the device's own product note first and open; the notes of bundles and editions fold away with the version notes
  const [mainNote, ...otherNotes] = hub.notes;

  return (
    <div id="versions" className={cx("grid gap-5", SECTION_SCROLL_MARGIN)}>
      {hub.editions.length > 0 ? (
        <ShelfRail
          shelf={{
            key: "versions",
            title: t("versions.title", { device }),
            reason: t("versions.reason"),
            items: hub.editions,
          }}
        />
      ) : (
        <section aria-labelledby={titleId} className="grid gap-3">
          <h2 id={titleId} className="type-section text-ink">
            {t("versions.title", { device })}
          </h2>
          <EmptyState
            title={t("versions.none")}
            text={t("versions.noneHint")}
            action={
              hub.used.length > 0 ? (
                <Key as="a" href="#used" size="sm">
                  {t("nav.used")}
                </Key>
              ) : undefined
            }
          />
        </section>
      )}

      {/* reading width for the table and the notes on wide screens */}
      <div className="grid gap-5 lg:max-w-4xl">
        {hub.versions.length > 0 ? (
          <div className="grid gap-2">
            <h3 className="type-sub text-ink">{t("versions.table")}</h3>
            <div className="panel panel--paper relative overflow-x-auto">
              <table className="w-full border-collapse">
                <thead>
                  <tr className="border-b border-line-strong">
                    <th scope="col" className="px-4 py-2.5 text-start type-label text-ink-2">
                      {t("versions.version")}
                    </th>
                    <th scope="col" className="px-4 py-2.5 text-start type-label text-ink-2">
                      {t("versions.model")}
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {hub.versions.map((version) => {
                    const later = researchDate(version.releaseDate, f);
                    return (
                      <tr key={version.variantId} className="border-b border-line last:border-b-0">
                        <td className="px-4 py-2 align-top">
                          <LocaleLink to={`/p/${version.productSlug}`} className="flex min-h-11 items-center type-strong text-ink hover:underline">
                            <span>{version.title}</span>
                          </LocaleLink>
                          {later ? (
                            <Status tone="info" className="pb-2">
                              {t("versions.comesOut", { date: later.text })}
                            </Status>
                          ) : null}
                        </td>
                        <td className="px-4 py-2 align-top">
                          <span className="flex min-h-11 items-center">
                            {version.modelNumber ? (
                              <bdi dir="ltr" className="nums whitespace-nowrap type-body text-ink">
                                {version.modelNumber}
                              </bdi>
                            ) : (
                              <span className="type-caption text-ink-2">{t("versions.noModel")}</span>
                            )}
                          </span>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </div>
        ) : null}

        {mainNote ? (
          <div className="grid gap-2">
            <h3 className="type-sub text-ink">{t("versions.notes")}</h3>
            <div className="panel flex items-start gap-3 p-4">
              <Icon name="info" size={20} className="mt-0.5 shrink-0 text-info" />
              <p className="min-w-0 type-body text-ink">{mainNote.text}</p>
            </div>
          </div>
        ) : null}

        {otherNotes.length + versionNotes.length > 0 ? (
          <Disclosure summary={t("versions.versionNotes")} icon="info" variant="panel">
            <ul role="list" className="grid gap-3">
              {otherNotes.map((note) => (
                <li key={note.productSlug} className="grid gap-0.5">
                  <span className="type-strong text-ink">{note.productName}</span>
                  <span className="type-caption text-ink-2">{note.text}</span>
                </li>
              ))}
              {versionNotes.map((version) => (
                <li key={version.variantId} className="grid gap-0.5">
                  <span className="type-strong text-ink">{version.title}</span>
                  <span className="type-caption text-ink-2">{version.note}</span>
                </li>
              ))}
            </ul>
          </Disclosure>
        ) : null}

        {hub.highlights.length > 0 ? (
          <Disclosure summary={t("versions.highlights")} icon="sparkle" variant="panel">
            <ul role="list" className="grid gap-1.5">
              {hub.highlights.map((item, index) => (
                <li key={index} className="flex items-start gap-2 type-body text-ink">
                  <Icon name="check" size={16} className="mt-1.5 shrink-0 text-ink-2" />
                  <span>{item}</span>
                </li>
              ))}
            </ul>
          </Disclosure>
        ) : null}
      </div>
    </div>
  );
}
