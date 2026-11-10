/*
 * The small, safe picture of one tool step that the live activity windows show: the query and the
 * result titles of a search, a page's title and a short snippet, the tail of a command's output, a
 * device's new state. Everything passes through sanitize(), long tokens are masked, strings are cut,
 * and the whole preview stays under PREVIEW_MAX_BYTES. Full page bodies and raw arguments never leave.
 */
import type { NovaActionOverlay, ToolPreview } from "@nova/contracts";
import { sanitize } from "../core/security/sanitize.js";

export const PREVIEW_MAX_BYTES = 2048;

type Rec = Record<string, unknown>;

const rec = (value: unknown): Rec | null =>
  value && typeof value === "object" && !Array.isArray(value)
    ? (value as Rec)
    : null;

// A long run of letters and digits that is not plain hex (a hash) reads as a credential.
const LONG_TOKEN = /[A-Za-z0-9_\-+/=]{32,}/g;
const maskTokens = (text: string): string =>
  text.replace(LONG_TOKEN, (token) =>
    /[A-Za-z]/.test(token) &&
    /\d/.test(token) &&
    !/^[0-9a-f-]+$/i.test(token) &&
    !/^[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+$/.test(token)
      ? "[redacted]"
      : token,
  );

/** sanitize() plus the long-token mask: for text shown live (terminal output, typed text). */
export const maskSecrets = (text: string): string => maskTokens(sanitize(text));

/** One line of display text: sanitized, masked, control characters out, at most `max` characters. */
export function previewText(value: unknown, max: number): string {
  if (typeof value !== "string" && typeof value !== "number") return "";
  const clean = maskTokens(sanitize(String(value)))
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f\u007f]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return clean.length > max ? `${clean.slice(0, max - 1).trimEnd()}…` : clean;
}

/** Several lines (terminal output): keeps line breaks, keeps the last `max` characters. */
function previewTail(value: unknown, max: number, maxLines = 14): string {
  if (typeof value !== "string") return "";
  const lines = maskTokens(sanitize(value))
    .replace(/\r\n?/g, "\n")
    // eslint-disable-next-line no-control-regex
    .replace(/\u001b\[[0-9;?]*[A-Za-z]/g, "")
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, "")
    .split("\n")
    .map((line) => (line.length > 160 ? `${line.slice(0, 159)}…` : line));
  while (lines.length && !lines.at(-1)!.trim()) lines.pop();
  let text = lines.slice(-maxLines).join("\n");
  if (text.length > max) text = `…${text.slice(-(max - 1))}`;
  return text;
}

/** Only the host name of a URL; never its path, query or userinfo. */
export function previewDomain(value: unknown): string {
  if (typeof value !== "string") return "";
  try {
    const url = new URL(value.trim());
    if (!/^https?:$/.test(url.protocol)) return "";
    return url.hostname.replace(/^www\./, "").slice(0, 80);
  } catch {
    return "";
  }
}

const first = (source: Rec | null, keys: string[]): unknown => {
  if (!source) return undefined;
  for (const key of keys)
    if (source[key] !== undefined && source[key] !== null) return source[key];
  return undefined;
};

/** The payload the tool returned: `result` when present, else the result object itself. */
const payload = (result: Rec): Rec | null => rec(result.result) ?? result;

const searchHits = (list: unknown, max = 8) => {
  if (!Array.isArray(list)) return [];
  return list.slice(0, max).flatMap((item) => {
    const hit = rec(item);
    const title = previewText(first(hit, ["title", "name", "headline"]), 110);
    const domain =
      previewDomain(first(hit, ["url", "link", "href"])) ||
      previewText(first(hit, ["source", "domain"]), 60);
    return title ? [{ title, domain }] : [];
  });
};

const home = (name: string) => /^(ha_|home_)/.test(name);
const terminal = (name: string) => /^(termix_run_command|code_)/.test(name);
const page = (name: string) =>
  name === "web_read" ||
  name === "wikipedia" ||
  /^browser_(read|open|status|back|tab|click|click_confirmed|type|press|scroll)$/.test(
    name,
  );

/** The full address for a live browser window's address bar: http(s), no userinfo, tokens masked, capped. */
export function previewUrl(value: unknown): string {
  if (typeof value !== "string") return "";
  try {
    const url = new URL(value.trim());
    if (!/^https?:$/.test(url.protocol)) return "";
    url.username = "";
    url.password = "";
    const text = maskTokens(sanitize(url.href));
    return text.length > 600 ? "" : text;
  } catch {
    return "";
  }
}

/** Typed text as the owner may see it: something that looks like a password is shown as dots. */
export function previewTyped(value: unknown, secret = false): string {
  if (typeof value !== "string" || !value) return "";
  const looksSecret =
    secret ||
    (!/\s/.test(value) &&
      value.length >= 6 &&
      /[A-Za-z]/.test(value) &&
      /[^A-Za-z]/.test(value));
  if (looksSecret) return "•".repeat(Math.min(16, value.length));
  return previewText(value, 80);
}

const unit = (value: unknown, size: unknown) =>
  typeof value === "number" &&
  typeof size === "number" &&
  size > 0 &&
  Number.isFinite(value)
    ? Math.round(Math.min(1, Math.max(0, value / size)) * 1000) / 1000
    : undefined;

/** Where a browser click or typing landed, normalised to the page viewport. */
function browserAction(
  name: string,
  input: Rec,
  data: Rec | null,
): NovaActionOverlay | undefined {
  const point = rec(data?.point);
  const x = unit(point?.x, point?.vw);
  const y = unit(point?.y, point?.vh);
  const at = x !== undefined && y !== undefined ? { x, y } : {};
  if (name === "browser_click" || name === "browser_click_confirmed")
    return { kind: "click", ...at };
  if (name === "browser_type")
    return {
      kind: "type",
      ...at,
      text: previewTyped(input.text, data?.secret === true),
    };
  if (name === "browser_press")
    return { kind: "key", key: previewText(input.key, 20) };
  if (name === "browser_scroll") return { kind: "scroll" };
  return undefined;
}

/** What desktop_act did where, normalised to the last screenshot. */
function desktopAction(input: Rec, outcome: Rec): NovaActionOverlay {
  const pointer = rec(outcome.pointer);
  const at =
    typeof pointer?.x === "number" && typeof pointer.y === "number"
      ? { x: pointer.x, y: pointer.y }
      : {};
  const action = String(input.action ?? "");
  if (/click/.test(action)) return { kind: "click", ...at };
  if (action === "type")
    return { kind: "type", ...at, text: previewTyped(input.text) };
  if (action === "key") return { kind: "key", key: previewText(input.key, 30) };
  if (action === "scroll") return { kind: "scroll", ...at };
  return { kind: "move", ...at };
}
const search = (name: string) =>
  name === "web_search" ||
  name === "news_headlines" ||
  name === "browser_search";

/** What the step is about before it runs: the query, the domain, the command. Undefined when nothing safe. */
export function toolStartPreview(
  name: string,
  args: Rec | null | undefined,
): ToolPreview | undefined {
  const input = rec(args) ?? {};
  const built: ToolPreview | undefined = search(name)
    ? {
        kind: "search",
        query: previewText(first(input, ["query", "topic", "q"]), 160),
      }
    : page(name)
      ? {
          kind: "page",
          domain:
            previewDomain(input.url) ||
            (name === "wikipedia" ? "wikipedia.org" : ""),
          title: name === "wikipedia" ? previewText(input.query, 120) : "",
          ...(name.startsWith("browser_")
            ? { url: previewUrl(input.url) }
            : {}),
        }
      : name === "desktop_screenshot" || name === "desktop_act"
        ? { kind: "screen", question: previewText(input.question, 160) }
        : terminal(name)
          ? {
              kind: "terminal",
              host: previewText(input.host, 60),
              command:
                name === "termix_run_command"
                  ? previewText(input.command, 300)
                  : previewText(
                      [
                        name.replace(/^code_/, "").replace(/_/g, " "),
                        first(input, ["path", "query", "pattern", "project"]),
                      ]
                        .filter((part) => typeof part === "string" && part)
                        .join(" "),
                      200,
                    ),
            }
          : home(name)
            ? {
                kind: "data",
                title: previewText(
                  first(input, ["entity_id", "name", "area"]),
                  80,
                ),
              }
            : undefined;
  return built ? capPreview(built) : undefined;
}

/** What came back, in a form small enough to show and safe enough to send. */
export function toolResultPreview(
  name: string,
  args: Rec | null | undefined,
  result: unknown,
): ToolPreview | undefined {
  const outcome = rec(result);
  if (!outcome) return undefined;
  // Tool errors can carry upstream diagnostics; a failed step shows only that it failed.
  if (outcome.ok !== true) return undefined;
  const input = rec(args) ?? {};
  const data = payload(outcome);
  let built: ToolPreview | undefined;
  if (search(name)) {
    const list = first(data, ["results", "items", "links"]);
    const results = searchHits(list);
    built = {
      kind: "search",
      query: previewText(first(data, ["query", "topic"]) ?? input.query, 160),
      results,
      total: Array.isArray(list) ? list.length : results.length,
    };
  } else if (page(name)) {
    const text = first(data, ["text", "extract", "summary", "content"]);
    const browser = name.startsWith("browser_");
    const action = browser ? browserAction(name, input, data) : undefined;
    built = {
      kind: "page",
      title: previewText(first(data, ["title", "name"]), 120),
      domain:
        previewDomain(first(data, ["url", "link"])) ||
        previewDomain(input.url) ||
        (name === "wikipedia" ? "wikipedia.org" : ""),
      snippet: previewText(text, 360),
      ...(browser
        ? { url: previewUrl(first(data, ["url"]) ?? input.url) }
        : {}),
      ...(action ? { action } : {}),
    };
  } else if (name === "desktop_act") {
    built = { kind: "screen", action: desktopAction(input, outcome) };
  } else if (name === "desktop_screenshot") {
    built = {
      kind: "screen",
      question: previewText(input.question, 160),
      text: previewText(
        first(outcome, ["screenDescription", "description"]) ??
          first(data, ["screenDescription", "description"]),
        520,
      ),
    };
  } else if (terminal(name)) {
    const output = first(data, [
      "output",
      "stdout",
      "diff",
      "content",
      "text",
      "status",
    ]);
    const exit = first(data, ["exitCode", "code"]);
    built = {
      kind: "terminal",
      host: previewText(first(data, ["host"]) ?? input.host, 60),
      ...(Number.isInteger(exit) ? { exitCode: exit as number } : {}),
      output:
        typeof output === "string"
          ? previewTail(output, 900)
          : Array.isArray(output)
            ? previewTail(output.map(String).join("\n"), 900)
            : "",
    };
  } else {
    built = dataPreview(name, data);
  }
  return built ? capPreview(built) : undefined;
}

function dataPreview(name: string, data: Rec | null): ToolPreview | undefined {
  if (!data) return undefined;
  if (home(name)) {
    const attributes = rec(data.attributes);
    const state = previewText(data.state, 40);
    const unit = previewText(attributes?.unit_of_measurement, 12);
    const label = previewText(
      attributes?.friendly_name ?? data.entity_id ?? data.name,
      80,
    );
    if (!state && !label) return undefined;
    return {
      kind: "data",
      title: label,
      rows: state
        ? [{ label: "Status", value: unit ? `${state} ${unit}` : state }]
        : [],
    };
  }
  if (name.startsWith("proxmox_")) {
    const summary = rec(data.summary);
    if (summary) {
      const running = Array.isArray(summary.runningNames)
        ? summary.runningNames
        : [];
      const stopped = Array.isArray(summary.stoppedNames)
        ? summary.stoppedNames
        : [];
      return {
        kind: "data",
        title: `${previewText(summary.running, 6) || running.length} van ${previewText(summary.total, 6) || running.length + stopped.length} actief`,
        rows: [
          ...running.map((vm) => ({
            label: previewText(vm, 40),
            value: "aan",
          })),
          ...stopped.map((vm) => ({
            label: previewText(vm, 40),
            value: "uit",
          })),
        ]
          .filter((row) => row.label)
          .slice(0, 8),
      };
    }
    const label = previewText(first(data, ["name", "vmid"]), 60);
    const status = previewText(first(data, ["status", "qmpstatus"]), 30);
    return label || status
      ? {
          kind: "data",
          title: label,
          rows: status ? [{ label: "Status", value: status }] : [],
        }
      : undefined;
  }
  if (name === "weather_forecast") {
    const current = rec(data.current);
    const place = previewText(rec(data.location)?.name, 60);
    if (!current) return undefined;
    const temp =
      typeof current.temperature === "number"
        ? `${Math.round(current.temperature)}°`
        : "";
    return {
      kind: "data",
      title: place,
      rows: [
        ...(temp ? [{ label: "Nu", value: temp }] : []),
        ...(previewText(current.condition, 40)
          ? [{ label: "Lucht", value: previewText(current.condition, 40) }]
          : []),
        ...(typeof current.windKmh === "number"
          ? [{ label: "Wind", value: `${Math.round(current.windKmh)} km/u` }]
          : []),
      ],
    };
  }
  if (name.startsWith("calendar_")) {
    const events = Array.isArray(data.events) ? data.events : null;
    if (!events) return undefined;
    const next = rec(events[0]);
    return {
      kind: "data",
      title: events.length
        ? `${events.length} afspra${events.length === 1 ? "ak" : "ken"}`
        : "Geen afspraken",
      rows: next
        ? [
            {
              label:
                previewText(first(next, ["start", "date"]), 40) || "Volgende",
              value: previewText(first(next, ["summary", "title"]), 80),
            },
          ].filter((row) => row.value)
        : [],
    };
  }
  return undefined;
}

const bytes = (value: unknown) =>
  Buffer.byteLength(JSON.stringify(value), "utf8");

/** Shrink until the JSON fits: drop list items, then halve the longest strings. Empty fields go. */
export function capPreview(preview: ToolPreview): ToolPreview | undefined {
  const draft = JSON.parse(JSON.stringify(preview)) as Rec;
  for (const [key, value] of Object.entries(draft))
    if (value === "" || (Array.isArray(value) && !value.length))
      delete draft[key];
  for (let guard = 0; bytes(draft) > PREVIEW_MAX_BYTES && guard < 64; guard++) {
    const list = ["results", "rows"].find(
      (key) =>
        Array.isArray(draft[key]) && (draft[key] as unknown[]).length > 2,
    );
    if (list) {
      (draft[list] as unknown[]).pop();
      continue;
    }
    const key = ["output", "snippet", "text", "command", "query", "title"]
      .filter((name) => typeof draft[name] === "string")
      .sort(
        (a, b) => (draft[b] as string).length - (draft[a] as string).length,
      )[0];
    if (!key || (draft[key] as string).length < 16) {
      for (const name of ["results", "rows"]) delete draft[name];
      continue;
    }
    const text = draft[key] as string;
    draft[key] =
      key === "output"
        ? `…${text.slice(Math.ceil(text.length / 2))}`
        : `${text.slice(0, Math.floor(text.length / 2))}…`;
  }
  if (bytes(draft) > PREVIEW_MAX_BYTES) return undefined;
  return Object.keys(draft).length > 1 ? (draft as ToolPreview) : undefined;
}
