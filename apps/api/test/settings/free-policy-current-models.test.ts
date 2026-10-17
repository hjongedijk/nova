import { describe, expect, it } from "vitest";
import { withCurrentlyEnabled } from "../../src/settings/free-policy-wizard.service.js";

const listed = [
  {
    provider: "groq",
    modelId: "openai/gpt-oss-120b",
    name: "x",
    freeType: "recurring-daily",
    tos: "caution",
  },
];

describe("withCurrentlyEnabled", () => {
  it("keeps already-trusted models selectable and never duplicates listed ones", () => {
    const result = withCurrentlyEnabled(listed, {
      enabledModels: [
        "cloudflare-ai/@cf/meta/llama-3.3-70b-instruct-fp8-fast",
        "gemini/gemini-embedding-2",
        "groq/openai/gpt-oss-120b",
      ],
    });
    expect(result.map((m) => `${m.provider}/${m.modelId}`)).toEqual([
      "groq/openai/gpt-oss-120b",
      "cloudflare-ai/@cf/meta/llama-3.3-70b-instruct-fp8-fast",
      "gemini/gemini-embedding-2",
    ]);
  });

  it("ignores malformed entries and a missing list", () => {
    expect(withCurrentlyEnabled(listed, {})).toEqual(listed);
    expect(
      withCurrentlyEnabled(listed, {
        enabledModels: [42, "nodash", "/x", "p/bad model", "p/ok-model"],
      }).map((m) => `${m.provider}/${m.modelId}`),
    ).toEqual(["groq/openai/gpt-oss-120b", "p/ok-model"]);
  });
});

describe("model ids with an @ prefix", () => {
  it("can be selected in a free-policy plan", async () => {
    const { buildFreePolicyPlan } =
      await import("../../src/settings/free-policy-plan.js");
    const account = {
      id: "3a9ba78a-6980-4f51-999e-50ba699103cc",
      provider: "cloudflare-ai",
      name: "x",
      active: true,
      authType: "apikey",
      credentialPresent: true,
      fingerprint: "f".repeat(64),
    };
    const plan = buildFreePolicyPlan(
      {
        selection: [
          {
            connectionId: account.id,
            modelId: "@cf/meta/llama-3.3-70b-instruct-fp8-fast",
            officialSource:
              "https://developers.cloudflare.com/workers-ai/platform/pricing/",
          },
        ],
        acknowledgeBillingDisabled: true,
        acknowledgeHardStop: true,
        acknowledgeTerms: true,
        acknowledgeAllClients: true,
        acknowledgeQuotaRefresh: true,
      },
      [account],
      [
        {
          provider: "cloudflare-ai",
          modelId: "@cf/meta/llama-3.3-70b-instruct-fp8-fast",
          name: "x",
          freeType: "recurring-daily",
          tos: "caution",
        },
      ],
      ["cloudflare-ai"],
    );
    expect(plan.enabledModels).toEqual([
      "cloudflare-ai/@cf/meta/llama-3.3-70b-instruct-fp8-fast",
    ]);
  });
});
