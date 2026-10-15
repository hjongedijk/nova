import assert from "node:assert/strict";
import test from "node:test";
import { readNodeRedLogs } from "./node-red-logs.mjs";

const at = "2026-10-15T08:30:12.123456789Z";
const normalized = "2026-10-15T08:30:12.123Z";
function frame(text, id = 1) {
  const bytes = Buffer.isBuffer(text) ? text : Buffer.from(text);
  const header = Buffer.alloc(8);
  header[0] = id;
  header.writeUInt32BE(bytes.length, 4);
  return Buffer.concat([header, bytes]);
}
const read = (bytes) => readNodeRedLogs(async () => bytes);
const rejects = (bytes) =>
  assert.rejects(read(bytes), /^Error: Node-RED logs unavailable$/);

test("uses only fixed read-only bounded Node-RED Docker logs endpoint", async () => {
  const calls = [];
  const result = await readNodeRedLogs(async (...args) => {
    calls.push(args);
    return frame(`${at} ready\n`);
  });
  assert.deepEqual(calls, [
    [
      "/containers/nova-node-red/logs?stdout=1&stderr=1&timestamps=1&tail=100&follow=0",
      "GET",
      undefined,
      { raw: true, maxBytes: 65536, timeoutMs: 5000 },
    ],
  ]);
  assert.deepEqual(result, {
    entries: [{ at: normalized, stream: "stdout", text: "ready" }],
    limited: true,
    truncated: false,
  });
});

test("handles stdout/stderr and multiple rows across frames", async () => {
  const result = await read(
    Buffer.concat([
      frame(`${at} first\n${at} sec`),
      frame(`${at} error\n`, 2),
      frame("ond\n"),
    ]),
  );
  assert.deepEqual(
    result.entries.map(({ stream, text }) => [stream, text]),
    [
      ["stdout", "first"],
      ["stderr", "error"],
      ["stdout", "second"],
    ],
  );
});

test("decodes split multibyte UTF8 independently for each stream", async () => {
  const bytes = Buffer.from(`${at} café🙂\n`);
  const split = bytes.indexOf(Buffer.from("é")) + 1;
  const result = await read(
    Buffer.concat([
      frame(bytes.subarray(0, split)),
      frame(`${at} fout\n`, 2),
      frame(bytes.subarray(split)),
    ]),
  );
  assert.deepEqual(
    result.entries.map((entry) => entry.text),
    ["fout", "café🙂"],
  );
});

test("accepts empty snapshots/frames and a timestamped final partial line", async () => {
  assert.deepEqual(await read(Buffer.alloc(0)), {
    entries: [],
    limited: true,
    truncated: false,
  });
  const result = await read(
    Buffer.concat([frame(""), frame(`${at} still running`)]),
  );
  assert.equal(result.entries[0].text, "still running");
});

test("strips ANSI CSI/OSC, C0/C1 controls and CR without interpreting text", async () => {
  const result = await read(
    frame(
      `${at} \u001b[31mred\u001b[0m\u001b]8;;https://private.invalid\u0007label\u001b]8;;\u0007\u0000\t\r\u0085!\n`,
    ),
  );
  assert.equal(result.entries[0].text, "redlabel!");
});

test("bounds each row by2048 UTF16 units without splitting a Unicode character", async () => {
  const result = await read(frame(`${at} ${"x".repeat(2047)}🙂tail\n`));
  assert.equal(result.entries[0].text, "x".repeat(2047));
  assert.equal(result.entries[0].truncated, true);
  assert.equal(result.truncated, true);
});

test("keeps at most the last100 rows and reports truncation", async () => {
  const result = await read(
    frame(Array.from({ length: 105 }, (_, i) => `${at} line${i}\n`).join("")),
  );
  assert.equal(result.entries.length, 100);
  assert.equal(result.entries[0].text, "line5");
  assert.equal(result.entries[99].text, "line104");
  assert.equal(result.truncated, true);
});

test("valid RFC3339 offset and nanosecond timestamps normalize to ISO", async () => {
  const result = await read(
    frame("2026-10-15T10:30:12.123456789+02:00 local\n"),
  );
  assert.equal(result.entries[0].at, normalized);
});

for (const value of [
  "2026-02-30T08:30:12Z",
  "2026-00-15T08:30:12Z",
  "2026-13-15T08:30:12Z",
  "2026-10-00T08:30:12Z",
  "0000-10-15T08:30:12Z",
  "2026-10-15T24:30:12Z",
  "2026-10-15T08:60:12Z",
  "2026-10-15T08:30:60Z",
  "2026-10-15T08:30:12+24:00",
  "2026-10-15T08:30:12+02:60",
  "2026-10-15T08:30:12.1234567890Z",
  "15 October 2026",
])
  test(`rejects invalid timestamp${value}`, () =>
    rejects(frame(`${value} private detail\n`)));

test("rejects an untimestamped multiline continuation instead of returning partial output", () =>
  rejects(frame(`${at} first\nprivate continuation\n`)));
test("rejects raw TTY text instead of guessing a framing mode", () =>
  rejects(Buffer.from(`${at} private\n`)));
test("rejects incomplete headers and payloads", async () => {
  await rejects(Buffer.alloc(7));
  await rejects(frame(`${at} private\n`).subarray(0, -1));
  await rejects(Buffer.concat([frame(`${at} first\n`), Buffer.from([1])]));
});
test("rejects unexpected stream identifiers or reserved bytes", async () => {
  for (const id of [0, 3, 255]) await rejects(frame(`${at} private\n`, id));
  for (const byte of [1, 2, 3]) {
    const malformed = frame(`${at} private\n`);
    malformed[byte] = 1;
    await rejects(malformed);
  }
});
test("rejects invalid and incomplete UTF8 and cross-stream byte repairs", async () => {
  await rejects(
    frame(
      Buffer.concat([
        Buffer.from(`${at} `),
        Buffer.from([0xff]),
        Buffer.from("\n"),
      ]),
    ),
  );
  await rejects(
    frame(Buffer.concat([Buffer.from(`${at} `), Buffer.from([0xc3])])),
  );
  await rejects(
    Buffer.concat([frame(Buffer.from([0xc3])), frame(Buffer.from([0xa9]), 2)]),
  );
});
test("rejects oversized/non-buffer raw responses", async () => {
  await rejects(Buffer.alloc(65537));
  await rejects(`${at} plain text`);
  await rejects(null);
});
test("never exposes Docker exception details", async () => {
  await assert.rejects(
    readNodeRedLogs(async () => {
      throw new Error("private Docker host credential");
    }),
    /^Error: Node-RED logs unavailable$/,
  );
});

test("accepts the exact64KiB response boundary and bounds the returned text", async () => {
  const overhead = 8 + Buffer.byteLength(at) + 2;
  const bytes = frame(`${at} ${"x".repeat(65536 - overhead)}\n`);
  assert.equal(bytes.length, 65536);
  const result = await read(bytes);
  assert.equal(result.entries[0].text.length, 2048);
  assert.equal(result.truncated, true);
});

test("preserves four-byte Unicode split across consecutive frames", async () => {
  const prefix = Buffer.from(`${at} `);
  const emoji = Buffer.from("🙂");
  const result = await read(
    Buffer.concat([
      frame(Buffer.concat([prefix, emoji.subarray(0, 1)])),
      frame(emoji.subarray(1, 3)),
      frame(Buffer.concat([emoji.subarray(3), Buffer.from("\n")])),
    ]),
  );
  assert.equal(result.entries[0].text, "🙂");
});
