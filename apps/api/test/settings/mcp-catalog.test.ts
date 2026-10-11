import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ConfirmationsService } from "../../src/confirmations/confirmations.service.js";
import {
  AuditService,
  type AuditRecord,
} from "../../src/core/audit/audit.service.js";
import { NovaConfig } from "../../src/core/config/nova-config.js";
import { McpHub } from "../../src/integrations/mcp/mcp.hub.js";
import {
  isReviewedMcpServer,
  reviewedMcpServerSpec,
} from "../../src/integrations/mcp/reviewed-mcp-servers.js";
import { McpManagement } from "../../src/settings/mcp-management.service.js";

const cleanups: (() => void)[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const cleanup of cleanups.splice(0)) cleanup();
});

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "nova-mcp-catalog-"));
  const file = path.join(root, "mcp-servers.json");
  fs.writeFileSync(file, JSON.stringify({ servers: {} }), { mode: 0o600 });
  cleanups.push(() => fs.rmSync(root, { recursive: true, force: true }));
  const config = {
    dataDir: root,
    mcpConfig: file,
    dataFile: (name: string) => path.join(root, name),
  } as NovaConfig;
  const record = vi.fn((entry: AuditRecord) => ({
    ...entry,
    id: "audit",
    timestamp: "now",
  }));
  const audit = { record } as unknown as AuditService;
  const confirmations = new ConfirmationsService(audit);
  confirmations.now = () => Date.now();
  const reconfigure = vi.fn(async () => {});
  const hub = { reconfigure } as unknown as McpHub;
  const service = new McpManagement(config, hub, confirmations, audit);
  return { root, file, service, record, reconfigure };
}

async function confirm(
  f: ReturnType<typeof fixture>,
  prepared: ReturnType<typeof f.service.prepareCatalog>,
) {
  if (!prepared.ok) throw new Error(prepared.error);
  return f.service.confirmCatalog(
    prepared.action.sessionId,
    prepared.action.confirmationId,
    true,
  );
}

describe("reviewed MCP catalog management", () => {
  it("pins CalDAV to secret references and five read-only calendar tools", () => {
    const spec = reviewedMcpServerSpec("caldav");
    expect(spec).toMatchObject({
      command: "/opt/caldav-mcp/node_modules/.bin/caldav-mcp",
      args: [],
      enabled: false,
      risk: "READ_ONLY",
      toolRisks: {
        list_calendars: "READ_ONLY",
        list_events: "READ_ONLY",
        get_event: "READ_ONLY",
        search_events: "READ_ONLY",
        get_free_busy: "READ_ONLY",
      },
      env: {
        CALDAV_URL: "${CALDAV_URL}",
        CALDAV_USERNAME: "${CALDAV_USERNAME}",
        CALDAV_PASSWORD: "${CALDAV_PASSWORD}",
        CALDAV_READ_ONLY: "true",
        CALDAV_ALLOW_TOOLS:
          "list_calendars,list_events,get_event,search_events,get_free_busy",
      },
    });
    expect(isReviewedMcpServer("caldav", spec!)).toBe(true);
    expect(
      isReviewedMcpServer("caldav", {
        ...spec!,
        env: { ...spec!.env, CALDAV_READ_ONLY: "false" },
      }),
    ).toBe(false);
    expect(spec?.env?.CALDAV_PASSWORD).toBe("${CALDAV_PASSWORD}");
  });

  it("pins IMAP to TLS and only two non-mutating message tools", () => {
    const spec = reviewedMcpServerSpec("imap");
    expect(spec).toMatchObject({
      command: "/opt/imap-mcp/node_modules/.bin/imap-mcp",
      args: [],
      enabled: false,
      risk: "READ_ONLY",
      toolRisks: {
        list_messages: "READ_ONLY",
        get_message: "READ_ONLY",
      },
      env: {
        IMAP_HOST: "${IMAP_HOST}",
        IMAP_USER: "${IMAP_USER}",
        IMAP_PASSWORD: "${IMAP_PASSWORD}",
        IMAP_TLS: "implicit",
        IMAP_PORT: "993",
        IMAP_READ_ONLY: "true",
        IMAP_SEEN_KEYWORD: "",
        IMAP_ALLOW_TOOLS: "list_messages,get_message",
      },
    });
    expect(isReviewedMcpServer("imap", spec!)).toBe(true);
    expect(
      isReviewedMcpServer("imap", {
        ...spec!,
        env: { ...spec!.env, IMAP_READ_ONLY: "false" },
      }),
    ).toBe(false);
    expect(
      isReviewedMcpServer("imap", {
        ...spec!,
        env: { ...spec!.env, IMAP_ALLOW_TOOLS: "essential" },
      }),
    ).toBe(false);
    expect(spec?.env?.IMAP_PASSWORD).toBe("${IMAP_PASSWORD}");
  });

  it("adds only a fixed reviewed server disabled, then removes it after confirmation", async () => {
    const f = fixture();
    const before = f.service.catalog();
    expect(before.installed).toEqual([]);
    expect(before.available.map(({ id }) => id)).toContain("context7");
    expect(JSON.stringify(before)).not.toMatch(
      /"command"|"args"|"env"|context7-mcp/,
    );

    const add = f.service.prepareCatalog("context7", "add");
    expect(add).toMatchObject({ ok: true });
    expect(JSON.stringify(add)).not.toMatch(/"command"|"env"|context7-mcp/);
    const added = await confirm(f, add);
    if (!added.ok) throw new Error(added.error);
    expect(added).toMatchObject({
      ok: true,
      verified: true,
      server: "context7",
      operation: "add",
    });
    const config = JSON.parse(fs.readFileSync(f.file, "utf8")) as {
      servers: Record<string, Record<string, unknown>>;
    };
    expect(config.servers.context7).toMatchObject({
      command: "context7-mcp",
      args: [],
      env: {},
      enabled: false,
    });
    expect(fs.statSync(f.file).mode & 0o777).toBe(0o600);
    expect(f.service.catalog().installed).toEqual(["context7"]);

    const remove = f.service.prepareCatalog("context7", "remove");
    expect(await confirm(f, remove)).toMatchObject({
      ok: true,
      verified: true,
      server: "context7",
      operation: "remove",
    });
    expect(JSON.parse(fs.readFileSync(f.file, "utf8")).servers).toEqual({});
    expect(f.service.catalog().available.map(({ id }) => id)).toContain(
      "context7",
    );
    expect(f.reconfigure).toHaveBeenCalledTimes(2);
    expect(JSON.stringify(f.record.mock.calls)).not.toMatch(
      /"command"|"env"|context7-mcp/,
    );
  });

  it("undoes only the latest unchanged NOVA catalog addition", async () => {
    const f = fixture();
    const added = await confirm(f, f.service.prepareCatalog("context7", "add"));
    if (!added.ok) throw new Error(added.error);
    const history = f.service.history("context7");
    expect(history.revisions).toHaveLength(1);
    const revision = history.revisions[0]!;
    expect(revision.change).toEqual({ kind: "catalog", operation: "add" });
    expect(JSON.stringify(history)).not.toMatch(
      /command|context7-mcp|env|Fingerprint/i,
    );

    const prepared = f.service.prepareRollback("context7", revision.id);
    expect(prepared).toMatchObject({
      ok: true,
      warning: expect.stringContaining("uitgeschakeld"),
    });
    const undone = await confirm(f, prepared);
    expect(undone).toMatchObject({
      ok: true,
      verified: true,
      server: "context7",
      operation: "remove",
    });
    expect(f.service.catalog().installed).toEqual([]);
    expect(f.service.history("context7").revisions[0]?.change).toEqual({
      kind: "catalog",
      operation: "remove",
    });
    expect(f.reconfigure).toHaveBeenCalledTimes(2);
  });

  it("refuses catalog-add undo after enablement, configuration changes, or a stale confirm", async () => {
    const enabled = fixture();
    await confirm(enabled, enabled.service.prepareCatalog("context7", "add"));
    const enabledConfig = JSON.parse(fs.readFileSync(enabled.file, "utf8"));
    enabledConfig.servers.context7.enabled = true;
    fs.writeFileSync(enabled.file, JSON.stringify(enabledConfig), {
      mode: 0o600,
    });
    const enabledRevision = enabled.service.history("context7").revisions[0]!;
    expect(() =>
      enabled.service.prepareRollback("context7", enabledRevision.id),
    ).toThrow("uitgeschakelde NOVA-toevoeging");

    const changed = fixture();
    await confirm(changed, changed.service.prepareCatalog("context7", "add"));
    const changedConfig = JSON.parse(fs.readFileSync(changed.file, "utf8"));
    changedConfig.servers.context7.description = "custom";
    fs.writeFileSync(changed.file, JSON.stringify(changedConfig), {
      mode: 0o600,
    });
    const changedRevision = changed.service.history("context7").revisions[0]!;
    expect(() =>
      changed.service.prepareRollback("context7", changedRevision.id),
    ).toThrow("uitgeschakelde NOVA-toevoeging");

    const stale = fixture();
    await confirm(stale, stale.service.prepareCatalog("context7", "add"));
    const staleRevision = stale.service.history("context7").revisions[0]!;
    const prepared = stale.service.prepareRollback(
      "context7",
      staleRevision.id,
    );
    if (!prepared.ok) throw new Error(prepared.error);
    const staleConfig = JSON.parse(fs.readFileSync(stale.file, "utf8"));
    staleConfig.servers.context7.enabled = true;
    fs.writeFileSync(stale.file, JSON.stringify(staleConfig), { mode: 0o600 });
    await expect(confirm(stale, prepared)).resolves.toMatchObject({
      ok: false,
      error: expect.stringContaining("intussen gewijzigd"),
    });
  });

  it("cancels catalog-add undo without changing the installed server", async () => {
    const f = fixture();
    await confirm(f, f.service.prepareCatalog("context7", "add"));
    const revision = f.service.history("context7").revisions[0]!;
    const prepared = f.service.prepareRollback("context7", revision.id);
    if (!prepared.ok) throw new Error(prepared.error);
    await expect(
      f.service.confirmCatalog(
        prepared.action.sessionId,
        prepared.action.confirmationId,
        false,
      ),
    ).resolves.toMatchObject({ ok: true, cancelled: true });
    expect(f.service.catalog().installed).toEqual(["context7"]);
    expect(f.reconfigure).toHaveBeenCalledTimes(1);
  });

  it("rejects custom IDs and removal of an unreviewed server", () => {
    const f = fixture();
    expect(() => f.service.prepareCatalog("arbitrary", "add")).toThrow(
      "beoordeelde catalogus",
    );
    fs.writeFileSync(
      f.file,
      JSON.stringify({
        servers: {
          filesystem: {
            command: "unreviewed-command",
            args: [],
            env: {},
            enabled: false,
          },
        },
      }),
      { mode: 0o600 },
    );
    expect(() => f.service.prepareCatalog("filesystem", "remove")).toThrow(
      "beoordeelde MCP-server",
    );
  });

  it("keeps a verified write successful if the final audit append fails", async () => {
    const f = fixture();
    const prepared = f.service.prepareCatalog("context7", "add");
    f.record.mockImplementation((entry) => {
      if (entry.phase === "verified") throw new Error("audit unavailable");
      return { ...entry, id: "audit", timestamp: "now" };
    });

    await expect(confirm(f, prepared)).resolves.toMatchObject({
      ok: true,
      verified: true,
      operation: "add",
    });
    expect(
      JSON.parse(fs.readFileSync(f.file, "utf8")).servers.context7.enabled,
    ).toBe(false);
  });
});
