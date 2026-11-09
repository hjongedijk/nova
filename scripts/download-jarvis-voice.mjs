#!/usr/bin/env node
import { createHash } from "node:crypto";
import { createWriteStream } from "node:fs";
import { chmod, mkdir, readFile, rename, rm, stat } from "node:fs/promises";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import { Readable } from "node:stream";

const root = path.resolve(process.argv[2] ?? "dev-data/piper");
// Pinned revisions: the English Jarvis voice (MIT) and the Dutch fallback voice from rhasspy/piper-voices (CC0).
const jarvis =
  "https://huggingface.co/jgkawell/jarvis/resolve/37f8763122312665f091d1fc760abaf1f79b02cc/en/en_GB/jarvis/medium";
const pim =
  "https://huggingface.co/rhasspy/piper-voices/resolve/cf910fb59f1d79ab3b625a63993a108751c6c25d/nl/nl_NL/pim/medium";
const assets = [
  {
    url: `${jarvis}/jarvis-medium.onnx`,
    target: "en_GB-jarvis-medium.onnx",
    size: 63_511_038,
  },
  {
    url: `${jarvis}/jarvis-medium.onnx.json`,
    target: "en_GB-jarvis-medium.onnx.json",
    size: 7_266,
    language: "en_GB",
  },
  {
    url: `${pim}/nl_NL-pim-medium.onnx`,
    target: "nl_NL-pim-medium.onnx",
    size: 63_221_984,
    sha256: "1e1ed370c3b60ca734e525bdcd1f05f71b42bfb0a15693f1e89c012d72052d2a",
  },
  {
    url: `${pim}/nl_NL-pim-medium.onnx.json`,
    target: "nl_NL-pim-medium.onnx.json",
    size: 5_461,
    language: "nl_NL",
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
  const response = await fetch(asset.url, {
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
      `Download failed for ${asset.target}: HTTP ${response.status}`,
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
        `${asset.target} size mismatch (${actual}, expected ${asset.size})`,
      );
    if (asset.language) {
      const config = JSON.parse(await readFile(temporary, "utf8"));
      if (config.language?.code !== asset.language)
        throw new Error("Unexpected model language");
    }
    if (asset.sha256) {
      const digest = createHash("sha256")
        .update(await readFile(temporary))
        .digest("hex");
      if (digest !== asset.sha256)
        throw new Error(`${asset.target} checksum mismatch`);
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
