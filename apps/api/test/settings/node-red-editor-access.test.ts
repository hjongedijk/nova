import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Request, Response } from "express";
import {
  NODE_RED_EDITOR_PREFIX,
  NodeRedEditorAccess,
} from "../../src/settings/node-red-editor-access.service.js";

const TTL = 30 * 60 * 1000;
const ORIGIN = "https://nova.example";
const request = (
  headers: Record<string, string> = {},
  method = "GET",
): Request =>
  ({
    headers: { host: "nova.example", ...headers },
    socket: { remoteAddress: "127.0.0.1" },
    method,
  }) as Request;

function response() {
  const cookie = vi.fn();
  const clearCookie = vi.fn();
  return {
    cookie,
    clearCookie,
    value: { cookie, clearCookie } as unknown as Response,
  };
}

function fixture() {
  return { editor: new NodeRedEditorAccess() };
}

function open(
  editor: NodeRedEditorAccess,
  cookie?: string,
  upstreamAuth = true,
) {
  const res = response();
  const result = editor.open(
    request({ origin: ORIGIN, ...(cookie ? { cookie } : {}) }, "POST"),
    res.value,
    upstreamAuth,
  );
  const [name, token, options] = res.cookie.mock.calls[0]!;
  return {
    result,
    token: token as string,
    cookie: `${name}=${token}`,
    options,
  };
}

describe("Node-RED editor browser sessions", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-10-15T10:00:00Z"));
  });
  afterEach(() => vi.useRealTimers());

  it("mints a scoped HTTP-only capability without exposing it in JSON", () => {
    const { editor } = fixture();
    const session = open(editor);
    expect(session.token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(session.options).toEqual({
      httpOnly: true,
      secure: true,
      sameSite: "strict",
      path: NODE_RED_EDITOR_PREFIX,
      maxAge: TTL,
    });
    expect(session.result).toEqual({
      url: NODE_RED_EDITOR_PREFIX,
      expiresAt: "2026-10-15T10:30:00.000Z",
    });
    expect(JSON.stringify(session.result)).not.toContain(session.token);
    const authorized = editor.authorize(request({ cookie: session.cookie }));
    expect(authorized).toMatchObject({ origin: ORIGIN, upstreamAuth: true });
    expect(authorized?.key).toMatch(/^[a-f0-9]{64}$/);
    expect(authorized?.key).not.toBe(session.token);
  });

  it("reuses the browser capability while refreshing its TTL and auth metadata", () => {
    const { editor } = fixture();
    const first = open(editor);
    const key = editor.authorize(request({ cookie: first.cookie }))!.key;
    vi.advanceTimersByTime(TTL - 1000);
    const refreshed = open(editor, first.cookie, false);
    expect(refreshed.cookie).toBe(first.cookie);
    expect(editor.authorize(request({ cookie: first.cookie }))).toMatchObject({
      key,
      upstreamAuth: false,
    });
    vi.advanceTimersByTime(1001);
    expect(editor.authorize(request({ cookie: first.cookie }))).not.toBeNull();
    vi.advanceTimersByTime(TTL - 1001);
    expect(editor.authorize(request({ cookie: first.cookie }))).toBeNull();
    expect(open(editor, first.cookie).cookie).not.toBe(first.cookie);
  });

  it.each([
    "https://evil.example",
    "http://nova.example",
    "null",
    "https://nova.example/path",
    "https://nova.example/",
    "https://nova.example?x=1",
    "https://nova.example#x",
    "https://user:pass@nova.example",
    "file://nova.example",
    "not a URL",
  ])("rejects invalid session-mint origins: %s", (origin) => {
    const { editor } = fixture();
    const res = response();
    expect(() =>
      editor.open(request({ origin }, "POST"), res.value, true),
    ).toThrow("Ongeldige oorsprong");
    expect(res.cookie).not.toHaveBeenCalled();
  });

  it("requires an explicit origin and permits HTTP only on local development hosts", () => {
    const { editor } = fixture();
    expect(() =>
      editor.open(request({}, "POST"), response().value, true),
    ).toThrow();
    for (const host of ["localhost:3000", "127.0.0.1:3000"]) {
      const res = response();
      expect(
        editor.open(
          request({ host, origin: `http://${host}` }, "POST"),
          res.value,
          false,
        ).url,
      ).toBe(NODE_RED_EDITOR_PREFIX);
    }
    expect(() =>
      editor.open(
        request({ host: "dev.local", origin: "http://dev.local" }, "POST"),
        response().value,
        true,
      ),
    ).toThrow();
  });

  it("binds requests to the session host and origin including WebSocket upgrades", () => {
    const { editor } = fixture();
    const { cookie } = open(editor);
    const invalidHeaders: Record<string, string>[] = [
      { host: "evil.example" },
      { origin: "https://evil.example" },
      { origin: "null" },
      { origin: `${ORIGIN}/path` },
      { origin: "https://user@nova.example" },
      { "sec-fetch-site": "cross-site" },
      { "sec-fetch-site": "same-site" },
    ];
    for (const headers of invalidHeaders)
      expect(editor.authorize(request({ cookie, ...headers }))).toBeNull();
    expect(editor.authorize(request({ cookie }), true)).toBeNull();
    expect(
      editor.authorize(request({ cookie, origin: ORIGIN }), true),
    ).not.toBeNull();
    expect(
      editor.authorize(request({ cookie, "sec-fetch-site": "same-origin" })),
    ).not.toBeNull();
  });

  it.each(["POST", "PUT", "PATCH", "DELETE"])(
    "requires Origin for %s without relying on global unlock",
    (method) => {
      const { editor } = fixture();
      const { cookie } = open(editor);
      expect(editor.authorize(request({ cookie }, method))).toBeNull();
      expect(
        editor.authorize(request({ cookie, origin: ORIGIN }, method)),
      ).not.toBeNull();
    },
  );

  it("rejects duplicate cookies and never exposes mutable stored session metadata", () => {
    const { editor } = fixture();
    const { cookie } = open(editor);
    expect(
      editor.authorize(request({ cookie: `${cookie}; ${cookie}` })),
    ).toBeNull();
    const session = editor.authorize(request({ cookie }))!;
    session.upstreamAuth = false;
    expect(editor.authorize(request({ cookie }))?.upstreamAuth).toBe(true);
  });

  it("closes only its own session and rejects cross-origin logout", () => {
    const { editor } = fixture();
    const first = open(editor);
    const second = open(editor);
    const res = response();
    expect(() =>
      editor.close(
        request(
          { cookie: first.cookie, origin: "https://evil.example" },
          "POST",
        ),
        res.value,
      ),
    ).toThrow();
    expect(editor.authorize(request({ cookie: first.cookie }))).not.toBeNull();
    editor.close(
      request({ cookie: first.cookie, origin: ORIGIN }, "POST"),
      res.value,
    );
    expect(res.clearCookie).toHaveBeenCalledWith("nova_node_red_editor", {
      httpOnly: true,
      secure: true,
      sameSite: "strict",
      path: NODE_RED_EDITOR_PREFIX,
    });
    expect(editor.authorize(request({ cookie: first.cookie }))).toBeNull();
    expect(editor.authorize(request({ cookie: second.cookie }))).not.toBeNull();
  });

  it("bounds live sessions and prunes expiry before evicting a current session", () => {
    const { editor } = fixture();
    const first = open(editor);
    const rest = Array.from({ length: 63 }, () => open(editor));
    const refreshed = open(editor, first.cookie);
    const newest = open(editor);
    expect(editor.authorize(request({ cookie: rest[0]!.cookie }))).toBeNull();
    expect(
      editor.authorize(request({ cookie: refreshed.cookie })),
    ).not.toBeNull();
    expect(editor.authorize(request({ cookie: newest.cookie }))).not.toBeNull();
    vi.advanceTimersByTime(TTL - 1);
    const survivor = open(editor, first.cookie);
    vi.advanceTimersByTime(1);
    for (let index = 0; index < 63; index++) open(editor);
    expect(
      editor.authorize(request({ cookie: survivor.cookie })),
    ).not.toBeNull();
  });
});
