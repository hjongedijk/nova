import { afterEach, describe, expect, it } from "vitest";
import { sanitize } from "../../../src/core/security/sanitize.js";

describe("sanitize prompt and persistence secrets", () => {
  const originalEnv = { ...process.env };
  afterEach(() => {
    process.env = { ...originalEnv };
  });

  it("redacts labelled secrets in plain text and JSON-shaped text", () => {
    expect(
      sanitize(
        'password: first-secret; {"api_key":"second-secret","client_secret":"third-secret"}',
      ),
    ).toBe(
      'password: [redacted]; {"api_key":"[redacted]","client_secret":"[redacted]"}',
    );
  });

  it("redacts configured secret values and sensitive object fields", () => {
    process.env.NOVA_TEST_PRIVATE_TOKEN = "configured-test-secret";
    expect(
      sanitize({
        prompt: "the value is configured-test-secret",
        authorization: "Bearer configured-test-secret",
        token: "configured-test-secret",
      }),
    ).toEqual({
      prompt: "the value is [redacted]",
    });
  });
});
