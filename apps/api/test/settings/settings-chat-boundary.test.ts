import http from "node:http";
import { afterEach, describe, expect, it, vi } from "vitest";
import { sendRequest } from "../../src/core/security/safe-request.js";
import { normalizeSkill } from "../../src/settings/skills/skills.js";
import { runSkill } from "../../src/settings/skills/run-skill.js";
import { webhook } from "./helpers.js";

afterEach(() => vi.restoreAllMocks());
describe("settings screen credentials cannot become webhook tools", () => {
  it.each(["x-nova-admin", "X-NOVA-ADMIN", "x-nova-pin", "X-Nova-Pin"])(
    "rejects new plain and secret %s headers",
    (name) => {
      for (const field of ["headers", "secretHeaders"]) {
        const input = webhook();
        input.http = {
          ...input.http,
          [field]: [{ name, value: "private-admin-secret" }],
        };
        expect(() => normalizeSkill(input)).toThrow(
          /kan niet worden ingesteld/,
        );
      }
    },
  );
  it.each(["x-nova-admin", "X-Nova-Pin", " x-nova-admin "])(
    "blocks imported/legacy %s before any connection",
    async (name) => {
      const network = vi.spyOn(http, "request").mockImplementation(() => {
        throw new Error("Network must not run");
      });
      await expect(
        sendRequest("https://public-nova.example/api/settings/services", {
          method: "PUT",
          headers: { [name]: "private-admin-secret" },
          body: "{}",
        }),
      ).rejects.toThrow(
        "NOVA-beheerheaders zijn alleen voor het instellingenscherm.",
      );
      expect(network).not.toHaveBeenCalled();
    },
  );
  it("keeps legacy stored skills blocked at runtime without exposing their credential", async () => {
    const network = vi.spyOn(http, "request").mockImplementation(() => {
      throw new Error("Network must not run");
    });
    const skill = normalizeSkill(webhook());
    if (skill.type !== "webhook") throw new Error("Expected webhook fixture");
    skill.http.secretHeaders.push({
      name: "x-nova-pin",
      value: "private-admin-secret",
    });
    const result = await runSkill(skill, { actie: "open" });
    expect(result).toMatchObject({
      ok: false,
      error: "NOVA-beheerheaders zijn alleen voor het instellingenscherm.",
    });
    expect(JSON.stringify(result)).not.toContain("private-admin-secret");
    expect(network).not.toHaveBeenCalled();
  });

  it("does not return unexpected request diagnostics from a stored skill", async () => {
    const skill = normalizeSkill(webhook());
    if (skill.type !== "webhook") throw new Error("Expected webhook fixture");
    skill.http.url = "https://[invalid-host?token=private-runtime-secret";
    const result = await runSkill(skill, { actie: "open" });
    expect(result).toMatchObject({
      ok: false,
      error: "De aanroep is mislukt. Controleer de verbinding en instellingen.",
    });
    expect(JSON.stringify(result)).not.toContain("private-runtime-secret");
  });
});
