import { Module } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import fs from "node:fs";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { ApiEngine } from "../../src/apis/api-engine.service.js";
import { ApiMaintenanceService } from "../../src/apis/api-maintenance.service.js";
import { ApiRegistry } from "../../src/apis/api-registry.js";
import { ApiSource } from "../../src/apis/api.source.js";
import { ApiVault } from "../../src/apis/api-vault.js";
import { UNTRUSTED_SOURCES } from "../../src/tools/autonomy-policy.js";
import { AuditService } from "../../src/core/audit/audit.service.js";
import { CoreModule } from "../../src/core/core.module.js";
import { NovaConfig } from "../../src/core/config/nova-config.js";
import { JarvisStateStore } from "../../src/planning/jarvis-state.store.js";
import { SettingsStore } from "../../src/settings/store/settings.store.js";
import { ToolsModule } from "../../src/tools/tools.module.js";
import { ToolsService } from "../../src/tools/tools.service.js";
import {
  SECRET,
  OPENAPI3,
  petShop,
  startFakeApi,
  type FakeApi,
} from "./fake-api.js";

@Module({
  imports: [CoreModule, ToolsModule],
  providers: [
    ApiVault,
    ApiRegistry,
    ApiEngine,
    ApiSource,
    JarvisStateStore,
    ApiMaintenanceService,
  ],
})
class ApisTestModule {}

let tools: ToolsService;
let audit: AuditService;
let engine: ApiEngine;
let api: FakeApi;
let config: NovaConfig;
const out: string[] = [];
const outputs: unknown[] = [];

const run = async (
  name: string,
  args: Record<string, unknown>,
  session = "s1",
  approved: Parameters<ToolsService["execute"]>[3] = null,
) => {
  const result = await tools.execute(name, args, session, approved);
  outputs.push(result);
  return result;
};

describe("api tools through ToolsService", () => {
  beforeAll(async () => {
    process.env.JARVIS_ENABLE_ACTIONS = "true";
    for (const stream of [process.stdout, process.stderr]) {
      const original = stream.write.bind(stream);
      vi.spyOn(stream, "write").mockImplementation(((
        chunk: unknown,
        ...rest: unknown[]
      ) => {
        out.push(String(chunk));
        return (original as (...a: unknown[]) => boolean)(chunk, ...rest);
      }) as never);
    }
    const moduleRef = await Test.createTestingModule({
      imports: [CoreModule, ToolsModule, ApisTestModule],
    }).compile();
    await moduleRef.init();
    tools = moduleRef.get(ToolsService);
    audit = moduleRef.get(AuditService);
    engine = moduleRef.get(ApiEngine);
    config = moduleRef.get(NovaConfig);
    moduleRef.get(SettingsStore);
    api = await startFakeApi(petShop);
  });
  afterAll(async () => {
    delete process.env.JARVIS_ENABLE_ACTIONS;
    vi.restoreAllMocks();
    await api.close();
  });

  it("api output counts as untrusted for autonomy", () => {
    expect(UNTRUSTED_SOURCES.has("api")).toBe(true);
  });

  it("api_connect moves a raw token to the vault before audit and returns no secret", async () => {
    const result = await run("api_connect", {
      base_url: api.url,
      token: SECRET,
      name: "Pets",
      local_network: true,
    });
    expect(result.ok).toBe(true);
    const summary = result.result as {
      id: string;
      status: string;
      auth: { type: string; credentialStored: boolean };
      loginVerified: boolean;
    };
    expect(summary).toMatchObject({
      id: "pets",
      status: "ready",
      loginVerified: true,
      auth: { type: "bearer", credentialStored: true },
    });
    const entries = audit.read(50).filter((e) => e.tool === "api_connect");
    expect(entries.length).toBeGreaterThan(0);
    const serialized = JSON.stringify(entries);
    expect(serialized).not.toContain(SECRET);
    expect(serialized).toMatch(/credential_ref/);
  });

  it("registers per-operation tools plus meta tools, with a spec-driven schema", () => {
    const names = tools.list().filter((t) => t.source === "api");
    for (const meta of [
      "api_connect",
      "api_list",
      "api_describe",
      "api_test",
      "api_remove",
      "api_refresh",
      "api_attach_docs",
      "api_call",
      "api_configure",
      "api_workflow_plan",
    ])
      expect(
        names.some((t) => t.name === meta),
        meta,
      ).toBe(true);
    expect(names.find((t) => t.name === "api_pets_listPets")?.risk).toBe(
      "READ_ONLY",
    );
    expect(names.find((t) => t.name === "api_pets_deletePet")?.risk).toBe(
      "DANGEROUS",
    );
    const model = tools
      .forModel()
      .find((t) => t.function.name === "api_pets_getPet")!;
    expect(model.function.parameters).toMatchObject({
      required: ["id"],
      properties: { id: { type: "string" } },
    });
  });

  it("reads run directly and are marked untrusted", async () => {
    const result = await run("api_pets_listPets", {});
    expect(result).toMatchObject({
      ok: true,
      status: 200,
      untrusted: true,
      result: [{ id: "1", name: "Rex" }],
    });
    const viaCall = await run("api_call", {
      integration: "pets",
      operation: "getPet",
      params: { id: "1" },
    });
    expect(viaCall.ok).toBe(true);
    expect(viaCall.result).toEqual({ id: "1", name: "Rex" });
    const post = await run("api_pets_searchPets", { body: { q: "rex" } });
    expect(post.ok).toBe(true);
  });

  it("mutating operations ask for confirmation, then run once approved", async () => {
    const before = api.hits.length;
    const pending = await run(
      "api_pets_createPet",
      { body: { name: "Fido" } },
      "s2",
    );
    expect(pending.requiresConfirmation).toBe(true);
    expect(api.hits.length).toBe(before);
    const approved = await run(
      "api_pets_createPet",
      { body: { name: "Fido" } },
      "s2",
      pending.action!,
    );
    expect(approved).toMatchObject({ ok: true, status: 201 });
    expect(api.hits.at(-1)).toMatchObject({ method: "POST", url: "/v1/pets" });
  });

  it("destructive operations never run without confirmation, also through api_call", async () => {
    const before = api.hits.length;
    const direct = await run("api_pets_deletePet", { id: "1" }, "s3");
    expect(direct).toMatchObject({ ok: false, requiresConfirmation: true });
    expect(direct.action?.risk).toBe("DANGEROUS");
    const generic = await run(
      "api_call",
      { integration: "pets", operation: "deletePet", params: { id: "1" } },
      "s3",
    );
    expect(generic).toMatchObject({ ok: false, requiresConfirmation: true });
    expect(generic.action?.risk).toBe("DANGEROUS");
    expect(api.hits.length).toBe(before);
    // unknown operation falls back to CONFIRM, never to a silent run
    const unknown = await run(
      "api_call",
      { integration: "pets", operation: "nope" },
      "s3",
    );
    expect(unknown.requiresConfirmation).toBe(true);
  });

  it("proactive (read-only) scope refuses mutating api tools", async () => {
    const result = await tools.execute(
      "api_pets_createPet",
      { body: { name: "x" } },
      "s4",
      null,
      false,
      { readOnlyOnly: true },
    );
    expect(result.ok).toBe(false);
    expect(
      tools
        .forModel(undefined, true)
        .some((t) => t.function.name === "api_pets_createPet"),
    ).toBe(false);
    expect(
      tools
        .forModel(undefined, true)
        .some((t) => t.function.name === "api_pets_listPets"),
    ).toBe(true);
  });

  it("api_configure: raising is free, lowering needs confirmation and never goes below what was proven", async () => {
    const raise = await run(
      "api_configure",
      { integration: "pets", operation: "listPets", risk: "CONFIRM" },
      "s5",
    );
    expect(raise.ok).toBe(true);
    expect(
      engine.registry.get("pets")!.operations.find((o) => o.id === "listPets"),
    ).toMatchObject({ risk: "CONFIRM", floor: "READ_ONLY" });
    const nowAsks = await run("api_pets_listPets", {}, "s5");
    expect(nowAsks.requiresConfirmation).toBe(true);
    const lower = await run(
      "api_configure",
      { integration: "pets", operation: "listPets", risk: "READ_ONLY" },
      "s5",
    );
    expect(lower.requiresConfirmation).toBe(true);
    await run(
      "api_configure",
      { integration: "pets", operation: "listPets", risk: "READ_ONLY" },
      "s5",
      lower.action!,
    );
    expect(
      engine.registry.get("pets")!.operations.find((o) => o.id === "listPets")!
        .risk,
    ).toBe("READ_ONLY");
    const below = await run(
      "api_configure",
      { integration: "pets", operation: "createPet", risk: "READ_ONLY" },
      "s5",
    );
    const approved = await run(
      "api_configure",
      { integration: "pets", operation: "createPet", risk: "READ_ONLY" },
      "s5",
      below.action!,
    );
    expect(approved.ok).toBe(false);
    expect(
      engine.registry.get("pets")!.operations.find((o) => o.id === "createPet")!
        .risk,
    ).toBe("CONFIRM");
  });

  it("api_attach_docs keeps pasted material and the token inside it out of the audit log", async () => {
    const curl = `curl -H 'X-Api-Key: planted-key-9999' ${api.url}/v1/pets/1`;
    const result = await run("api_attach_docs", {
      integration: "pets",
      text: curl,
    });
    expect(result.ok).toBe(true);
    const logged = JSON.stringify(
      audit.read(30).filter((e) => e.tool === "api_attach_docs"),
    );
    expect(logged).not.toContain("planted-key-9999");
    expect(logged).toContain("characters of documentation");
  });

  it("api_workflow_plan lists operations across integrations and NOVA's own tools without running anything", async () => {
    const before = api.hits.length;
    const result = await run("api_workflow_plan", {
      goal: "list pets and show the time",
    });
    expect(result.ok).toBe(true);
    const plan = result.result as {
      apiOperations: { integration: string; operation: string; risk: string }[];
      novaTools: unknown[];
      howToRun: string;
    };
    expect(
      plan.apiOperations.some(
        (o) => o.operation === "listPets" && o.risk === "READ_ONLY",
      ),
    ).toBe(true);
    expect(plan.howToRun).toMatch(/agent_run/);
    expect(api.hits.length).toBe(before);
  });

  it("keeps the model's tool list manageable: operation tools only when relevant, at most 12", async () => {
    const paths = Object.fromEntries(
      Array.from({ length: 40 }, (_, n) => [
        `/gadgets/${n}/info`,
        { get: { operationId: `gadgetInfo${n}`, summary: `Gadget ${n} info` } },
      ]),
    );
    const big = await startFakeApi((hit) =>
      hit.url === "/openapi.json"
        ? { body: { openapi: "3.0.0", info: { title: "Gadgets" }, paths } }
        : { body: {} },
    );
    try {
      const connected = await run("api_connect", {
        base_url: big.url,
        name: "Gadgets",
        local_network: true,
      });
      expect(connected.ok).toBe(true);
      const unrelated = tools
        .forModel({ message: "wat is het weer morgen", role: "conversation" })
        .map((t) => t.function.name);
      expect(
        unrelated.filter((n) => /^api_(gadgets|pets)_/.test(n)),
      ).toHaveLength(0);
      const related = tools
        .forModel({
          message: "toon gadget info voor de gadgets api",
          role: "conversation",
        })
        .map((t) => t.function.name);
      const operationTools = related.filter((n) =>
        /^api_(gadgets|pets)_/.test(n),
      );
      expect(operationTools.length).toBeGreaterThan(0);
      expect(operationTools.length).toBeLessThanOrEqual(12);
      expect(related.length).toBeLessThanOrEqual(24);
      const dutch = tools
        .forModel({ message: "koppel een api voor mij", role: "conversation" })
        .map((t) => t.function.name);
      expect(dutch).toContain("api_connect");
      // every tool name is valid and unique
      const all = tools.list().map((t) => t.name);
      expect(new Set(all).size).toBe(all.length);
      expect(all.every((n) => /^[a-zA-Z0-9_-]{1,64}$/.test(n))).toBe(true);
    } finally {
      await big.close();
    }
    void OPENAPI3;
  });

  it("api_remove needs confirmation and deletes the credential", async () => {
    const ref = (engine.registry.get("pets")!.auth as { ref: string }).ref;
    const pending = await run("api_remove", { integration: "pets" }, "s6");
    expect(pending.requiresConfirmation).toBe(true);
    expect(engine.registry.get("pets")).toBeDefined();
    const done = await run(
      "api_remove",
      { integration: "pets" },
      "s6",
      pending.action!,
    );
    expect(done.ok).toBe(true);
    expect(engine.registry.get("pets")).toBeUndefined();
    expect(engine.vault.has(ref)).toBe(false);
  });

  it("the planted secret appears nowhere: tool results, audit log, data files, process output", () => {
    for (const planted of [SECRET, "planted-key-9999"]) {
      expect(JSON.stringify(outputs), "tool results").not.toContain(planted);
      expect(JSON.stringify(audit.read(1000)), "audit").not.toContain(planted);
      expect(out.join(""), "stdout/stderr").not.toContain(planted);
      for (const name of fs.readdirSync(config.dataDir))
        if (fs.statSync(config.dataFile(name)).isFile())
          expect(
            fs.readFileSync(config.dataFile(name)).includes(planted),
            name,
          ).toBe(false);
    }
  });
});
