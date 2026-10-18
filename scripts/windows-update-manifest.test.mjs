import assert from "node:assert/strict";
import test from "node:test";
import { windowsUpdateManifest } from "./windows-update-manifest.mjs";

// Encoding fixture only. The Tauri updater verifies the cryptographic signature before installation.
const signature = Buffer.from("fixture-signature").toString("base64");
test("manifest points to the versioned installer and preserves its exact signature", () => {
  const manifest = windowsUpdateManifest(
    "0.1.74",
    `${signature}\n`,
    new Date("2026-10-18T00:00:00Z"),
  );
  assert.equal(manifest.version, "0.1.74");
  assert.equal(manifest.pub_date, "2026-10-18T00:00:00.000Z");
  assert.deepEqual(manifest.platforms, {
    "windows-x86_64": {
      signature,
      url: "https://github.com/hjongedijk/nova/releases/download/v0.1.74/NOVA-Setup-0.1.74.exe",
    },
  });
});
test("missing signatures and invalid version paths cannot be published", () => {
  for (const version of [
    "v0.1.74",
    "00.1.74",
    "0.1.74/../other",
    "0.1",
    "",
    undefined,
  ])
    assert.throws(() => windowsUpdateManifest(version, signature));
  for (const value of ["", undefined, "not base64", "a", "x".repeat(4097)])
    assert.throws(() => windowsUpdateManifest("0.1.74", value));
});
