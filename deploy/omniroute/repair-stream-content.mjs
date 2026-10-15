import { readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

const VERSION = "3.8.51";
const ORIGINAL = '"string"==typeof a.content?(0,g.MP)(p(a.content)):a.content';
const REPAIRED =
  '"string"==typeof a.content?(0,g.MP)(p(a.content)):"number"==typeof a.content&&Number.isFinite(a.content)?String(a.content):a.content';
const STREAM_ORIGINAL =
  'let z=w||x||n||t?.content===""&&t?.reasoning_content||!p&&"string"==typeof t?.reasoning_content&&t.reasoning_content.length>0;';
const STREAM_REPAIRED =
  'let z="number"==typeof m?.content&&Number.isFinite(m.content)||w||x||n||t?.content===""&&t?.reasoning_content||!p&&"string"==typeof t?.reasoning_content&&t.reasoning_content.length>0;';
const PATCHES = [
  { original: ORIGINAL, repaired: REPAIRED },
  { original: STREAM_ORIGINAL, repaired: STREAM_REPAIRED },
];

function occurrences(source, literal) {
  return source.split(literal).length - 1;
}

function patchLiteral(source, original, repaired) {
  if (occurrences(source, repaired) !== 0) {
    throw new Error("Streaming content repair already present");
  }
  if (occurrences(source, original) !== 1) {
    throw new Error("Expected exactly one known streaming content expression");
  }
  return source.replace(original, repaired);
}

export function patchSource(source) {
  return patchLiteral(source, ORIGINAL, REPAIRED);
}

export function patchStreamSource(source) {
  return patchLiteral(source, STREAM_ORIGINAL, STREAM_REPAIRED);
}

async function main(root) {
  const manifest = JSON.parse(
    await readFile(path.join(root, "package.json"), "utf8"),
  );
  if (manifest.version !== VERSION) {
    throw new Error(`Streaming content repair requires OmniRoute ${VERSION}`);
  }

  const chunksDir = path.join(root, ".build/next/server/chunks");
  const entries = await readdir(chunksDir, { withFileTypes: true });
  const candidates = [];
  const totals = PATCHES.map(() => 0);
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith(".js")) continue;
    const filename = path.join(chunksDir, entry.name);
    const source = await readFile(filename, "utf8");
    const counts = PATCHES.map(({ original, repaired }, index) => {
      if (occurrences(source, repaired) !== 0) {
        throw new Error("Streaming content repair already present");
      }
      const count = occurrences(source, original);
      totals[index] += count;
      return count;
    });
    if (counts.some((count) => count > 0))
      candidates.push({ filename, source, counts });
  }
  if (totals.some((total) => total !== 1)) {
    throw new Error(
      "Expected exactly one of each known streaming content expression across chunks",
    );
  }

  // Validate and prepare both repairs before any file is written.
  const updates = candidates.map(({ filename, source, counts }) => {
    let patched = source;
    PATCHES.forEach(({ original, repaired }, index) => {
      if (counts[index] > 0)
        patched = patchLiteral(patched, original, repaired);
    });
    return { filename, patched };
  });
  for (const { filename, patched } of updates) {
    // Updating existing files retains their permissions.
    await writeFile(filename, patched, "utf8");
  }
  process.stdout.write("Repaired streaming content expressions: 2\n");
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  main(process.argv[2] ?? "/app").catch((error) => {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  });
}
