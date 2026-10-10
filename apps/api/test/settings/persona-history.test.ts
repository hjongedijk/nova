import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SettingsMutationsService } from "../../src/settings/settings-mutations.service.js";
import { ADMIN, createApp, type TestApp } from "./helpers.js";

describe("persona change history", () => {
  let nova: TestApp;
  let directory: string;

  beforeEach(async () => {
    directory = fs.mkdtempSync(path.join(os.tmpdir(), "nova-persona-history-"));
    nova = await createApp({
      env: { NOVA_DATA_DIR: directory, NOVA_ADMIN_PIN: "" },
    });
  });

  afterEach(async () => {
    await nova.app.close();
    fs.rmSync(directory, { recursive: true, force: true });
  });

  it("stores a private bounded revision and refuses stale rollback", async () => {
    const first = await nova.api
      .put("/api/settings/persona")
      .set(ADMIN)
      .send({ text: "Warm butler" });
    expect(first.status).toBe(200);
    const second = await nova.api
      .put("/api/settings/persona")
      .set(ADMIN)
      .send({ text: "Calm butler" });
    expect(second.status).toBe(200);

    const history = await nova.api
      .get("/api/settings/persona/history")
      .set(ADMIN);
    expect(history.body.revisions).toHaveLength(2);
    expect(history.body.revisions[0]).toMatchObject({
      before: "Warm butler",
      after: "Calm butler",
    });
    const revision = history.body.revisions[0];

    const stale = await nova.api
      .post(
        `/api/settings/persona/history/${history.body.revisions[1].id}/rollback`,
      )
      .set(ADMIN)
      .send({});
    expect(stale.status).toBe(404);
    expect((await nova.api.get("/api/settings").set(ADMIN)).body.persona).toBe(
      "Calm butler",
    );

    const rollback = await nova.api
      .post(`/api/settings/persona/history/${revision.id}/rollback`)
      .set(ADMIN)
      .send({});
    expect(rollback.status).toBe(200);
    expect(rollback.body).toMatchObject({ ok: true, persona: "Warm butler" });
    const updated = await nova.api
      .get("/api/settings/persona/history")
      .set(ADMIN);
    expect(updated.body.revisions[0].revertedFrom).toBe(revision.id);

    const historyFile = path.join(directory, "persona-history.json");
    expect(fs.statSync(historyFile).mode & 0o777).toBe(0o600);
    const audit = fs.readFileSync(
      path.join(directory, "actions.jsonl"),
      "utf8",
    );
    expect(audit).not.toContain("Warm butler");
    expect(audit).not.toContain("Calm butler");
  });

  it("records persona changes made through the confirmed chat mutation", async () => {
    const mutations = nova.app.get(SettingsMutationsService);
    mutations.setPersona("A warmer assistant", {
      sessionId: "fixture-session",
      confirmation: "confirmed_tool",
    });
    const history = await nova.api
      .get("/api/settings/persona/history")
      .set(ADMIN);
    expect(history.body.revisions[0]).toMatchObject({
      before: "",
      after: "A warmer assistant",
    });
  });

  it("redacts credential-shaped text from stored history", async () => {
    const secret = "this-is-a-private-bearer-token";
    const response = await nova.api
      .put("/api/settings/persona")
      .set(ADMIN)
      .send({ text: `Use Bearer ${secret} and password=hunter2.` });
    expect(response.status).toBe(200);
    const history = await nova.api
      .get("/api/settings/persona/history")
      .set(ADMIN);
    expect(history.body.revisions[0].after).toContain("[redacted]");
    const file = fs.readFileSync(
      path.join(directory, "persona-history.json"),
      "utf8",
    );
    expect(file).not.toContain(secret);
    expect(file).not.toContain("hunter2");
  });

  it("protects history reads with the PIN and rollbacks with the admin header", async () => {
    const pinnedDirectory = `${directory}-pinned`;
    const pinned = await createApp({
      env: { NOVA_DATA_DIR: pinnedDirectory, NOVA_ADMIN_PIN: "fixture-pin" },
    });
    try {
      expect(
        (await pinned.api.get("/api/settings/persona/history")).status,
      ).toBe(401);
      expect(
        (
          await pinned.api
            .get("/api/settings/persona/history")
            .set("x-nova-pin", "fixture-pin")
        ).status,
      ).toBe(200);
      expect(
        (
          await pinned.api
            .post(
              "/api/settings/persona/history/11111111-1111-4111-8111-111111111111/rollback",
            )
            .set("x-nova-pin", "fixture-pin")
            .send({})
        ).status,
      ).toBe(403);
    } finally {
      await pinned.app.close();
      fs.rmSync(pinnedDirectory, { recursive: true, force: true });
    }
  });
});
