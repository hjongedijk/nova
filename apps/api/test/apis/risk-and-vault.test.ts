import fs from "node:fs";
import { describe, expect, it } from "vitest";
import { classify } from "../../src/apis/risk.js";
import { ApiVault } from "../../src/apis/api-vault.js";
import { sanitize } from "../../src/core/security/sanitize.js";
import { SECRET, startFakeApi, petShop } from "./fake-api.js";
import { makeEngine } from "./helpers.js";

describe("risk classification", () => {
  type Row = [string, Parameters<typeof classify>[0], string];
  const rows: Row[] = [
    ["GET", { protocol: "rest", method: "GET", name: "listPets" }, "READ_ONLY"],
    ["HEAD", { protocol: "rest", method: "HEAD", name: "x" }, "READ_ONLY"],
    [
      "OPTIONS",
      { protocol: "rest", method: "OPTIONS", name: "x" },
      "READ_ONLY",
    ],
    [
      "GET with a destructive-sounding data name",
      { protocol: "rest", method: "GET", name: "listDeletedItems" },
      "READ_ONLY",
    ],
    [
      "GET that is itself a reset",
      { protocol: "rest", method: "GET", name: "resetDevice" },
      "DANGEROUS",
    ],
    [
      "POST default",
      { protocol: "rest", method: "POST", name: "createPet", explicitId: true },
      "CONFIRM",
    ],
    ["PUT", { protocol: "rest", method: "PUT", name: "updatePet" }, "CONFIRM"],
    [
      "PATCH",
      { protocol: "rest", method: "PATCH", name: "patchPet" },
      "CONFIRM",
    ],
    [
      "POST search with x-readonly",
      { protocol: "rest", method: "POST", name: "x", readonlyHint: true },
      "READ_ONLY",
    ],
    [
      "POST searchPets with a spec operationId",
      {
        protocol: "rest",
        method: "POST",
        name: "searchPets",
        explicitId: true,
      },
      "READ_ONLY",
    ],
    [
      "POST search without a spec operationId stays CONFIRM",
      {
        protocol: "rest",
        method: "POST",
        name: "post_search",
        explicitId: false,
      },
      "CONFIRM",
    ],
    [
      "PUT never read-only by name",
      { protocol: "rest", method: "PUT", name: "searchPets", explicitId: true },
      "CONFIRM",
    ],
    [
      "DELETE",
      { protocol: "rest", method: "DELETE", name: "removeNothing" },
      "DANGEROUS",
    ],
    [
      "POST named purge",
      { protocol: "rest", method: "POST", name: "purgeCache" },
      "DANGEROUS",
    ],
    [
      "POST path with shutdown",
      { protocol: "rest", method: "POST", name: "x", path: "/server/shutdown" },
      "DANGEROUS",
    ],
    [
      "POST reboot",
      { protocol: "rest", method: "POST", name: "rebootNode" },
      "DANGEROUS",
    ],
    [
      "POST format disk",
      { protocol: "rest", method: "POST", name: "formatDisk" },
      "DANGEROUS",
    ],
    [
      "graphql query",
      { protocol: "graphql", method: "query", name: "customers" },
      "READ_ONLY",
    ],
    [
      "graphql mutation",
      { protocol: "graphql", method: "mutation", name: "createCustomer" },
      "CONFIRM",
    ],
    [
      "graphql destructive mutation",
      { protocol: "graphql", method: "mutation", name: "deleteCustomer" },
      "DANGEROUS",
    ],
    [
      "soap unknown",
      { protocol: "soap", method: "POST", name: "GetQuote" },
      "CONFIRM",
    ],
    [
      "soap destructive",
      { protocol: "soap", method: "POST", name: "DestroyAccount" },
      "DANGEROUS",
    ],
    [
      "jsonrpc unknown",
      { protocol: "jsonrpc", method: "POST", name: "wallet.balance" },
      "CONFIRM",
    ],
    [
      "jsonrpc introspection",
      { protocol: "jsonrpc", method: "POST", name: "rpc.discover" },
      "READ_ONLY",
    ],
    [
      "jsonrpc destructive",
      { protocol: "jsonrpc", method: "POST", name: "wallet.reset" },
      "DANGEROUS",
    ],
  ];
  it.each(rows)("%s", (_name, input, expected) => {
    expect(classify(input)).toBe(expected);
  });
});

describe("vault and registry persistence", () => {
  const mode = (file: string) => fs.statSync(file).mode & 0o777;

  it("writes 0600 files and never holds the secret in plaintext, base64 or the spec file", async () => {
    const api = await startFakeApi(petShop);
    const { config, engine } = makeEngine();
    try {
      await engine.connect({
        baseUrl: api.url,
        token: SECRET,
        local: true,
        name: "Pets",
      });
      for (const name of ["apis.json", "apis-secrets.json", "apis.key"])
        expect(mode(config.dataFile(name)), name).toBe(0o600);
      for (const name of ["apis.json", "apis-secrets.json"]) {
        const raw = fs.readFileSync(config.dataFile(name));
        expect(raw.includes(SECRET), `${name} plain`).toBe(false);
        expect(
          raw.includes(Buffer.from(SECRET).toString("base64")),
          `${name} base64`,
        ).toBe(false);
        expect(
          raw.includes(Buffer.from(SECRET, "utf16le")),
          `${name} utf16`,
        ).toBe(false);
      }
      // The registry stores a reference only.
      expect(fs.readFileSync(config.dataFile("apis.json"), "utf8")).toMatch(
        /"ref": "sec_[0-9a-f]{10}"/,
      );
      // A new process (new vault instance) reads it back.
      const again = new ApiVault(config);
      const ref = engine.registry.list()[0]!.auth;
      expect(ref.type === "bearer" && again.get(ref.ref)).toBe(SECRET);
    } finally {
      await api.close();
    }
  });

  it("fails closed on tampering and on a missing key", () => {
    const { config, vault } = makeEngine();
    const ref = vault.put("sk-test-1111", "t", "a.example");
    const file = JSON.parse(
      fs.readFileSync(config.dataFile("apis-secrets.json"), "utf8"),
    ) as { secrets: Record<string, { ct: string }> };
    file.secrets[ref]!.ct = Buffer.from("tampered-tampered").toString("base64");
    fs.writeFileSync(
      config.dataFile("apis-secrets.json"),
      JSON.stringify(file),
      { mode: 0o600 },
    );
    expect(new ApiVault(config).get(ref)).toBeUndefined();
    fs.rmSync(config.dataFile("apis.key"));
    expect(() => new ApiVault(config).put("sk-test-2222")).toThrow(
      /key missing/,
    );
  });

  it("binds a credential to one host and redacts every form of it", () => {
    const { vault } = makeEngine();
    const ref = vault.put("user:pw-0000-long", "t", "a.example");
    expect(vault.bindHost(ref, "a.example")).toBe(true);
    expect(vault.bindHost(ref, "evil.example")).toBe(false);
    // The same secret value for another host gets its own entry.
    expect(vault.put("user:pw-0000-long", "t", "b.example")).not.toBe(ref);
    const forms = [
      "user:pw-0000-long",
      Buffer.from("user:pw-0000-long").toString("base64"),
      encodeURIComponent("user:pw-0000-long"),
      "pw-0000-long",
    ];
    for (const form of forms)
      expect(vault.redact(`x ${form} y`), form).toBe("x [redacted] y");
    // The global redaction knows it too (audit, logs, memory all pass through sanitize).
    expect(sanitize("echo pw-0000-long here")).toBe("echo [redacted] here");
  });
});
