import { readdirSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { spawnSync } from "node:child_process";

const root = resolve("docs/img");
const patterns = {
  email: /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i,
  privateIp:
    /\b(?:10\.\d{1,3}|192\.168\.\d{1,3}|172\.(?:1[6-9]|2\d|3[01])\.\d{1,3})\.\d{1,3}\b/,
  credential:
    /(?:password|passwd|wachtwoord|api[ _-]?key|secret|bearer|token)\s*[:=]\s*\S{8,}/i,
};

function images(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const file = join(directory, entry.name);
    if (entry.isDirectory()) return images(file);
    return /\.(?:png|jpe?g|webp)$/i.test(entry.name) ? [file] : [];
  });
}

const files = images(root).sort();
let failed = false;
for (const file of files) {
  const result = spawnSync("tesseract", [file, "stdout", "-l", "eng"], {
    encoding: "utf8",
    env: { ...process.env, OMP_THREAD_LIMIT: "1" },
    timeout: 20_000,
    maxBuffer: 2_000_000,
    stdio: ["ignore", "pipe", "ignore"],
  });
  const name = relative(resolve("."), file);
  if (result.error || result.status !== 0) {
    console.error(`${name}: OCR failed`);
    failed = true;
    continue;
  }
  const matches = Object.entries(patterns)
    .filter(([, pattern]) => pattern.test(result.stdout))
    .map(([category]) => category);
  if (matches.length) {
    console.error(`${name}: review ${matches.join(", ")}`);
    failed = true;
  }
}
if (failed) process.exitCode = 1;
else console.log(`${files.length} screenshots checked with local OCR.`);
