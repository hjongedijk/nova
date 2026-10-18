// Publish metadata for the exact installer bytes signed by Tauri. No private keys are read here.
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

export function windowsUpdateManifest(version, signature, date = new Date()) {
  if (
    typeof version !== "string" ||
    !/^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)$/.test(version) ||
    version.length > 80
  )
    throw new Error("Invalid Windows release version");
  if (typeof signature !== "string")
    throw new Error("Missing update signature");
  const signed = signature.trim();
  if (
    !signed ||
    signed.length > 4096 ||
    !/^[A-Za-z0-9+/]+={0,2}$/.test(signed) ||
    Buffer.from(signed, "base64").toString("base64") !== signed
  )
    throw new Error("Invalid update signature encoding");
  return {
    version,
    notes: `NOVA voor Windows ${version}. Bekijk GitHub voor de volledige wijzigingen.`,
    pub_date: date.toISOString(),
    platforms: {
      "windows-x86_64": {
        signature: signed,
        url: `https://github.com/hjongedijk/nova/releases/download/windows-v${version}/NOVA-Setup-${version}.exe`,
      },
    },
  };
}

if (
  process.argv[1] &&
  pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url
) {
  const [, , version, signaturePath, output] = process.argv;
  if (!signaturePath || !output)
    throw new Error("Expected version, signature path and output path");
  const manifest = windowsUpdateManifest(
    version,
    fs.readFileSync(signaturePath, "utf8"),
  );
  fs.writeFileSync(output, JSON.stringify(manifest, null, 2) + "\n");
}
