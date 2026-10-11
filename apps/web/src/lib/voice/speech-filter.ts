const DUTCH_CARDINALS = [
  "nul",
  "één",
  "twee",
  "drie",
  "vier",
  "vijf",
  "zes",
  "zeven",
  "acht",
  "negen",
  "tien",
  "elf",
  "twaalf",
  "dertien",
  "veertien",
  "vijftien",
  "zestien",
  "zeventien",
  "achttien",
  "negentien",
  "twintig",
  "eenentwintig",
  "tweeëntwintig",
  "drieëntwintig",
  "vierentwintig",
  "vijfentwintig",
  "zesentwintig",
  "zevenentwintig",
  "achtentwintig",
  "negenentwintig",
  "dertig",
  "eenendertig",
  "tweeëndertig",
  "drieëndertig",
  "vierendertig",
  "vijfendertig",
  "zesendertig",
  "zevenendertig",
  "achtendertig",
  "negenendertig",
  "veertig",
  "eenenveertig",
  "tweeënveertig",
  "drieënveertig",
  "vierenveertig",
  "vijfenveertig",
  "zesenveertig",
  "zevenenveertig",
  "achtenveertig",
  "negenenveertig",
  "vijftig",
  "eenenvijftig",
  "tweeënvijftig",
  "drieënvijftig",
  "vierenvijftig",
  "vijfenvijftig",
  "zesenvijftig",
  "zevenenvijftig",
  "achtenvijftig",
  "negenenvijftig",
] as const;
const DUTCH_MONTHS = [
  "januari",
  "februari",
  "maart",
  "april",
  "mei",
  "juni",
  "juli",
  "augustus",
  "september",
  "oktober",
  "november",
  "december",
] as const;

export interface PronunciationEntry {
  term: string;
  say: string;
}

const PRONUNCIATIONS_KEY = "novaPronunciations";

export function pronunciationEntries(): PronunciationEntry[] {
  try {
    const parsed: unknown = JSON.parse(
      localStorage.getItem(PRONUNCIATIONS_KEY) ?? "[]",
    );
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter(
        (entry): entry is PronunciationEntry =>
          entry !== null &&
          typeof entry === "object" &&
          typeof entry.term === "string" &&
          typeof entry.say === "string" &&
          entry.term.trim().length > 0 &&
          entry.term.length <= 80 &&
          entry.say.trim().length > 0 &&
          entry.say.length <= 120,
      )
      .slice(0, 100);
  } catch {
    return [];
  }
}

export function savePronunciationEntries(entries: PronunciationEntry[]): void {
  const safe = entries
    .filter(
      (entry) =>
        entry.term.trim().length > 0 &&
        entry.term.length <= 80 &&
        entry.say.trim().length > 0 &&
        entry.say.length <= 120,
    )
    .slice(0, 100);
  try {
    localStorage.setItem(PRONUNCIATIONS_KEY, JSON.stringify(safe));
  } catch {
    // The current session still works; browser storage can be unavailable.
  }
}

export function applyPronunciations(
  text: string,
  entries: PronunciationEntry[],
): string {
  return [...entries]
    .sort((left, right) => right.term.length - left.term.length)
    .reduce((result, entry) => {
      const term = entry.term.trim();
      const escaped = term.replace(/[\\^$.*+?()[\]{}|]/g, "\\$&");
      const expression = new RegExp(
        `(?<![\\p{L}\\p{N}_])${escaped}(?![\\p{L}\\p{N}_])`,
        "giu",
      );
      const replacement = entry.say
        .trim()
        .replace(/(?:https?:\/\/|www\.)[^\s<>]+/gi, "")
        .replace(/<[^>]*>|[`*_#]/g, "")
        .replace(
          /[\p{Extended_Pictographic}\p{Emoji_Presentation}\uFE0F\u200D]/gu,
          "",
        )
        .replace(/[\r\n\t]+/g, " ")
        .trim();
      return replacement ? result.replace(expression, replacement) : result;
    }, text);
}

/** Find a natural streaming boundary without letting a long sentence delay speech. */
export function speechChunkBoundary(
  text: string,
  maxLength = 180,
  minimumSentenceLength = 30,
): number {
  const sentence = /[.!?…]+["”')\]]*\s+|\n+/g;
  for (let match = sentence.exec(text); match; match = sentence.exec(text)) {
    if (match.index + match[0].length >= minimumSentenceLength)
      return match.index + match[0].length;
  }
  if (text.length <= maxLength) return -1;

  const clauses = /[,;—–][ \t]+/g;
  const candidates: number[] = [];
  for (let match = clauses.exec(text); match; match = clauses.exec(text)) {
    const end = match.index + match[0].length;
    if (end >= 80 && end <= maxLength) candidates.push(end);
    if (end > maxLength) break;
  }
  if (candidates.length) return candidates[candidates.length - 1]!;

  // A long sentence without a clause marker still needs bounded spoken latency.
  const wordEnd = text.lastIndexOf(" ", maxLength);
  return wordEnd >= 80 ? wordEnd + 1 : -1;
}

function spokenDate(year: number, month: number, day: number): string | null {
  if (year < 1900 || year > 9999 || month < 1 || month > 12) return null;
  const date = new Date(Date.UTC(year, month - 1, day));
  if (
    date.getUTCFullYear() !== year ||
    date.getUTCMonth() !== month - 1 ||
    date.getUTCDate() !== day
  )
    return null;
  return `${cardinalUnderThousand(day)} ${DUTCH_MONTHS[month - 1]} ${spokenYear(year)}`;
}

function spokenYear(year: number): string {
  if (year < 1000) return cardinalUnderThousand(year);
  if (year < 2000) {
    const century = Math.floor(year / 100);
    const remainder = year % 100;
    return `${cardinalUnderThousand(century)}honderd${remainder ? ` ${cardinalUnderThousand(remainder)}` : ""}`;
  }
  return cardinalBelowTrillion(year);
}

function naturalizeDates(text: string): string {
  const iso = text.replace(
    /(?<![\d/-])(\d{4})-(\d{2})-(\d{2})(?![\d/-])/g,
    (match, year: string, month: string, day: string) =>
      spokenDate(Number(year), Number(month), Number(day)) ?? match,
  );
  return iso.replace(
    /(?<!\d)(\d{1,2})[/-](\d{1,2})[/-](\d{4})(?!\d)/g,
    (match, day: string, month: string, year: string) =>
      spokenDate(Number(year), Number(month), Number(day)) ?? match,
  );
}

function naturalizeClockTimes(text: string): string {
  return text.replace(
    /(?<![\d.])([01]?\d|2[0-3]):([0-5]\d)(?:[ \t]*uur\b)?(?!\d|\.\d)/g,
    (_match, rawHour: string, rawMinute: string) => {
      const hour = Number(rawHour);
      const minute = Number(rawMinute);
      const hourWord = DUTCH_CARDINALS[hour] ?? rawHour;
      return minute === 0
        ? `${hourWord} uur`
        : `${hourWord} uur ${DUTCH_CARDINALS[minute] ?? rawMinute}`;
    },
  );
}

function naturalizeAmountsAndUnits(text: string): string {
  const amounts = text.replace(
    /€\s*(\d{1,3}(?:\.\d{3})*|\d+)(?:,(\d{2}))?(?!,\d)/g,
    (_match, euros: string, cents?: string) =>
      cents ? `${euros} euro en ${cents} cent` : `${euros} euro`,
  );
  return amounts
    .replace(/\b(\d+(?:,\d+)?)\s*°\s*C\b/gi, "$1 graden Celsius")
    .replace(
      /(?<![\w.])(\d+(?:[.,]\d+)?)\s*(kWh|kW|km|cm|mm|kg|mg|m|g|%)(?!\w)/gi,
      (_match, amount: string, rawUnit: string) => {
        const unit: Record<string, string> = {
          kwh: "kilowattuur",
          kw: "kilowatt",
          km: "kilometer",
          cm: "centimeter",
          mm: "millimeter",
          kg: "kilogram",
          mg: "milligram",
          m: "meter",
          g: "gram",
          "%": "procent",
        };
        return `${amount} ${unit[rawUnit.toLowerCase()] ?? rawUnit}`;
      },
    )
    .replace(/\bo\.a\./gi, "onder andere")
    .replace(/\bm\.a\.w\./gi, "met andere woorden")
    .replace(/\bbijv\./gi, "bijvoorbeeld")
    .replace(/\betc\./gi, "enzovoort");
}

function cardinalUnderThousand(value: number): string {
  if (value < DUTCH_CARDINALS.length)
    return DUTCH_CARDINALS[value] ?? String(value);
  const tensWords: Record<number, string> = {
    60: "zestig",
    70: "zeventig",
    80: "tachtig",
    90: "negentig",
  };
  const unitPrefixes = [
    "",
    "eenen",
    "tweeën",
    "drieën",
    "vieren",
    "vijfen",
    "zesen",
    "zevenen",
    "achten",
    "negenen",
  ];
  if (value < 100) {
    const tens = Math.floor(value / 10) * 10;
    return `${unitPrefixes[value % 10]}${tensWords[tens] ?? value}`;
  }
  const hundreds = Math.floor(value / 100);
  const hundredWord =
    hundreds === 1
      ? "honderd"
      : `${DUTCH_CARDINALS[hundreds] ?? hundreds}honderd`;
  const remainder = value % 100;
  return remainder
    ? `${hundredWord}${cardinalUnderThousand(remainder)}`
    : hundredWord;
}

function cardinalBelowTrillion(value: number): string {
  if (value < 1000) return cardinalUnderThousand(value);
  if (value < 1_000_000) {
    const thousands = Math.floor(value / 1000);
    const remainder = value % 1000;
    const prefix = `${thousands === 1 ? "" : cardinalUnderThousand(thousands)}duizend`;
    return remainder ? `${prefix} ${cardinalUnderThousand(remainder)}` : prefix;
  }
  const billions = Math.floor(value / 1_000_000_000);
  const millions = Math.floor((value % 1_000_000_000) / 1_000_000);
  const thousands = Math.floor((value % 1_000_000) / 1000);
  const remainder = value % 1000;
  const parts: string[] = [];
  if (billions)
    parts.push(
      `${billions === 1 ? "een" : cardinalUnderThousand(billions)} miljard`,
    );
  if (millions)
    parts.push(
      `${millions === 1 ? "een" : cardinalUnderThousand(millions)} miljoen`,
    );
  if (thousands)
    parts.push(
      `${thousands === 1 ? "" : cardinalUnderThousand(thousands)}duizend`,
    );
  if (remainder) parts.push(cardinalUnderThousand(remainder));
  return parts.join(" ");
}

function naturalizeCardinals(text: string): string {
  const abbreviations: Record<string, string> = {
    AI: "aa ie",
    API: "aa pee ie",
    CPU: "cee pee uu",
    DNS: "dee en es",
    HTTP: "haa tee tee pee",
    HTTPS: "haa tee tee pee es",
    IP: "ie pee",
    URL: "uu er el",
    USB: "uu es bee",
  };
  const withAbbreviations = text.replace(
    /\b(AI|API|CPU|DNS|HTTPS|HTTP|IP|URL|USB)\b/g,
    (match) => abbreviations[match] ?? match,
  );
  return withAbbreviations.replace(
    /(?<![\p{L}\p{N}/])(?<!\d-)(?<!\.)(\d{1,3}(?:\.\d{3})+|\d{1,12})(?![\p{L}\p{N}/-]|,\d|\.\d)/gu,
    (match) => {
      const value = Number(match.replace(/\./g, ""));
      return value < 1_000_000_000_000 ? cardinalBelowTrillion(value) : match;
    },
  );
}

function naturalizeTables(input: string): string {
  const lines = input.split("\n");
  const output: string[] = [];
  for (let index = 0; index < lines.length;) {
    const isPipeRow = (line: string) => /^\s*\|.*\|\s*$/.test(line.trim());
    if (!isPipeRow(lines[index] ?? "")) {
      output.push(lines[index] ?? "");
      index++;
      continue;
    }
    const start = index;
    while (index < lines.length && isPipeRow(lines[index] ?? "")) index++;
    const block = lines.slice(start, index);
    if (block.length < 2 || !block.some((line) => /-{3,}/.test(line))) {
      output.push(...block);
      continue;
    }
    const rows = block.map((line) =>
      line
        .trim()
        .replace(/^\|/, "")
        .replace(/\|$/, "")
        .split("|")
        .map((cell) => cell.trim()),
    );
    const headers = rows[0] ?? [];
    const data = rows
      .slice(1)
      .filter((row) => !row.every((cell) => /^:?-{3,}:?$/.test(cell)));
    output.push(
      data.length
        ? data
            .map(
              (row) =>
                row
                  .map((value, cell) =>
                    headers[cell] ? `${headers[cell]}: ${value}` : value,
                  )
                  .filter(Boolean)
                  .join("; ") + ".",
            )
            .join(" ")
        : headers.join(" "),
    );
  }
  return output.join("\n");
}

function naturalizeLists(input: string): string {
  return input.replace(
    /(?:^\s*(?:[-+*]|\d+[.)])\s+[^\n]*(?:\n|$)){1,}/gm,
    (list) =>
      list
        .split("\n")
        .map((line) => line.replace(/^\s*(?:[-+*]|\d+[.)])\s+/, "").trim())
        .filter(Boolean)
        .map((item) => (/[.!?]$/.test(item) ? item : `${item}.`))
        .join(" "),
  );
}

/** Convert chat markup to plain text suitable for speech synthesis. */
export function speechText(input: string): string {
  const structured = naturalizeLists(naturalizeTables(String(input || "")));
  const plain = structured
    // Keep a link's readable label, never announce its destination.
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/\[([^\]]+)\]\[[^\]]*\]/g, "$1")
    .replace(/^\s*\[[^\]]+\]:\s*\S+.*$/gm, "")
    // Tags and raw URLs do not make useful spoken content.
    .replace(/<[^>]*>/g, " ")
    .replace(/\b(?:https?:\/\/|www\.)[^\s<>]+/gi, " ")
    // Markdown structure and decoration.
    .replace(/^\s{0,3}#{1,6}\s+/gm, "")
    .replace(/^\s{0,3}>\s?/gm, "")
    .replace(/^\s*(?:[-+*]|\d+[.)])\s+/gm, "")
    .replace(/^\s*\|?(?:\s*:?-{3,}:?\s*\|)+\s*$/gm, "")
    .replace(/[|]/g, " ")
    .replace(/\*\*|__|~~|`/g, "")
    .replace(/[*_]/g, "")
    // Emoji and their presentation/joiner code points.
    .replace(
      /[\p{Extended_Pictographic}\p{Emoji_Presentation}\uFE0F\u200D]/gu,
      "",
    )
    .replace(/\u00A0/g, " ")
    .replace(/\bNOVA\b/g, "Nova")
    .replace(/[ \t]+/g, " ")
    .replace(/ *\n */g, "\n")
    .replace(/\s+([,.;:!?])/g, "$1")
    .replace(/\n+/g, " ")
    .replace(/\s{2,}/g, " ")
    .trim();
  const naturalized = naturalizeCardinals(
    naturalizeAmountsAndUnits(naturalizeClockTimes(naturalizeDates(plain))),
  );
  return applyPronunciations(naturalized, pronunciationEntries());
}
