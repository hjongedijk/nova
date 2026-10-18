import assert from "node:assert/strict";
import { cpSync, mkdtempSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { spawnSync } from "node:child_process";
import {
  driftedFiles,
  isVersion,
  nextVersion,
  readVersion,
  STREAMS,
  syncVersion,
} from "./version.mjs";

const repo = resolve(import.meta.dirname, "..");

test("next version increments the patch and rolls into the minor at 99", () => {
  assert.equal(nextVersion("v0.1.73"), "0.1.74");
  assert.equal(nextVersion("v0.1.98"), "0.1.99");
  assert.equal(nextVersion("v0.1.99"), "0.2.0");
  assert.equal(nextVersion("1.9.99"), "1.10.0");
  assert.equal(nextVersion(""), "0.1.1");
  assert.throws(() => nextVersion("v0.3.00"));
});

test("versions must be unpadded semver", () => {
  for (const ok of ["0.1.0", "10.20.30"]) assert.ok(isVersion(ok), ok);
  for (const bad of ["0.3.00", "01.2.3", "1.2", "v1.2.3", "1.2.3-rc1"])
    assert.ok(!isVersion(bad), bad);
});

test("the repository manifests match each stream's VERSION file", () => {
  for (const stream of ["nova", "windows"])
    assert.deepEqual(
      driftedFiles(repo, readVersion(repo, stream), stream),
      [],
      stream,
    );
});

test("streams are independent: each sync touches only its own files", () => {
  const copy = mkdtempSync(join(tmpdir(), "nova-version-"));
  try {
    for (const file of [
      "VERSION",
      "apps/windows/VERSION",
      "package-lock.json",
      "apps/api/package.json",
      "apps/web/package.json",
      "packages/contracts/package.json",
      "apps/windows/Cargo.lock",
      "apps/windows/src-tauri/Cargo.toml",
      "apps/windows/src-tauri/tauri.conf.json",
      "apps/windows/crates/nova-win-agent/Cargo.toml",
      "apps/windows/crates/nova-win-core/Cargo.toml",
    ]) {
      mkdirSync(dirname(join(copy, file)), { recursive: true });
      cpSync(join(repo, file), join(copy, file));
    }
    const windowsBefore = readVersion(copy, "windows");
    const novaChanged = syncVersion(copy, "0.2.0", "nova");
    assert.ok(novaChanged.length > 0);
    assert.ok(novaChanged.every((file) => !file.startsWith("apps/windows/")));
    assert.equal(readVersion(copy, "nova"), "0.2.0");
    assert.equal(readVersion(copy, "windows"), windowsBefore);
    const windowsChanged = syncVersion(copy, "0.5.0", "windows");
    assert.ok(windowsChanged.every((file) => file.startsWith("apps/windows/")));
    assert.equal(readVersion(copy, "nova"), "0.2.0");
    assert.deepEqual(driftedFiles(copy, "0.5.0", "windows"), []);
    assert.deepEqual(syncVersion(copy, "0.5.0", "windows"), []);
    const conf = JSON.parse(
      readFileSync(
        join(copy, "apps/windows/src-tauri/tauri.conf.json"),
        "utf8",
      ),
    );
    assert.equal(conf.version, "0.5.0");
  } finally {
    rmSync(copy, { recursive: true, force: true });
  }
});

test("tag prefixes keep the streams apart", () => {
  assert.equal(nextVersion("windows-v0.1.99"), "0.2.0");
  assert.equal(STREAMS.nova.tagPrefix, "v");
  assert.equal(STREAMS.windows.tagPrefix, "windows-v");
});

test("release validation refreshes remote tags before accepting an explicit version", () => {
  const root = mkdtempSync(join(tmpdir(), "nova-release-tags-"));
  const remote = join(root, "remote.git");
  const checkout = join(root, "checkout");
  mkdirSync(checkout);
  const git = (cwd, ...args) => {
    const result = spawnSync("git", args, { cwd, encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr);
    return result.stdout.trim();
  };
  try {
    git(root, "init", "--bare", remote);
    git(checkout, "init", "-b", "main");
    git(checkout, "config", "user.email", "release-test@example.invalid");
    git(checkout, "config", "user.name", "Release fixture");
    mkdirSync(join(checkout, "scripts"));
    for (const file of ["scripts/release.sh", "scripts/version.mjs", "VERSION"])
      cpSync(join(repo, file), join(checkout, file));
    git(checkout, "add", ".");
    git(checkout, "commit", "-m", "fixture");
    git(checkout, "remote", "add", "origin", remote);
    git(checkout, "tag", "v0.1.73");
    git(checkout, "push", "origin", "main", "v0.1.73");
    const commit = git(checkout, "rev-parse", "HEAD");
    git(root, "--git-dir", remote, "update-ref", "refs/tags/v0.1.75", commit);
    assert.equal(git(checkout, "tag", "--list", "v0.1.75"), "");
    const result = spawnSync(
      "bash",
      ["scripts/release.sh", "--confirm", "v0.1.74", "nova", "0.1.74"],
      { cwd: checkout, encoding: "utf8" },
    );
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /must be newer than v0\.1\.75/);
    assert.equal(git(checkout, "status", "--porcelain"), "");
    assert.equal(
      git(root, "--git-dir", remote, "tag", "--list", "v0.1.74"),
      "",
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
