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

  it("redacts short configured credentials such as a short PIN", () => {
    process.env.NOVA_ADMIN_PIN = "123";
    expect(sanitize("configured PIN 123 used for a private action.")).toBe(
      "configured PIN [redacted] used for a private action.",
    );
  });
  it.each([
    [
      "https://user:password@example.com/path?view=day#part",
      "https://[redacted]@example.com/path?view=day#part",
    ],
    ["http://username@example.com", "http://[redacted]@example.com"],
    [
      "HTTPS://us%65r:p%40ss%3Aword@example.com:8443/a",
      "HTTPS://[redacted]@example.com:8443/a",
    ],
    [
      "https://account:first:second@[2001:db8::1]:8443/path",
      "https://[redacted]@[2001:db8::1]:8443/path",
    ],
    ["https://:private-value@example.com", "https://[redacted]@example.com"],
    [
      "https://first:private@extra@host.test/a",
      "https://[redacted]@host.test/a",
    ],
    ["https://account:private@", "https://[redacted]@"],
  ])("redacts unregistered HTTP URL userinfo: %s", (input, expected) => {
    expect(sanitize(input)).toBe(expected);
    expect(sanitize(expected)).toBe(expected);
  });

  it("preserves JSON, code and punctuation around credential spans and nearby URLs", () => {
    expect(
      sanitize('{"link":"https://admin:qwerty@test.com/a?mode=day"}'),
    ).toBe('{"link":"https://[redacted]@test.com/a?mode=day"}');
    expect(
      sanitize("fetch('https://user:private@example.com/a'); next();"),
    ).toBe("fetch('https://[redacted]@example.com/a'); next();");
    expect(
      sanitize(
        "(https://user:private@example.com),https://second:other@test.com/x!",
      ),
    ).toBe("(https://[redacted]@example.com),https://[redacted]@test.com/x!");
    expect(
      sanitize("https://public.test,https://user:private@other.test"),
    ).toBe("https://public.test,https://[redacted]@other.test");
  });

  it("preserves noncredential URLs, emails and surrounding ordinary code", () => {
    const input =
      "fetch('https://public.test/path');send('hello@example.com'); https://public.test/a@b?recipient=hello@example.com#hello@example.com";
    expect(sanitize(input)).toBe(input);
    expect(
      sanitize("https://public.test/a http://[2001:db8::1]/ hello@example.com"),
    ).toBe("https://public.test/a http://[2001:db8::1]/ hello@example.com");
  });

  it("redacts nested prompt/memory/log strings before returning object projections", () => {
    expect(
      sanitize({
        prompt: "open https://unregistered:private@host.test/path",
        logs: ["https://second:another@host.test"],
      }),
    ).toEqual({
      prompt: "open https://[redacted]@host.test/path",
      logs: ["https://[redacted]@host.test"],
    });
  });

  it("handles long and repeated malformed authorities without truncating later credentials", () => {
    const long = "a".repeat(100_000);
    expect(sanitize(`https://${long}:private@host.test/path`)).toBe(
      "https://[redacted]@host.test/path",
    );
    const noCredentials = `https://${long}/path`;
    expect(sanitize(noCredentials)).toBe(noCredentials);
    const prefix = "https://invalid/path ".repeat(5000);
    expect(sanitize(`${prefix}https://tail:private@last.test`)).toBe(
      `${prefix}https://[redacted]@last.test`,
    );
  });
});
