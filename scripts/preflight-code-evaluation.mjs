#!/usr/bin/env node
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { pathToFileURL } from "node:url";

if (process.argv.includes("--help")) {
  console.log(
    "Read-only K2.8 preflight. Build the API and set NOVA_DATA_DIR, OMNIROUTE_DATABASE and OMNIROUTE_API_KEY from the NOVA install. This script never sends model requests.",
  );
  process.exit(0);
}
if (process.argv.length !== 2) {
  console.error("This preflight accepts no run or model-call options.");
  process.exit(2);
}

const result = {
  ready: false,
  routeStatus: "NOT_CHECKED",
  policySha256: null,
  verifiedFreeCandidates: [],
  novaKeyAccessMode: "unknown",
  explicitlyAllowedModels: [],
  eligibleCandidates: [],
  modelRequests: 0,
};

try {
  if (
    !process.env.NOVA_DATA_DIR ||
    !fs.existsSync(process.env.NOVA_DATA_DIR) ||
    !fs.statSync(process.env.NOVA_DATA_DIR).isDirectory()
  )
    throw new Error("Set NOVA_DATA_DIR to an existing NOVA data directory.");
  if (
    !process.env.OMNIROUTE_DATABASE ||
    !fs.existsSync(process.env.OMNIROUTE_DATABASE) ||
    !fs.statSync(process.env.OMNIROUTE_DATABASE).isFile()
  )
    throw new Error(
      "Set OMNIROUTE_DATABASE to the verified read-only gateway database.",
    );
  if (!process.env.OMNIROUTE_API_KEY)
    throw new Error("OMNIROUTE_API_KEY is not configured.");

  const root = path.resolve(import.meta.dirname, "..");
  const { NovaConfig } = await import(
    pathToFileURL(path.join(root, "apps/api/dist/core/config/nova-config.js"))
  );
  const { RoutingService } = await import(
    pathToFileURL(path.join(root, "apps/api/dist/routing/routing.service.js"))
  );
  const config = new NovaConfig();
  const route = new RoutingService(config).status();
  result.routeStatus = route.status;
  if (!route.ready || !route.freeOnly || route.policyVerified !== true)
    throw new Error("The verified-free route is unavailable.");

  const policy = fs.readFileSync(config.dataFile("free-routing-policy.json"));
  result.policySha256 = crypto
    .createHash("sha256")
    .update(policy)
    .digest("hex");
  result.verifiedFreeCandidates = [
    ...new Set(
      (route.enabledModels ?? []).filter(
        (model) => !route.embeddingModels?.includes(model),
      ),
    ),
  ].sort();

  const db = new DatabaseSync(config.omniDatabase, { readOnly: true });
  let key;
  try {
    key = db
      .prepare(
        "SELECT model_access_mode,allowed_models FROM api_keys WHERE key=? AND is_active=1 AND revoked_at IS NULL LIMIT 1",
      )
      .get(config.omniKey);
  } finally {
    db.close();
  }
  if (!key)
    throw new Error(
      "The active NOVA key was not found in the verified gateway database.",
    );
  if (key.model_access_mode !== "all" && key.model_access_mode !== "restricted")
    throw new Error("The NOVA key's model access mode is invalid.");
  result.novaKeyAccessMode = key.model_access_mode;
  let allowed;
  if (key.model_access_mode === "all") {
    allowed = result.verifiedFreeCandidates;
  } else {
    const parsed = JSON.parse(key.allowed_models);
    if (
      !Array.isArray(parsed) ||
      parsed.length > 500 ||
      parsed.some((id) => typeof id !== "string" || id.length > 200) ||
      new Set(parsed).size !== parsed.length
    )
      throw new Error("The NOVA key's model allowlist is invalid.");
    allowed = parsed;
  }
  result.explicitlyAllowedModels = [...allowed].sort();
  result.eligibleCandidates = result.verifiedFreeCandidates.filter((id) =>
    allowed.includes(id),
  );
  if (!result.eligibleCandidates.length)
    throw new Error(
      "No verified-free candidate is explicitly accessible to the NOVA key.",
    );
  result.ready = true;
} catch (error) {
  result.error = error instanceof Error ? error.message : "Preflight failed.";
}

console.log(JSON.stringify(result, null, 2));
if (!result.ready) process.exitCode = 1;
