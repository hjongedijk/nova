#!/usr/bin/env node
import { createWriteStream } from "node:fs";
import { chmod, mkdir, readFile, rename, rm, stat } from "node:fs/promises";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import { Readable } from "node:stream";

const revision = "37f8763122312665f091d1fc760abaf1f79b02cc";
const root = path.resolve(process.argv[2] ?? "dev-data/piper");
const base = `https://huggingface.co/jgkawell/jarvis/resolve/${revision}/en/en_GB/jarvis/medium`;
const assets = [
  {
    source: "jarvis-medium.onnx",
    target: "en_GB-jarvis-medium.onnx",
    size: 63_511_038,
  },
  {
    source: "jarvis-medium.onnx.json",
    target: "en_GB-jarvis-medium.onnx.json",
    size: 7_266,
  },
];

await mkdir(root, { recursive: true });
for (const asset of assets) {
  const destination = path.join(root, asset.target);
  try {
    if ((await stat(destination)).size === asset.size) {
      await chmod(destination, 0o644);
      console.log(`${asset.target} already present`);
      continue;
    }
  } catch {
    /* Download missing file. */
  }
  const response = await fetch(`${base}/${asset.source}`, {
    redirect: "follow",
    signal: AbortSignal.timeout(120_000),
  });
  const finalUrl = new URL(response.url);
  if (
    finalUrl.protocol !== "https:" ||
    !(
      finalUrl.hostname === "huggingface.co" ||
      finalUrl.hostname.endsWith(".cdn.hf.co")
    )
  )
    throw new Error(`Refusing unexpected download host: ${finalUrl.hostname}`);
  if (!response.ok || !response.body)
    throw new Error(
      `Download failed for ${asset.source}: HTTP ${response.status}`,
    );
  const temporary = `${destination}.partial`;
  try {
    await pipeline(
      Readable.fromWeb(response.body),
      createWriteStream(temporary, { mode: 0o644 }),
    );
    const actual = (await stat(temporary)).size;
    if (actual !== asset.size)
      throw new Error(
        `${asset.source} size mismatch (${actual}, expected ${asset.size})`,
      );
    if (asset.source.endsWith(".json")) {
      const config = JSON.parse(await readFile(temporary, "utf8"));
      if (config.language?.code !== "en_GB")
        throw new Error("Unexpected model language");
    }
    await rename(temporary, destination);
    await chmod(destination, 0o644);
    console.log(`Downloaded ${asset.target} (${actual} bytes)`);
  } catch (error) {
    await rm(temporary, { force: true });
    throw error;
  }
}
console.log(
  `Voice files installed at ${root}; files are local and ignored by Git.`,
);
