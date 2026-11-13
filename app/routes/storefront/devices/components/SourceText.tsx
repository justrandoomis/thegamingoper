import { sourceLang } from "./format";

/**
 * A research source's title (or publisher) as ONE isolate in its own language and direction (format.ts sourceLang):
 * an Arabic title on an English or Sorani page, a Japanese one on any page, an English one on an Arabic page — each is
 * read with its own voice and keeps its own order, and a title that wraps stays one run. `lead` (the publisher before
 * the title, «IGN Middle East — شركة Valve تعلن…») sits inside it as an isolate of its own language: the line reads in
 * the title's direction, publisher first. Used by the hub's sources (SpecSection) and the product page's
 * (product/components/Details).
 *
 *   <SourceText text={source.title} />                              «Nintendo Switch 2 – Tech specs»
 *   <SourceText text={source.title} lead={source.publisher} />      «Nintendo of America — Nintendo Switch 2 Tech Specs»
 */
export function SourceText({ text, lead }: { text: string; lead?: string | null }) {
  const own = sourceLang(text);
  return (
    <bdi lang={own?.lang} dir={own?.dir}>
      {lead ? (
        <>
          <SourceText text={lead} />
          {" — "}
        </>
      ) : null}
      {text}
    </bdi>
  );
}
