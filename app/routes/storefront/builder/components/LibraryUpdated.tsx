/**
 * «حدّثنا قائمة الألعاب» — the game list this page was loaded with is gone. A deploy publishes a newer list and deletes
 * the old content-hashed files (public/library/switch/list.<hash>.json and d/<n>.<hash>.json), so a page opened before
 * it asks for files that answer 404 (../lib/use-library isLibraryUpdated). Only a reload reads the new manifest; the
 * plan is safe in this browser (localStorage). Said plainly, with the one key that helps — never the generic "did not
 * load" with a retry that would ask for the same missing file again.
 *
 *   <LibraryUpdated />          a note (the games step in place of the list, above the list, the review's notes)
 *   reloadPage()                the key's action (also the toast's, when a details chunk is gone under an open sheet)
 */
import { Key } from "~/ui/Key";
import { Note } from "~/ui/Note";
import { useBuilderT } from "../lib/format";

/** A fresh copy of the page: the new manifest, the new list. */
export function reloadPage(): void {
  window.location.reload();
}

export function LibraryUpdated({ className }: { className?: string }) {
  const t = useBuilderT();
  return (
    <Note
      tone="info"
      icon="arrows-clockwise"
      title={t("updated.title")}
      action={
        <Key size="sm" icon="arrows-clockwise" onClick={reloadPage}>
          {t("updated.reload")}
        </Key>
      }
      className={className}
    >
      {t("updated.text")}
    </Note>
  );
}
