import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { UpdatesService } from "../../src/settings/updates.service.js";
import { ADMIN, createApp, type TestApp } from "./helpers.js";

let nova: TestApp;
let directory: string;
let updates: UpdatesService;
const release = (extra: Record<string, unknown> = {}) => ({
  tag_name: "v0.1.12",
  draft: false,
  prerelease: false,
  body: "Release notes",
  published_at: "2026-10-10T10:00:00Z",
  ...extra,
});
const response = (data: unknown = release(), status = 200) => ({
  status,
  data,
  headers: {},
});

beforeEach(async () => {
  directory = fs.mkdtempSync(path.join(os.tmpdir(), "nova-updates-"));
  nova = await createApp({
    env: {
      NOVA_DATA_DIR: directory,
      NOVA_VERSION: "0.1.11",
      NOVA_ADMIN_PIN: "",
    },
  });
  updates = nova.app.get(UpdatesService);
  // Every test replaces the transport before calling the service or controller.
  vi.spyOn(updates, "request").mockResolvedValue(response());
});

afterEach(async () => {
  vi.restoreAllMocks();
  await nova.app.close();
  fs.rmSync(directory, { recursive: true, force: true });
});

describe("explicit release checks", () => {
  it("reads local status without contacting GitHub", async () => {
    expect((await nova.api.get("/api/settings/updates")).body).toEqual({
      running: "0.1.11",
      checkedAt: null,
      latest: null,
      updateAvailable: null,
    });
    expect(updates.request).not.toHaveBeenCalled();
  });

  it("exposes the running version on the public health endpoint", async () => {
    expect((await nova.api.get("/api/nova/health")).body.version).toBe(
      "0.1.11",
    );
  });

  it("uses only the fixed public release URL and bounded, credential-free options", async () => {
    const result = await nova.api
      .post("/api/settings/updates/check")
      .set(ADMIN)
      .send({ url: "https://attacker.invalid", token: "do-not-send" });
    expect(result.status).toBe(200);
    expect(result.body.updateAvailable).toBe(true);
    expect(updates.request).toHaveBeenCalledExactlyOnceWith(
      "https://api.github.com/repos/hjongedijk/nova/releases/latest",
      {
        headers: {
          accept: "application/vnd.github+json",
          "user-agent": "NOVA-update-check",
        },
        timeoutMs: 5000,
        signal: expect.any(AbortSignal),
      },
    );
    expect(JSON.stringify(vi.mocked(updates.request).mock.calls)).not.toContain(
      "do-not-send",
    );
  });

  it("shares concurrent checks and caches the result for five minutes", async () => {
    let now = Date.parse("2026-10-10T12:00:00Z");
    vi.spyOn(Date, "now").mockImplementation(() => now);
    let finish!: (value: ReturnType<typeof response>) => void;
    vi.mocked(updates.request).mockImplementationOnce(
      () => new Promise((resolve) => (finish = resolve)),
    );
    const first = updates.check();
    expect(updates.check()).toBe(first);
    expect(updates.request).toHaveBeenCalledTimes(1);
    finish(response());
    const initial = await first;
    now += 5 * 60 * 1000 - 1;
    expect(await updates.check()).toEqual(initial);
    expect(updates.request).toHaveBeenCalledTimes(1);
    now += 1;
    await updates.check();
    expect(updates.request).toHaveBeenCalledTimes(2);
  });

  it.each([
    ["v0.1.12", true],
    ["0.2.0", true],
    ["v1.0.0", true],
    ["v0.1.11", false],
    ["v0.1.9", false],
    ["v0.0.99", false],
  ])("compares release %s with the running version", async (tag, expected) => {
    vi.mocked(updates.request).mockResolvedValue(
      response(release({ tag_name: tag })),
    );
    expect((await updates.check()).updateAvailable).toBe(expected);
  });

  it("reports an unknown comparison for a development build", async () => {
    const development = await createApp({
      env: {
        NOVA_DATA_DIR: directory,
        NOVA_VERSION: "dev",
        NOVA_ADMIN_PIN: "",
      },
    });
    try {
      const service = development.app.get(UpdatesService);
      vi.spyOn(service, "request").mockResolvedValue(response());
      expect((await service.check()).updateAvailable).toBeNull();
    } finally {
      await development.app.close();
    }
  });

  it.each([
    null,
    release({ tag_name: "v0.2.0-beta.1" }),
    release({ tag_name: "v9999999.0.0" }),
    release({ tag_name: "../../private" }),
    release({ draft: true }),
    release({ prerelease: true }),
    release({ draft: undefined }),
    release({ prerelease: "false" }),
  ])("rejects invalid, draft or prerelease metadata: %j", async (metadata) => {
    vi.mocked(updates.request).mockResolvedValue(response(metadata));
    const result = await updates.check();
    expect(result.latest).toBeNull();
    expect(result.updateAvailable).toBeNull();
    expect(result.error).toMatch(/ongeldig antwoord/);
  });

  it("bounds notes and generates a trusted release URL instead of trusting upstream URLs", async () => {
    vi.mocked(updates.request).mockResolvedValue(
      response(
        release({
          body: "n".repeat(15000),
          html_url: "javascript:private-secret",
        }),
      ),
    );
    const result = await updates.check();
    expect(result.latest).toEqual({
      version: "v0.1.12",
      url: "https://github.com/hjongedijk/nova/releases/tag/v0.1.12",
      notes: "n".repeat(12000),
      publishedAt: "2026-10-10T10:00:00.000Z",
    });
    expect(JSON.stringify(result)).not.toContain("private-secret");
  });

  it("handles missing notes and invalid dates without reflecting their values", async () => {
    vi.mocked(updates.request).mockResolvedValue(
      response(
        release({
          body: { secret: "private-secret" },
          published_at: "private-secret",
        }),
      ),
    );
    const result = await updates.check();
    expect(result.latest?.notes).toBe("");
    expect(result.latest?.publishedAt).toBeNull();
    expect(JSON.stringify(result)).not.toContain("private-secret");
  });

  it.each([403, 429, 500, 302])(
    "handles HTTP %s without reflecting upstream errors or following redirects",
    async (status) => {
      vi.mocked(updates.request).mockResolvedValue({
        ...response({ message: "private-secret" }, status),
        headers: { location: "https://attacker.invalid/private-secret" },
      });
      const result = await updates.check();
      expect(result.error).toBeTruthy();
      expect(result.latest).toBeNull();
      expect(JSON.stringify(result)).not.toContain("private-secret");
      expect(updates.request).toHaveBeenCalledTimes(1);
      if (status === 403 || status === 429)
        expect(result.error).toMatch(/begrenst/);
    },
  );

  it("keeps the last valid release after a failed refresh and caches the failure", async () => {
    let now = Date.parse("2026-10-10T12:00:00Z");
    vi.spyOn(Date, "now").mockImplementation(() => now);
    const first = await updates.check();
    now += 5 * 60 * 1000;
    vi.mocked(updates.request).mockRejectedValue(
      new Error("network-private-secret"),
    );
    const failed = await updates.check();
    expect(failed.latest).toEqual(first.latest);
    expect(failed.checkedAt).not.toEqual(first.checkedAt);
    expect(failed.updateAvailable).toBe(true);
    expect(failed.error).toMatch(/niet bereikbaar/);
    expect(JSON.stringify(failed)).not.toContain("network-private-secret");
    expect(await updates.check()).toEqual(failed);
    expect(updates.request).toHaveBeenCalledTimes(2);
  });
});
