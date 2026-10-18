import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ADMIN, createApp, type TestApp } from "./helpers.js";

let nova: TestApp;
let directory: string;
beforeEach(async () => {
  directory = fs.mkdtempSync(path.join(os.tmpdir(), "nova-runtime-api-"));
  nova = await createApp({
    env: {
      NOVA_DATA_DIR: directory,
      NOVA_ADMIN_PIN: "",
      NOVA_STT_MODEL: "env-whisper",
      NTFY_TOKEN: "env-ntfy-token",
    },
  });
});
afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  await nova.app.close();
  fs.rmSync(directory, { recursive: true, force: true });
});

const get = () => nova.api.get("/api/settings/runtime").set(ADMIN);
const put = (id: string, body: object) =>
  nova.api.put(`/api/settings/runtime/${id}`).set(ADMIN).send(body);
const field = (
  body: { groups: { id: string; fields: Record<string, unknown>[] }[] },
  group: string,
  key: string,
) =>
  body.groups.find((g) => g.id === group)!.fields.find((f) => f.key === key)!;

describe("runtime settings", () => {
  it("shows the environment default and never returns secrets", async () => {
    const body = (await get()).body;
    expect(field(body, "stt", "model")).toMatchObject({
      source: "environment",
      value: "env-whisper",
    });
    const token = field(body, "ntfy", "token");
    expect(token).toMatchObject({ source: "environment", configured: true });
    expect(token).not.toHaveProperty("value");
    expect(JSON.stringify(body)).not.toContain("env-ntfy-token");
  });

  it("saves a value that wins immediately, then falls back on reset", async () => {
    const saved = await put("stt", { values: { model: "saved-whisper" } });
    expect(saved.status).toBe(200);
    expect(field(saved.body, "stt", "model")).toMatchObject({
      source: "settings",
      value: "saved-whisper",
    });
    expect(
      JSON.parse(
        fs.readFileSync(path.join(directory, "runtime-settings.json"), "utf8"),
      ).groups.stt.model,
    ).toBe("saved-whisper");
    const reset = await put("stt", { values: {}, reset: ["model"] });
    expect(field(reset.body, "stt", "model")).toMatchObject({
      source: "environment",
      value: "env-whisper",
    });
  });

  it("keeps a secret when the replacement is blank and hides it", async () => {
    await put("ntfy", { values: { token: "saved-secret-token", topic: "t" } });
    const again = await put("ntfy", { values: { token: "", topic: "t2" } });
    expect(JSON.stringify(again.body)).not.toContain("saved-secret-token");
    expect(
      JSON.parse(
        fs.readFileSync(path.join(directory, "runtime-settings.json"), "utf8"),
      ).groups.ntfy,
    ).toMatchObject({ token: "saved-secret-token", topic: "t2" });
  });

  it("rejects invalid input without echoing it", async () => {
    for (const [id, values] of [
      ["home", { latitude: "123" }],
      ["news", { feeds: "not json" }],
      ["ntfy", { url: "ftp://x" }],
      ["stt", { mode: "nonsense" }],
      ["stt", { unknown: "x" }],
    ] as const) {
      expect((await put(id, { values })).status).toBe(400);
    }
    expect((await put("nope", { values: {} })).status).toBe(400);
  });
});
