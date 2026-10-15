import { describe, expect, it } from "vitest";
import { nodeRedEditorRoute } from "../../src/settings/node-red-editor-policy.js";

describe("native Node-RED editor route policy", () => {
  it.each([
    "/%73ettings",
    "/%73ettings/user",
    "/settings/%75ser",
    "/%66lows",
    "/%6eodes",
    "/%6Eodes/node-red",
    "/context/%67lobal",
    "/context/%6eode/abc/key",
    "/nodes/%40scope/package",
    "/plugins/%40scope/package",
    "/%63redentials/http%20request/abc",
    "/%6cibrary/local/flows/entry.json",
    "/%69nject/abc",
    "/debug/abc/%65nable",
  ])(
    "rejects encoded literal route segments before adding private bearer: %s",
    (path) => {
      for (const method of ["GET", "POST", "PUT", "DELETE"]) {
        expect(nodeRedEditorRoute(path, method)).toBeNull();
      }
    },
  );

  it.each([
    "/settings",
    "/settings/user",
    "/flows",
    "/flow/abc.123-4_5",
    "/nodes",
    "/nodes/messages?lng=en-US",
    "/nodes/node-red",
    "/nodes/node-red/inject",
    "/nodes/node-red/inject/messages?lng=de",
    "/nodes/@scope/package",
    "/nodes/@scope/package/node",
    "/nodes/@scope/package/node/messages",
    "/plugins",
    "/plugins/messages?lng=en",
    "/plugins/@scope/package",
    "/plugins/@scope/package/config",
    "/icons",
    "/credentials/mqtt-broker/abc",
    "/credentials/http%20request/abc",
    "/context/global",
    "/context/global/key/nested",
    "/context/node/abc",
    "/context/flow/abc/key?store=memory",
    "/udp-ports/abc",
    "/library/local/flows",
    "/library/local/flows/",
    "/library/local/flows/folder/",
    "/library/local/flows/folder/caf%C3%A9%20flow.json",
  ])("allows GET %s with private upstream authentication", (path) => {
    expect(nodeRedEditorRoute(path, "GET")).toEqual({
      path,
      authenticated: true,
    });
  });

  it.each([
    ["POST", "/settings/user"],
    ["POST", "/flows"],
    ["POST", "/flow"],
    ["PUT", "/flow/abc"],
    ["DELETE", "/flow/abc"],
    ["DELETE", "/context/global/key"],
    ["DELETE", "/context/node/abc/key/nested"],
    ["POST", "/library/local/flows/folder/flow.json"],
    ["POST", "/inject/abc"],
    ["POST", "/debug/enable"],
    ["POST", "/debug/abc/disable"],
  ])("allows %s %s with private upstream authentication", (method, path) => {
    expect(nodeRedEditorRoute(path, method)).toEqual({
      path,
      authenticated: true,
    });
  });

  it.each([
    "/",
    "/favicon.ico",
    "/red/red.min.js?v=abc",
    "/vendor/jquery/jquery.min.js",
    "/types/node/index.d.ts",
    "/theme",
    "/theme/",
    "/theme/style.css",
    "/icons/node-red/inject.svg",
    "/icons/@scope/package/icon.svg",
    "/resources/@scope/package/caf%C3%A9%20icon.svg",
    "/locales/editor?lng=en-US",
    "/debug/view/view.html",
    "/debug/view/debug-utils.js",
    "/%72ed/red.min.js",
  ])(
    "serves GET/HEAD assets without injecting private credentials: %s",
    (path) => {
      for (const method of ["GET", "HEAD"]) {
        expect(nodeRedEditorRoute(path, method)).toEqual({
          path,
          authenticated: false,
        });
      }
      expect(nodeRedEditorRoute(path, "POST")).toBeNull();
    },
  );

  it.each([
    ["HEAD", "/settings"],
    ["POST", "/nodes"],
    ["PUT", "/nodes/node-red"],
    ["DELETE", "/nodes/@scope/package"],
    ["PUT", "/nodes/node-red/inject"],
    ["GET", "/projects"],
    ["POST", "/projects/demo"],
    ["GET", "/settings/user/keys"],
    ["GET", "/diagnostics"],
    ["GET", "/flows/state"],
    ["GET", "/auth/login"],
    ["POST", "/auth/token"],
    ["GET", "/comms"],
    ["GET", "/my-http-node"],
    ["POST", "/my-http-node"],
    ["POST", "/debug/anything"],
    ["GET", "/nodes/messages/extra/segments"],
    ["GET", "/nodes/node-red/inject/messages/extra"],
    ["GET", "/plugins/a/b/c"],
    ["DELETE", "/context/global"],
    ["DELETE", "/context/node/abc"],
    ["POST", "/library/local/flows"],
    ["POST", "/library/local/flows/"],
    ["GET", "/flow/abc/extra"],
    ["GET", "/settings/"],
    ["get", "/settings"],
    ["OPTIONS", "/flows"],
    ["TRACE", "/"],
    ["GET", `/flow/${"a".repeat(129)}`],
  ])("denies unsupported routes and methods: %s %s", (method, path) => {
    expect(nodeRedEditorRoute(path, method)).toBeNull();
  });

  it.each([
    "https://example.com/settings",
    "//example.com/settings",
    "settings",
    "",
    "/red/../settings",
    "/red/./red.js",
    "/red/%2e%2e/settings",
    "/red/%2E/red.js",
    "/red/%252e%252e/settings",
    "/red/%25252fsettings",
    "/red/%2fsettings",
    "/red/%5csettings",
    "/red/\\settings",
    "/red//settings",
    "/%2fexample.com",
    "/red/%",
    "/red/%FF",
    "/red/%00",
    "/red/%0d%0aHost:test",
    "/red/a\u007f",
    "/red/a#fragment",
    "/red/%3fsettings",
    "/red/%23fragment",
    "/red/a b",
    "/settings?x=%",
    "/settings?x=%0a",
    "/settings?x=\n",
    "/red/" + "a".repeat(8192),
  ])("denies malformed, ambiguous or smuggled paths: %s", (path) => {
    expect(nodeRedEditorRoute(path, "GET")).toBeNull();
  });

  it.each([
    "access_token",
    "ACCESS_TOKEN",
    "auth",
    "ToKeN",
    "authorization",
    "%61uth",
  ])("denies browser authentication query parameter %s", (name) => {
    expect(
      nodeRedEditorRoute(`/settings?lng=en&${name}=secret`, "GET"),
    ).toBeNull();
    expect(nodeRedEditorRoute(`/red/red.js?${name}=secret`, "GET")).toBeNull();
  });
});
