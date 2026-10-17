import fs from "node:fs";
import { NovaConfig } from "../../src/core/config/nova-config.js";
import { ApiEngine } from "../../src/apis/api-engine.service.js";
import { ApiRegistry } from "../../src/apis/api-registry.js";
import { ApiVault } from "../../src/apis/api-vault.js";

export function makeEngine() {
  const config = new NovaConfig();
  for (const file of ["apis.json", "apis-secrets.json", "apis.key"])
    fs.rmSync(config.dataFile(file), { force: true });
  const vault = new ApiVault(config);
  const registry = new ApiRegistry(config);
  const engine = new ApiEngine(registry, vault, config);
  return { config, vault, registry, engine };
}
