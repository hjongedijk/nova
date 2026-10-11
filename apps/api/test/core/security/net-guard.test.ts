import dns from "node:dns";
import { describe, expect, it, vi } from "vitest";
import {
  assertPublicUrl,
  guardedLookup,
  isPrivateAddress,
} from "../../../src/core/security/net-guard.js";

describe("public outbound address guard", () => {
  it.each([
    "0.0.0.0",
    "10.0.0.1",
    "100.64.0.1",
    "127.0.0.1",
    "169.254.169.254",
    "172.16.0.1",
    "192.0.0.1",
    "192.0.2.1",
    "192.88.99.1",
    "192.168.1.1",
    "198.18.0.1",
    "198.51.100.1",
    "203.0.113.1",
    "224.0.0.1",
    "240.0.0.1",
    "::",
    "::1",
    "::ffff:192.168.1.1",
    "fc00::1",
    "fe80::1",
    "ff02::1",
    "2001::1",
    "2001:db8::1",
    "2002:c000:0201::1",
  ])("blocks non-public address %s", (address) => {
    expect(isPrivateAddress(address)).toBe(true);
  });

  it.each([
    "8.8.8.8",
    "1.1.1.1",
    "2001:4860:4860::8888",
    "2606:4700:4700::1111",
    "::ffff:8.8.8.8",
  ])("allows public address %s", (address) => {
    expect(isPrivateAddress(address)).toBe(false);
  });

  it.each([
    "ftp://example.com/file",
    "https://user:pass@example.com/",
    "https://localhost/",
    "https://api.local/",
    "http://10.0.0.5/",
    "https://example.com:8443/",
  ])("rejects unsafe outbound URL %s", (url) => {
    expect(() => assertPublicUrl(url)).toThrow();
  });

  it("accepts public HTTPS and standard HTTP targets", () => {
    expect(assertPublicUrl("https://example.com/path").hostname).toBe(
      "example.com",
    );
    expect(assertPublicUrl("http://example.com:80/path").protocol).toBe(
      "http:",
    );
  });

  it("fails closed when DNS returns both public and private addresses", async () => {
    const lookup = vi.spyOn(dns, "lookup").mockImplementation(((
      _hostname,
      _options,
      callback,
    ) => {
      const resolve = callback as unknown as (
        error: Error | null,
        addresses: dns.LookupAddress[],
      ) => void;
      resolve(null, [
        { address: "8.8.8.8", family: 4 },
        { address: "127.0.0.1", family: 4 },
      ]);
    }) as typeof dns.lookup);
    try {
      const guarded = guardedLookup as unknown as (
        hostname: string,
        options: dns.LookupOptions,
        callback: (
          error: Error | null,
          addresses?: dns.LookupAddress[],
        ) => void,
      ) => void;
      await expect(
        new Promise<void>((resolve, reject) =>
          guarded("example.com", { all: true }, (error) =>
            error ? reject(error) : resolve(),
          ),
        ),
      ).rejects.toThrow("Blocked: address is not public");
    } finally {
      lookup.mockRestore();
    }
  });
});
