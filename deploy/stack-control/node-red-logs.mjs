import { stripVTControlCharacters } from "node:util";

const PATH =
  "/containers/nova-node-red/logs?stdout=1&stderr=1&timestamps=1&tail=100&follow=0";
const MAX_BYTES = 64 * 1024;
const MAX_ROWS = 100;
const MAX_TEXT = 2048;

function timestamp(value) {
  const match =
    /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,9})?(Z|[+-]\d{2}:\d{2})$/.exec(
      value,
    );
  if (!match) throw new Error();
  const [, year, month, day, hour, minute, second, zone] = match;
  const calendar = new Date(0);
  calendar.setUTCFullYear(Number(year), Number(month) - 1, Number(day));
  if (
    Number(year) < 1 ||
    calendar.getUTCFullYear() !== Number(year) ||
    calendar.getUTCMonth() !== Number(month) - 1 ||
    calendar.getUTCDate() !== Number(day) ||
    Number(hour) > 23 ||
    Number(minute) > 59 ||
    Number(second) > 59 ||
    (zone !== "Z" &&
      (Number(zone.slice(1, 3)) > 23 || Number(zone.slice(4, 6)) > 59))
  )
    throw new Error();
  const parsed = new Date(value);
  if (!Number.isFinite(parsed.getTime())) throw new Error();
  return parsed.toISOString();
}

/** Fixed read-only, bounded Docker log snapshot. No caller-controlled identity or options. */
export async function readNodeRedLogs(docker) {
  try {
    const raw = await docker(PATH, "GET", undefined, {
      raw: true,
      maxBytes: MAX_BYTES,
      timeoutMs: 5000,
    });
    if (!Buffer.isBuffer(raw) || raw.length > MAX_BYTES) throw new Error();
    const streams = new Map(
      [1, 2].map((id) => [
        id,
        { decoder: new TextDecoder("utf-8", { fatal: true }), pending: "" },
      ]),
    );
    const entries = [];
    let truncated = false;
    const row = (line, id) => {
      const separator = line.indexOf(" ");
      if (separator === -1) throw new Error();
      const at = timestamp(line.slice(0, separator));
      let text = [...stripVTControlCharacters(line.slice(separator + 1))]
        .filter((char) => {
          const code = char.codePointAt(0);
          return code >= 32 && (code < 127 || code > 159);
        })
        .join("");
      const shortened = text.length > MAX_TEXT;
      if (shortened) {
        text = text.slice(0, MAX_TEXT);
        // Preserve complete Unicode characters at the UTF-16 bound.
        if (/[\uD800-\uDBFF]$/.test(text)) text = text.slice(0, -1);
        truncated = true;
      }
      entries.push({
        at,
        stream: id === 1 ? "stdout" : "stderr",
        text,
        ...(shortened ? { truncated: true } : {}),
      });
      if (entries.length > MAX_ROWS) {
        entries.shift();
        truncated = true;
      }
    };
    const consume = (id, text) => {
      const state = streams.get(id);
      state.pending += text;
      let end;
      while ((end = state.pending.indexOf("\n")) !== -1) {
        row(state.pending.slice(0, end), id);
        state.pending = state.pending.slice(end + 1);
      }
    };
    for (let offset = 0; offset < raw.length;) {
      if (raw.length - offset < 8) throw new Error();
      const id = raw[offset];
      if (
        !streams.has(id) ||
        raw[offset + 1] !== 0 ||
        raw[offset + 2] !== 0 ||
        raw[offset + 3] !== 0
      )
        throw new Error();
      const length = raw.readUInt32BE(offset + 4);
      offset += 8;
      if (length > raw.length - offset) throw new Error();
      consume(
        id,
        streams.get(id).decoder.decode(raw.subarray(offset, offset + length), {
          stream: true,
        }),
      );
      offset += length;
    }
    for (const [id, state] of streams) {
      consume(id, state.decoder.decode());
      if (state.pending) row(state.pending, id);
    }
    return { entries, limited: true, truncated };
  } catch {
    // Docker errors and malformed payloads can contain private operational data.
    throw new Error("Node-RED logs unavailable");
  }
}
