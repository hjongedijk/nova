import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Test } from "@nestjs/testing";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import { ToolsModule } from "../../src/tools/tools.module.js";
import { ToolsService } from "../../src/tools/tools.service.js";
import { CoreModule } from "../../src/core/core.module.js";
import type { NovaConfig } from "../../src/core/config/nova-config.js";
import {
  McpHub,
  McpModule,
  McpSource,
  readMcpServers,
  resolveEnv,
  toolName,
} from "../../src/integrations/mcp/index.js";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "nova-mcp-"));
afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));
const fixture = fileURLToPath(
  new URL("../fixtures/mcp-echo-server.mjs", import.meta.url),
);

const configFile = (servers: unknown, name = "mcp.json") => {
  const file = path.join(dir, name);
  fs.writeFileSync(file, JSON.stringify({ servers }));
  return file;
};
const hubFor = (file: string) => new McpHub({ mcpConfig: file } as NovaConfig);
const call = { sessionId: "t", signal: new AbortController().signal };

describe("MCP hub", () => {
  const hubs: McpHub[] = [];
  afterEach(async () => {
    await Promise.all(hubs.splice(0).map((hub) => hub.stop()));
  });
  const start = async (file: string) => {
    const hub = hubFor(file);
    hubs.push(hub);
    await hub.sync();
    return hub;
  };

  it("exposes stdio tools with risk from read-only hints", async () => {
    const hub = await start(
      configFile({
        echo: { command: process.execPath, args: [fixture], risk: "CONFIRM" },
        off: { command: "missing", enabled: false },
        needs_key: {
          command: process.execPath,
          args: [fixture],
          env: { TOKEN: "${NOVA_TEST_UNSET_TOKEN}" },
        },
      }),
    );
    const defs = hub.definitions();
    expect(defs.map((d) => d.name).sort()).toEqual([
      "mcp_echo_echo",
      "mcp_echo_write_note",
    ]);
    expect(Object.fromEntries(defs.map((d) => [d.name, d.risk]))).toEqual({
      mcp_echo_echo: "READ_ONLY",
      mcp_echo_write_note: "CONFIRM",
    });
    expect(defs[0]?.description).toMatch(/^\[echo\] /);
    expect(defs[0]?.parameters.additionalProperties).toBe(false);
    expect(await hub.execute("mcp_echo_echo", { text: "hi" })).toEqual({
      ok: true,
      verified: null,
      result: "hi",
    });
    expect(hub.owns("mcp_echo_echo")).toBe(true);
    expect(hub.health()).toEqual({
      configured: true,
      servers: ["echo"],
      tools: 2,
    });
  });

  it("retains revisions within a connection and invalidates them on an identical reconnect", async () => {
    const hub = await start(
      configFile(
        {
          echo: {
            command: process.execPath,
            args: [fixture],
            risk: "CONFIRM",
            env: { SECRET_TOKEN: "private-execution-secret" },
          },
        },
        "revision.json",
      ),
    );
    const before = hub.definitions();
    const revision = before[0]!.approvalRevision;
    expect(revision).toMatch(/^[a-f0-9-]{36}$/);
    expect(before.every((tool) => tool.approvalRevision === revision)).toBe(
      true,
    );
    await hub.sync();
    expect(hub.definitions()).toEqual(before);
    await hub.stop();
    await hub.start();
    const after = hub.definitions();
    expect(after[0]!.approvalRevision).not.toBe(revision);
    const exposed = (tools: typeof before) =>
      tools.map((tool) => ({
        name: tool.name,
        description: tool.description,
        parameters: tool.parameters,
        risk: tool.risk,
      }));
    expect(exposed(after)).toEqual(exposed(before));
    expect(JSON.stringify(after)).not.toContain("private-execution-secret");
    expect(JSON.stringify(hub.health())).not.toContain(
      after[0]!.approvalRevision,
    );
  });

  it("the default risk is CONFIRM and a declared risk applies to tools without a hint", async () => {
    const hub = await start(
      configFile(
        { echo: { command: process.execPath, args: [fixture], risk: "SAFE" } },
        "safe.json",
      ),
    );
    const risks = Object.fromEntries(
      hub.definitions().map((d) => [d.name, d.risk]),
    );
    expect(risks.mcp_echo_write_note).toBe("SAFE");
    const bare = await start(
      configFile(
        { echo: { command: process.execPath, args: [fixture] } },
        "bare.json",
      ),
    );
    expect(
      bare.definitions().find((d) => d.name === "mcp_echo_write_note")?.risk,
    ).toBe("CONFIRM");
  });

  it("a missing server or config is logged and skipped, never thrown", async () => {
    const hub = await start(
      configFile({
        ghost: { command: "/nonexistent/nova-mcp-server" },
        broken: { command: process.execPath, args: ["-e", "process.exit(1)"] },
        echo: { command: process.execPath, args: [fixture] },
      }),
    );
    expect(hub.health().servers).toEqual(["echo"]);
    const none = await start(path.join(dir, "does-not-exist.json"));
    expect(none.definitions()).toEqual([]);
    expect(none.configured).toBe(false);
    fs.writeFileSync(path.join(dir, "bad.json"), "{nope");
    expect((await start(path.join(dir, "bad.json"))).definitions()).toEqual([]);
  });

  it("calling a tool of a server that is gone answers offline", async () => {
    const hub = await start(
      configFile({ echo: { command: process.execPath, args: [fixture] } }),
    );
    await hub.stop();
    expect(await hub.execute("mcp_echo_echo", { text: "x" })).toEqual({
      ok: false,
      error: "MCP server is offline",
    });
    expect(hub.definitions()).toEqual([]);
  });

  it("stop closes the servers and sync does not connect twice", async () => {
    const hub = await start(
      configFile({ echo: { command: process.execPath, args: [fixture] } }),
    );
    await Promise.all([hub.sync(), hub.sync()]);
    expect(hub.health().tools).toBe(2);
    await hub.stop();
    expect(hub.health().servers).toEqual([]);
  });

  it("the module starts in the background, offers a tool source and shuts down", async () => {
    const file = configFile({
      echo: { command: process.execPath, args: [fixture] },
    });
    const moduleRef = await Test.createTestingModule({
      imports: [CoreModule, McpModule, ToolsModule],
    })
      .overrideProvider(McpHub)
      .useValue(hubFor(file))
      .compile();
    await moduleRef.init();
    const hub = moduleRef.get(McpHub);
    await hub.sync();
    const source = moduleRef.get(McpSource);
    expect(source.source).toBe("mcp");
    expect(
      source
        .definitions()
        .map((d) => d.name)
        .sort(),
    ).toEqual(["mcp_echo_echo", "mcp_echo_write_note"]);
    expect(await source.execute("mcp_echo_echo", { text: "yo" }, call)).toEqual(
      {
        ok: true,
        verified: null,
        result: "yo",
      },
    );
    const tools = moduleRef.get(ToolsService);
    const revision = source.definitions()[0]!.approvalRevision!;
    const modelTools = tools
      .forModel()
      .filter((tool) => tool.function.name.startsWith("mcp_echo_"));
    const publicTools = tools
      .list()
      .filter((tool) => tool.name.startsWith("mcp_echo_"));
    expect(modelTools).toHaveLength(2);
    expect(publicTools).toHaveLength(2);
    expect(JSON.stringify(modelTools)).not.toContain(revision);
    expect(JSON.stringify(publicTools)).not.toContain(revision);
    expect(JSON.stringify(modelTools)).not.toContain("approvalRevision");
    expect(JSON.stringify(publicTools)).not.toContain("approvalRevision");
    await moduleRef.close();
    expect(hub.health().servers).toEqual([]);
  });
});

describe("MCP config helpers", () => {
  it("tool names are mcp_<server>_<tool>, cleaned and at most 64 characters", () => {
    expect(toolName("echo", "write.note")).toBe("mcp_echo_write_note");
    const long = toolName("a".repeat(40), "b".repeat(40));
    expect(long.length).toBeLessThanOrEqual(64);
    expect(long).not.toBe(toolName("a".repeat(40), "b".repeat(39) + "c"));
  });

  it("${VARS} in env are resolved and unset ones name what is missing", () => {
    expect(resolveEnv({ A: "x-${B}" }, { B: "1" })).toEqual({
      env: { A: "x-1" },
    });
    expect(resolveEnv({ A: "${NOPE}", C: "${ALSO}" }, {})).toEqual({
      missing: ["NOPE"],
    });
    expect(resolveEnv(undefined, {})).toEqual({ env: {} });
  });

  it("readMcpServers tolerates a missing or odd file", () => {
    expect(readMcpServers(path.join(dir, "nope.json"))).toEqual({});
    const file = path.join(dir, "odd.json");
    fs.writeFileSync(file, JSON.stringify({ servers: "x" }));
    expect(readMcpServers(file)).toEqual({});
  });
});
