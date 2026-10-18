import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { NovaConfig } from "../../src/core/config/nova-config.js";
import { AuditService } from "../../src/core/audit/audit.service.js";
import { ManagedTargetsAccessStore } from "../../src/settings/managed-targets-access.store.js";
import { HomeAssistantService } from "../../src/home/home-assistant.service.js";
import { HomeAssistantAccessHistory } from "../../src/settings/home-assistant-access-history.service.js";
import { createApp, type TestApp } from "./helpers.js";
import { dbStat } from "../helpers/nova-db.js";

let nova: TestApp;
let directory: string;
const admin = { "x-nova-admin": "1" };
const allowlist = {
  mode: "allowlist",
  proxmoxNodeIds: [],
  proxmoxGuestIds: [],
  termixHostIds: [],
  pangolinSiteIds: [],
  pangolinResourceIds: [],
};

beforeAll(async () => {
  directory = fs.mkdtempSync(path.join(os.tmpdir(), "nova-target-history-"));
  nova = await createApp({ env: { NOVA_DATA_DIR: directory } });
});
afterAll(async () => {
  await nova.app.close();
  fs.rmSync(directory, { recursive: true, force: true });
});

describe("managed target access history", () => {
  it("keeps unexpected Home Assistant failures out of the settings response", async () => {
    const home = nova.app.get(HomeAssistantService);
    const sync = home.sync.bind(home);
    home.sync = async () => {
      throw new Error("private-host.local /data/private/ha-token.json");
    };
    try {
      const response = await nova.api
        .put("/api/settings/home-assistant/access")
        .set(admin)
        .send({ mode: "all", areaIds: [], deviceIds: [], entityIds: [] });
      expect(response.status).toBe(500);
      expect(response.body).toEqual({ error: "Dat is niet gelukt." });
    } finally {
      home.sync = sync;
    }
  });

  it("keeps unknown policy diagnostics private but preserves input errors", async () => {
    const home = nova.app.get(HomeAssistantService);
    const sync = home.sync.bind(home);
    const setAccessPolicy = home.setAccessPolicy.bind(home);
    home.sync = async () => home.entities;
    try {
      home.setAccessPolicy = () => {
        throw new Error("private-host.local /data/private/policy.json");
      };
      const failed = await nova.api
        .put("/api/settings/home-assistant/access")
        .set(admin)
        .send({ mode: "all", areaIds: [], deviceIds: [], entityIds: [] });
      expect(failed.status).toBe(500);
      expect(failed.body).toEqual({ error: "Dat is niet gelukt." });
      home.setAccessPolicy = setAccessPolicy;
      const invalid = await nova.api
        .put("/api/settings/home-assistant/access")
        .set(admin)
        .send({ mode: "unknown", areaIds: [], deviceIds: [], entityIds: [] });
      expect(invalid.status).toBe(400);
      expect(invalid.body.error).toBe("Ongeldige Home Assistant-toegang.");
    } finally {
      home.sync = sync;
      home.setAccessPolicy = setAccessPolicy;
    }
  });

  it("stores private bounded changes and restores in one rollback step", async () => {
    const changed = await nova.api
      .put("/api/settings/managed-targets/access")
      .set(admin)
      .send(allowlist);
    expect(changed.status).toBe(200);
    const history = await nova.api
      .get("/api/settings/managed-targets/access/history")
      .set(admin);
    expect(history.status).toBe(200);
    expect(history.body.revisions).toHaveLength(1);
    const revision = history.body.revisions[0];
    expect(revision).toMatchObject({
      before: { mode: "all" },
      after: allowlist,
    });
    const config = nova.app.get(NovaConfig);
    expect(
      dbStat(config.dataFile("managed-targets-access-history.json")).mode &
        0o777,
    ).toBe(0o600);

    const confirmed = await nova.api
      .post(
        `/api/settings/managed-targets/access/history/${revision.id}/rollback`,
      )
      .set(admin)
      .send({});
    expect(confirmed.status).toBe(200);
    expect(confirmed.body).toMatchObject({ ok: true, policy: { mode: "all" } });
    expect(nova.app.get(ManagedTargetsAccessStore).get().mode).toBe("all");
    expect(
      nova.audits.some(
        (row) =>
          row.tool === "managed_targets_access_rollback" &&
          row.phase === "verified",
      ),
    ).toBe(true);
  });

  it("rejects stale rollback after a later policy edit", async () => {
    await nova.api
      .put("/api/settings/managed-targets/access")
      .set(admin)
      .send(allowlist);
    const history = await nova.api
      .get("/api/settings/managed-targets/access/history")
      .set(admin);
    const original = history.body.revisions.find(
      (entry: { before: { mode: string }; after: { mode: string } }) =>
        entry.before.mode === "all" && entry.after.mode === "allowlist",
    );
    await nova.api
      .put("/api/settings/managed-targets/access")
      .set(admin)
      .send({ ...allowlist, mode: "all" });
    const rolled = await nova.api
      .post(
        `/api/settings/managed-targets/access/history/${original.id}/rollback`,
      )
      .set(admin)
      .send({});
    expect(rolled.status).toBe(404);
  });

  it("does not change access when the attempt audit cannot be written", async () => {
    await nova.api
      .put("/api/settings/managed-targets/access")
      .set(admin)
      .send(allowlist);
    const history = await nova.api
      .get("/api/settings/managed-targets/access/history")
      .set(admin);
    const revision = history.body.revisions.at(-1);
    const audit = nova.app.get(AuditService);
    const record = audit.record.bind(audit);
    audit.record = (() => {
      throw new Error("audit unavailable");
    }) as typeof audit.record;
    try {
      const result = await nova.api
        .post(
          `/api/settings/managed-targets/access/history/${revision.id}/rollback`,
        )
        .set(admin)
        .send({});
      expect(result.body).toMatchObject({ ok: false });
      expect(nova.app.get(ManagedTargetsAccessStore).get().mode).toBe(
        "allowlist",
      );
    } finally {
      audit.record = record;
    }
  });

  it("reports a committed rollback when only the final audit append fails", async () => {
    await nova.api
      .put("/api/settings/managed-targets/access")
      .set(admin)
      .send(allowlist);
    const history = await nova.api
      .get("/api/settings/managed-targets/access/history")
      .set(admin);
    const revision = history.body.revisions.at(-1);
    const audit = nova.app.get(AuditService);
    const record = audit.record.bind(audit);
    let calls = 0;
    audit.record = ((...args: Parameters<typeof audit.record>) => {
      calls++;
      if (calls === 2) throw new Error("outcome audit unavailable");
      return record(...args);
    }) as typeof audit.record;
    try {
      const result = await nova.api
        .post(
          `/api/settings/managed-targets/access/history/${revision.id}/rollback`,
        )
        .set(admin)
        .send({});
      expect(result.body).toMatchObject({
        ok: true,
        policy: { mode: "all" },
        auditWarning: expect.stringMatching(/uitgevoerd/),
      });
      expect(nova.app.get(ManagedTargetsAccessStore).get().mode).toBe("all");
    } finally {
      audit.record = record;
    }
  });

  it("keeps private Home Assistant access history and rolls back in one step after live validation", async () => {
    const home = nova.app.get(HomeAssistantService);
    home.areas = [{ area_id: "office", name: "Office" }];
    home.devices = [];
    home.entities = [];
    const sync = home.sync.bind(home);
    home.sync = async () => home.entities;
    home.setAccessPolicy({
      mode: "all",
      areaIds: [],
      deviceIds: [],
      entityIds: [],
    });
    try {
      const changed = await nova.api
        .put("/api/settings/home-assistant/access")
        .set(admin)
        .send({
          mode: "allowlist",
          areaIds: ["office"],
          deviceIds: [],
          entityIds: [],
        });
      expect(changed.status).toBe(200);
      const history = await nova.api
        .get("/api/settings/home-assistant/access/history")
        .set(admin);
      expect(history.body.revisions).toHaveLength(1);
      const config = nova.app.get(NovaConfig);
      expect(
        dbStat(config.dataFile("home-assistant-access-history.json")).mode &
          0o777,
      ).toBe(0o600);
      const revision = history.body.revisions[0];
      const restored = await nova.api
        .post(
          `/api/settings/home-assistant/access/history/${revision.id}/rollback`,
        )
        .set(admin)
        .send({});
      expect(restored.body).toMatchObject({
        ok: true,
        policy: { mode: "all" },
      });
      expect(
        nova.audits.some(
          (row) =>
            row.tool === "home_assistant_access_rollback" &&
            row.phase === "verified",
        ),
      ).toBe(true);
    } finally {
      home.sync = sync;
    }
  });

  it("rejects a Home Assistant policy edit made while rollback sync is pending", async () => {
    const home = nova.app.get(HomeAssistantService);
    home.areas = [
      { area_id: "office", name: "Office" },
      { area_id: "kitchen", name: "Kitchen" },
    ];
    home.devices = [];
    home.entities = [];
    home.setAccessPolicy({
      mode: "all",
      areaIds: [],
      deviceIds: [],
      entityIds: [],
    });
    const sync = home.sync.bind(home);
    home.sync = async () => home.entities;
    let releaseSync: (() => void) | undefined;
    try {
      await nova.api
        .put("/api/settings/home-assistant/access")
        .set(admin)
        .send({
          mode: "allowlist",
          areaIds: ["office"],
          deviceIds: [],
          entityIds: [],
        });
      const history = await nova.api
        .get("/api/settings/home-assistant/access/history")
        .set(admin);
      const revision = history.body.revisions[0];
      const historyService = nova.app.get(HomeAssistantAccessHistory);
      let signalSync!: () => void;
      const syncStarted = new Promise<void>(
        (resolve) => (signalSync = resolve),
      );
      const syncGate = new Promise<void>((resolve) => (releaseSync = resolve));
      home.sync = async () => {
        signalSync();
        await syncGate;
        return home.entities;
      };
      const responsePromise = historyService.rollback(revision.id);
      await syncStarted;
      home.setAccessPolicy({
        mode: "allowlist",
        areaIds: ["kitchen"],
        deviceIds: [],
        entityIds: [],
      });
      releaseSync?.();
      const result = await responsePromise;
      expect(result).toMatchObject({
        ok: false,
        error: expect.stringMatching(/gewijzigd/),
      });
      expect(home.accessPolicy().areaIds).toEqual(["kitchen"]);
    } finally {
      releaseSync?.();
      home.sync = sync;
    }
  });
});
