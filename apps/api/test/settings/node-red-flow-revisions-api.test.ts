import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { NodeRedManagement } from "../../src/settings/node-red-management.service.js";
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
});
