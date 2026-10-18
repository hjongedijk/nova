#!/usr/bin/env node
// NOVA version helper. Two independent release streams, each with its own VERSION file:
//   nova     VERSION                 tags vX.Y.Z          web, API, Docker image (package.json files)
//   windows  apps/windows/VERSION    tags windows-vX.Y.Z  Windows agent (Cargo, tauri.conf.json)
//   node scripts/version.mjs next <stream> [latest-tag]   print the next version (no prefix)
//   node scripts/version.mjs validate X.Y.Z               exit 1 unless it is unpadded semver
//   node scripts/version.mjs sync <stream> [X.Y.Z]        write VERSION and sync that stream's files
//   node scripts/version.mjs check [stream]               exit 1 when a manifest differs from VERSION
//   node scripts/version.mjs prefix <stream>              print the git tag prefix
// Versions are unpadded (0.1.99 -> 0.2.0, never 0.3.00): Cargo, npm and MSI reject padding.
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const VERSION_PATTERN =
  /^(0|[1-9]\d{0,5})\.(0|[1-9]\d{0,5})\.(0|[1-9]\d{0,5})$/;

export const isVersion = (value) => VERSION_PATTERN.test(String(value));

export const compare = (a, b) => {
  const left = a.split(".").map(Number);
  const right = b.split(".").map(Number);
  for (let index = 0; index < 3; index++)
    if (left[index] !== right[index]) return left[index] - right[index];
  return 0;
};

/** Next version after `latest` ("v0.1.99" or "0.1.99"); PATCH rolls into MINOR at 99. */
export const nextVersion = (latest) => {
  const clean = String(latest || "0.1.0").replace(/^(?:windows-)?v/, "");
  if (!isVersion(clean)) throw new Error(`Invalid version: ${latest}`);
  const [major, minor, patch] = clean.split(".").map(Number);
  return patch >= 99
    ? `${major}.${minor + 1}.0`
    : `${major}.${minor}.${patch + 1}`;
};

const replaceFirst = (text, pattern, replacement, label) => {
  if (!pattern.test(text)) throw new Error(`No version found in ${label}`);
  return text.replace(pattern, replacement);
};

const packageJsons = [
  "apps/api/package.json",
  "apps/web/package.json",
  "packages/contracts/package.json",
];
const cargoTomls = [
  "apps/windows/src-tauri/Cargo.toml",
  "apps/windows/crates/nova-win-agent/Cargo.toml",
  "apps/windows/crates/nova-win-core/Cargo.toml",
];
const cargoPackages = ["nova", "nova-win-agent", "nova-win-core"];
const lockWorkspaces = ["apps/api", "apps/web", "packages/contracts"];

const jsonVersion = (file) => [
  file,
  (text, v) => replaceFirst(text, /("version": ")[^"]*(")/, `$1${v}$2`, file),
];

export const STREAMS = {
  nova: {
    versionFile: "VERSION",
    tagPrefix: "v",
    targets: [
      ...packageJsons.map(jsonVersion),
      [
        "package-lock.json",
        (text, v) =>
          lockWorkspaces.reduce(
            (result, key) =>
              replaceFirst(
                result,
                new RegExp(
                  `("${key}": \\{\\s+"name": "[^"]+",\\s+"version": ")[^"]*(")`,
                ),
                `$1${v}$2`,
                `package-lock ${key}`,
              ),
            text,
          ),
      ],
    ],
  },
  windows: {
    versionFile: "apps/windows/VERSION",
    tagPrefix: "windows-v",
    targets: [
      jsonVersion("apps/windows/src-tauri/tauri.conf.json"),
      ...cargoTomls.map((file) => [
        file,
        (text, v) =>
          replaceFirst(text, /^(version = ")[^"]*(")/m, `$1${v}$2`, file),
      ]),
      [
        "apps/windows/Cargo.lock",
        (text, v) =>
          cargoPackages.reduce(
            (result, name) =>
              replaceFirst(
                result,
                new RegExp(`(name = "${name}"\\r?\\nversion = ")[^"]*(")`),
                `$1${v}$2`,
                `Cargo.lock ${name}`,
              ),
            text,
          ),
      ],
    ],
  },
};

const stream = (name) => {
  if (!STREAMS[name]) throw new Error(`Unknown stream: ${name}`);
  return STREAMS[name];
};

export const readVersion = (root, name = "nova") =>
  readFileSync(join(root, stream(name).versionFile), "utf8").trim();

/** Write the stream's VERSION and sync its manifests. Returns the files that changed. */
export const syncVersion = (root, version, name = "nova") => {
  if (!isVersion(version)) throw new Error(`Invalid version: ${version}`);
  const { targets, versionFile } = stream(name);
  const changed = [];
  const write = (file, next) => {
    const path = join(root, file);
    let before = "";
    try {
      before = readFileSync(path, "utf8");
    } catch {
      /* VERSION may not exist yet */
    }
    if (before !== next) {
      writeFileSync(path, next);
      changed.push(file);
    }
  };
  for (const [file, transform] of targets)
    write(file, transform(readFileSync(join(root, file), "utf8"), version));
  write(versionFile, `${version}\n`);
  return changed;
};

/** Files of the stream whose stored version differs from `version`. */
export const driftedFiles = (root, version, name = "nova") =>
  stream(name)
    .targets.filter(([file, transform]) => {
      const text = readFileSync(join(root, file), "utf8");
      return transform(text, version) !== text;
    })
    .map(([file]) => file);

const main = (argv) => {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  const [command, first, second] = argv;
  if (command === "next") return console.log(nextVersion(second));
  if (command === "prefix") return console.log(stream(first).tagPrefix);
  if (command === "validate") {
    if (!isVersion(first)) {
      console.error(`Invalid version (expected X.Y.Z, unpadded): ${first}`);
      process.exit(1);
    }
    return;
  }
  if (command === "sync") {
    const version = second ?? readVersion(root, first);
    const changed = syncVersion(root, version, first);
    return console.log(
      `${first} ${version}: ${changed.length ? changed.join(", ") : "already in sync"}`,
    );
  }
  if (command === "check") {
    const names = first ? [first] : Object.keys(STREAMS);
    const drift = names.flatMap((name) =>
      driftedFiles(root, readVersion(root, name), name),
    );
    if (drift.length) {
      console.error(`Out of sync with VERSION: ${drift.join(", ")}`);
      process.exit(1);
    }
    return;
  }
  console.error(
    "Usage: version.mjs next <stream> [tag] | prefix <stream> | validate X.Y.Z | sync <stream> [X.Y.Z] | check [stream]",
  );
  process.exit(2);
};

if (process.argv[1] === fileURLToPath(import.meta.url))
  main(process.argv.slice(2));
