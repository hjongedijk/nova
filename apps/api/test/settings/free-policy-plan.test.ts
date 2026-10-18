import { describe, expect, it } from "vitest";
import { ValidationError } from "../../src/core/errors/validation.error.js";
import {
  buildFreePolicyPlan,
  type PlanAccount,
  type PlanModel,
} from "../../src/settings/free-policy-plan.js";

const first = "11111111-1111-4111-8111-111111111111";
const second = "22222222-2222-4222-8222-222222222222";
const account: PlanAccount = {
  id: first,
  provider: "provider-a",
  name: "Private account",
  active: true,
  authType: "apikey",
  credentialPresent: true,
  fingerprint: "a".repeat(64),
};
const model: PlanModel = {
  provider: "provider-a",
  modelId: "vendor/model:free",
  name: "Candidate",
  freeType: "recurring-daily",
  tos: "ok",
};
const selection = () => ({
  connectionId: first,
  modelId: model.modelId,
  officialSource: "https://provider.example/pricing",
});
const input = () => ({
  selection: [selection()],
});
const build = (
  value: unknown = input(),
  accounts = [account],
  models = [model],
  providers = ["provider-a", "provider-b"],
) => buildFreePolicyPlan(value, accounts, models, providers);

function rejected(value: unknown, accounts = [account], models = [model]) {
  expect(() => build(value, accounts, models)).toThrow(ValidationError);
  try {
    build(value, accounts, models);
  } catch (error) {
    expect((error as ValidationError).details).toHaveLength(1);
    expect((error as Error).message).not.toContain("private-token");
  }
}

describe("operator-attested free policy plan", () => {
  it("builds complete strict policy with account binding and leaves native eligibility unverified", () => {
    const result = build();
    expect(result).toEqual({
      route: "auto",
      status: "OK",
      nativeFreeAccessPolicy: "strict",
      enabledModels: ["provider-a/vendor/model:free"],
      verifiedProviders: ["provider-a"],
      verifiedConnectionIds: [first],
      verifiedConnections: [
        { id: first, provider: "provider-a", fingerprint: "a".repeat(64) },
      ],
      blockedProviders: ["provider-b"],
      nativeModelAllowlist: ["provider-a/vendor/model:free"],
      catalog: [
        {
          provider: "provider-a",
          modelId: "vendor/model:free",
          freeType: "recurring-daily",
          tos: "ok",
          billingVerified: true,
          hardStopGuaranteed: true,
          accountFreeVerified: true,
          evidenceSource: "operator-account",
          nativeAutoEligible: false,
          officialSource: "https://provider.example/pricing",
        },
      ],
      providers: [],
    });
  });

  it("sorts and deduplicates provider, model and connection sets deterministically", () => {
    const otherAccount = { ...account, id: second, provider: "provider-z" };
    const otherModel = { ...model, provider: "provider-z", modelId: "a-model" };
    const value = input();
    value.selection = [
      { ...selection(), connectionId: second, modelId: otherModel.modelId },
      selection(),
    ];
    const result = build(
      value,
      [otherAccount, account],
      [otherModel, model],
      ["blocked-z", "provider-z", "provider-a", "blocked-a", "blocked-z"],
    );
    expect(result.enabledModels).toEqual([
      "provider-a/vendor/model:free",
      "provider-z/a-model",
    ]);
    expect(result.verifiedProviders).toEqual(["provider-a", "provider-z"]);
    expect(result.verifiedConnectionIds).toEqual([first, second]);
    expect(result.blockedProviders).toEqual(["blocked-a", "blocked-z"]);
    expect(result.catalog.map(({ provider }) => provider)).toEqual([
      "provider-a",
      "provider-z",
    ]);
    expect(result.nativeModelAllowlist).toEqual(result.enabledModels);
    expect(result.nativeModelAllowlist).not.toBe(result.enabledModels);
  });

  it("allows several exact models on the same account and caution terms", () => {
    const another = { ...model, modelId: "other", tos: "caution" };
    const value = input();
    value.selection.push({ ...selection(), modelId: "other" });
    const result = build(value, [account], [model, another]);
    expect(result.verifiedConnections).toHaveLength(1);
    expect(result.catalog).toHaveLength(2);
    expect(
      result.catalog.every(
        ({ nativeAutoEligible }) => nativeAutoEligible === false,
      ),
    ).toBe(true);
  });

  it.each([
    null,
    [],
    "private-token",
    {},
    { ...input(), extra: "private-token" },
    { ...input(), selection: [] },
    { ...input(), selection: {} },
  ])("rejects invalid overall input: %j", (value) => rejected(value));
  it("rejects the removed acknowledgement fields", () => {
    rejected({ ...input(), acknowledgeBillingDisabled: true });
  });
  it("rejects more than twenty selections before constructing a plan", () =>
    rejected({ ...input(), selection: Array.from({ length: 21 }, selection) }));
  it.each([
    null,
    [],
    {},
    { ...selection(), extra: "private-token" },
    { ...selection(), modelId: "model?token=private-token" },
    { ...selection(), modelId: "x".repeat(201) },
    { ...selection(), modelId: "模型" },
    { ...selection(), connectionId: "connection-id" },
    { ...selection(), connectionId: "00000000-0000-0000-0000-000000000000" },
  ])("rejects malformed selection: %j", (value) =>
    rejected({ ...input(), selection: [value] }),
  );
  it("rejects duplicate canonical models", () =>
    rejected({ ...input(), selection: [selection(), selection()] }));
  it("rejects two accounts for one provider even when selecting different models", () => {
    const another = { ...model, modelId: "other-model" };
    rejected(
      {
        ...input(),
        selection: [
          selection(),
          { ...selection(), connectionId: second, modelId: another.modelId },
        ],
      },
      [account, { ...account, id: second }],
      [model, another],
    );
  });
  it.each([
    { active: false },
    { authType: "oauth" },
    { credentialPresent: false },
    { fingerprint: "" },
    { fingerprint: "a".repeat(63) },
    { fingerprint: "g".repeat(64) },
    { provider: "bad/provider" },
  ])("rejects unverifiable account attributes: %j", (attributes) =>
    rejected(input(), [{ ...account, ...attributes }]),
  );
  it("rejects absent or ambiguous account identities", () => {
    rejected(input(), []);
    rejected(input(), [account, { ...account }]);
  });
  it.each([
    "trial",
    "one-time-initial",
    "keyless",
    "discontinued",
    "",
    "recurring-",
    "recurring-private-token?",
  ])("rejects nonrecurring catalog types: %s", (freeType) =>
    rejected(input(), [account], [{ ...model, freeType }]),
  );
  it.each(["avoid", "ambiguous", "unknown", "", "unrecognized"])(
    "rejects unverified or prohibited terms: %s",
    (tos) => rejected(input(), [account], [{ ...model, tos }]),
  );
  it("rejects wrong provider, missing model and ambiguous catalog entries", () => {
    rejected(input(), [account], [{ ...model, provider: "provider-b" }]);
    rejected(input(), [account], []);
    rejected(input(), [account], [model, { ...model }]);
  });
  it.each([
    "http://provider.example/pricing",
    "data:text/plain,private-token",
    "file:///pricing",
    "https://user:private-token@provider.example/pricing",
    "https://provider.example/pricing?token=private-token",
    "https://provider.example/pricing#private-token",
    "https://provider.example/?",
    "https://provider.example/#",
    "https://localhost/pricing",
    "https://nova/pricing",
    "https://gateway.local/pricing",
    "https://127.0.0.1/pricing",
    "https://192.168.1.1/pricing",
    "https://[::1]/pricing",
    "https://provider.example/sk-abcdefghijklmno",
    " https://provider.example/pricing",
    "https://provider.example/" + "x".repeat(2048),
    "private-token",
    "",
  ])("rejects unsafe or secret-bearing source URL: %s", (officialSource) =>
    rejected({ ...input(), selection: [{ ...selection(), officialSource }] }),
  );
  it("normalizes source URLs without claiming automatic source verification", () => {
    const result = build({
      ...input(),
      selection: [
        { ...selection(), officialSource: "HTTPS://PROVIDER.EXAMPLE:443" },
      ],
    });
    expect(result.catalog[0]!.officialSource).toBe("https://provider.example/");
    expect(result.catalog[0]!.nativeAutoEligible).toBe(false);
    expect(result.catalog[0]!.evidenceSource).toBe("operator-account");
    expect(result.catalog[0]).not.toHaveProperty("nativeQuota");
  });
  it("never returns account labels, credentials or extra catalog payloads", () => {
    const result = build(
      input(),
      [
        {
          ...account,
          name: "private-token",
          apiKey: "private-token",
        } as PlanAccount,
      ],
      [
        {
          ...model,
          name: "private-token",
          secret: "private-token",
        } as PlanModel,
      ],
    );
    expect(JSON.stringify(result)).not.toContain("private-token");
    expect(result.providers).toEqual([]);
  });
  it("rejects an invalid known-provider inventory", () =>
    expect(() => build(input(), [account], [model], ["bad/provider"])).toThrow(
      ValidationError,
    ));
  it("does not mutate inputs or account/model metadata", () => {
    const value = input();
    const original = JSON.stringify({ value, account, model });
    build(value);
    expect(JSON.stringify({ value, account, model })).toBe(original);
  });
});
