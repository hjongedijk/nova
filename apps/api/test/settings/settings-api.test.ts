import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { DEFAULT_QUICK_ACTIONS } from "../../src/settings/store/settings.store.js";
import { NovaConfig } from "../../src/core/config/nova-config.js";
import { HomeAssistantService } from "../../src/home/home-assistant.service.js";
import { ProxmoxService } from "../../src/proxmox/proxmox.service.js";
import { TermixService } from "../../src/integrations/termix/termix.service.js";
import { PangolinService } from "../../src/integrations/pangolin/pangolin.service.js";
import { JarvisStateStore } from "../../src/planning/jarvis-state.store.js";
import { WorkspaceProjects } from "../../src/settings/workspace-projects.service.js";
import type { WallpaperPort } from "../../src/settings/wallpaper.port.js";
import {
  ADMIN,
  createApp,
  type Reply,
  json,
  lan,
  onLan,
  playbook,
  service,
  type TestApp,
  webhook,
} from "./helpers.js";

let nova: TestApp;
const improveCalls: string[] = [];

beforeAll(async () => {
  nova = await createApp({
    llm: {
      complete: async (messages) => {
        improveCalls.push(messages[1]!.content);
        const draft = JSON.parse(messages[1]!.content).concept;
        return JSON.stringify({
          description: `Beter: ${draft.name}`,
          notes: "ok",
        });
      },
    },
  });
});
afterAll(() => nova.app.close());
beforeEach(() => {
  fs.rmSync(path.join(nova.store["file" as never] as string), { force: true });
  fs.rmSync(nova.app.get(NovaConfig).dataFile("note-widget-history.json"), {
    force: true,
  });
  fs.rmSync(
    nova.app.get(NovaConfig).dataFile("instruction-skill-history.json"),
    { force: true },
  );
  nova.store.reset();
  nova.audits.length = 0;
});

const call = async (
  method: "get" | "post" | "put" | "delete",
  route: string,
  body?: unknown,
  headers: Record<string, string> = ADMIN,
): Promise<Reply> => {
  if (
    method === "post" &&
    route === "/import" &&
    body &&
    typeof body === "object" &&
    Object.hasOwn(body, "data")
  ) {
    const request = body as { data: unknown; mode?: unknown };
    const data =
      request.data && typeof request.data === "object"
        ? ({ ...request.data } as Record<string, unknown>)
        : request.data;
    if (data && typeof data === "object")
      delete (data as Record<string, unknown>).status;
    const prepared = await nova.api
      .post("/api/settings/import/prepare")
      .set(headers)
      .send({ data, mode: request.mode, acknowledgeEffects: true });
    if (prepared.status !== 200 || !prepared.body.action)
      return { status: prepared.status, ...prepared.body };
    const { sessionId, confirmationId } = prepared.body.action;
    return call(
      "post",
      "/import",
      { sessionId, confirmationId, approve: true },
      headers,
    );
  }
  const response = await nova.api[method](`/api/settings${route}`)
    .set(headers)
    .send(body as object | undefined);
  return { status: response.status, ...(response.body as object) };
};

describe("the settings API", () => {
  it("protects code workspace browsing and returns only the selected project's files", async () => {
    const projects = nova.app.get(WorkspaceProjects);
    projects.create({ name: "Code UI" });
    const filePath = path.join(
      projects.projectDirectory("code-ui"),
      "hello.ts",
    );
    fs.writeFileSync(filePath, "export const hello = true;");
    const treePath = "/api/settings/workspace/code/tree";
    const pinned = await createApp({ env: { NOVA_ADMIN_PIN: "4321" } });
    try {
      expect((await pinned.api.get(treePath).set(ADMIN)).status).toBe(401);
    } finally {
      await pinned.app.close();
    }
    const tree = await nova.api.get(treePath).set(ADMIN);
    expect(tree.status).toBe(200);
    expect(tree.body.files).toEqual([{ path: "hello.ts", bytes: 26 }]);
    const file = await nova.api
      .get("/api/settings/workspace/code/file")
      .query({ path: "hello.ts" })
      .set(ADMIN);
    expect(file.status).toBe(200);
    expect(file.body.content).toContain("export const hello = true;");
    expect(
      (
        await nova.api
          .get("/api/settings/workspace/code/file")
          .query({ path: "../outside" })
          .set(ADMIN)
      ).status,
    ).toBe(400);
  });

  it("protects stack status and validates bounded restart actions", async () => {
    const statusPath = "/api/settings/stack-control/services";
    const preparePath = "/api/settings/stack-control/restart/prepare";
    expect(
      (await nova.api.post(preparePath).send({ service: "nova" })).status,
    ).toBe(403);
    expect((await nova.api.get(statusPath).set(ADMIN)).status).toBe(200);
    expect(
      (
        await nova.api
          .post(preparePath)
          .set(ADMIN)
          .send({ service: "docker", command: "rm -rf /" })
      ).status,
    ).toBe(400);
    expect(
      (
        await nova.api
          .post("/api/settings/stack-control/restart/confirm")
          .set(ADMIN)
          .send({
            sessionId: "anything",
            confirmationId: "anything",
            approve: true,
          })
      ).status,
    ).toBe(400);
  });

  it("returns only bounded target names from configured infrastructure services", async () => {
    const proxmox = nova.app.get(ProxmoxService);
    const termix = nova.app.get(TermixService);
    const pangolin = nova.app.get(PangolinService);
    vi.spyOn(proxmox, "configured", "get").mockReturnValue(true);
    vi.spyOn(proxmox, "rawNodes").mockResolvedValue([{ node: "pve-node" }]);
    vi.spyOn(proxmox, "resources").mockResolvedValue([
      { node: "pve-node", vmid: 101, name: "guest-one", type: "qemu" },
    ]);
    vi.spyOn(termix, "configured", "get").mockReturnValue(true);
    vi.spyOn(termix, "listHosts").mockResolvedValue([
      { id: 7, name: "nas", ip: "10.0.0.4", username: "secret" },
    ]);
    vi.spyOn(pangolin, "configured", "get").mockReturnValue(true);
    vi.spyOn(pangolin, "listTargets").mockImplementation(async (name) =>
      name === "pangolin_sites"
        ? { sites: [{ id: "site-1", name: "tunnel", online: true }] }
        : {
            resources: [
              { id: "resource-1", name: "app", domain: "private.test" },
            ],
          },
    );

    const response = await nova.api
      .get("/api/settings/managed-targets/inventory")
      .set(ADMIN);
    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({
      proxmox: {
        nodes: [{ id: "pve-node", name: "pve-node" }],
        guests: [{ id: "pve-node/101", name: "guest-one" }],
      },
      termix: { hosts: [{ id: "7", name: "nas" }] },
      pangolin: {
        sites: [{ id: "site-1", name: "tunnel" }],
        resources: [{ id: "resource-1", name: "app" }],
      },
    });
    expect(JSON.stringify(response.body)).not.toMatch(
      /secret|10\.0\.0\.4|private\.test|online/,
    );
    const access = await nova.api
      .put("/api/settings/managed-targets/access")
      .set(ADMIN)
      .send({
        mode: "allowlist",
        proxmoxNodeIds: ["pve-node"],
        proxmoxGuestIds: [],
        termixHostIds: ["7"],
        pangolinSiteIds: ["site-1"],
        pangolinResourceIds: ["resource-1"],
      });
    expect(access.status).toBe(200);
    expect(access.body.policy).toMatchObject({
      mode: "allowlist",
      proxmoxNodeIds: ["pve-node"],
      termixHostIds: ["7"],
      pangolinSiteIds: ["site-1"],
      pangolinResourceIds: ["resource-1"],
    });
    const invalid = await nova.api
      .put("/api/settings/managed-targets/access")
      .set(ADMIN)
      .send({
        mode: "allowlist",
        proxmoxNodeIds: ["not-in-inventory"],
        proxmoxGuestIds: [],
        termixHostIds: [],
        pangolinSiteIds: [],
        pangolinResourceIds: [],
      });
    expect(invalid.status).toBe(400);
  });

  it("returns only a bounded Home Assistant names inventory on request", async () => {
    const home = nova.app.get(HomeAssistantService);
    home.syncedAt = new Date().toISOString();
    home.areas = [{ area_id: "living", name: "Woonkamer" }];
    home.devices = [{ id: "device-1", name: "Lamp", area_id: "living" }];
    home.entities = [
      {
        entity_id: "light.living",
        state: "on",
        attributes: { secret: "hidden" },
        friendly_name: "Plafondlamp",
        domain: "light",
        area_id: "living",
        device_id: "device-1",
        aliases: [],
        capabilities: ["secret"],
      },
    ] as never;
    const response = await nova.api.get(
      "/api/settings/home-assistant/inventory",
    );
    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({
      areas: [{ id: "living", name: "Woonkamer" }],
      devices: [{ id: "device-1", name: "Lamp", areaId: "living" }],
      entities: [
        {
          id: "light.living",
          name: "Plafondlamp",
          domain: "light",
          areaId: "living",
          deviceId: "device-1",
        },
      ],
    });
    expect(JSON.stringify(response.body)).not.toContain("hidden");
    home.syncedAt = null;
    const unavailable = await nova.api.get(
      "/api/settings/home-assistant/inventory",
    );
    expect(unavailable.status).toBe(503);
  });

  it("hides Home Assistant sync diagnostics from the settings response", async () => {
    const home = nova.app.get(HomeAssistantService);
    const sync = vi
      .spyOn(home, "sync")
      .mockRejectedValue(
        new Error("private-ha.internal /srv/private/password=abc123"),
      );
    try {
      const response = await nova.api.get(
        "/api/settings/home-assistant/inventory",
      );
      expect(response.status).toBe(503);
      expect(response.body.error).toBe(
        "Home Assistant reageert niet. Controleer de koppeling en probeer opnieuw.",
      );
      expect(JSON.stringify(response.body)).not.toMatch(
        /private-ha|\/srv\/private|abc123/,
      );
    } finally {
      sync.mockRestore();
    }
  });

  it("keeps private bounded history for existing note text and checks rollback conflicts", async () => {
    const created = await call("post", "/widgets", {
      type: "note",
      title: "Persoonlijke notitie",
      text: "Eerste versie",
    });
    const widgetId = (created.widget as { id: string }).id;
    expect(
      (
        await call("post", "/widgets", {
          type: "note",
          title: "Persoonlijke notitie",
          text: "Geen tweede notitie",
        })
      ).status,
    ).toBe(400);
    expect(
      (
        await call("put", `/widgets/${widgetId}`, {
          type: "note",
          title: "Persoonlijke notitie",
          text: "Tweede versie",
        })
      ).status,
    ).toBe(200);
    const history = await call("get", `/widgets/${widgetId}/history`);
    expect(history.revisions[0]).toMatchObject({
      before: "Eerste versie",
      after: "Tweede versie",
    });
    expect(history.revisions).toHaveLength(2);
    const historyPath = path.join(
      path.dirname(nova.store["file" as never] as string),
      "note-widget-history.json",
    );
    expect(fs.statSync(historyPath).mode & 0o777).toBe(0o600);
    expect(JSON.stringify(nova.audits)).not.toContain("Eerste versie");
    const revision = (history.revisions as { id: string }[])[0]!.id;
    expect(
      (await call("post", `/widgets/${widgetId}/history/${revision}/rollback`))
        .status,
    ).toBe(200);
    expect(
      nova.store.get().widgets.find((item) => item.id === widgetId),
    ).toMatchObject({ text: "Eerste versie" });

    await call("put", `/widgets/${widgetId}`, {
      type: "note",
      title: "Persoonlijke notitie",
      text: "Derde versie",
    });
    expect(
      (await call("post", `/widgets/${widgetId}/history/${revision}/rollback`))
        .status,
    ).toBe(409);
    expect((await call("delete", `/widgets/${widgetId}`)).status).toBe(200);
    const recreated = await call("post", "/widgets", {
      type: "note",
      title: "Persoonlijke notitie",
      text: "Nieuwe notitie",
    });
    const recreatedId = (recreated.widget as { id: string }).id;
    expect(recreatedId).not.toBe(widgetId);
    expect(
      (await call("get", `/widgets/${recreatedId}/history`)).revisions,
    ).toMatchObject([{ createdSnapshot: { title: "Persoonlijke notitie" } }]);
    const secretUpdate = await call("put", `/widgets/${recreatedId}`, {
      type: "note",
      title: "Persoonlijke notitie",
      text: "api_key: nooit-bewaren",
    });
    expect(secretUpdate.historyWarning).toMatch(/geheim/i);
    expect(
      JSON.stringify(await call("get", `/widgets/${recreatedId}/history`)),
    ).not.toContain("nooit-bewaren");
    const urlCredentialUpdate = await call("put", `/widgets/${recreatedId}`, {
      type: "note",
      title: "Persoonlijke notitie",
      text: "Link https://user:pass@example.test/private",
    });
    expect(urlCredentialUpdate.historyWarning).toMatch(/geheim/i);
    expect(
      JSON.stringify(await call("get", `/widgets/${recreatedId}/history`)),
    ).not.toContain("user:pass");
    const sshCredentialUpdate = await call("put", `/widgets/${recreatedId}`, {
      type: "note",
      title: "Persoonlijke notitie",
      text: "Host ssh://operator:private@server.example:22",
    });
    expect(sshCredentialUpdate.historyWarning).toMatch(/geheim/i);
    expect(
      JSON.stringify(await call("get", `/widgets/${recreatedId}/history`)),
    ).not.toContain("operator:private");
  });

  it("records and restores safe note title and enabled changes", async () => {
    const created = await call("post", "/widgets", {
      type: "note",
      title: "Oude titel",
      text: "Zelfde tekst",
      enabled: true,
    });
    const widgetId = (created.widget as { id: string }).id;
    await call("put", `/widgets/${widgetId}`, {
      type: "note",
      title: "Nieuwe titel",
      text: "Zelfde tekst",
      enabled: false,
    });
    const history = await call("get", `/widgets/${widgetId}/history`);
    const revision = (
      history.revisions as {
        id: string;
        beforeSnapshot?: { title: string; enabled: boolean; text: string };
        afterSnapshot?: { title: string; enabled: boolean; text: string };
      }[]
    ).find((row) => row.beforeSnapshot);
    expect(revision).toMatchObject({
      beforeSnapshot: {
        title: "Oude titel",
        enabled: true,
        text: "Zelfde tekst",
      },
      afterSnapshot: {
        title: "Nieuwe titel",
        enabled: false,
        text: "Zelfde tekst",
      },
    });
    const rawHistory = fs.readFileSync(
      nova.app.get(NovaConfig).dataFile("note-widget-history.json"),
      "utf8",
    );
    expect(rawHistory).toContain("Oude titel");
    expect(JSON.stringify(nova.audits)).not.toContain("Oude titel");

    expect(
      (
        await call(
          "post",
          `/widgets/${widgetId}/history/${revision!.id}/rollback`,
        )
      ).status,
    ).toBe(200);
    expect(
      nova.store.get().widgets.find((item) => item.id === widgetId),
    ).toMatchObject({
      title: "Oude titel",
      enabled: true,
      text: "Zelfde tekst",
    });
  });

  it("rejects note metadata rollback after any snapshot field changes", async () => {
    const created = await call("post", "/widgets", {
      type: "note",
      title: "Start",
      text: "Tekst",
      enabled: true,
    });
    const widgetId = (created.widget as { id: string }).id;
    await call("put", `/widgets/${widgetId}`, {
      type: "note",
      title: "Doel",
      text: "Tekst",
      enabled: false,
    });
    const history = await call("get", `/widgets/${widgetId}/history`);
    const revision = (
      history.revisions as {
        id: string;
        beforeSnapshot?: unknown;
      }[]
    ).find((row) => row.beforeSnapshot)!;
    await call("put", `/widgets/${widgetId}`, {
      type: "note",
      title: "Doel",
      text: "Tekst",
      enabled: true,
    });
    expect(
      (
        await call(
          "post",
          `/widgets/${widgetId}/history/${revision.id}/rollback`,
        )
      ).status,
    ).toBe(409);
  });

  it("can undo creation only while the secret-screened note is unchanged", async () => {
    const created = await call("post", "/widgets", {
      type: "note",
      title: "Testnotitie",
      text: "Alleen lokale inhoud",
    });
    const widgetId = (created.widget as { id: string }).id;
    const history = await call("get", `/widgets/${widgetId}/history`);
    const creation = (history.revisions as { id: string }[])[0]!;
    expect(history.revisions).toMatchObject([
      {
        before: "",
        after: "Alleen lokale inhoud",
        createdSnapshot: { title: "Testnotitie", enabled: true },
      },
    ]);
    expect(JSON.stringify(nova.audits)).not.toContain("Alleen lokale inhoud");

    await call("put", `/widgets/${widgetId}`, {
      type: "note",
      title: "Testnotitie",
      text: "Aangepast na aanmaken",
    });
    expect(
      (
        await call(
          "post",
          `/widgets/${widgetId}/history/${creation.id}/rollback`,
        )
      ).status,
    ).toBe(409);

    const current = await call("post", "/widgets", {
      type: "note",
      title: "Andere testnotitie",
      text: "Nog niet aangepast",
    });
    const currentId = (current.widget as { id: string }).id;
    const currentHistory = await call("get", `/widgets/${currentId}/history`);
    const currentCreation = (currentHistory.revisions as { id: string }[])[0]!;
    expect(
      (
        await call(
          "post",
          `/widgets/${currentId}/history/${currentCreation.id}/rollback`,
        )
      ).removed,
    ).toBe(true);
    expect(nova.store.get().widgets.some((item) => item.id === currentId)).toBe(
      false,
    );
  });

  it("tracks only safe value-widget display fields and preserves current data source on rollback", async () => {
    const created = await call("post", "/widgets", {
      type: "value",
      title: "Temperatuur",
      source: { url: "https://example.test/first.json", extract: "value" },
      refreshMinutes: 15,
      unit: "°C",
    });
    expect(created.status).toBe(201);
    const widgetId = (created.widget as { id: string }).id;
    await call("put", `/widgets/${widgetId}`, {
      type: "value",
      title: "Buiten",
      source: { url: "https://example.test/second.json", extract: "current" },
      refreshMinutes: 30,
      unit: "°F",
    });
    const history = await call("get", `/widgets/${widgetId}/display-history`);
    expect(history.revisions).toMatchObject([
      {
        before: { type: "value", title: "Temperatuur", unit: "°C" },
        after: { type: "value", title: "Buiten", unit: "°F" },
      },
    ]);
    const historyPath = path.join(
      path.dirname(nova.store["file" as never] as string),
      "widget-display-history.json",
    );
    expect(fs.statSync(historyPath).mode & 0o777).toBe(0o600);
    const revision = (history.revisions as { id: string }[])[0]!.id;
    expect(
      (
        await call(
          "post",
          `/widgets/${widgetId}/display-history/${revision}/rollback`,
        )
      ).status,
    ).toBe(200);
    expect(
      nova.store.get().widgets.find((item) => item.id === widgetId),
    ).toMatchObject({
      title: "Temperatuur",
      unit: "°C",
      source: { url: "https://example.test/second.json", extract: "current" },
      refreshMinutes: 30,
    });
    expect(fs.readFileSync(historyPath, "utf8")).not.toContain("example.test");
  });

  it("skips secret-shaped widget display history and rejects stale widget rollback", async () => {
    const created = await call("post", "/widgets", {
      type: "list",
      title: "Nieuws",
      source: { url: "https://example.test/news.json", extract: "items" },
      refreshMinutes: 15,
      itemPath: "title",
      max: 5,
    });
    const widgetId = (created.widget as { id: string }).id;
    await call("put", `/widgets/${widgetId}`, {
      type: "list",
      title: "Ander nieuws",
      source: { url: "https://example.test/news.json", extract: "items" },
      refreshMinutes: 15,
      itemPath: "name",
      max: 8,
    });
    const history = await call("get", `/widgets/${widgetId}/display-history`);
    const revision = (history.revisions as { id: string }[])[0]!.id;
    await call("put", `/widgets/${widgetId}`, {
      type: "list",
      title: "Derde titel",
      source: { url: "https://example.test/news.json", extract: "items" },
      refreshMinutes: 15,
      itemPath: "name",
      max: 8,
    });
    expect(
      (
        await call(
          "post",
          `/widgets/${widgetId}/display-history/${revision}/rollback`,
        )
      ).status,
    ).toBe(409);
    const secret = await call("put", `/widgets/${widgetId}`, {
      type: "list",
      title: "api_key: dummy",
      source: { url: "https://example.test/news.json", extract: "items" },
      refreshMinutes: 15,
      itemPath: "name",
      max: 8,
    });
    expect(secret.historyWarning).toMatch(/onveilige|geheim/i);
    expect(
      fs.readFileSync(
        path.join(
          path.dirname(nova.store["file" as never] as string),
          "widget-display-history.json",
        ),
        "utf8",
      ),
    ).not.toContain("dummy");
  });

  it("never reuses value/list widget IDs after deletion", async () => {
    const body = {
      type: "value",
      title: "Herbruikbare titel",
      source: { url: "https://example.test/value.json", extract: "value" },
      refreshMinutes: 15,
      unit: "°C",
    };
    const first = await call("post", "/widgets", body);
    const firstId = (first.widget as { id: string }).id;
    await call("put", `/widgets/${firstId}`, { ...body, unit: "°F" });
    expect(
      (await call("get", `/widgets/${firstId}/display-history`)).revisions,
    ).toHaveLength(1);
    expect((await call("delete", `/widgets/${firstId}`)).status).toBe(200);

    const second = await call("post", "/widgets", body);
    const secondId = (second.widget as { id: string }).id;
    expect(secondId).not.toBe(firstId);
    expect(
      (await call("get", `/widgets/${secondId}/display-history`)).revisions,
    ).toEqual([]);
  });

  it("needs the admin header for writes, and reads the home screen without it", async () => {
    expect((await call("put", "/persona", { text: "x" }, {})).status).toBe(403);
    expect((await call("post", "/skills", playbook(), {})).status).toBe(403);
    expect((await call("get", "/", undefined, {})).status).toBe(200);
    const pub = await call("get", "/public", undefined, {});
    expect(pub.status).toBe(200);
    expect(pub.quickActions).toEqual(DEFAULT_QUICK_ACTIONS);
  });

  it("protects MCP activity behind the settings PIN and rejects invalid IDs", async () => {
    const pinned = await createApp({ env: { NOVA_ADMIN_PIN: "4321" } });
    try {
      const endpoint = "/api/settings/mcp/servers/echo/activity";
      expect((await pinned.api.get(endpoint)).status).toBe(401);
      expect(
        (await pinned.api.get("/api/settings/mcp/servers/echo/history")).status,
      ).toBe(401);
      expect(
        (await pinned.api.get(endpoint).set("x-nova-pin", "4321")).status,
      ).toBe(200);
      expect(
        (
          await pinned.api
            .get("/api/settings/mcp/servers/%2F/activity")
            .set("x-nova-pin", "4321")
        ).status,
      ).toBe(400);
      const test = "/api/settings/mcp/servers/echo/test";
      expect((await pinned.api.post(test)).status).toBe(401);
      expect(
        (
          await pinned.api
            .post(test)
            .set("x-nova-pin", "4321")
            .set("x-nova-admin", "1")
        ).body,
      ).toMatchObject({ ok: false, toolCount: 0 });
    } finally {
      await pinned.app.close();
    }
  });

  it("protects MCP catalog management and accepts only reviewed server IDs", async () => {
    const directory = fs.mkdtempSync(
      path.join(os.tmpdir(), "nova-mcp-catalog-api-"),
    );
    const configPath = path.join(directory, "mcp-servers.json");
    fs.writeFileSync(configPath, JSON.stringify({ servers: {} }), {
      mode: 0o600,
    });
    const pinned = await createApp({
      env: { NOVA_DATA_DIR: directory, NOVA_ADMIN_PIN: "4321" },
    });
    try {
      const catalog = "/api/settings/mcp/servers/catalog";
      expect((await pinned.api.get(catalog)).status).toBe(401);
      const listed = await pinned.api.get(catalog).set("x-nova-pin", "4321");
      expect(listed.status).toBe(200);
      expect(
        listed.body.available.map((entry: { id: string }) => entry.id).sort(),
      ).toEqual([
        "arxiv",
        "caldav",
        "context7",
        "filesystem",
        "github",
        "imap",
        "sequential-thinking",
      ]);
      expect(JSON.stringify(listed.body)).not.toMatch(/"command"|"args"|"env"/);

      const preparePath = "/api/settings/mcp/servers/context7/prepare-catalog";
      expect(
        (
          await pinned.api
            .post(preparePath)
            .set("x-nova-pin", "4321")
            .set("x-nova-admin", "1")
            .send({ operation: "add", command: "untrusted-command" })
        ).status,
      ).toBe(400);
      const prepared = await pinned.api
        .post(preparePath)
        .set("x-nova-pin", "4321")
        .set("x-nova-admin", "1")
        .send({ operation: "add" });
      expect(prepared.body).toMatchObject({
        ok: true,
        action: { risk: "DANGEROUS" },
      });
      const added = await pinned.api
        .post("/api/settings/mcp/servers/confirm-catalog")
        .set("x-nova-pin", "4321")
        .set("x-nova-admin", "1")
        .send({
          sessionId: prepared.body.action.sessionId,
          confirmationId: prepared.body.action.confirmationId,
          approve: true,
        });
      expect(added.body).toMatchObject({
        ok: true,
        verified: true,
        server: "context7",
        operation: "add",
      });
      const saved = JSON.parse(fs.readFileSync(configPath, "utf8")) as {
        servers: Record<string, { enabled: boolean } | undefined>;
      };
      expect(saved.servers.context7?.enabled).toBe(false);
    } finally {
      await pinned.app.close();
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });

  it("protects per-key model-access history behind the settings PIN", async () => {
    const directory = fs.mkdtempSync(
      path.join(os.tmpdir(), "nova-key-model-history-api-"),
    );
    const pinned = await createApp({
      env: { NOVA_DATA_DIR: directory, NOVA_ADMIN_PIN: "4321" },
    });
    try {
      const endpoint =
        "/api/settings/omniroute/accounts/keys/client/model-access/history";
      expect((await pinned.api.get(endpoint)).status).toBe(401);
      expect(
        (await pinned.api.get(endpoint).set("x-nova-pin", "4321")).body,
      ).toEqual({ revisions: [], truncated: false });
      const badRollback = await pinned.api
        .post(
          "/api/settings/omniroute/accounts/keys/client/model-access/prepare-rollback",
        )
        .set("x-nova-pin", "4321")
        .set("x-nova-admin", "1")
        .send({ revisionId: "invalid", acknowledgeGlobalEffect: true });
      expect(badRollback.status).toBe(200);
      expect(badRollback.body).toMatchObject({ ok: false });
    } finally {
      await pinned.app.close();
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });

  it("toggles NOVA-owned MCP servers only after fresh dangerous confirmation", async () => {
    const directory = fs.mkdtempSync(
      path.join(os.tmpdir(), "nova-mcp-settings-"),
    );
    const fixture = path.resolve(
      process.cwd(),
      "test/fixtures/mcp-echo-server.mjs",
    );
    fs.writeFileSync(
      path.join(directory, "mcp-servers.json"),
      JSON.stringify({
        servers: {
          echo: {
            command: process.execPath,
            args: [fixture],
            env: { PRIVATE_TOKEN: "mcp-private-fixture-token" },
            risk: "CONFIRM",
            enabled: false,
          },
        },
      }),
      { mode: 0o600 },
    );
    const pinned = await createApp({
      env: { NOVA_DATA_DIR: directory, NOVA_ADMIN_PIN: "4321" },
    });
    const api = (method: "get" | "post", route: string, body?: object) =>
      pinned.api[method](`/api/settings/mcp${route}`)
        .set({ "x-nova-admin": "1", "x-nova-pin": "4321" })
        .send(body);
    try {
      const denied = await pinned.api
        .post("/api/settings/mcp/servers/echo/prepare-toggle")
        .set({ "x-nova-admin": "1" })
        .send({ enabled: true });
      expect(denied.status).toBe(401);

      const prepared = await api("post", "/servers/echo/prepare-toggle", {
        enabled: true,
      });
      expect(prepared.body.action.risk).toBe("DANGEROUS");
      expect(JSON.stringify(prepared.body)).not.toContain(
        "mcp-private-fixture-token",
      );
      const enabled = await api("post", "/servers/confirm-toggle", {
        sessionId: prepared.body.action.sessionId,
        confirmationId: prepared.body.action.confirmationId,
        approve: true,
      });
      expect(enabled.body).toMatchObject({
        ok: true,
        server: "echo",
        enabled: true,
      });
      expect((await api("get", "/servers")).body.servers[0]).toMatchObject({
        id: "echo",
        enabled: true,
        connected: true,
      });

      const riskChange = await api(
        "post",
        "/servers/echo/tools/write_note/prepare-risk",
        { risk: "SAFE" },
      );
      expect(riskChange.body.action.risk).toBe("DANGEROUS");
      expect(JSON.stringify(riskChange.body)).not.toContain(
        "mcp-private-fixture-token",
      );
      const riskSaved = await api("post", "/servers/confirm-tool-risk", {
        sessionId: riskChange.body.action.sessionId,
        confirmationId: riskChange.body.action.confirmationId,
        approve: true,
      });
      expect(riskSaved.body).toMatchObject({
        ok: true,
        server: "echo",
        tool: "write_note",
        risk: "SAFE",
      });
      expect((await api("get", "/servers")).body.servers[0].tools).toEqual(
        expect.arrayContaining([
          { name: "echo", risk: "CONFIRM" },
          { name: "write_note", risk: "SAFE" },
        ]),
      );

      const staleRisk = await api(
        "post",
        "/servers/echo/tools/write_note/prepare-risk",
        { risk: "DANGEROUS" },
      );
      const staleDisable = await api("post", "/servers/echo/prepare-toggle", {
        enabled: false,
      });
      const configPath = path.join(directory, "mcp-servers.json");
      const config = JSON.parse(fs.readFileSync(configPath, "utf8"));
      config.servers.echo.env.PRIVATE_TOKEN = "rotated-after-prepare";
      fs.writeFileSync(configPath, JSON.stringify(config), { mode: 0o600 });
      const staleRiskResult = await api("post", "/servers/confirm-tool-risk", {
        sessionId: staleRisk.body.action.sessionId,
        confirmationId: staleRisk.body.action.confirmationId,
        approve: true,
      });
      expect(staleRiskResult.body.ok).toBe(false);
      const staleResult = await api("post", "/servers/confirm-toggle", {
        sessionId: staleDisable.body.action.sessionId,
        confirmationId: staleDisable.body.action.confirmationId,
        approve: true,
      });
      expect(staleResult.body.ok).toBe(false);
      expect((await api("get", "/servers")).body.servers[0].connected).toBe(
        true,
      );

      const disable = await api("post", "/servers/echo/prepare-toggle", {
        enabled: false,
      });
      const disabled = await api("post", "/servers/confirm-toggle", {
        sessionId: disable.body.action.sessionId,
        confirmationId: disable.body.action.confirmationId,
        approve: true,
      });
      expect(disabled.body).toMatchObject({ ok: true, enabled: false });
      expect((await api("get", "/servers")).body.servers[0]).toMatchObject({
        enabled: false,
        connected: false,
        toolCount: 0,
      });
      const history = await api("get", "/servers/echo/history");
      expect(history.body.revisions).toHaveLength(3);
      expect(history.body.revisions[0]).toMatchObject({
        server: "echo",
        change: { kind: "enabled", before: true, after: false },
      });
      expect(JSON.stringify(history.body)).not.toContain(
        "rotated-after-prepare",
      );
      const historyPath = path.join(directory, "mcp-settings-history.json");
      expect(fs.statSync(historyPath).mode & 0o777).toBe(0o600);
      const tamperedHistory = JSON.parse(fs.readFileSync(historyPath, "utf8"));
      tamperedHistory[0].env = { PRIVATE_TOKEN: "history-file-secret" };
      fs.writeFileSync(historyPath, JSON.stringify(tamperedHistory), {
        mode: 0o600,
      });
      const sanitizedHistory = await api("get", "/servers/echo/history");
      expect(JSON.stringify(sanitizedHistory.body)).not.toContain(
        "history-file-secret",
      );
      const staleRollbackPrepared = await api(
        "post",
        `/servers/echo/history/${history.body.revisions[0].id}/prepare-rollback`,
        {},
      );
      const changedConfig = JSON.parse(fs.readFileSync(configPath, "utf8"));
      changedConfig.servers.echo.env.PRIVATE_TOKEN = "changed-before-rollback";
      fs.writeFileSync(configPath, JSON.stringify(changedConfig), {
        mode: 0o600,
      });
      const staleRollback = await api("post", "/servers/confirm-toggle", {
        sessionId: staleRollbackPrepared.body.action.sessionId,
        confirmationId: staleRollbackPrepared.body.action.confirmationId,
        approve: true,
      });
      expect(staleRollback.body.ok).toBe(false);
      const rollbackPrepared = await api(
        "post",
        `/servers/echo/history/${history.body.revisions[0].id}/prepare-rollback`,
        {},
      );
      expect(rollbackPrepared.body.action.risk).toBe("DANGEROUS");
      const rollbackResult = await api("post", "/servers/confirm-toggle", {
        sessionId: rollbackPrepared.body.action.sessionId,
        confirmationId: rollbackPrepared.body.action.confirmationId,
        approve: true,
      });
      expect(rollbackResult.body).toMatchObject({ ok: true, enabled: true });
      expect((await api("get", "/servers")).body.servers[0]).toMatchObject({
        enabled: true,
        connected: true,
      });
      expect(
        (await api("get", "/servers/echo/history")).body.revisions,
      ).toHaveLength(4);
      const riskRevision = sanitizedHistory.body.revisions.find(
        (revision: { change: { kind: string } }) =>
          revision.change.kind === "tool-risk",
      );
      const riskRollbackPrepared = await api(
        "post",
        `/servers/echo/history/${riskRevision.id}/prepare-rollback`,
        {},
      );
      expect(riskRollbackPrepared.body.action.risk).toBe("DANGEROUS");
      const riskRollbackResult = await api(
        "post",
        "/servers/confirm-tool-risk",
        {
          sessionId: riskRollbackPrepared.body.action.sessionId,
          confirmationId: riskRollbackPrepared.body.action.confirmationId,
          approve: true,
        },
      );
      expect(riskRollbackResult.body).toMatchObject({
        ok: true,
        risk: "CONFIRM",
      });
      expect(
        (await api("get", "/servers/echo/history")).body.revisions,
      ).toHaveLength(5);
      expect(
        JSON.parse(fs.readFileSync(configPath, "utf8")).servers.echo.env
          .PRIVATE_TOKEN,
      ).toBe("changed-before-rollback");
      expect(
        JSON.parse(fs.readFileSync(configPath, "utf8")).servers.echo.toolRisks,
      ).toEqual({ write_note: "CONFIRM" });
    } finally {
      await pinned.app.close();
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });

  it("rejects an MCP config reached through a symlink outside the NOVA data root", async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "nova-mcp-root-"));
    const external = fs.mkdtempSync(
      path.join(os.tmpdir(), "nova-mcp-external-"),
    );
    fs.writeFileSync(
      path.join(external, "mcp-servers.json"),
      JSON.stringify({
        servers: {
          echo: { command: "unused", risk: "CONFIRM", enabled: false },
        },
      }),
    );
    fs.symlinkSync(external, path.join(directory, "linked"), "dir");
    const pinned = await createApp({
      env: {
        NOVA_DATA_DIR: directory,
        JARVIS_MCP_CONFIG: path.join(directory, "linked", "mcp-servers.json"),
      },
    });
    try {
      const result = await pinned.api
        .post("/api/settings/mcp/servers/echo/prepare-toggle")
        .set(ADMIN)
        .send({ enabled: true });
      expect(result.status).toBe(400);
      expect(
        JSON.parse(
          fs.readFileSync(path.join(external, "mcp-servers.json"), "utf8"),
        ).servers.echo.enabled,
      ).toBe(false);
    } finally {
      await pinned.app.close();
      fs.rmSync(directory, { recursive: true, force: true });
      fs.rmSync(external, { recursive: true, force: true });
    }
  });

  it("protects everything except the public list when a PIN is set", async () => {
    const pinned = await createApp({ env: { NOVA_ADMIN_PIN: "4321" } });
    try {
      const send = (
        method: "get" | "put",
        route: string,
        headers: Record<string, string>,
        body?: object,
      ) =>
        pinned.api[method](`/api/settings${route}`)
          .set(headers)
          .send(body)
          .then((r) => ({ status: r.status, body: r.body }));
      const denied = await send("get", "/", {});
      expect(denied.status).toBe(401);
      expect(denied.body).toEqual({ error: "PIN vereist", pinRequired: true });
      expect((await send("get", "/skills/ochtend/versions", {})).status).toBe(
        401,
      );
      expect(
        (await send("get", "/helper/preferences/history", {})).status,
      ).toBe(401);
      expect((await send("get", "/tools/history", {})).status).toBe(401);
      expect((await send("get", "/sidebar/history", {})).status).toBe(401);
      expect(
        (
          await pinned.api
            .post(
              "/api/settings/tools/history/00000000-0000-0000-0000-000000000000/rollback",
            )
            .set("x-nova-pin", "4321")
            .send({})
        ).status,
      ).toBe(403);
      expect(
        (
          await pinned.api
            .post(
              "/api/settings/helper/preferences/history/00000000-0000-0000-0000-000000000000/rollback",
            )
            .send({})
        ).status,
      ).toBe(401);
      expect(
        (
          await pinned.api
            .get("/api/settings/helper/preferences/history")
            .set("x-nova-pin", "4321")
        ).status,
      ).toBe(200);
      expect(
        (
          await pinned.api
            .post(
              "/api/settings/helper/preferences/history/00000000-0000-0000-0000-000000000000/rollback",
            )
            .set("x-nova-pin", "4321")
            .send({})
        ).status,
      ).toBe(403);
      expect((await send("get", "/", { "x-nova-pin": "0000" })).status).toBe(
        401,
      );
      const ok = await send("get", "/", { "x-nova-pin": "4321" });
      expect(ok.status).toBe(200);
      expect(ok.body.pinRequired).toBe(true);
      // the PIN alone does not allow a write
      expect(
        (await send("put", "/persona", { "x-nova-pin": "4321" }, { text: "x" }))
          .status,
      ).toBe(403);
      expect(
        (
          await send(
            "put",
            "/persona",
            { "x-nova-pin": "4321", ...ADMIN },
            { text: "x" },
          )
        ).status,
      ).toBe(200);
      expect((await send("get", "/public", {})).status).toBe(200);
    } finally {
      await pinned.app.close();
    }
  });

  it("keeps standing approval fingerprints private and only permits guarded revocation", async () => {
    const grant = {
      id: "approved-rule",
      tool: "echo",
      argsHash: "a".repeat(64),
      schemaHash: "b".repeat(64),
      scope: "living room",
      createdAt: Date.now(),
    };
    nova.store.update((next) => {
      next.standingApprovals = [grant];
    });
    const overview = await call("get", "/");
    expect(overview.standingApprovals).toEqual([
      {
        id: grant.id,
        tool: grant.tool,
        scope: grant.scope,
        createdAt: grant.createdAt,
      },
    ]);
    expect(JSON.stringify(overview)).not.toContain(grant.argsHash);
    expect(JSON.stringify(overview)).not.toContain(grant.schemaHash);
    const backup = await call("get", "/export");
    expect(backup).not.toHaveProperty("standingApprovals");
    expect(JSON.stringify(backup)).not.toContain(grant.argsHash);
    expect(
      (await call("delete", "/standing-approvals/approved-rule", undefined, {}))
        .status,
    ).toBe(403);
    expect(nova.store.get().standingApprovals).toEqual([grant]);
    expect(
      (await call("delete", "/standing-approvals/approved-rule")).status,
    ).toBe(200);
    expect(nova.store.get().standingApprovals).toEqual([]);
    expect(
      nova.audits.some(
        (entry) =>
          (entry.arguments as { what?: string }).what ===
          "standing_approval_revoked",
      ),
    ).toBe(true);
    expect(
      (
        await call("post", "/import", {
          data: { ...backup, standingApprovals: [grant] },
          mode: "replace",
        })
      ).status,
    ).toBe(400);
    expect(nova.store.get().standingApprovals).toEqual([]);
  });

  it("creates, changes, switches off and deletes skills, and logs each change", async () => {
    const created = await call("post", "/skills", playbook());
    expect(created.status).toBe(201);
    expect(created.skill.id).toBe("filmavond");
    expect((await call("post", "/skills", playbook())).status).toBe(400);
    const changed = await call("put", "/skills/filmavond", {
      ...created.skill,
      name: "Filmavond gewijzigd",
      description: "Bijgewerkte omschrijving voor de avond.",
      examples: ["filmavond met rustig licht"],
      instructions: "Nieuwe stappen.",
      enabled: false,
    });
    expect(changed.status).toBe(200);
    expect(changed.skill.version).toBe(2);
    expect(changed.skill.enabled).toBe(false);
    nova.audits.push(null as never);
    nova.audits.push({
      tool: "settings_change",
      timestamp: "2026-10-10 (private-token)",
      arguments: {
        what: "skill-updated",
        skill: "filmavond",
        version: 99,
      },
    } as never);
    const history = await call("get", "/skills/filmavond/versions");
    expect(history).toMatchObject({
      status: 200,
      currentVersion: 2,
      versions: [
        { version: 1, action: "created" },
        { version: 2, action: "updated" },
      ],
    });
    expect(JSON.stringify(history)).not.toContain("Nieuwe stappen.");
    nova.audits.splice(-2);
    const contentHistory = await call(
      "get",
      "/skills/filmavond/content-history",
    );
    expect(contentHistory).toMatchObject({
      status: 200,
      revisions: [
        {
          before: {
            name: "Filmavond",
            enabled: true,
            instructions: playbook().instructions,
          },
          after: {
            name: "Filmavond gewijzigd",
            description: "Bijgewerkte omschrijving voor de avond.",
            examples: ["filmavond met rustig licht"],
            enabled: false,
            instructions: "Nieuwe stappen.",
          },
        },
        {
          before: null,
          after: {
            name: "Filmavond",
            enabled: true,
            instructions: playbook().instructions,
          },
        },
      ],
    });
    expect(JSON.stringify(contentHistory)).not.toContain("PRIVATE_TOKEN");
    const historyPath = nova.app
      .get(NovaConfig)
      .dataFile("instruction-skill-history.json");
    expect(fs.statSync(historyPath).mode & 0o777).toBe(0o600);
    const revision = contentHistory.revisions[0];
    const restored = await call(
      "post",
      `/skills/filmavond/content-history/${revision.id}/rollback`,
    );
    expect(restored).toMatchObject({
      status: 200,
      skill: {
        name: "Filmavond",
        enabled: true,
        instructions: playbook().instructions,
      },
    });
    await call("put", "/skills/filmavond", {
      ...restored.skill,
      description: "Een latere wijziging maakt oude rollback ongeldig.",
    });
    expect(
      (
        await call(
          "post",
          `/skills/filmavond/content-history/${revision.id}/rollback`,
        )
      ).status,
    ).toBe(404);
    const overview = await call("get", "/");
    expect(
      overview.skills.find((item: { id: string }) => item.id === "filmavond")
        .instructions,
    ).toBe(playbook().instructions);
    expect((await call("put", "/skills/bestaatniet", playbook())).status).toBe(
      404,
    );
    const bad = await call("put", "/skills/filmavond", {
      ...created.skill,
      instructions: "",
    });
    expect(bad.status).toBe(400);
    expect(bad.error).toMatch(/Schrijf de instructies/);
    expect((await call("delete", "/skills/filmavond")).status).toBe(200);
    expect(fs.readFileSync(historyPath, "utf8")).not.toContain(
      "Nieuwe stappen.",
    );
    const gone = await call("delete", "/skills/filmavond");
    expect(gone.status).toBe(404);
    expect(gone.error).toBe("Die vaardigheid bestaat niet.");
    expect(
      nova.audits.map((item) => (item.arguments as { what: string }).what),
    ).toEqual([
      "skill-created",
      "skill-updated",
      "instruction_skill_rollback",
      "skill-updated",
      "skill-deleted",
    ]);
    expect(
      nova.audits.every(
        (item) =>
          item.sessionId === "settings" &&
          item.tool === "settings_change" &&
          item.confirmation === "admin_ui",
      ),
    ).toBe(true);
  });

  it("can remove a newly created instruction skill through its private history", async () => {
    const created = await call(
      "post",
      "/skills",
      playbook({
        name: "Tijdelijke hulp",
        instructions: "Een korte tijdelijke instructie.",
      }),
    );
    expect(created.status).toBe(201);
    const history = await call(
      "get",
      "/skills/tijdelijke_hulp/content-history",
    );
    expect(history).toMatchObject({
      status: 200,
      revisions: [
        {
          before: null,
          after: { instructions: "Een korte tijdelijke instructie." },
        },
      ],
    });
    const revision = history.revisions[0];
    const rollback = await call(
      "post",
      `/skills/tijdelijke_hulp/content-history/${revision.id}/rollback`,
    );
    expect(rollback).toMatchObject({ status: 200, removed: true });
    expect((await call("get", "/")).skills).not.toContainEqual(
      expect.objectContaining({ id: "tijdelijke_hulp" }),
    );
    expect(
      fs.readFileSync(
        nova.app.get(NovaConfig).dataFile("instruction-skill-history.json"),
        "utf8",
      ),
    ).not.toContain("Een korte tijdelijke instructie.");
  });

  it("skips instruction history snapshots when sanitization would alter them", async () => {
    const secretSkill = await call(
      "post",
      "/skills",
      playbook({
        name: "Private instructie",
        instructions: "Gebruik api_key: this-is-a-private-fixture-value.",
      }),
    );
    expect(secretSkill.status).toBe(201);
    const changed = await call("put", "/skills/private_instructie", {
      ...secretSkill.skill,
      description: "Aangepaste omschrijving.",
    });
    expect(changed.status).toBe(200);
    const history = await call(
      "get",
      "/skills/private_instructie/content-history",
    );
    expect(history).toMatchObject({ status: 200, revisions: [] });
    expect(JSON.stringify(history)).not.toContain(
      "this-is-a-private-fixture-value",
    );
    expect(
      fs.existsSync(
        nova.app.get(NovaConfig).dataFile("instruction-skill-history.json"),
      ),
    ).toBe(false);
  });

  it("offers an enabled webhook skill to the model at once", async () => {
    await call("post", "/skills", webhook());
    expect(nova.tools.list().map((tool) => tool.name)).toContain(
      "skill_garagedeur",
    );
    expect(
      nova.tools.list().find((t) => t.name === "skill_garagedeur"),
    ).toMatchObject({
      source: "skills",
      risk: "CONFIRM",
    });
    await call("delete", "/skills/garagedeur");
    expect(nova.tools.list().map((tool) => tool.name)).not.toContain(
      "skill_garagedeur",
    );
  });

  it("stores a secret, never returns it, and keeps it on edit", async () => {
    const created = await call("post", "/skills", webhook());
    expect(created.status).toBe(201);
    expect(JSON.stringify(created)).not.toContain("geheim-123");
    expect(JSON.stringify(await call("get", "/"))).not.toContain("geheim-123");
    expect(JSON.stringify(await call("get", "/export"))).not.toContain(
      "geheim-123",
    );
    const edited = await call("put", "/skills/garagedeur", {
      ...created.skill,
      description: "Een andere beschrijving van de deur",
    });
    expect(edited.status).toBe(200);
    const stored = nova.store.get().skills[0] as {
      http: { secretHeaders: { value: string }[] };
    };
    expect(stored.http.secretHeaders[0]?.value).toBe("geheim-123");
  });

  it("switches built-in tools off, edits them and restores them", async () => {
    let overview = await call("get", "/");
    expect(overview.tools[0].enabled).toBe(true);
    await call("put", "/tools/echo", {
      enabled: false,
      description: "Mijn eigen uitleg voor echo",
    });
    overview = await call("get", "/");
    const echo = overview.tools.find(
      (item: { name: string }) => item.name === "echo",
    );
    expect(echo).toMatchObject({
      enabled: false,
      switchedOff: true,
      edited: true,
      description: "Mijn eigen uitleg voor echo",
      defaultDescription: "Return supplied text",
    });
    expect(
      (await call("put", "/tools/echo", { description: "kort" })).status,
    ).toBe(400);
    expect((await call("delete", "/tools/echo")).status).toBe(200);
    const restored = (await call("get", "/")).tools.find(
      (item: { name: string }) => item.name === "echo",
    );
    expect(restored.enabled).toBe(true);
    expect(restored.description).toBe("Return supplied text");
  });

  it("restores only tool descriptions and rejects stale or secret history", async () => {
    await call("put", "/tools/echo", {
      description: "Mijn eerste uitleg voor echo",
    });
    await call("put", "/tools/echo", {
      description: "Mijn tweede uitleg voor echo",
    });
    const history = await call("get", "/tools/echo/description-history");
    expect(history.revisions[0].after).toBe("Mijn tweede uitleg voor echo");
    const revision = history.revisions[0];
    await call(
      "post",
      `/tools/echo/description-history/${revision.id}/rollback`,
      {},
    );
    const echo = (await call("get", "/")).tools.find(
      (item: { name: string }) => item.name === "echo",
    );
    expect(echo.description).toBe("Mijn eerste uitleg voor echo");
    expect(echo.enabled).toBe(true);
    expect(
      (
        await call(
          "post",
          `/tools/echo/description-history/${revision.id}/rollback`,
          {},
        )
      ).status,
    ).toBe(409);
    const unsafe = await call("put", "/tools/echo", {
      description: "Open https://user:pass@example.test",
    });
    expect(unsafe.historyWarning).toMatch(/geheim/i);
    expect(
      JSON.stringify(await call("get", "/tools/echo/description-history")),
    ).not.toContain("user:pass");
    expect(JSON.stringify(nova.audits)).not.toContain("user:pass");
    const reset = await call("delete", "/tools/echo");
    expect(reset.historyWarning).toMatch(/geheim/i);
  });

  it("sets personal rules and quick actions, including going back to the defaults", async () => {
    expect(
      (await call("put", "/persona", { text: "Spreek me aan met Harm." }))
        .status,
    ).toBe(200);
    expect((await call("get", "/")).persona).toBe("Spreek me aan met Harm.");
    expect(
      (await call("put", "/persona/style", { style: "playful" })).personaStyle,
    ).toBe("playful");
    expect((await call("get", "/")).personaStyle).toBe("playful");
    const profile = {
      name: "Nova",
      character: "warm en nieuwsgierig",
      address: "je/jij",
      avoid: "valse menselijke ervaringen",
    };
    expect(
      (await call("put", "/persona/profile", { profile })).personaProfile,
    ).toEqual(profile);
    expect((await call("get", "/")).personaProfile).toEqual(profile);
    const householdProfiles = [
      {
        id: "harm",
        label: "Harm",
        personaProfile: profile,
        communicationPreferences: ["concise", "fewer_jokes"],
      },
      {
        id: "sam",
        label: "Sam",
        personaProfile: { ...profile, address: "Sam" },
        communicationPreferences: ["warmer"],
      },
    ];
    const savedHousehold = await call("put", "/household-profiles", {
      profiles: householdProfiles,
      activeProfileId: "sam",
    });
    expect(savedHousehold.activeHouseholdProfileId).toBe("sam");
    expect((await call("get", "/")).householdProfiles).toEqual(
      householdProfiles,
    );
    expect((await call("get", "/")).personaProfile).toEqual(
      householdProfiles[1]!.personaProfile,
    );
    expect(
      (
        await call("put", "/household-profiles", {
          profiles: householdProfiles,
          activeProfileId: "missing",
        })
      ).status,
    ).toBe(400);
    expect(
      (
        await call("put", "/household-profiles", {
          profiles: [{ ...householdProfiles[0], id: "bad id" }],
          activeProfileId: "bad id",
        })
      ).status,
    ).toBe(400);
    expect(
      (
        await call("put", "/persona/profile", {
          profile: { ...profile, extra: "ignored?" },
        })
      ).status,
    ).toBe(400);
    expect(
      (
        await call("put", "/persona/profile", {
          profile: { ...profile, name: "x".repeat(41) },
        })
      ).status,
    ).toBe(400);
    expect(
      (await call("put", "/persona/style", { style: "unrestricted" })).status,
    ).toBe(400);
    expect(
      (await call("put", "/persona", { text: "x".repeat(2001) })).status,
    ).toBe(400);
    const items = [
      { label: "Licht aan", prompt: "Zet het licht in de woonkamer aan" },
    ];
    expect(
      (await call("put", "/quick-actions", { items })).quickActions,
    ).toEqual(items);
    expect((await call("get", "/public", undefined, {})).quickActions).toEqual(
      items,
    );
    expect((await call("get", "/")).quickActionsAreDefault).toBe(false);
    expect(
      (
        await call("put", "/quick-actions", {
          items: [{ label: "", prompt: "x" }],
        })
      ).status,
    ).toBe(400);
    const nextItems = [{ label: "Muziek", prompt: "Speel rustige muziek af" }];
    await call("put", "/quick-actions", { items: nextItems });
    const history = await call("get", "/quick-actions/history");
    expect(history.revisions.length).toBeGreaterThanOrEqual(2);
    const revision = history.revisions[0];
    expect(revision.after.items).toEqual(nextItems);
    expect(
      (await call("post", `/quick-actions/history/${revision.id}/rollback`, {}))
        .quickActions,
    ).toEqual(items);
    expect(
      (await call("post", `/quick-actions/history/${revision.id}/rollback`, {}))
        .status,
    ).toBe(409);
    const firstRevision = history.revisions[1];
    expect(
      (
        await call(
          "post",
          `/quick-actions/history/${firstRevision.id}/rollback`,
          {},
        )
      ).quickActions,
    ).toEqual(DEFAULT_QUICK_ACTIONS);
    expect((await call("get", "/")).quickActionsAreDefault).toBe(true);
    expect(
      (await call("put", "/quick-actions", { reset: true })).quickActions,
    ).toEqual(DEFAULT_QUICK_ACTIONS);
    expect((await call("get", "/")).quickActionsAreDefault).toBe(true);
    const credentialText = "Open https://user:pass@example.test/status";
    const secretResult = await call("put", "/quick-actions", {
      items: [{ label: "Status", prompt: credentialText }],
    });
    expect(secretResult.historyWarning).toMatch(/geheim/i);
    const safeHistory = await call("get", "/quick-actions/history");
    expect(JSON.stringify(safeHistory)).not.toContain("user:pass");
  });

  it("shows examples in the public list only for skills that are on", async () => {
    await call("post", "/skills", playbook());
    await call(
      "post",
      "/skills",
      playbook({ name: "Uit", enabled: false, examples: ["verborgen"] }),
    );
    const pub = await call("get", "/public", undefined, {});
    expect(pub.skillExamples).toEqual([
      {
        name: "Filmavond",
        examples: ["start filmavond", "ik wil een film kijken"],
      },
    ]);
  });

  it.skipIf(!lan)("tests a draft before it is saved", async () => {
    const fake = await service((_entry, response) =>
      json(response, 200, { state: "open" }),
    );
    try {
      const draft = {
        ...webhook(),
        http: {
          ...webhook().http,
          url: onLan(fake.port, "/api/{actie}"),
          allowPrivate: true,
          extract: "state",
        },
      };
      const ok = await call("post", "/skills/test", {
        skill: draft,
        args: { actie: "open" },
      });
      expect(ok.type).toBe("webhook");
      expect(ok.ok).toBe(true);
      expect(ok.result.response).toBe("open");
      expect(nova.store.get().skills).toHaveLength(0); // a test saves nothing
      const wrong = await call("post", "/skills/test", {
        skill: draft,
        args: { actie: "half" },
      });
      expect(wrong.ok).toBe(false);
      expect(wrong.error).toMatch(/moet een van deze zijn/);
      expect(
        (
          await call("post", "/skills/test", {
            skill: { ...draft, name: "" },
            args: {},
          })
        ).status,
      ).toBe(400);
    } finally {
      fake.close();
    }
  });

  it("tests whether a playbook would be picked", async () => {
    const match = await call("post", "/skills/test", {
      skill: playbook(),
      phrase: "start filmavond",
    });
    expect(match).toMatchObject({ type: "instruction", matched: true });
    expect(
      (
        await call("post", "/skills/test", {
          skill: playbook(),
          phrase: "wat is het weer",
        })
      ).matched,
    ).toBe(false);
  });

  it("lists the recent runs of a skill from the action log", async () => {
    nova.audit.record({
      tool: "skill_garagedeur",
      result: { ok: true },
      arguments: { actie: "dicht" },
    });
    nova.audit.record({ tool: "echo", result: { ok: true } });
    nova.audit.record({
      tool: "skill_garagedeur",
      result: { ok: false, error: "HTTP 500" },
      arguments: { actie: "open" },
    });
    nova.audit.record({
      tool: "skill_garagedeur",
      result: {
        ok: false,
        error: "connect failed at private-host?token=secret-value",
      },
      arguments: { actie: "open" },
    });
    const runs = (await call("get", "/skills/garagedeur/runs")).runs;
    expect(
      runs.map((item: { ok: boolean; error: string }) => [item.ok, item.error]),
    ).toEqual([
      [false, "De aanroep is mislukt."],
      [false, "HTTP 500"],
      [true, null],
    ]);
    expect(JSON.stringify(runs)).not.toContain("secret-value");
    expect(runs[0].at).toBeTruthy();
    expect((await call("get", "/skills/nietbestaand/runs")).runs).toEqual([]);
  });

  it("returns only safe action-log fields to the browser", async () => {
    nova.audit.record({
      tool: "skill_filmavond",
      risk: "SAFE",
      arguments: { instruction: "private-input-9281" },
      result: {
        ok: false,
        error: "upstream-trace-code-9281",
        diagnostic: "private-diagnostic-9281",
      },
    });
    const response = await nova.api.get("/api/audit").set(ADMIN);
    expect(response.status).toBe(200);
    const entry = response.body.entries[0];
    expect(entry).toMatchObject({
      tool: "skill_filmavond",
      risk: "SAFE",
      result: { ok: false, error: "Actie mislukt." },
    });
    expect(entry).not.toHaveProperty("arguments");
    expect(JSON.stringify(entry)).not.toMatch(/9281/);
  });

  it("proposes an improvement and saves nothing", async () => {
    nova.audit.record({
      tool: "skill_filmavond",
      result: { ok: false, error: "upstream-trace-code-9281" },
    });
    const proposal = await call("post", "/skills/improve", {
      skill: playbook(),
      goal: "duidelijker",
    });
    expect(proposal.ok).toBe(true);
    expect(proposal.changes.description).toBe("Beter: Filmavond");
    expect(nova.store.get().skills).toHaveLength(0);
    expect((await call("post", "/skills/improve", {})).status).toBe(400);
    expect(JSON.parse(improveCalls.at(-1)!).doel).toBe("duidelijker");
    expect(improveCalls.at(-1)).toContain("De aanroep is mislukt.");
    expect(improveCalls.at(-1)).not.toContain("upstream-trace-code-9281");
  });

  it("drafts a skill from a description", async () => {
    const draft = await call("post", "/skills/draft", {
      description: "Als ik goedenacht zeg, zet dan alle lampen uit",
    });
    expect(draft.ok).toBe(true);
    expect(draft.fellBack).toBe(true); // the fake model answers with a skill proposal, not a draft
    expect(draft.draft.type).toBe("instruction");
    expect(
      (await call("post", "/skills/draft", { description: "kort" })).status,
    ).toBe(400);
  });

  it("restores skills and settings from a backup, without the secrets", async () => {
    await call("post", "/skills", webhook());
    await call("post", "/skills", playbook());
    await call("put", "/persona", { text: "Kort antwoorden." });
    await call("put", "/tools/echo", { enabled: false });
    const backup = await call("get", "/export");
    expect(backup.format).toBe("nova-settings");
    expect(JSON.stringify(backup)).not.toContain("geheim-123");
    nova.store.update((settings) => {
      settings.skills = [];
      settings.persona = "";
      settings.toolOverrides = {};
    });
    const data = { ...backup, status: undefined };
    const restored = await call("post", "/import", { data, mode: "replace" });
    expect(restored.status).toBe(200);
    expect(restored.imported).toBe(2);
    expect(restored.missingSecrets).toEqual([
      { skill: "Garagedeur", headers: ["X-Token"] },
    ]);
    const now = nova.store.get();
    expect(now.persona).toBe("Kort antwoorden.");
    expect(now.toolOverrides).toEqual({ echo: { enabled: false } });
    const garage = now.skills.find((item) => item.id === "garagedeur") as {
      http: { secretHeaders: unknown[] };
    };
    expect(garage.http.secretHeaders).toEqual([]);
    expect(
      (await call("post", "/import", { data: { format: "iets-anders" } }))
        .status,
    ).toBe(400);
    expect(
      (
        await call("post", "/import", {
          data: { ...data, skills: [{ type: "webhook", name: "Kapot" }] },
        })
      ).status,
    ).toBe(400);
    const merged = await call("post", "/import", {
      data: {
        ...data,
        skills: [playbook({ name: "Extra" })],
        persona: undefined,
      },
      mode: "merge",
    });
    expect(merged.status).toBe(200);
    expect(
      nova.store
        .get()
        .skills.map((item) => item.id as string)
        .sort(),
    ).toEqual(["extra", "filmavond", "garagedeur"]);
  });

  it("preserves existing user settings and stable IDs through replace import", async () => {
    await call("post", "/skills", playbook());
    await call("put", "/persona", {
      text: "Een rustige persoonlijke assistent.",
    });
    await call("put", "/quick-actions", {
      items: [{ label: "Filmavond", prompt: "Start filmavond" }],
    });
    await call("put", "/tools/echo", {
      enabled: false,
      description: "Return the supplied text without changing it.",
    });
    const widget = await call("post", "/widgets", {
      type: "note",
      title: "Mijn notitie",
      text: "Bewaar deze tekst.",
      enabled: true,
    });
    expect(widget.status).toBe(201);
    const widgetId = (widget.widget as { id: string }).id;
    const sidebar = [
      { id: "systeem", column: "right", page: 2, shown: false },
      { id: `w:${widgetId}`, column: "left", page: 3, shown: true },
    ];
    expect((await call("put", "/sidebar", { items: sidebar })).status).toBe(
      200,
    );
    nova.store.update((settings) => {
      settings.helper = { mode: "both", display: 2 };
      settings.helperPreferences = {
        autohide: false,
        contrast: true,
        shape: "ring",
        wardrobe: { theme: "violet", seasonal: false, birthday: "10-10" },
        cues: {
          enabled: true,
          volume: 0.6,
          theme: "playful",
          cues: { done: false, file: true },
          quiet: { enabled: true, start: "23:00", end: "06:00" },
        },
      };
    });
    const backup = await call("get", "/export");
    const contents = (reply: Reply) => {
      const copy: Record<string, unknown> = { ...reply };
      delete copy.status;
      delete copy.exportedAt;
      copy.skills = (copy.skills as Record<string, unknown>[]).map((skill) => {
        const imported = { ...skill };
        delete imported.createdAt;
        delete imported.updatedAt;
        return imported;
      });
      return copy;
    };
    const expected = contents(backup);
    nova.store.update((settings) => {
      settings.persona = "Changed";
      settings.quickActions = [];
      settings.skills = [];
      settings.widgets = [];
      settings.sidebar = null;
      settings.toolOverrides = {};
      settings.helper = { mode: "wallpaper", display: 0 };
      settings.helperPreferences.contrast = false;
      settings.helperPreferences.wardrobe = {
        theme: "nova",
        seasonal: true,
        birthday: "",
      };
    });
    expect(
      (await call("post", "/import", { data: backup, mode: "replace" })).status,
    ).toBe(200);
    const restored = await call("get", "/export");
    const actual = contents(restored);
    expect(actual).toEqual(expected);
    expect(nova.store.get().helper).toEqual({ mode: "both", display: 2 });
    expect(nova.store.get().helperPreferences).toEqual(
      backup.helperPreferences,
    );
    const overview = await call("get", "/");
    expect(overview.skills).toMatchObject([{ id: "filmavond" }]);
    expect(overview.widgets).toMatchObject([{ id: widgetId }]);
    expect(overview.sidebar).toEqual(expect.arrayContaining(sidebar));
  });

  it("restores null quick actions and sidebar defaults while omitted fields preserve them", async () => {
    const actions = [{ label: "Eigen knop", prompt: "Wat is het weer?" }];
    const sidebar = [{ id: "systeem", column: "right", page: 2, shown: false }];
    await call("put", "/quick-actions", { items: actions });
    await call("put", "/sidebar", { items: sidebar });
    const custom = nova.store.get();
    expect(
      (
        await call("post", "/import", {
          data: { format: "nova-settings", version: 1, skills: [] },
          mode: "merge",
        })
      ).status,
    ).toBe(200);
    expect(nova.store.get().quickActions).toEqual(custom.quickActions);
    expect(nova.store.get().sidebar).toEqual(custom.sidebar);
    expect(
      (
        await call("post", "/import", {
          data: {
            format: "nova-settings",
            version: 1,
            skills: [],
            quickActions: null,
            sidebar: null,
          },
          mode: "replace",
        })
      ).status,
    ).toBe(200);
    expect(nova.store.get().quickActions).toBeNull();
    expect(nova.store.get().sidebar).toBeNull();
    const overview = await call("get", "/");
    expect(overview.quickActions).toEqual(DEFAULT_QUICK_ACTIONS);
    expect(overview.quickActionsAreDefault).toBe(true);
    expect(overview.sidebar).toEqual(
      expect.arrayContaining([
        { id: "systeem", column: "left", page: 1, shown: true },
      ]),
    );
  });

  it("takes the private migration snapshot only behind the overview guard", async () => {
    const snapshot = vi.spyOn(nova.store, "backupBeforeSettingsPage");
    try {
      await call("get", "/public", undefined, {});
      await call("get", "/export");
      expect(snapshot).not.toHaveBeenCalled();
      expect((await call("get", "/")).status).toBe(200);
      expect(snapshot).toHaveBeenCalledOnce();
      nova.app.get(JarvisStateStore).replaceLists({
        boodschappen: [
          {
            id: "1234abcd",
            text: "brood",
            addedAt: "2026-10-10T10:00:00.000Z",
          },
        ],
      });
      const exported = await call("get", "/export");
      expect(exported.lists.boodschappen[0].text).toBe("brood");
      expect(Object.keys(exported).sort()).toEqual(
        [
          "exportedAt",
          "connections",
          "format",
          "helper",
          "helperPreferences",
          "householdProfiles",
          "lists",
          "modelRoles",
          "nodeRedFlowsIncluded",
          "persona",
          "personaProfile",
          "personaStyle",
          "activeHouseholdProfileId",
          "quickActions",
          "sidebar",
          "skills",
          "status",
          "toolOverrides",
          "version",
          "widgets",
        ].sort(),
      );
      const pinned = await createApp({ env: { NOVA_ADMIN_PIN: "4321" } });
      const deniedSnapshot = vi.spyOn(pinned.store, "backupBeforeSettingsPage");
      try {
        expect((await pinned.api.get("/api/settings")).status).toBe(401);
        expect(deniedSnapshot).not.toHaveBeenCalled();
        expect(
          (await pinned.api.get("/api/settings").set("x-nova-pin", "4321"))
            .status,
        ).toBe(200);
        expect(deniedSnapshot).toHaveBeenCalledOnce();
      } finally {
        deniedSnapshot.mockRestore();
        await pinned.app.close();
      }
    } finally {
      snapshot.mockRestore();
    }
  });

  it("has a ceiling on the number of skills", async () => {
    nova.store.update(
      (settings) =>
        void (settings.skills = Array.from({ length: 50 }, (_, i) => ({
          ...playbook({ name: `Skill ${i}`, examples: [] }),
          id: `skill_${i}`,
        }))),
    );
    const refused = await call(
      "post",
      "/skills",
      playbook({ name: "Een te veel" }),
    );
    expect(refused.status).toBe(400);
    expect(refused.error).toMatch(/Maximaal 50/);
  });

  it("groups tools in abilities and switches a whole ability", async () => {
    await call("put", "/tools/echo", {
      description: "Aangepaste echo-omschrijving.",
    });
    const overview = await call("get", "/");
    const system = overview.abilities.find(
      (a: { id: string }) => a.id === "systeem",
    );
    expect(system.tools).toContain("echo");
    expect(system.total).toBe(system.tools.length);
    const historyBefore = (await call("get", "/tools/history")).revisions;
    const off = await call("put", "/abilities/systeem", { enabled: false });
    expect(off.status).toBe(200);
    expect(nova.store.get().toolOverrides.echo).toEqual({
      enabled: false,
      description: "Aangepaste echo-omschrijving.",
    });
    const history = await call("get", "/tools/history");
    expect(history.revisions).toHaveLength(historyBefore.length + 1);
    expect(history.revisions[0].after.echo).toBe(false);
    expect(JSON.stringify(history.revisions[0])).not.toContain(
      "Aangepaste echo-omschrijving.",
    );
    expect(
      (await call("get", "/")).abilities.find(
        (a: { id: string }) => a.id === "systeem",
      ).state,
    ).toBe("off");
    const restored = await call(
      "post",
      `/tools/history/${history.revisions[0].id}/rollback`,
      {},
    );
    expect(restored.status).toBe(200);
    expect(nova.store.get().toolOverrides.echo).toEqual({
      description: "Aangepaste echo-omschrijving.",
    });
    expect(
      (await call("get", "/")).tools.find(
        (item: { name: string }) => item.name === "echo",
      ).description,
    ).toBe("Aangepaste echo-omschrijving.");
    const missing = await call("put", "/abilities/bestaat-niet", {
      enabled: true,
    });
    expect(missing.status).toBe(404);
    expect(missing.error).toBe("Dat onderdeel bestaat niet.");
    expect((await call("put", "/abilities/systeem", {})).status).toBe(400);
  });

  it("records and conflict-checks sidebar layout rollback", async () => {
    const before = (await call("get", "/")).sidebar;
    const after = before.map((item: { shown: boolean }, index: number) =>
      index === 0 ? { ...item, shown: !item.shown } : item,
    );
    expect((await call("put", "/sidebar", { items: after })).status).toBe(200);
    const history = await call("get", "/sidebar/history");
    expect(history.revisions[0].before).toEqual(before);
    expect(history.revisions[0].after).toEqual(after);
    const restored = await call(
      "post",
      `/sidebar/history/${history.revisions[0].id}/rollback`,
      {},
    );
    expect(restored.status).toBe(200);
    expect(restored.sidebar).toEqual(before);
    expect(
      (await call("get", "/sidebar/history")).revisions[0].revertedFrom,
    ).toBe(history.revisions[0].id);
  });

  it("shows the public address with only its origin", async () => {
    const proxied = await createApp({
      env: { NOVA_PUBLIC_URL: "https://nova.example.com/app" },
    });
    try {
      const shown = await proxied.api.get("/api/settings/public");
      expect(shown.body.publicUrl).toBe("https://nova.example.com");
    } finally {
      await proxied.app.close();
    }
    expect((await call("get", "/public", undefined, {})).publicUrl).toBe("");
  });
});

describe("the wallpaper screen", () => {
  it("says there is no agent without a Windows module", async () => {
    const response = await call("get", "/wallpaper");
    expect(response).toMatchObject({ available: false, reason: "no-agent" });
    expect(
      (await call("post", "/wallpaper", { display: 1, mode: "full" })).status,
    ).toBe(400);
  });

  it("lists the displays and sets the wallpaper through the port", async () => {
    const displays = [
      {
        index: 1,
        name: "D1",
        primary: true,
        width: 1920,
        height: 1080,
        mode: "off",
      },
      {
        index: 2,
        name: "D2",
        primary: false,
        width: 2560,
        height: 1440,
        mode: "off",
      },
    ] as const;
    const state = displays.map((item) => ({ ...item })) as {
      index: number;
      mode: string;
    }[];
    const sets: unknown[] = [];
    let failure: string | null = null;
    const port: WallpaperPort = {
      configured: true,
      displays: async () =>
        failure
          ? { ok: false, error: failure }
          : { ok: true, displays: structuredClone(state) as never },
      setWallpaper: async (display, mode) => {
        sets.push({ display, mode });
        for (const screen of state)
          if (display === 0 || display === screen.index) screen.mode = mode;
        return { ok: true, displays: structuredClone(state) as never };
      },
      setMode: async () => ({ ok: true, displays: [] }),
      helperSize: async () => ({ ok: true }),
    };
    const wallpaper = await createApp({ wallpaper: port });
    try {
      const send = async (
        method: "get" | "post",
        body?: object,
        headers: Record<string, string> = ADMIN,
      ): Promise<Reply> => {
        const r = await wallpaper.api[method]("/api/settings/wallpaper")
          .set(headers)
          .send(body);
        return { status: r.status, ...(r.body as object) };
      };
      const listed = await send("get");
      expect(listed.available).toBe(true);
      expect(listed.displays).toHaveLength(2);
      const set = await send("post", { display: 2, mode: "sphere" });
      expect(set.displays[1].mode).toBe("sphere");
      expect(set.displays[0].mode).toBe("off");
      expect(sets.at(-1)).toEqual({ display: 2, mode: "sphere" });
      const revisions = await wallpaper.api
        .get("/api/settings/wallpaper/history")
        .set(ADMIN);
      expect(revisions.body.revisions[0]).toMatchObject({
        display: 2,
        before: "off",
        after: "sphere",
      });
      const revisionId = revisions.body.revisions[0].id as string;
      const restored = await wallpaper.api
        .post(`/api/settings/wallpaper/history/${revisionId}/rollback`)
        .set(ADMIN)
        .send({});
      expect(restored.status).toBe(200);
      expect(restored.body.displays[1].mode).toBe("off");
      expect(sets.at(-1)).toEqual({ display: 2, mode: "off" });
      expect(
        (
          await wallpaper.api
            .post(`/api/settings/wallpaper/history/${revisionId}/rollback`)
            .set(ADMIN)
            .send({})
        ).status,
      ).toBe(400);
      expect((await send("post", { display: 1, mode: "zwart" })).status).toBe(
        400,
      );
      expect((await send("post", { display: 99, mode: "full" })).status).toBe(
        400,
      );
      expect(
        (await send("post", { display: 1, mode: "full" }, {})).status,
      ).toBe(403);
      failure = "De agent is te oud voor deze functie.";
      expect(await send("get")).toMatchObject({
        available: false,
        reason: "old-agent",
      });
      failure = "geen verbinding";
      expect(await send("get")).toMatchObject({
        available: false,
        reason: "unreachable",
      });
      expect(
        wallpaper.audits.some(
          (row) => (row.arguments as { what?: string }).what === "wallpaper",
        ),
      ).toBe(true);
    } finally {
      await wallpaper.app.close();
    }
  });
});

describe("the helper overlay choice", () => {
  const port = (
    log: unknown[],
    failure: { error: string | null },
  ): WallpaperPort => ({
    configured: true,
    displays: async () => ({
      ok: true,
      displays: [],
      mode: "wallpaper",
      helperDisplay: 0,
    }),
    setWallpaper: async () => ({ ok: true, displays: [] }),
    setMode: async (mode, display) => {
      log.push({ mode, display });
      return failure.error
        ? { ok: false, error: failure.error }
        : { ok: true, displays: [], mode, helperDisplay: display };
    },
    helperSize: async (expanded, options) => {
      log.push({ expanded, ...(options ? { options } : {}) });
      return { ok: true };
    },
  });

  it("defaults to the wallpaper and says there is no agent without one", async () => {
    const app = await createApp();
    try {
      const got = await app.api.get("/api/settings/helper").set(ADMIN);
      expect(got.body.settings).toEqual({ mode: "wallpaper", display: 0 });
      expect(got.body.desktop).toMatchObject({ reason: "no-agent" });
      const set = await app.api
        .post("/api/settings/helper")
        .set(ADMIN)
        .send({ mode: "helper", display: 2 });
      // Saved, but not applied.
      expect(set.body).toMatchObject({
        settings: { mode: "helper", display: 2 },
        applied: false,
      });
      const again = await app.api.get("/api/settings/helper").set(ADMIN);
      expect(again.body.settings).toEqual({ mode: "helper", display: 2 });
      const history = await app.api
        .get("/api/settings/helper/history")
        .set(ADMIN);
      expect(history.body.revisions).toHaveLength(1);
      expect(history.body.revisions[0]).toMatchObject({
        before: { mode: "wallpaper", display: 0 },
        after: { mode: "helper", display: 2 },
      });
      const rollback = await app.api
        .post(
          `/api/settings/helper/history/${history.body.revisions[0].id}/rollback`,
        )
        .set(ADMIN);
      expect(rollback.body).toMatchObject({
        settings: { mode: "wallpaper", display: 0 },
        applied: false,
        error: "Er is geen Windows-agent ingesteld.",
      });
      expect(
        (await app.api.get("/api/settings/helper").set(ADMIN)).body.settings,
      ).toEqual({ mode: "wallpaper", display: 0 });
    } finally {
      await app.app.close();
    }
  });

  it("validates, saves and applies the choice through the port", async () => {
    const log: unknown[] = [];
    const failure = { error: null as string | null };
    const app = await createApp({ wallpaper: port(log, failure) });
    try {
      const post = (body: object, headers: Record<string, string> = ADMIN) =>
        app.api.post("/api/settings/helper").set(headers).send(body);
      const ok = await post({ mode: "both", display: 1 });
      expect(ok.status).toBe(200);
      expect(ok.body).toMatchObject({
        applied: true,
        settings: { mode: "both", display: 1 },
        desktop: { available: true, mode: "both", helperDisplay: 1 },
      });
      expect(log.at(-1)).toEqual({ mode: "both", display: 1 });
      expect((await post({ mode: "scherm" })).status).toBe(400);
      expect((await post({ mode: "helper", display: 99 })).status).toBe(400);
      expect((await post({ mode: "helper", display: 1.5 })).status).toBe(400);
      expect((await post({ mode: "helper" }, {})).status).toBe(403);
      // An agent that cannot be reached: the choice is still kept.
      failure.error = "geen verbinding";
      const down = await post({ mode: "helper", display: 0 });
      expect(down.body).toMatchObject({
        applied: false,
        error: "geen verbinding",
        settings: { mode: "helper", display: 0 },
      });
      expect(
        (await app.api.get("/api/settings/helper").set(ADMIN)).body.settings,
      ).toEqual({ mode: "helper", display: 0 });
      expect(
        app.audits.some(
          (row) => (row.arguments as { what?: string }).what === "helper",
        ),
      ).toBe(true);
    } finally {
      await app.app.close();
    }
  });

  it("rolls back helper history only when the current choice still matches", async () => {
    const log: unknown[] = [];
    const pin = { ...ADMIN, "x-nova-pin": "helper-history-pin" };
    const directory = fs.mkdtempSync(path.join("/tmp", "nova-helper-mode-"));
    const app = await createApp({
      env: {
        NOVA_ADMIN_PIN: "helper-history-pin",
        NOVA_DATA_DIR: directory,
      },
      wallpaper: port(log, { error: null }),
    });
    try {
      const save = (mode: string, display: number) =>
        app.api.post("/api/settings/helper").set(pin).send({ mode, display });
      expect((await app.api.get("/api/settings/helper/history")).status).toBe(
        401,
      );
      await save("both", 1);
      const firstHistory = await app.api
        .get("/api/settings/helper/history")
        .set(pin);
      expect(firstHistory.body.revisions).toHaveLength(1);
      expect(
        fs.statSync(
          path.join(
            path.dirname(app.store["file" as never] as string),
            "helper-mode-history.json",
          ),
        ).mode & 0o777,
      ).toBe(0o600);
      const firstId = firstHistory.body.revisions[0].id;
      await save("helper", 2);
      const stale = await app.api
        .post(`/api/settings/helper/history/${firstId}/rollback`)
        .set(pin);
      expect(stale.status).toBe(404);

      const currentHistory = await app.api
        .get("/api/settings/helper/history")
        .set(pin);
      const currentId = currentHistory.body.revisions[0].id;
      const rollback = await app.api
        .post(`/api/settings/helper/history/${currentId}/rollback`)
        .set(pin);
      expect(rollback.body).toMatchObject({
        settings: { mode: "both", display: 1 },
        applied: true,
      });
      expect(log.at(-1)).toEqual({ mode: "both", display: 1 });
      const afterRollback = await app.api
        .get("/api/settings/helper/history")
        .set(pin);
      expect(afterRollback.body.revisions[0].revertedFrom).toBe(currentId);
      expect(JSON.stringify(afterRollback.body)).not.toMatch(/token|secret/i);
    } finally {
      await app.app.close();
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });

  it("persists helper preferences after reload and rejects invalid settings without changing them", async () => {
    const defaults = await call("get", "/helper/preferences", undefined, {});
    expect(defaults).toMatchObject({
      autohide: true,
      contrast: false,
      shape: "orb",
      notifications: {
        info: "helper",
        briefing: "speak",
        warning: "speak",
        critical: "speak",
        timer: "speak",
      },
      rituals: {
        morning: { enabled: false, time: "08:00" },
        evening: { enabled: false, time: "22:00" },
        checkIn: { enabled: false, afterHours: 4 },
      },
      cues: {
        enabled: true,
        volume: 0.35,
        theme: "soft",
        cues: {},
        quiet: { enabled: false, start: "22:00", end: "07:00" },
      },
    });
    const preferences = {
      autohide: false,
      contrast: true,
      shape: "ring",
      notifications: {
        info: "screen",
        briefing: "speak",
        warning: "helper",
        critical: "speak",
        timer: "speak",
      },
      rituals: {
        morning: { enabled: true, time: "07:30" },
        evening: { enabled: false, time: "22:00" },
        checkIn: { enabled: true, afterHours: 6 },
        weeklyOverview: { enabled: false, time: "18:00" },
        calendarReminders: { enabled: false, minutesBefore: 15 },
      },
      cues: {
        enabled: true,
        volume: 0.7,
        theme: "minimal",
        cues: { done: false, file: true },
        quiet: { enabled: true, start: "23:15", end: "06:30" },
      },
    };
    const saved = await call("put", "/helper/preferences", preferences);
    expect(saved).toMatchObject({ status: 200, ok: true, preferences });
    nova.store.reset();
    expect(await call("get", "/helper/preferences", undefined, {})).toEqual({
      status: 200,
      ...preferences,
      rituals: {
        ...preferences.rituals,
        weeklyOverview: { enabled: false, time: "18:00" },
      },
    });
    const invalid = [
      { ...preferences, shape: "unknown" },
      { ...preferences, cues: { ...preferences.cues, volume: 1.1 } },
      { ...preferences, cues: { ...preferences.cues, volume: -0.1 } },
      { ...preferences, cues: { ...preferences.cues, volume: "0.7" } },
      { ...preferences, cues: { ...preferences.cues, theme: "unknown" } },
      {
        ...preferences,
        cues: {
          ...preferences.cues,
          quiet: { ...preferences.cues.quiet, start: "24:00" },
        },
      },
      {
        ...preferences,
        cues: {
          ...preferences.cues,
          quiet: { ...preferences.cues.quiet, end: "07:99" },
        },
      },
      {
        ...preferences,
        cues: { ...preferences.cues, cues: { unknown: true } },
      },
      { ...preferences, cues: { ...preferences.cues, cues: { done: "yes" } } },
      {
        ...preferences,
        rituals: {
          ...preferences.rituals,
          morning: { enabled: true, time: "25:00" },
        },
      },
      {
        ...preferences,
        rituals: {
          ...preferences.rituals,
          checkIn: { enabled: true, afterHours: 5 },
        },
      },
      {
        ...preferences,
        rituals: {
          ...preferences.rituals,
          calendarReminders: { enabled: true, minutesBefore: 10 },
        },
      },
    ];
    for (const body of invalid)
      expect((await call("put", "/helper/preferences", body)).status).toBe(400);
    expect(nova.store.get().helperPreferences).toEqual(preferences);
  });

  it("exposes preferences with a PIN configured but requires PIN and admin header to write", async () => {
    const app = await createApp({ env: { NOVA_ADMIN_PIN: "1234" } });
    try {
      const got = await app.api.get("/api/settings/helper/preferences");
      expect(got.status).toBe(200);
      const write = (headers: Record<string, string>) =>
        app.api
          .put("/api/settings/helper/preferences")
          .set(headers)
          .send(got.body);
      expect((await write({})).status).toBe(401);
      expect((await write(ADMIN)).status).toBe(401);
      expect((await write({ "x-nova-pin": "1234" })).status).toBe(403);
      expect((await write({ ...ADMIN, "x-nova-pin": "1234" })).status).toBe(
        200,
      );
      const revoke = (headers: Record<string, string>) =>
        app.api.delete("/api/settings/standing-approvals/id").set(headers);
      expect((await revoke(ADMIN)).status).toBe(401);
      expect((await revoke({ "x-nova-pin": "1234" })).status).toBe(403);
    } finally {
      await app.app.close();
    }
  });

  it("forwards named helper views and validates flags while retaining legacy sizing", async () => {
    const log: unknown[] = [];
    const app = await createApp({ wallpaper: port(log, { error: null }) });
    try {
      const size = (body: object) =>
        app.api.post("/api/settings/helper/size").send(body);
      for (const view of ["compact", "overview", "chat", "confirmation"]) {
        expect(
          (await size({ view, hidden: true, reducedMotion: true })).status,
        ).toBe(200);
        expect(log.at(-1)).toEqual({
          expanded: view !== "compact",
          options: { view, hidden: true, reducedMotion: true },
        });
      }
      for (const body of [
        { view: "unknown" },
        { view: "chat", hidden: "yes" },
        { view: "chat", reducedMotion: 1 },
        { expanded: "yes" },
      ])
        expect((await size(body)).status).toBe(400);
      expect((await size({ expanded: false })).status).toBe(200);
      expect(log.at(-1)).toEqual({ expanded: false });
    } finally {
      await app.app.close();
    }
  });

  it("lets the helper page resize its window without a PIN, and only with a boolean", async () => {
    const log: unknown[] = [];
    const app = await createApp({
      env: { NOVA_ADMIN_PIN: "1234" },
      wallpaper: port(log, { error: null }),
    });
    try {
      const size = (body: object) =>
        app.api.post("/api/settings/helper/size").send(body);
      expect((await size({ expanded: true })).body).toEqual({ ok: true });
      expect(log.at(-1)).toEqual({ expanded: true });
      expect((await size({ expanded: "ja" })).status).toBe(400);
      // The choice itself still needs the PIN.
      expect((await app.api.get("/api/settings/helper")).status).toBe(401);
    } finally {
      await app.app.close();
    }
  });
});
