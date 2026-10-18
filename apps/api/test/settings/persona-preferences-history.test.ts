import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ADMIN, createApp, type TestApp } from "./helpers.js";
import { auditText, dbStat, historyRows } from "../helpers/nova-db.js";

describe("persona style and profile history", () => {
  let nova: TestApp;
  let directory: string;

  beforeEach(async () => {
    directory = fs.mkdtempSync(
      path.join(os.tmpdir(), "nova-persona-preferences-"),
    );
    nova = await createApp({
      env: { NOVA_DATA_DIR: directory, NOVA_ADMIN_PIN: "" },
    });
  });

  afterEach(async () => {
    await nova.app.close();
    fs.rmSync(directory, { recursive: true, force: true });
  });

  it("stores style/profile changes privately and restores only the matching snapshot", async () => {
    expect(
      (
        await nova.api
          .put("/api/settings/persona/style")
          .set(ADMIN)
          .send({ style: "playful" })
      ).status,
    ).toBe(200);
    expect(
      (
        await nova.api
          .put("/api/settings/persona/profile")
          .set(ADMIN)
          .send({
            profile: {
              name: "NOVA",
              character: "droog",
              address: "u",
              avoid: "overdrijven",
            },
          })
      ).status,
    ).toBe(200);

    const history = await nova.api
      .get("/api/settings/persona/preferences/history")
      .set(ADMIN);
    expect(history.body.revisions).toHaveLength(2);
    const profileRevision = history.body.revisions[0];
    const restoredProfile = await nova.api
      .post(
        `/api/settings/persona/preferences/history/${profileRevision.id}/rollback`,
      )
      .set(ADMIN)
      .send({});
    expect(restoredProfile.status).toBe(200);
    expect(restoredProfile.body.snapshot).toMatchObject({
      style: "playful",
      profile: { character: "warm, nieuwsgierig en met af en toe droge humor" },
    });

    const stale = await nova.api
      .post(
        `/api/settings/persona/preferences/history/${history.body.revisions[0].id}/rollback`,
      )
      .set(ADMIN)
      .send({});
    expect(stale.status).toBe(404);
    const styleRevision = history.body.revisions[1];
    const restoredStyle = await nova.api
      .post(
        `/api/settings/persona/preferences/history/${styleRevision.id}/rollback`,
      )
      .set(ADMIN)
      .send({});
    expect(restoredStyle.status).toBe(200);
    expect(restoredStyle.body.snapshot.style).toBe("friendly");

    const file = path.join(directory, "persona-preferences-history.json");
    expect(dbStat(file).mode & 0o777).toBe(0o600);
    const audit = auditText(directory);
    expect(audit).not.toContain("overdrijven");
    expect(audit).not.toContain("droog");
  });

  it("skips profile snapshots that contain redacted credential-shaped text", async () => {
    const secret = "profile-bearer-secret-value";
    const response = await nova.api
      .put("/api/settings/persona/profile")
      .set(ADMIN)
      .send({
        profile: {
          name: "NOVA",
          character: `Bearer ${secret}`,
          address: "je",
          avoid: "",
        },
      });
    expect(response.status).toBe(200);
    const history = await nova.api
      .get("/api/settings/persona/preferences/history")
      .set(ADMIN);
    expect(history.body.revisions).toHaveLength(0);
    const file = path.join(directory, "persona-preferences-history.json");
    expect(historyRows(file)).toEqual([]);
  });
});
