import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ADMIN, createApp, type TestApp } from "./helpers.js";

describe("household profile switch history", () => {
  let nova: TestApp;
  let directory: string;
  const profiles = [
    {
      id: "harm",
      label: "Harm-private-label",
      personaProfile: {
        name: "NOVA",
        character: "Private character text",
        address: "je/jij",
        avoid: "private preference",
      },
      communicationPreferences: ["concise"],
    },
    {
      id: "sam",
      label: "Sam-private-label",
      personaProfile: {
        name: "NOVA",
        character: "Another private character",
        address: "u",
        avoid: "another private preference",
      },
      communicationPreferences: ["warmer"],
    },
  ];

  beforeEach(async () => {
    directory = fs.mkdtempSync(
      path.join(os.tmpdir(), "nova-household-history-"),
    );
    nova = await createApp({
      env: { NOVA_DATA_DIR: directory, NOVA_ADMIN_PIN: "" },
    });
    await nova.api
      .put("/api/settings/household-profiles")
      .set(ADMIN)
      .send({ profiles, activeProfileId: "harm" });
  });

  afterEach(async () => {
    await nova.app.close();
    fs.rmSync(directory, { recursive: true, force: true });
  });

  it("stores only profile IDs and restores the previous still-existing profile", async () => {
    await nova.api
      .put("/api/settings/household-profiles")
      .set(ADMIN)
      .send({ profiles, activeProfileId: "sam" });

    const response = await nova.api
      .get("/api/settings/household-profiles/history")
      .set(ADMIN);
    expect(response.status).toBe(200);
    expect(response.body.revisions).toHaveLength(1);
    const revision = response.body.revisions[0];
    expect(revision).toMatchObject({
      beforeProfileId: "harm",
      afterProfileId: "sam",
    });
    expect(Object.keys(revision).sort()).toEqual(
      ["id", "at", "beforeProfileId", "afterProfileId"].sort(),
    );
    const historyFile = path.join(directory, "household-profile-history.json");
    expect(fs.statSync(historyFile).mode & 0o777).toBe(0o600);
    const historyText = fs.readFileSync(historyFile, "utf8");
    expect(historyText).not.toContain("Harm-private-label");
    expect(historyText).not.toContain("Private character text");

    const restored = await nova.api
      .post(`/api/settings/household-profiles/history/${revision.id}/rollback`)
      .set(ADMIN)
      .send({});
    expect(restored.status).toBe(200);
    expect(restored.body.activeHouseholdProfileId).toBe("harm");
    const settings = await nova.api.get("/api/settings").set(ADMIN);
    expect(settings.body.activeHouseholdProfileId).toBe("harm");
    expect(settings.body.personaProfile).toEqual(profiles[0]!.personaProfile);
  });

  it("rejects rollback after the active profile changed again", async () => {
    await nova.api
      .put("/api/settings/household-profiles")
      .set(ADMIN)
      .send({ profiles, activeProfileId: "sam" });
    const history = await nova.api
      .get("/api/settings/household-profiles/history")
      .set(ADMIN);
    const revision = history.body.revisions[0];
    await nova.api
      .put("/api/settings/household-profiles")
      .set(ADMIN)
      .send({ profiles, activeProfileId: "harm" });

    const stale = await nova.api
      .post(`/api/settings/household-profiles/history/${revision.id}/rollback`)
      .set(ADMIN)
      .send({});
    expect(stale.status).toBe(404);
  });

  it("does not make an old switch reversible again after a profile cycle", async () => {
    await nova.api
      .put("/api/settings/household-profiles")
      .set(ADMIN)
      .send({ profiles, activeProfileId: "sam" });
    const firstHistory = await nova.api
      .get("/api/settings/household-profiles/history")
      .set(ADMIN);
    const firstRevision = firstHistory.body.revisions[0];

    await nova.api
      .put("/api/settings/household-profiles")
      .set(ADMIN)
      .send({ profiles, activeProfileId: "harm" });
    await nova.api
      .put("/api/settings/household-profiles")
      .set(ADMIN)
      .send({ profiles, activeProfileId: "sam" });

    const stale = await nova.api
      .post(
        `/api/settings/household-profiles/history/${firstRevision.id}/rollback`,
      )
      .set(ADMIN)
      .send({});
    expect(stale.status).toBe(404);
  });
});
