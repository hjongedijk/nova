/* eslint-disable @typescript-eslint/no-unused-vars -- fixtures left from the removed confirmation flow */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { ConfirmationsService } from "../../src/confirmations/confirmations.service.js";
import { OmniRouteManagement } from "../../src/routing/omniroute-management.service.js";
import { createApp, type TestApp } from "./helpers.js";

let nova: TestApp;
let confirmations: ConfirmationsService;
let hidden = false;
let hiddenModelId = "gpt-fixture";
let patches = 0;
let sessionNumber = 0;
const session = () => `model-settings-${++sessionNumber}`;
const modelArgs = {
  provider: "openai",
  modelId: "gpt-fixture",
  hidden: true,
};

beforeAll(async () => {
  nova = await createApp({
    env: {
      JARVIS_ENABLE_ACTIONS: "false",
      JARVIS_EXTENSIONS: "true",
      OMNIROUTE_ADMIN_PASSWORD: "fixture-only",
    },
    llm: {
      complete: async () => {
        throw new Error("Unexpected LLM call");
      },
    },
  });
  confirmations = nova.app.get(ConfirmationsService);
  const management = nova.app.get(OmniRouteManagement);
  management.configure({
    fetcher: async (input, init) => {
      const url = new URL(String(input));
      if (url.pathname === "/api/auth/login")
        return new Response("{}", {
          headers: { "set-cookie": "auth_token=fixture; Path=/" },
        });
      if (url.pathname === "/api/provider-models" && init?.method === "PATCH") {
        patches++;
        hidden = (JSON.parse(String(init.body)) as { isHidden: boolean })
          .isHidden;
        hiddenModelId = url.searchParams.get("modelId") ?? "";
        return Response.json({ ok: true });
      }
      if (url.pathname === "/api/provider-models")
        return Response.json({
          models: [{ id: "gpt-fixture", modelId: "gpt-fixture" }],
          hiddenModelsByProvider: hidden ? { openai: [hiddenModelId] } : {},
        });
      if (url.pathname === "/api/models/catalog")
        return Response.json({
          catalog: {
            openai: {
              models: [{ id: "gpt-synced", name: "Synced model" }],
            },
          },
        });
      return new Response("{}", { status: 404 });
    },
  });
});

afterAll(() => nova.app.close());
beforeEach(() => {
  hidden = false;
  hiddenModelId = "gpt-fixture";
  patches = 0;
  nova.audits.length = 0;
});

describe("OmniRoute model visibility through chat", () => {
  it("offers model management with OmniRoute admin even when the legacy action flag is false", () => {
    expect(nova.tools.list()).toContainEqual(
      expect.objectContaining({
        name: "settings_model_visibility",
        enabled: true,
        risk: "READ_ONLY",
      }),
    );
  });

  it("reads catalog visibility without changing access or aliases", async () => {
    const result = await nova.tools.execute(
      "settings_model_visibility",
      { provider: "openai", modelId: "gpt-fixture" },
      session(),
    );
    expect(result).toMatchObject({
      ok: true,
      verified: true,
      result: { provider: "openai", modelId: "gpt-fixture", hidden: false },
    });
    expect(patches).toBe(0);
  });

  it("recognizes a synced catalog model alongside custom models", async () => {
    const result = await nova.tools.execute(
      "settings_model_visibility",
      { provider: "openai", modelId: "gpt-synced" },
      session(),
    );
    expect(result).toMatchObject({
      ok: true,
      verified: true,
      result: { provider: "openai", modelId: "gpt-synced", hidden: false },
    });
  });

  it("rejects unknown models without writing changes", async () => {
    const result = await nova.tools.execute(
      "settings_model_visibility",
      { provider: "openai", modelId: "not-in-catalog", hidden: true },
      session(),
    );
    expect(result).toMatchObject({ ok: false });
    expect(patches).toBe(0);
  });
});
