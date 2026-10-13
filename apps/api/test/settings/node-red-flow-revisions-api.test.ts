import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { NodeRedManagement } from "../../src/settings/node-red-management.service.js";
import { NodeRedFlowRevisions } from "../../src/settings/node-red-flow-revisions.service.js";
import { ADMIN, createApp } from "./helpers.js";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0))
    fs.rmSync(root, { recursive: true, force: true });
});

describe("Node-RED flow revision settings API", () => {
  it("keeps captured flows private behind the settings guard", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "nova-flow-api-"));
    roots.push(root);
    const app = await createApp({
      env: { NOVA_DATA_DIR: root, NOVA_ADMIN_PIN: "fixture-pin" },
    });
    const endpoint = "/api/settings/node-red/flow-revisions";
    const pin = { ...ADMIN, "x-nova-pin": "fixture-pin" };
    const snapshot = vi
      .spyOn(app.app.get(NodeRedManagement), "flowSnapshot")
      .mockResolvedValue({
        revision: "rev-1",
        flows: [{ id: "tab-a", type: "tab", label: "Private flow label" }],
      });
    try {
      expect((await app.api.get(endpoint).set(ADMIN)).status).toBe(401);
      expect(
        (
          await app.api
            .post(`${endpoint}/capture`)
            .set({ "x-nova-pin": "fixture-pin" })
            .send({})
        ).status,
      ).toBe(403);
      const captured = await app.api
        .post(`${endpoint}/capture`)
        .set(pin)
        .send({});
      expect(captured.status).toBe(200);
      expect(captured.body).toMatchObject({ nodeCount: 1 });
      expect(JSON.stringify(captured.body)).not.toContain("Private flow");
      const listed = await app.api.get(endpoint).set(pin);
      expect(listed.body.revisions).toHaveLength(1);
      expect(JSON.stringify(listed.body)).not.toContain("Private flow");
      expect(
        JSON.stringify(
          app.audits.filter((row) => row.tool === "node_red_flow_capture"),
        ),
      ).not.toContain("Private flow");
      snapshot.mockRejectedValueOnce(new Error("private upstream path"));
      const failed = await app.api
        .post(`${endpoint}/capture`)
        .set(pin)
        .send({});
      expect(failed.status).toBeGreaterThanOrEqual(400);
      expect(JSON.stringify(failed.body)).not.toContain(
        "private upstream path",
      );
      expect(
        (await app.api.get(endpoint).set(pin)).body.revisions,
      ).toHaveLength(1);
    } finally {
      await app.app.close();
    }
  });

  it("requires fresh DANGEROUS confirmation and refuses stale restore", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "nova-flow-restore-"));
    roots.push(root);
    const app = await createApp({
      env: {
        NOVA_DATA_DIR: root,
        NOVA_ADMIN_PIN: "fixture-pin",
        NODE_RED_ADMIN_TOKEN: "fixture-admin-token-01234567890123456789",
      },
    });
    const pin = { ...ADMIN, "x-nova-pin": "fixture-pin" };
    const history = app.app.get(NodeRedFlowRevisions);
    const old = history.record({
      revision: "rev-1",
      flows: [{ id: "tab-a", type: "tab", label: "Private old flow" }],
    });
    history.record({
      revision: "rev-2",
      flows: [{ id: "tab-b", type: "tab", label: "Private current flow" }],
    });
    let live = {
      revision: "rev-2",
      flows: [{ id: "tab-b", type: "tab", label: "Private current flow" }],
    };
    const management = app.app.get(NodeRedManagement);
    vi.spyOn(management, "flowSnapshot").mockImplementation(async () =>
      structuredClone(live),
    );
    const write = vi
      .spyOn(management, "writeFlowSnapshot")
      .mockImplementation(async (expected, flows) => {
        expect(expected).toBe("rev-2");
        live = {
          revision: "rev-3",
          flows: structuredClone(flows) as typeof live.flows,
        };
        return { ok: true, revision: "rev-3" };
      });
    const endpoint = `/api/settings/node-red/flow-revisions/${old.id}`;
    try {
      expect(
        (await app.api.post(`${endpoint}/prepare-restore`).set(ADMIN).send({}))
          .status,
      ).toBe(401);
      expect(
        (
          await app.api
            .post(`${endpoint}/prepare-restore`)
            .set({ "x-nova-pin": "fixture-pin" })
            .send({})
        ).status,
      ).toBe(403);
      const prepared = await app.api
        .post(`${endpoint}/prepare-restore`)
        .set(pin)
        .send({});
      expect(prepared.status).toBe(200);
      expect(prepared.body.action).toMatchObject({
        risk: "DANGEROUS",
        allowAlways: false,
      });
      expect(JSON.stringify(prepared.body)).not.toContain("Private");
      const action = prepared.body.action as {
        sessionId: string;
        confirmationId: string;
      };
      const cancelled = await app.api
        .post(`${endpoint}/confirm-restore`)
        .set(pin)
        .send({
          sessionId: action.sessionId,
          confirmationId: action.confirmationId,
          approve: false,
        });
      expect(cancelled.body).toMatchObject({ ok: true, cancelled: true });
      expect(write).not.toHaveBeenCalled();
      const reused = await app.api
        .post(`${endpoint}/confirm-restore`)
        .set(pin)
        .send({
          sessionId: action.sessionId,
          confirmationId: action.confirmationId,
          approve: true,
        });
      expect(reused.body).toMatchObject({ ok: false });

      const stale = await app.api
        .post(`${endpoint}/prepare-restore`)
        .set(pin)
        .send({});
      live.revision = "external-rev";
      const staleResult = await app.api
        .post(`${endpoint}/confirm-restore`)
        .set(pin)
        .send({
          sessionId: stale.body.action.sessionId,
          confirmationId: stale.body.action.confirmationId,
          approve: true,
        });
      expect(staleResult.status).toBe(409);
      expect(write).not.toHaveBeenCalled();
      live.revision = "rev-2";

      const fresh = await app.api
        .post(`${endpoint}/prepare-restore`)
        .set(pin)
        .send({});
      const restored = await app.api
        .post(`${endpoint}/confirm-restore`)
        .set(pin)
        .send({
          sessionId: fresh.body.action.sessionId,
          confirmationId: fresh.body.action.confirmationId,
          approve: true,
        });
      expect(restored.status).toBe(200);
      expect(restored.body).toMatchObject({
        ok: true,
        revision: { nodeCount: 1 },
      });
      expect(write).toHaveBeenCalledOnce();
      expect(history.list().revisions[0]?.id).toBe(restored.body.revision.id);
      expect(JSON.stringify(restored.body)).not.toContain("Private");
      expect(
        JSON.stringify(
          app.audits.filter((row) => row.tool === "node_red_flow_restore"),
        ),
      ).not.toContain("Private");
    } finally {
      await app.app.close();
    }
  });
});
