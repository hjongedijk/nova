import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import {
  mkdtemp,
  mkdir,
  readFile,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { patchSource, patchStreamSource } from "./repair-stream-content.mjs";

const ORIGINAL = '"string"==typeof a.content?(0,g.MP)(p(a.content)):a.content';
const STREAM_ORIGINAL =
  'let z=w||x||n||t?.content===""&&t?.reasoning_content||!p&&"string"==typeof t?.reasoning_content&&t.reasoning_content.length>0;';
const cli = fileURLToPath(
  new URL("./repair-stream-content.mjs", import.meta.url),
);
const compile = (expression) =>
  new Function("a", "g", "p", `return (${expression});`);
const normalize = (fn, content) =>
  fn({ content }, { MP: (text) => text.replace(/\n{3,}/g, "\n\n") }, (text) =>
    text.replace(/\u200b/g, ""),
  );

test("finite numeric deltas survive the gateway string-content filter", () => {
  const before = compile(ORIGINAL);
  const after = compile(patchSource(ORIGINAL));
  const values = [19, ":", 53, ":", 7];
  const visible = (fn) =>
    values
      .map((value) => normalize(fn, value))
      .filter((value) => typeof value === "string" && value.length > 0)
      .join("");
  assert.equal(visible(before), "::");
  assert.equal(visible(after), "19:53:7");
  for (const value of [0, -19, 0.25, -0.5, Number.MAX_VALUE]) {
    assert.equal(normalize(after, value), String(value));
  }
});

test("strings and every other value retain their existing behavior", () => {
  const before = compile(ORIGINAL);
  const after = compile(patchSource(ORIGINAL));
  for (const value of [
    "07",
    "",
    "19:53:07",
    "a\u200bb\n\n\nc",
    null,
    undefined,
    true,
    false,
    [],
    {},
    ["19"],
    { text: "19" },
    NaN,
    Infinity,
    -Infinity,
  ]) {
    assert.equal(normalize(after, value), normalize(before, value));
  }
});

test("patchSource changes only the known expression and rejects unexpected inputs", () => {
  const source = `prefix;${ORIGINAL};suffix`;
  const patched = patchSource(source);
  assert.ok(patched.startsWith("prefix;"));
  assert.ok(patched.endsWith(";suffix"));
  assert.throws(() => patchSource("unknown expression"), /exactly one/);
  assert.throws(() => patchSource(`${ORIGINAL};${ORIGINAL}`), /exactly one/);
  assert.throws(() => patchSource(patched), /already present/);
  assert.throws(() => patchSource(`${patched};${ORIGINAL}`), /already present/);
});

test("finite numeric normalization forces wire reserialization and preserves existing triggers", () => {
  const before = new Function(
    "m",
    "t",
    "w",
    "x",
    "n",
    "p",
    `${STREAM_ORIGINAL}return Boolean(z);`,
  );
  const after = new Function(
    "m",
    "t",
    "w",
    "x",
    "n",
    "p",
    `${patchStreamSource(STREAM_ORIGINAL)}return Boolean(z);`,
  );
  const sanitizer = compile(patchSource(ORIGINAL));
  for (const content of [19, 0, -19, 0.25]) {
    const raw = { content };
    const clean = { content: normalize(sanitizer, content) };
    assert.equal(before(raw, clean, false, false, false, false), false);
    assert.equal(after(raw, clean, false, false, false, false), true);
    const wire = after(raw, clean, false, false, false, false) ? clean : raw;
    assert.equal(typeof JSON.parse(JSON.stringify(wire)).content, "string");
  }
  for (const content of [
    "19",
    "",
    null,
    undefined,
    false,
    [],
    {},
    NaN,
    Infinity,
    -Infinity,
  ]) {
    for (const flags of [
      [false, false, false, false],
      [true, false, false, false],
      [false, true, false, false],
      [false, false, true, false],
    ]) {
      const raw = { content };
      for (const clean of [
        { content },
        { content, reasoning_content: "reasoning" },
      ]) {
        assert.equal(after(raw, clean, ...flags), before(raw, clean, ...flags));
      }
    }
  }
});

test("stream repair rejects missing, duplicate, and already repaired expressions", () => {
  assert.throws(() => patchStreamSource("unknown"), /exactly one/);
  assert.throws(
    () => patchStreamSource(STREAM_ORIGINAL + STREAM_ORIGINAL),
    /exactly one/,
  );
  const repaired = patchStreamSource(STREAM_ORIGINAL);
  assert.throws(() => patchStreamSource(repaired), /already present/);
  assert.throws(
    () => patchStreamSource(repaired + STREAM_ORIGINAL),
    /already present/,
  );
});

async function fixture(t, version = "3.8.51") {
  const root = await mkdtemp(
    path.join(os.tmpdir(), "omniroute-stream-repair-"),
  );
  t.after(() => rm(root, { recursive: true, force: true }));
  const chunks = path.join(root, ".build/next/server/chunks");
  await mkdir(chunks, { recursive: true });
  await writeFile(path.join(root, "package.json"), JSON.stringify({ version }));
  return { root, chunks };
}

test("CLI patches both arbitrary chunks, preserves mode, and ignores other paths", async (t) => {
  const { root, chunks } = await fixture(t);
  const target = path.join(chunks, "arbitrary-name.js");
  await writeFile(target, ORIGINAL, { mode: 0o640 });
  const streamTarget = path.join(chunks, "stream-arbitrary.js");
  await writeFile(streamTarget, STREAM_ORIGINAL, { mode: 0o644 });
  await writeFile(path.join(chunks, "unrelated.js"), "const unchanged = 1;");
  await writeFile(path.join(chunks, "ignored.txt"), ORIGINAL);
  await mkdir(path.join(chunks, "nested"));
  await writeFile(path.join(chunks, "nested", "ignored.js"), ORIGINAL);
  const output = execFileSync(process.execPath, [cli, root], {
    encoding: "utf8",
  });
  assert.equal(output, "Repaired streaming content expressions: 2\n");
  assert.equal(await readFile(target, "utf8"), patchSource(ORIGINAL));
  assert.equal(
    await readFile(streamTarget, "utf8"),
    patchStreamSource(STREAM_ORIGINAL),
  );
  assert.equal((await stat(streamTarget)).mode & 0o777, 0o644);
  assert.equal((await stat(target)).mode & 0o777, 0o640);
  assert.equal(
    await readFile(path.join(chunks, "unrelated.js"), "utf8"),
    "const unchanged = 1;",
  );
  assert.equal(
    await readFile(path.join(chunks, "ignored.txt"), "utf8"),
    ORIGINAL,
  );
  const repeated = spawnSync(process.execPath, [cli, root], {
    encoding: "utf8",
  });
  assert.equal(repeated.status, 1);
  assert.match(repeated.stderr, /already present/);
});

test("CLI rejects unknown versions without writing", async (t) => {
  const { root, chunks } = await fixture(t, "3.8.52");
  const target = path.join(chunks, "target.js");
  const source = ORIGINAL + STREAM_ORIGINAL;
  await writeFile(target, source);
  const result = spawnSync(process.execPath, [cli, root], { encoding: "utf8" });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /requires OmniRoute 3\.8\.51/);
  assert.equal(await readFile(target, "utf8"), source);
});

test("CLI counts all chunks before writing and rejects missing or duplicate targets", async (t) => {
  const { root, chunks } = await fixture(t);
  const first = path.join(chunks, "first.js");
  const second = path.join(chunks, "second.js");
  for (const sources of [
    ["unknown", "other"],
    [ORIGINAL, "other"],
    ["unknown", STREAM_ORIGINAL],
    [ORIGINAL + ORIGINAL, STREAM_ORIGINAL],
    [ORIGINAL, STREAM_ORIGINAL + STREAM_ORIGINAL],
    [ORIGINAL, ORIGINAL + STREAM_ORIGINAL],
    [ORIGINAL + STREAM_ORIGINAL, STREAM_ORIGINAL],
    [ORIGINAL, patchStreamSource(STREAM_ORIGINAL)],
    [patchSource(ORIGINAL), STREAM_ORIGINAL],
  ]) {
    await writeFile(first, sources[0]);
    await writeFile(second, sources[1]);
    const result = spawnSync(process.execPath, [cli, root], {
      encoding: "utf8",
    });
    assert.equal(result.status, 1);
    assert.equal(await readFile(first, "utf8"), sources[0]);
    assert.equal(await readFile(second, "utf8"), sources[1]);
  }
});
