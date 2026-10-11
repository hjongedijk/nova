import { describe, expect, it } from "vitest";
import { ApiError } from "./client.ts";
import { friendlyApiError } from "./error-copy.ts";

describe("API error copy", () => {
  it("maps known failures to short Dutch and English instructions", () => {
    expect(friendlyApiError("No verified free model", 503, "en")).toContain(
      "no verified free AI route",
    );
    expect(friendlyApiError("fetch failed", 0, "nl")).toContain(
      "gekoppelde dienst",
    );
    expect(friendlyApiError("payload", 409, "en")).toContain(
      "settings changed",
    );
  });

  it("hides unknown API diagnostics and detail strings", () => {
    const diagnostic = "private-stack.internal /srv/private/token=abc123";
    const error = new ApiError(diagnostic, 502, [diagnostic]);
    expect(error.message).not.toContain(diagnostic);
    expect(error.details).toBeUndefined();
    expect(friendlyApiError(diagnostic, 500, "en")).not.toContain(diagnostic);
  });
});
