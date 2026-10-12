const VIDEO_ID = /^[A-Za-z0-9_-]{11}$/;
const TIME_RANGE =
  /^(?:\d{2}:)?\d{2}:\d{2}\.\d{3}\s+-->\s+(?:\d{2}:)?\d{2}:\d{2}\.\d{3}(?:\s|$)/;

/** Accept only a YouTube video ID or a normal video link, never an arbitrary URL. */
export function youtubeVideoId(input: unknown): string | null {
  if (typeof input !== "string") return null;
  const value = input.trim();
  if (VIDEO_ID.test(value)) return value;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  if (url.protocol !== "https:" || url.username || url.password || url.port)
    return null;
  const host = url.hostname.toLowerCase();
  let id: string | undefined;
  if (["youtube.com", "www.youtube.com", "m.youtube.com"].includes(host)) {
    if (url.pathname === "/watch") {
      const values = url.searchParams.getAll("v");
      if (values.length === 1) id = values[0];
    } else {
      const match = /^\/(?:shorts|live)\/([A-Za-z0-9_-]{11})\/?$/.exec(
        url.pathname,
      );
      id = match?.[1];
    }
  } else if (host === "youtu.be" || host === "www.youtu.be") {
    id = /^\/([A-Za-z0-9_-]{11})\/?$/.exec(url.pathname)?.[1];
  }
  return id && VIDEO_ID.test(id) ? id : null;
}

export interface CaptionTrack {
  id: string;
  language: string;
  name: string;
  trackKind: string;
}

export function captionTracks(value: unknown): CaptionTrack[] {
  if (!value || typeof value !== "object" || Array.isArray(value)) return [];
  const items = (value as { items?: unknown }).items;
  if (!Array.isArray(items)) return [];
  return items.slice(0, 100).flatMap((item) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) return [];
    const row = item as { id?: unknown; snippet?: unknown };
    if (!row.snippet || typeof row.snippet !== "object") return [];
    const snippet = row.snippet as Record<string, unknown>;
    if (
      typeof row.id !== "string" ||
      row.id.length < 1 ||
      row.id.length > 200 ||
      typeof snippet.language !== "string" ||
      !/^[A-Za-z]{2,3}(?:-[A-Za-z0-9]{2,8})*$/.test(snippet.language)
    )
      return [];
    return [
      {
        id: row.id,
        language: snippet.language,
        name:
          typeof snippet.name === "string" ? snippet.name.slice(0, 100) : "",
        trackKind:
          typeof snippet.trackKind === "string" ? snippet.trackKind : "",
      },
    ];
  });
}

export function chooseCaptionTrack(
  tracks: CaptionTrack[],
  language?: string,
): CaptionTrack | null {
  const candidates = language
    ? tracks.filter(
        (track) => track.language.toLowerCase() === language.toLowerCase(),
      )
    : tracks;
  if (!candidates.length) return null;
  const preferred = language
    ? candidates
    : [
        ...candidates.filter((track) => track.language.toLowerCase() === "nl"),
        ...candidates.filter((track) => track.language.toLowerCase() === "en"),
        ...candidates,
      ];
  return (
    preferred.find((track) => track.trackKind !== "ASR") ?? preferred[0] ?? null
  );
}

const decodeEntity = (value: string): string =>
  value.replace(
    /&(#(?:x[0-9a-f]+|\d+)|amp|lt|gt|quot|apos|nbsp);/gi,
    (whole, entity: string) => {
      const named: Record<string, string> = {
        amp: "&",
        lt: "<",
        gt: ">",
        quot: '"',
        apos: "'",
        nbsp: " ",
      };
      if (entity[0] !== "#") return named[entity.toLowerCase()] ?? whole;
      const hex = entity[1]?.toLowerCase() === "x";
      const number = Number.parseInt(entity.slice(hex ? 2 : 1), hex ? 16 : 10);
      return Number.isInteger(number) &&
        number > 0 &&
        number <= 0x10ffff &&
        !(number >= 0xd800 && number <= 0xdfff)
        ? String.fromCodePoint(number)
        : whole;
    },
  );

/** VTT cue text is untrusted source material. Keep only spoken cue lines, bounded for the model. */
export function parseCaptionVtt(
  vtt: string,
  maxCharacters = 50_000,
): { text: string; cueCount: number; truncated: boolean } {
  const blocks = vtt
    .replace(/^\uFEFF/, "")
    .replace(/\r\n?/g, "\n")
    .split(/\n\s*\n/);
  const lines: string[] = [];
  let cueCount = 0;
  let length = 0;
  let truncated = false;
  for (const block of blocks) {
    const rows = block.split("\n");
    if (/^(?:WEBVTT|NOTE|STYLE|REGION)(?:\s|$)/.test(rows[0]?.trim() ?? ""))
      continue;
    const index = rows.findIndex((row) => TIME_RANGE.test(row.trim()));
    if (index < 0) continue;
    cueCount++;
    const cue = rows
      .slice(index + 1)
      .map((row) =>
        decodeEntity(row.replace(/<[^>]*>/g, ""))
          .replace(/\s+/g, " ")
          .trim(),
      )
      .filter(Boolean)
      .join(" ");
    if (!cue) continue;
    const remaining = maxCharacters - length - (lines.length ? 1 : 0);
    if (remaining <= 0) {
      truncated = true;
      break;
    }
    lines.push(cue.slice(0, remaining));
    length += Math.min(cue.length, remaining) + (lines.length > 1 ? 1 : 0);
    if (cue.length > remaining) {
      truncated = true;
      break;
    }
  }
  return { text: lines.join("\n"), cueCount, truncated };
}
