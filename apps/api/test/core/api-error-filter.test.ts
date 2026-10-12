import type { ArgumentsHost } from "@nestjs/common";
import { describe, expect, it, vi } from "vitest";
import { ApiErrorFilter } from "../../src/core/errors/validation.error.js";

describe("ApiErrorFilter", () => {
  it("keeps unknown diagnostics out of unexpected-error logs and responses", () => {
    const secret = "fixture-secret-value-that-must-not-leak";
    process.env.NOVA_TEST_SECRET = secret;
    try {
      const filter = new ApiErrorFilter();
      const logged = vi
        .spyOn(Reflect.get(filter, "log"), "error")
        .mockImplementation(() => undefined);
      const json = vi.fn();
      const status = vi.fn(() => ({ json }));
      const host = {
        switchToHttp: () => ({
          getResponse: () => ({ headersSent: false, status }),
        }),
      } as unknown as ArgumentsHost;

      filter.catch(
        new Error(`private-host.local /data/private/ha-token.json ${secret}`),
        host,
      );

      expect(status).toHaveBeenCalledWith(500);
      expect(json).toHaveBeenCalledWith({ error: "Dat is niet gelukt." });
      expect(logged).toHaveBeenCalledWith("Unexpected API error");
    } finally {
      delete process.env.NOVA_TEST_SECRET;
    }
  });
});
