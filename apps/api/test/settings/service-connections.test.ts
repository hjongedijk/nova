import fs from "node:fs";
import crypto from "node:crypto";
import os from "node:os";
import path from "node:path";
import { EventEmitter } from "node:events";
import mqtt from "mqtt";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AuditService } from "../../src/core/audit/audit.service.js";
import { NovaConfig } from "../../src/core/config/nova-config.js";
import { SemanticMemoryService } from "../../src/memory/semantic-memory.service.js";
import { ServiceConnectionsStore } from "../../src/settings/services/service-connections.store.js";
import { ServiceConnectionsAdapter } from "../../src/settings/services/service-connections.adapter.js";
import { ADMIN, createApp, json, service, type TestApp } from "./helpers.js";

let nova: TestApp;
let directory: string;
beforeEach(async () => {
  directory = fs.mkdtempSync(path.join(os.tmpdir(), "nova-connections-"));
  nova = await createApp({
    env: {
      NOVA_DATA_DIR: directory,
      HOME_ASSISTANT_URL: "http://fixture.invalid:8123",
      HOME_ASSISTANT_TOKEN: "environment-secret",
      NODE_RED_ADMIN_TOKEN: "environment-node-red-token",
      NOVA_ADMIN_PIN: "",
    },
  });
});
afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  await nova.app.close();
  fs.rmSync(directory, { recursive: true, force: true });
});

const request = (
  method: "get" | "put" | "post",
  tail = "",
  body?: object,
  headers: Record<string, string> = ADMIN,
) => nova.api[method](`/api/settings/services${tail}`).set(headers).send(body);
const home = (body: {
  services: {
    id: string;
    fields: { key: string; set?: boolean; value?: unknown }[];
    restartRequired: boolean;
  }[];
}) => body.services.find((item) => item.id === "home-assistant")!;
const persisted = () =>
  JSON.parse(fs.readFileSync(path.join(directory, "services.json"), "utf8"));

describe("service connection management", () => {
  it("archives eligible Qdrant memories only from the PIN-protected settings route", async () => {
    const memory = nova.app.get(SemanticMemoryService);
    const maintain = vi.fn(async () => ({
      ok: true,
      scanned: 12,
      archived: 3,
      more: false,
    }));
    memory.useBackends({ qdrant: { maintain } as never });

    const denied = await nova.api
      .post("/api/settings/services/qdrant/maintenance")
      .send({});
    expect(denied.status).toBe(403);

    const result = await request("post", "/qdrant/maintenance", {});
    expect(result.status).toBe(200);
    expect(result.body).toEqual({
      ok: true,
      scanned: 12,
      archived: 3,
      more: false,
    });
    expect(maintain).toHaveBeenCalledOnce();
  });

  it("backs up service addresses without exporting or replacing destination secrets", async () => {
    const source = await request("put", "/home-assistant", {
      values: {
        url: "http://source.invalid:8123",
        token: "source-private-token",
      },
    });
    expect(source.status).toBe(200);
    await request("put", "/mqtt", {
      values: { username: "source-user" },
    });
    const exported = await nova.api.get("/api/settings/export").set(ADMIN);
    expect(exported.status).toBe(200);
    expect(exported.body.connections["home-assistant"]).toMatchObject({
      url: "http://source.invalid:8123",
    });
    expect(exported.body.connections["home-assistant"]).not.toHaveProperty(
      "token",
    );
    expect(JSON.stringify(exported.body.connections)).not.toContain(
      "source-private-token",
    );
    expect(exported.body.connections.mqtt).not.toHaveProperty("username");

    const destination = await request("put", "/home-assistant", {
      values: {
        url: "http://destination.invalid:8123",
        token: "destination-private-token",
      },
    });
    await request("put", "/mqtt", {
      values: { username: "destination-user" },
    });
    expect(destination.status).toBe(200);
    const prepared = await nova.api
      .post("/api/settings/import/prepare")
      .set(ADMIN)
      .send({
        data: exported.body,
        mode: "replace",
        acknowledgeEffects: true,
      });
    expect(prepared.status).toBe(200);
    expect(prepared.body.summary).toMatchObject({
      connectionsChanged: true,
      changedConnections: 1,
      connectionChanges: [
        {
          service: "home-assistant",
          before: { url: "http://destination.invalid:8123" },
          after: { url: "http://source.invalid:8123" },
        },
      ],
    });
    expect(JSON.stringify(prepared.body)).not.toContain(
      "destination-private-token",
    );
    const { sessionId, confirmationId } = prepared.body.action;
    const result = await nova.api
      .post("/api/settings/import")
      .set(ADMIN)
      .send({ sessionId, confirmationId, approve: true });
    expect(result.body).toMatchObject({ ok: true, changedConnections: 1 });
    expect(persisted().services["home-assistant"]).toMatchObject({
      url: "http://source.invalid:8123",
      token: "destination-private-token",
    });
    expect(persisted().services.mqtt.username).toBe("destination-user");
    expect(
      fs.statSync(path.join(directory, "services.json")).mode & 0o777,
    ).toBe(0o600);
  });

  it("rolls settings, lists and service destinations back after a partial multi-file import", async () => {
    await request("put", "/home-assistant", {
      values: {
        url: "http://source.invalid:8123",
        token: "source-private-token",
      },
    });
    const exported = await nova.api.get("/api/settings/export").set(ADMIN);
    await request("put", "/home-assistant", {
      values: {
        url: "http://destination.invalid:8123",
        token: "destination-private-token",
      },
    });
    const previousPersona = nova.store.get().persona;
    const serviceStore = nova.app.get(ServiceConnectionsStore);
    vi.spyOn(serviceStore, "restoreSnapshot").mockImplementationOnce(() => {
      throw new Error("fixture interrupted service file write");
    });
    const prepared = await nova.api
      .post("/api/settings/import/prepare")
      .set(ADMIN)
      .send({
        data: exported.body,
        mode: "replace",
        acknowledgeEffects: true,
      });
    const { sessionId, confirmationId } = prepared.body.action;
    const result = await nova.api
      .post("/api/settings/import")
      .set(ADMIN)
      .send({ sessionId, confirmationId, approve: true });
    expect(result.body).toMatchObject({ ok: false });
    expect(nova.store.get().persona).toBe(previousPersona);
    expect(persisted().services["home-assistant"]).toMatchObject({
      url: "http://destination.invalid:8123",
      token: "destination-private-token",
    });
    expect(
      fs.existsSync(path.join(directory, "settings-import-transaction.json")),
    ).toBe(false);
  });

  it("preserves service settings when importing older v1 files without connections", async () => {
    await request("put", "/home-assistant", {
      values: {
        url: "http://destination.invalid:8123",
        token: "destination-private-token",
      },
    });
    const exported = await nova.api.get("/api/settings/export").set(ADMIN);
    delete exported.body.connections;
    const prepared = await nova.api
      .post("/api/settings/import/prepare")
      .set(ADMIN)
      .send({
        data: exported.body,
        mode: "replace",
        acknowledgeEffects: true,
      });
    expect(prepared.status).toBe(200);
    expect(prepared.body.summary.changedConnections).toBe(0);
    const { sessionId, confirmationId } = prepared.body.action;
    expect(
      (
        await nova.api
          .post("/api/settings/import")
          .set(ADMIN)
          .send({ sessionId, confirmationId, approve: true })
      ).body.ok,
    ).toBe(true);
    expect(persisted().services["home-assistant"]).toMatchObject({
      url: "http://destination.invalid:8123",
      token: "destination-private-token",
    });
  });

  it("rejects any credential field in imported service settings before writing", async () => {
    const exported = await nova.api.get("/api/settings/export").set(ADMIN);
    const data = structuredClone(exported.body);
    data.connections.qdrant.apiKey = "forbidden-imported-secret";
    const before = fs.existsSync(path.join(directory, "services.json"))
      ? fs.readFileSync(path.join(directory, "services.json"))
      : undefined;
    const response = await nova.api
      .post("/api/settings/import/prepare")
      .set(ADMIN)
      .send({ data, mode: "replace", acknowledgeEffects: true });
    expect(response.status).toBe(400);
    expect(JSON.stringify(response.body)).not.toContain(
      "forbidden-imported-secret",
    );
    const after = fs.existsSync(path.join(directory, "services.json"))
      ? fs.readFileSync(path.join(directory, "services.json"))
      : undefined;
    expect(after).toEqual(before);
  });

  it("guards reads with PIN and writes/probes/rollback with the admin header", async () => {
    expect(
      (await request("put", "/home-assistant", { values: {} }, {})).status,
    ).toBe(403);
    expect(
      (await request("post", "/home-assistant/test", { values: {} }, {}))
        .status,
    ).toBe(403);
    expect(
      (
        await request(
          "post",
          "/history/00000000-0000-0000-0000-000000000000/prepare-rollback",
          {},
          {},
        )
      ).status,
    ).toBe(403);
    const pinned = await createApp({
      env: { NOVA_DATA_DIR: directory, NOVA_ADMIN_PIN: "fixture-pin" },
    });
    try {
      expect((await pinned.api.get("/api/settings/services")).status).toBe(401);
      expect(
        (await pinned.api.get("/api/settings/services/history")).status,
      ).toBe(401);
      expect(
        (await pinned.api.get("/api/settings/services/restart")).status,
      ).toBe(401);
      expect(
        (await pinned.api.post("/api/settings/services/restart")).status,
      ).toBe(401);
      expect(
        (await pinned.api.get("/api/settings/services/mqtt/overview")).status,
      ).toBe(401);
      expect(
        (await pinned.api.get("/api/settings/services/home-assistant/status"))
          .status,
      ).toBe(401);
      expect(
        (
          await pinned.api
            .get("/api/settings/services")
            .set("x-nova-pin", "fixture-pin")
        ).status,
      ).toBe(200);
      expect(
        (
          await pinned.api
            .get("/api/settings/services/restart")
            .set("x-nova-pin", "fixture-pin")
        ).body,
      ).toMatchObject({ available: false, pendingChanges: false });
      expect(
        (
          await pinned.api
            .post("/api/settings/services/restart")
            .set("x-nova-pin", "fixture-pin")
        ).status,
      ).toBe(403);
      const mqttOverview = await pinned.api
        .get("/api/settings/services/mqtt/overview")
        .set("x-nova-pin", "fixture-pin");
      expect(mqttOverview.status).toBe(200);
      expect(mqttOverview.body.topics).toContain("jarvis/events/timer");
      expect(mqttOverview.body.recent).toEqual([]);
      expect(
        (
          await pinned.api
            .put("/api/settings/services/home-assistant")
            .set("x-nova-pin", "fixture-pin")
            .send({ values: {} })
        ).status,
      ).toBe(403);
      expect(fs.existsSync(path.join(directory, "services.json"))).toBe(false);
    } finally {
      await pinned.app.close();
    }
  });

  it("replaces secrets, keeps blank replacements and explicitly clears without disclosure", async () => {
    const initial = await request("get");
    expect(
      home(initial.body).fields.find((field) => field.key === "token"),
    ).toMatchObject({ set: true });
    expect(JSON.stringify(initial.body)).not.toContain("environment-secret");
    const saved = await request("put", "/home-assistant", {
      values: { token: "new-private-token" },
    });
    expect(saved.status).toBe(200);
    expect(persisted().services["home-assistant"].token).toBe(
      "new-private-token",
    );
    await request("put", "/home-assistant", { values: { token: "" } });
    expect(persisted().services["home-assistant"].token).toBe(
      "new-private-token",
    );
    const history = await request("get", "/history");
    expect(history.body.revisions[0].secretChanges).toEqual(["token"]);
    const auditText = fs.readFileSync(
      path.join(directory, "actions.jsonl"),
      "utf8",
    );
    const publicText =
      JSON.stringify([
        saved.body,
        history.body,
        nova.audits,
        persisted().history,
      ]) + auditText;
    expect(publicText).not.toContain("new-private-token");
    expect(publicText).not.toContain("environment-secret");
    for (const entry of home(saved.body).fields.filter(
      (field) => field.key === "token",
    )) {
      expect(entry).not.toHaveProperty("value");
    }
    const cleared = await request("put", "/home-assistant", {
      values: {},
      clearSecrets: ["token"],
    });
    expect(persisted().services["home-assistant"].token).toBe("");
    expect(
      home(cleared.body).fields.find((field) => field.key === "token")?.set,
    ).toBe(false);
    expect(
      (
        await request("put", "/home-assistant", {
          values: {},
          clearSecrets: ["url"],
        })
      ).status,
    ).toBe(400);
  });

  it.each([
    { url: "file:///etc/passwd" },
    { url: "http://user:password@fixture.invalid" },
    { url: "http://fixture.invalid/#fragment" },
    { url: "http://fixture.invalid/?token=private" },
    { url: "not a URL" },
    { unknown: "value" },
    { token: "line\nsecret" },
    JSON.parse('{"__proto__":{"polluted":true}}'),
  ])(
    "rejects malformed or unknown fields without changing persistence: %j",
    async (values) => {
      const response = await request("put", "/home-assistant", { values });
      expect(response.status).toBe(400);
      expect(fs.existsSync(path.join(directory, "services.json"))).toBe(false);
      expect({}).not.toHaveProperty("polluted");
      expect(JSON.stringify(response.body)).not.toContain("line\\nsecret");
    },
  );

  it("rejects unsupported services and non-boolean TLS policy", async () => {
    expect((await request("put", "/unknown", { values: {} })).status).toBe(400);
    expect(
      (await request("put", "/proxmox", { values: { verifyTls: "false" } }))
        .status,
    ).toBe(400);
    expect(
      (
        await request("put", "/mqtt", {
          values: { url: "https://fixture.invalid" },
        })
      ).status,
    ).toBe(400);
  });

  it("sanitizes credential-bearing legacy environment URLs in public fields", async () => {
    const legacy = await createApp({
      env: {
        NOVA_DATA_DIR: directory,
        HOME_ASSISTANT_URL:
          "http://legacy-user:legacy-private@fixture.invalid:8123/?key=query-private#fragment-private",
        MQTT_URL: "mqtt://broker-user:broker-private@fixture.invalid:1883",
        NOVA_ADMIN_PIN: "",
      },
    });
    try {
      const response = await legacy.api.get("/api/settings/services");
      expect(response.status).toBe(200);
      expect(
        home(response.body).fields.find((field) => field.key === "url")?.value,
      ).toBe("http://fixture.invalid:8123");
      const broker = response.body.services.find(
        (item: { id: string }) => item.id === "mqtt",
      );
      expect(
        broker.fields.find(
          (field: { key: string }) => field.key === "password",
        ),
      ).toMatchObject({ set: true });
      expect(JSON.stringify(response.body)).not.toMatch(
        /legacy-private|query-private|fragment-private|broker-private/,
      );
    } finally {
      await legacy.app.close();
    }
  });

  it("persists privately, leaves running config unchanged and applies overrides on reboot", async () => {
    const running = nova.app.get(NovaConfig);
    const saved = await request("put", "/home-assistant", {
      values: { url: "http://new-fixture.invalid:8123", token: "boot-secret" },
    });
    expect(home(saved.body).restartRequired).toBe(true);
    expect(running.homeAssistant).toEqual({
      url: "http://fixture.invalid:8123",
      token: "environment-secret",
    });
    expect(
      fs.statSync(path.join(directory, "services.json")).mode & 0o777,
    ).toBe(0o600);
    vi.stubEnv("NOVA_DATA_DIR", directory);
    vi.stubEnv("HOME_ASSISTANT_URL", "http://fallback.invalid");
    const reboot = new NovaConfig();
    expect(reboot.homeAssistant).toEqual({
      url: "http://new-fixture.invalid:8123",
      token: "boot-secret",
    });
    const rebootStore = new ServiceConnectionsStore(reboot, nova.audit);
    expect(home({ services: rebootStore.list() }).restartRequired).toBe(false);
    expect(reboot.freeOnly).toBe(true);
  });

  it("stores Node-RED admin-token replacements privately and applies them only after restart", async () => {
    const running = nova.app.get(NovaConfig);
    const saved = await request("put", "/node-red", {
      values: { adminToken: "replacement-node-red-token" },
    });
    expect(saved.status).toBe(200);
    const connection = saved.body.services.find(
      (item: { id: string }) => item.id === "node-red",
    );
    expect(connection.restartRequired).toBe(true);
    expect(
      connection.fields.find(
        (item: { key: string }) => item.key === "adminToken",
      ),
    ).toMatchObject({ kind: "secret", set: true });
    expect(
      connection.fields.find(
        (item: { key: string }) => item.key === "adminToken",
      ),
    ).not.toHaveProperty("value");
    expect(running.nodeRedAdminToken).toBe("environment-node-red-token");
    expect(persisted().services["node-red"].adminToken).toBe(
      "replacement-node-red-token",
    );
    expect(
      fs.statSync(path.join(directory, "services.json")).mode & 0o777,
    ).toBe(0o600);
    await request("put", "/node-red", { values: { adminToken: "" } });
    expect(persisted().services["node-red"].adminToken).toBe(
      "replacement-node-red-token",
    );
    const history = await request("get", "/history");
    const exported = await nova.api.get("/api/settings/export").set(ADMIN);
    expect(exported.body.connections["node-red"]).not.toHaveProperty(
      "adminToken",
    );
    expect(
      JSON.stringify([saved.body, history.body, exported.body, nova.audits]),
    ).not.toMatch(/replacement-node-red-token|environment-node-red-token/);
    vi.stubEnv("NOVA_DATA_DIR", directory);
    expect(new NovaConfig().nodeRedAdminToken).toBe(
      "replacement-node-red-token",
    );
    await request("put", "/node-red", {
      values: {},
      clearSecrets: ["adminToken"],
    });
    expect(new NovaConfig().nodeRedAdminToken).toBe("");
  });

  it("requires fresh dangerous confirmation to roll back and refuses secret revisions", async () => {
    await request("put", "/home-assistant", {
      values: { url: "http://changed.invalid:8123" },
    });
    const changed = (await request("get", "/history")).body.revisions[0];
    const prepared = await request(
      "post",
      `/history/${changed.id}/prepare-rollback`,
      {},
    );
    expect(prepared.status).toBe(200);
    expect(prepared.body.action.risk).toBe("DANGEROUS");
    const undone = await request("post", "/history/confirm-rollback", {
      sessionId: prepared.body.action.sessionId,
      confirmationId: prepared.body.action.confirmationId,
      approve: true,
    });
    expect(undone.status).toBe(200);
    expect(
      home(undone.body).fields.find((field) => field.key === "url")?.value,
    ).toBe("http://fixture.invalid:8123");
    expect(home(undone.body).restartRequired).toBe(false);
    expect(
      (await request("get", "/history")).body.revisions[0].revertedFrom,
    ).toBe(changed.id);
    await request("put", "/home-assistant", {
      values: { token: "rollback-secret" },
    });
    const secret = (await request("get", "/history")).body.revisions[0];
    expect(
      (await request("post", `/history/${secret.id}/prepare-rollback`, {}))
        .status,
    ).toBe(400);
    expect(persisted().services["home-assistant"].token).toBe(
      "rollback-secret",
    );
  });

  it("rejects rollback confirmation after a competing connection change", async () => {
    await request("put", "/home-assistant", {
      values: { url: "http://first.invalid:8123" },
    });
    const revision = (await request("get", "/history")).body.revisions[0];
    const prepared = await request(
      "post",
      `/history/${revision.id}/prepare-rollback`,
      {},
    );
    await request("put", "/home-assistant", {
      values: { url: "http://competing.invalid:8123" },
    });
    const result = await request("post", "/history/confirm-rollback", {
      sessionId: prepared.body.action.sessionId,
      confirmationId: prepared.body.action.confirmationId,
      approve: true,
    });
    expect(result.body.ok).toBe(false);
    expect(
      home({ services: (await request("get")).body.services }).fields.find(
        (field) => field.key === "url",
      )?.value,
    ).toBe("http://competing.invalid:8123");
  });

  it("binds confirmation to public fields only and preserves later secret updates", async () => {
    await request("put", "/home-assistant", {
      values: { token: "secret-before-prepare" },
    });
    await request("put", "/home-assistant", {
      values: { url: "http://rollback-target.invalid:8123" },
    });
    const revision = (await request("get", "/history")).body.revisions[0];
    const prepared = await request(
      "post",
      `/history/${revision.id}/prepare-rollback`,
      {},
    );
    const effective = nova.app
      .get(ServiceConnectionsStore)
      .effective("home-assistant");
    expect(prepared.body.action.args.current).not.toBe(
      crypto
        .createHash("sha256")
        .update(JSON.stringify(effective))
        .digest("hex"),
    );
    await request("put", "/home-assistant", {
      values: { token: "secret-updated-after-prepare" },
    });
    const result = await request("post", "/history/confirm-rollback", {
      sessionId: prepared.body.action.sessionId,
      confirmationId: prepared.body.action.confirmationId,
      approve: true,
    });
    expect(result.body.ok).toBe(true);
    expect(persisted().services["home-assistant"].token).toBe(
      "secret-updated-after-prepare",
    );
  });

  it("refuses persistence if the pre-change audit fails", async () => {
    vi.spyOn(nova.audit, "record").mockImplementation(() => {
      throw new Error("fixture audit unavailable");
    });
    expect(
      (
        await request("put", "/home-assistant", {
          values: { token: "uncommitted-private" },
        })
      ).status,
    ).toBe(500);
    expect(fs.existsSync(path.join(directory, "services.json"))).toBe(false);
  });
  it("masks the Proxmox token ID as a secret in responses, history and audit", async () => {
    const response = await request("put", "/proxmox", {
      values: {
        tokenId: "private-user@realm!private-token",
        tokenSecret: "private-proxmox-secret",
      },
    });
    expect(response.status).toBe(200);
    const proxmox = response.body.services.find(
      (item: { id: string }) => item.id === "proxmox",
    );
    expect(
      proxmox.fields.find((field: { key: string }) => field.key === "tokenId"),
    ).toMatchObject({ kind: "secret", set: true });
    expect(
      proxmox.fields.find((field: { key: string }) => field.key === "tokenId"),
    ).not.toHaveProperty("value");
    const history = await request("get", "/history");
    expect(history.body.revisions[0].secretChanges.sort()).toEqual([
      "tokenId",
      "tokenSecret",
    ]);
    expect(
      JSON.stringify([
        response.body,
        history.body,
        nova.audits,
        persisted().history,
      ]),
    ).not.toMatch(/private-user|private-token|private-proxmox-secret/);
    await request("put", "/proxmox", { values: { tokenId: "" } });
    expect(persisted().services.proxmox.tokenId).toBe(
      "private-user@realm!private-token",
    );
    await request("put", "/proxmox", { values: {}, clearSecrets: ["tokenId"] });
    expect(persisted().services.proxmox.tokenId).toBe("");
  });

  it("rolls back only fields changed by an old revision, preserving unrelated newer edits", async () => {
    const config = nova.app.get(NovaConfig);
    await request("put", "/qdrant", {
      values: { url: "http://first-qdrant.invalid" },
    });
    const first = (await request("get", "/history")).body.revisions[0];
    await request("put", "/qdrant", {
      values: { collection: "new_collection" },
    });
    const rolled = nova.app.get(ServiceConnectionsStore).rollback(first.id);
    expect(rolled).toBeTruthy();
    const effective = nova.app.get(ServiceConnectionsStore).effective("qdrant");
    expect(effective.url).toBe(config.qdrantUrl);
    expect(effective.collection).toBe("new_collection");
  });

  it("rejects rollback when the same field was changed later", async () => {
    await request("put", "/qdrant", {
      values: { url: "http://first-qdrant.invalid" },
    });
    const first = (await request("get", "/history")).body.revisions[0];
    await request("put", "/qdrant", {
      values: { url: "http://second-qdrant.invalid" },
    });
    const before = fs.readFileSync(
      path.join(directory, "services.json"),
      "utf8",
    );
    expect(() =>
      nova.app.get(ServiceConnectionsStore).rollback(first.id),
    ).toThrow();
    expect(fs.readFileSync(path.join(directory, "services.json"), "utf8")).toBe(
      before,
    );
    expect(nova.app.get(ServiceConnectionsStore).effective("qdrant").url).toBe(
      "http://second-qdrant.invalid",
    );
  });

  it("preserves a legacy MQTT WebSocket query when no MQTT override was saved", async () => {
    vi.stubEnv("NOVA_DATA_DIR", directory);
    vi.stubEnv(
      "MQTT_URL",
      "wss://fixture.invalid/mqtt?auth=legacy-query-private",
    );
    const before = new NovaConfig();
    expect(before.mqttUrl).toBe(
      "wss://fixture.invalid/mqtt?auth=legacy-query-private",
    );
    await request("put", "/qdrant", {
      values: { collection: "unrelated_collection" },
    });
    const after = new NovaConfig();
    expect(after.mqttUrl).toBe(before.mqttUrl);
    expect(after.qdrantCollection).toBe("unrelated_collection");
  });

  it("returns saved state and an audit warning when only the final audit write fails", async () => {
    const original = AuditService.prototype.record.bind(nova.audit);
    vi.spyOn(nova.audit, "record").mockImplementation((record) => {
      if (record.phase !== "attempt")
        throw new Error("private-final-audit-detail");
      return original(record);
    });
    const result = await request("put", "/home-assistant", {
      values: { token: "saved-private-token" },
    });
    expect(result.status).toBe(200);
    expect(result.body.ok).toBe(true);
    expect(result.body.auditWarning).toEqual(expect.any(String));
    expect(result.body.auditWarning).not.toContain(
      "private-final-audit-detail",
    );
    expect(persisted().services["home-assistant"].token).toBe(
      "saved-private-token",
    );
    expect(
      home((await request("get")).body).fields.find(
        (field) => field.key === "token",
      )?.set,
    ).toBe(true);
    expect((await request("get", "/history")).body.revisions).toHaveLength(1);
    expect(JSON.stringify(result.body)).not.toContain("saved-private-token");
  });

  it("captures OmniRoute verification provenance before loading a saved endpoint override", async () => {
    vi.stubEnv("NOVA_DATA_DIR", directory);
    vi.stubEnv("OMNIROUTE_URL", "http://verified-fixture.invalid/v1");
    await request("put", "/omniroute", {
      values: { url: "http://changed-fixture.invalid/v1" },
    });
    const reboot = new NovaConfig();
    expect(reboot.omniUrl).toBe("http://changed-fixture.invalid/v1");
    expect(reboot.verifiedOmniUrl).toBe("http://verified-fixture.invalid/v1");
  });
});

describe("read-only connection probes", () => {
  it("shows bounded Qdrant collection metadata through the guarded route", async () => {
    const fake = await service((entry, response) => {
      if (entry.url === "/collections")
        json(response, 200, {
          result: { collections: [{ name: "nova_memory" }, { name: "other" }] },
        });
      else
        json(response, 200, {
          result: {
            points_count: 12,
            indexed_vectors_count: 10,
            segments_count: 2,
            disk_data_size: 4567,
            ram_data_size: 1234,
            status: "green",
            secret: "private-detail",
          },
        });
    });
    try {
      await request("put", "/qdrant", {
        values: {
          url: `http://127.0.0.1:${fake.port}`,
          apiKey: "private-qdrant-key",
        },
      });
      const result = await nova.api
        .get("/api/settings/services/qdrant/overview")
        .set(ADMIN);
      expect(result.status).toBe(200);
      expect(result.body).toMatchObject({
        ok: true,
        collections: [
          {
            name: "nova_memory",
            points: 12,
            indexedVectors: 10,
            segments: 2,
            diskBytes: 4567,
            ramBytes: 1234,
            status: "green",
          },
          {
            name: "other",
            points: 12,
            indexedVectors: 10,
            segments: 2,
            diskBytes: 4567,
            ramBytes: 1234,
            status: "green",
          },
        ],
      });
      expect(JSON.stringify(result.body)).not.toContain("private-detail");
      expect(JSON.stringify([result.body, nova.audits])).not.toContain(
        "private-qdrant-key",
      );
      expect(fake.seen).toHaveLength(3);
      expect(
        fake.seen.every(
          (request) => request.headers["api-key"] === "private-qdrant-key",
        ),
      ).toBe(true);
      expect(
        fake.seen.every(
          (request) => request.method === "GET" && request.body === "",
        ),
      ).toBe(true);
    } finally {
      fake.close();
    }
  });

  it("limits Qdrant detail reads to twenty safe collection names", async () => {
    const fake = await service((entry, response) => {
      if (entry.url === "/collections")
        json(response, 200, {
          result: {
            collections: [
              ...Array.from({ length: 20 }, (_, index) => ({
                name: `collection_${index}`,
              })),
              { name: "../credentials" },
            ],
          },
        });
      else json(response, 200, { result: { points_count: 0 } });
    });
    try {
      await request("put", "/qdrant", {
        values: { url: `http://127.0.0.1:${fake.port}` },
      });
      const result = await nova.api
        .get("/api/settings/services/qdrant/overview")
        .set(ADMIN);
      expect(result.status).toBe(200);
      expect(result.body.collections).toHaveLength(20);
      expect(
        result.body.collections.every(
          (item: { diskBytes: unknown; ramBytes: unknown }) =>
            item.diskBytes === null && item.ramBytes === null,
        ),
      ).toBe(true);
      expect(result.body.truncated).toBe(true);
      expect(fake.seen).toHaveLength(21);
      expect(
        fake.seen.some((request) => request.url?.includes("credentials")),
      ).toBe(false);
    } finally {
      fake.close();
    }
  });

  it.each([
    [
      "omniroute",
      "/v1/models",
      { apiKey: "probe-private" },
      "authorization",
      "Bearer probe-private",
    ],
    [
      "home-assistant",
      "/api/",
      { token: "probe-private" },
      "authorization",
      "Bearer probe-private",
    ],
    [
      "qdrant",
      "/collections",
      { apiKey: "probe-private" },
      "api-key",
      "probe-private",
    ],
    [
      "proxmox",
      "/api2/json/version",
      { tokenId: "user@realm!nova", tokenSecret: "probe-private" },
      "authorization",
      "PVEAPIToken=user@realm!nova=probe-private",
    ],
    [
      "windows",
      "/v1/status",
      { token: "probe-private" },
      "authorization",
      "Bearer probe-private",
    ],
    [
      "termix",
      "/users/me",
      { apiKey: "probe-private" },
      "authorization",
      "Bearer probe-private",
    ],
    [
      "pangolin",
      "/orgs",
      { apiKey: "probe-private", host: "fixture.example" },
      "authorization",
      "Bearer probe-private",
    ],
  ] as const)(
    "tests %s with bounded GET and secret-safe status",
    async (id, endpoint, credentials, header, expected) => {
      const fake = await service((_entry, response) =>
        json(response, 200, { token: "body-private", credentials }),
      );
      const base = `http://127.0.0.1:${fake.port}${id === "omniroute" ? "/v1" : ""}`;
      const bound =
        id === "omniroute"
          ? await createApp({
              env: {
                NOVA_DATA_DIR: directory,
                NOVA_ADMIN_PIN: "",
                OMNIROUTE_URL: base,
              },
            })
          : nova;
      try {
        const response = await bound.api
          .post(`/api/settings/services/${id}/test`)
          .set(ADMIN)
          .send({
            values: { url: base, ...credentials },
          });
        expect(response.status).toBe(200);
        expect(response.body).toMatchObject({ ok: true, status: 200 });
        expect(fake.seen).toHaveLength(1);
        expect(fake.seen[0]).toMatchObject({
          method: "GET",
          url: endpoint,
          body: "",
        });
        expect(fake.seen[0]!.headers[header]).toBe(expected);
        if (id === "pangolin")
          expect(fake.seen[0]!.headers.host).toBe("fixture.example");
        const status = await bound.api
          .get(`/api/settings/services/${id}/status`)
          .set(ADMIN);
        expect(status.body.test).toBeNull();
        expect(
          JSON.stringify([response.body, status.body, nova.audits]),
        ).not.toMatch(/probe-private|body-private/);
        expect(fs.existsSync(path.join(directory, "services.json"))).toBe(
          false,
        );
      } finally {
        if (bound !== nova) await bound.app.close();
        fake.close();
      }
    },
  );

  it("refuses an unverified OmniRoute probe before sending any credential", async () => {
    const fake = await service((_entry, response) => json(response, 200, {}));
    try {
      const unverified = `http://127.0.0.1:${fake.port}/v1`;
      const response = await request("post", "/omniroute/test", {
        values: { url: unverified, apiKey: "must-not-leak-private" },
      });
      expect(response.status).toBe(200);
      expect(response.body.ok).toBe(false);
      expect(fake.seen).toHaveLength(0);
      expect(JSON.stringify(response.body)).not.toContain(
        "must-not-leak-private",
      );
      const direct = await nova.app
        .get(ServiceConnectionsAdapter)
        .test("omniroute", { url: unverified, apiKey: "direct-private" });
      expect(direct.ok).toBe(false);
      expect(fake.seen).toHaveLength(0);
      expect(JSON.stringify(direct)).not.toContain("direct-private");
    } finally {
      fake.close();
    }
  });

  it("reports auth failures safely and does not follow redirects with credentials", async () => {
    const destination = await service((_entry, response) =>
      json(response, 200, {}),
    );
    const redirect = await service((_entry, response) => {
      response.writeHead(302, {
        location: `http://127.0.0.1:${destination.port}/private`,
      });
      response.end("private-error-body");
    });
    const denied = await service((_entry, response) =>
      json(response, 401, { secret: "private-error-body" }),
    );
    try {
      const bounced = await request("post", "/home-assistant/test", {
        values: {
          url: `http://127.0.0.1:${redirect.port}`,
          token: "redirect-private",
        },
      });
      expect(bounced.body).toMatchObject({ ok: false, status: 302 });
      expect(destination.seen).toHaveLength(0);
      const refused = await request("post", "/home-assistant/test", {
        values: { url: `http://127.0.0.1:${denied.port}` },
      });
      expect(refused.body).toMatchObject({ ok: false, status: 401 });
      expect(JSON.stringify([bounced.body, refused.body])).not.toMatch(
        /redirect-private|private-error-body/,
      );
    } finally {
      redirect.close();
      destination.close();
      denied.close();
    }
  });

  it("maps transport failures to safe results without persisting", async () => {
    const fake = await service((_entry, response) =>
      response.destroy(new Error("private-transport-detail")),
    );
    try {
      const result = await request("post", "/node-red/test", {
        values: { url: `http://127.0.0.1:${fake.port}` },
      });
      expect(result.body).toMatchObject({ ok: false });
      expect(JSON.stringify(result.body)).not.toContain(
        "private-transport-detail",
      );
      expect(fake.seen[0]?.url).toBe("/settings");
      expect(fs.existsSync(path.join(directory, "services.json"))).toBe(false);
    } finally {
      fake.close();
    }
  });

  it("tests Node-RED with a bounded read-only settings request", async () => {
    const fake = await service((_entry, response) =>
      json(response, 200, { credential: "private-response-body" }),
    );
    try {
      const result = await request("post", "/node-red/test", {
        values: {
          url: `http://127.0.0.1:${fake.port}`,
          adminToken: "test-node-red-token",
        },
      });
      expect(result.status).toBe(200);
      expect(result.body).toMatchObject({ ok: true, status: 200 });
      expect(fake.seen).toHaveLength(1);
      expect(fake.seen[0]).toMatchObject({
        method: "GET",
        url: "/settings",
        body: "",
        headers: { authorization: "Bearer test-node-red-token" },
      });
      expect(JSON.stringify([result.body, nova.audits])).not.toContain(
        "private-response-body",
      );
      expect(JSON.stringify([result.body, nova.audits])).not.toContain(
        "test-node-red-token",
      );
      expect(fs.existsSync(path.join(directory, "services.json"))).toBe(false);
    } finally {
      fake.close();
    }
  });

  it("checks MQTT once and closes without publishing or subscribing", async () => {
    const client = new EventEmitter();
    const end = vi.fn(),
      publish = vi.fn(),
      subscribe = vi.fn();
    Object.assign(client, { end, publish, subscribe });
    const connect = vi.spyOn(mqtt, "connect").mockImplementation(() => {
      queueMicrotask(() => {
        client.emit("connect");
        client.emit("close");
      });
      return client as unknown as ReturnType<typeof mqtt.connect>;
    });
    const adapter = nova.app.get(ServiceConnectionsAdapter);
    const result = await adapter.test("mqtt", {
      url: "mqtt://fixture.invalid",
      username: "fixture-user",
      password: "mqtt-private",
    });
    expect(result.ok).toBe(true);
    expect(connect).toHaveBeenCalledOnce();
    expect(connect).toHaveBeenCalledWith(
      "mqtt://fixture.invalid",
      expect.objectContaining({
        username: "fixture-user",
        password: "mqtt-private",
        reconnectPeriod: 0,
        clean: true,
        connectTimeout: 5000,
      }),
    );
    expect(end).toHaveBeenCalledExactlyOnceWith(true);
    expect(publish).not.toHaveBeenCalled();
    expect(subscribe).not.toHaveBeenCalled();
    const matchingStatus = adapter.status("mqtt", {
      url: "mqtt://fixture.invalid",
      username: "fixture-user",
      password: "mqtt-private",
    });
    expect(matchingStatus?.ok).toBe(true);
    expect(
      adapter.status("mqtt", {
        url: "mqtt://changed.invalid",
        username: "fixture-user",
        password: "mqtt-private",
      }),
    ).toBeNull();
    expect(JSON.stringify(matchingStatus)).not.toContain("mqtt-private");
  });
});
