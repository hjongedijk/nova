import { ForbiddenException, type ExecutionContext } from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { NovaConfig } from "../../src/core/config/nova-config.js";
import { SettingsGuard } from "../../src/settings/settings.guard.js";

const WINDOW_MS = 5 * 60 * 1000;

function fixture(pin = "4321") {
  let isPublic = false;
  const reflector = {
    get: () => isPublic,
  } as unknown as Reflector;
  const guard = new SettingsGuard({ adminPin: pin } as NovaConfig, reflector);
  const attempt = (
    supplied: string | undefined,
    ip: string | undefined = "192.0.2.1",
    method = "GET",
    admin: string | undefined = undefined,
    remoteAddress = "192.0.2.99",
  ) => {
    const response = {
      status: vi.fn().mockReturnThis(),
      json: vi.fn().mockReturnThis(),
      setHeader: vi.fn(),
    };
    const context = {
      getHandler: () => () => {},
      switchToHttp: () => ({
        getRequest: () => ({
          ip,
          method,
          socket: { remoteAddress },
          get: (name: string) => (name === "x-nova-pin" ? supplied : admin),
        }),
        getResponse: () => response,
      }),
    } as unknown as ExecutionContext;
    let allowed = false;
    let error: unknown;
    try {
      allowed = guard.canActivate(context);
    } catch (caught) {
      error = caught;
    }
    return { allowed, error, response };
  };
  return { guard, attempt, setPublic: () => (isPublic = true) };
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-10-09T12:00:00Z"));
});
afterEach(() => vi.useRealTimers());

describe("settings PIN attempts", () => {
  it("clears previous failures after a correct PIN", () => {
    const { attempt } = fixture();
    for (let i = 0; i < 4; i++)
      expect(attempt("wrong").response.status).toHaveBeenCalledWith(401);
    expect(attempt("4321").allowed).toBe(true);
    expect(attempt("wrong").response.status).toHaveBeenCalledWith(401);
  });

  it("blocks the fifth wrong attempt and rejects a correct PIN until expiry", () => {
    const { attempt } = fixture();
    for (let i = 0; i < 4; i++) attempt("wrong");
    const fifth = attempt("wrong");
    expect(fifth.error).toBeInstanceOf(ForbiddenException);
    expect(fifth.response.status).toHaveBeenCalledWith(429);
    expect(fifth.response.setHeader).toHaveBeenCalledWith("Retry-After", "300");
    expect(fifth.response.json).toHaveBeenCalledWith({
      error: "Te veel onjuiste PIN-pogingen. Probeer later opnieuw.",
      pinRequired: true,
      retryAfterSeconds: 300,
    });
    vi.advanceTimersByTime(1500);
    const blocked = attempt("4321");
    expect(blocked.allowed).toBe(false);
    expect(blocked.response.setHeader).toHaveBeenCalledWith(
      "Retry-After",
      "299",
    );
    vi.advanceTimersByTime(WINDOW_MS - 1500);
    expect(attempt("4321").allowed).toBe(true);
  });

  it("expires a partial failure window", () => {
    const { attempt } = fixture();
    for (let i = 0; i < 4; i++) attempt("wrong");
    vi.advanceTimersByTime(WINDOW_MS);
    expect(attempt("wrong").response.status).toHaveBeenCalledWith(401);
  });

  it("isolates clients and uses the remote address when the IP is unavailable", () => {
    const { attempt } = fixture();
    for (let i = 0; i < 5; i++) attempt("wrong", "");
    expect(attempt("4321", "").response.status).toHaveBeenCalledWith(429);
    expect(attempt("4321", "192.0.2.2").allowed).toBe(true);
    expect(attempt("4321", "", "GET", undefined, "192.0.2.100").allowed).toBe(
      true,
    );
  });

  it("does not count missing or empty PINs, and never throttles public routes", () => {
    const { attempt, setPublic } = fixture();
    for (let i = 0; i < 8; i++) {
      expect(attempt(undefined).response.status).toHaveBeenCalledWith(401);
      expect(attempt("").response.status).toHaveBeenCalledWith(401);
    }
    expect(attempt("4321").allowed).toBe(true);
    for (let i = 0; i < 5; i++) attempt("wrong");
    setPublic();
    expect(attempt(undefined).allowed).toBe(true);
  });

  it("preserves the admin-header requirement with and without a configured PIN", () => {
    const pinned = fixture();
    expect(pinned.attempt("4321", "192.0.2.1", "PUT").error).toBeInstanceOf(
      ForbiddenException,
    );
    expect(pinned.attempt("4321", "192.0.2.1", "PUT", "1").allowed).toBe(true);
    const open = fixture("");
    expect(open.attempt(undefined).allowed).toBe(true);
    expect(open.attempt(undefined, "192.0.2.1", "POST").error).toBeInstanceOf(
      ForbiddenException,
    );
    expect(open.attempt(undefined, "192.0.2.1", "POST", "1").allowed).toBe(
      true,
    );
  });

  it("bounds client storage and removes expired entries", () => {
    const { guard, attempt } = fixture();
    for (let i = 0; i < 1001; i++) attempt("wrong", `client-${i}`);
    const entries = (guard as unknown as { pinAttempts: Map<string, unknown> })
      .pinAttempts;
    expect(entries.size).toBe(1000);
    expect(entries.has("client-0")).toBe(false);
    vi.advanceTimersByTime(WINDOW_MS);
    attempt("wrong", "fresh-client");
    expect(entries.size).toBe(1);
  });
});
