/* Text helpers for pages, feeds and search results. Anything fetched is untrusted text. */

const ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
  ndash: "–",
  mdash: "—",
  hellip: "…",
  euro: "€",
};

export function decodeEntities(value: unknown): string {
  return String(value)
    .replace(/&#x([0-9a-f]+);/gi, (_, hex: string) =>
      String.fromCodePoint(parseInt(hex, 16)),
    )
    .replace(/&#(\d+);/g, (_, number: string) =>
      String.fromCodePoint(Number(number)),
    )
    .replace(
      /&([a-z]+);/gi,
      (match, name: string) => ENTITIES[name.toLowerCase()] ?? match,
    );
}

/** Inline tags vanish without a gap, so "<b>Friesland</b>." stays "Friesland.". */
export const clean = (value: unknown): string =>
  decodeEntities(String(value).replace(/<[^>]+>/g, ""))
    .replace(/\s+/g, " ")
    .trim();

export function htmlToText(html: string): { title: string; text: string } {
  const title = clean(/<title[^>]*>([\s\S]*?)<\/title>/i.exec(html)?.[1] ?? "");
  let body =
    /<article[\s\S]*?<\/article>/i.exec(html)?.[0] ??
    /<main[\s\S]*?<\/main>/i.exec(html)?.[0] ??
    /<body[\s\S]*?<\/body>/i.exec(html)?.[0] ??
    html;
  body = body
    .replace(
      /<(script|style|noscript|svg|nav|header|footer|aside|form|iframe)\b[\s\S]*?<\/\1>/gi,
      " ",
    )
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(
      /<\/(p|div|li|h[1-6]|tr|td|th|section|blockquote)>|<br\s*\/?>/gi,
      "\n",
    );
  const text = decodeEntities(body.replace(/<[^>]+>/g, ""))
    .split("\n")
    .map((line) => line.replace(/\s+/g, " ").trim())
    .filter(Boolean)
    .join("\n");
  return { title, text };
}

/** A story is told in one short sentence; the model retells what it is given. */
export function firstSentence(text: unknown, max: number): string {
  const trimmed = String(text || "").trim();
  const end = trimmed.search(/[.!?](?:\s|$)/);
  const sentence =
    end > 0 && end < max ? trimmed.slice(0, end + 1) : trimmed.slice(0, max);
  return sentence.length < trimmed.length && sentence === trimmed.slice(0, max)
    ? `${sentence.trimEnd()}…`
    : sentence;
}
