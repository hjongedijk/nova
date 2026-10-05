import { describe, expect, it } from "vitest";
import {
  classifyFreeAccess,
  type FreeCandidate,
} from "../../src/routing/free-access.js";

const recurring: FreeCandidate = {
  provider: "openrouter",
  modelId: "fixture/model:free",
  freeType: "recurring-daily",
  billingVerified: true,
  hardStopGuaranteed: true,
  nativeQuota: { status: "SAFE", fetchedAt: new Date().toISOString() },
};
const confirmed: FreeCandidate = {
  ...recurring,
  accountFreeVerified: true,
  nativeQuota: undefined,
};

describe("classifyFreeAccess", () => {
  it("admits only verified recurring free access", () => {
    expect(classifyFreeAccess(recurring).allowed).toBe(true);
    expect(classifyFreeAccess(confirmed).allowed).toBe(true);
    expect(
      classifyFreeAccess({
        provider: "aihorde",
        modelId: "fixture",
        freeType: "keyless",
        permanent: true,
        anonymous: true,
        officialSource: "https://aihorde.net",
      }).allowed,
    ).toBe(true);
  });

  it.each([
    { paid: true },
    { promotional: true },
    { billingVerified: false },
    { hardStopGuaranteed: false },
    { modelId: "openrouter/auto" },
    { nativeQuota: { status: "EXHAUSTED" } },
    { tos: "avoid" },
    { tos: "ambiguous" },
    { modelExcluded: true },
  ])("refuses a confirmed account when %j", (patch) => {
    expect(classifyFreeAccess({ ...confirmed, ...patch }).allowed).toBe(false);
  });

  it.each([
    { modelId: "openrouter/auto" },
    { modelId: "fixture/paid" },
    { paid: true },
    { freeType: "one-time-initial" },
    { promotional: true },
    { billingVerified: false },
    { hardStopGuaranteed: false },
    { nativeQuota: { status: "UNKNOWN" } },
    { nativeQuota: { status: "SAFE", fetchedAt: "2020-01-01" } },
    { local: true },
  ])("refuses an unconfirmed account when %j", (patch) => {
    expect(classifyFreeAccess({ ...recurring, ...patch }).allowed).toBe(false);
  });

  it("names the reason", () => {
    expect(classifyFreeAccess({ ...confirmed, paid: true })).toMatchObject({
      category: "PAID",
    });
    expect(classifyFreeAccess({ ...confirmed, local: true })).toMatchObject({
      category: "LOCAL_EXCLUDED",
    });
    expect(classifyFreeAccess({ provider: "x" }).category).toBe("UNKNOWN");
  });
});
