"use strict";
const assert = require("node:assert/strict");
const { afterEach, test } = require("node:test");
const { request } = require("../shared");
const original = {
  fetch: global.fetch,
  token: process.env.NOVA_APP_TOKEN,
  url: process.env.NOVA_API_URL,
};
afterEach(() => {
  global.fetch = original.fetch;
  for (const [key, value] of [
    ["NOVA_APP_TOKEN", original.token],
    ["NOVA_API_URL", original.url],
  ]) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});
function loginResponse(char = "a") {
  return new Response("{}", {
    headers: {
      "set-cookie": `nova_access=${char.repeat(43)}; Path=/api; HttpOnly; Secure; SameSite=Strict`,
    },
  });
}
test("private app login is shared and only its cookie reaches normal node requests", async () => {
  process.env.NOVA_APP_TOKEN = "fixture-app-one";
  process.env.NOVA_API_URL = "http://nova:8080";
  let logins = 0;
  let posts = 0;
  global.fetch = async (url, options) => {
    if (url.endsWith("/access/unlock")) {
      logins++;
      assert.deepEqual(JSON.parse(options.body), { token: "fixture-app-one" });
      return loginResponse();
    }
    posts++;
    assert.equal(options.headers.cookie, `nova_access=${"a".repeat(43)}`);
    assert.equal(options.headers.origin, "https://nova:8080");
    assert.equal(options.headers.authorization, undefined);
    assert.equal(options.body.includes("fixture-app-one"), false);
    return Response.json({ reply: "ok" });
  };
  await Promise.all([
    request("/api/chat", { message: "Status" }),
    request("/api/tts", { text: "Hallo" }),
  ]);
  assert.equal(logins, 1);
  assert.equal(posts, 2);
});
test("renews after a marked guard rejection but never replays other failures", async () => {
  process.env.NOVA_APP_TOKEN = "fixture-app-two";
  let logins = 0;
  let posts = 0;
  global.fetch = async (url) => {
    if (url.endsWith("/access/unlock"))
      return loginResponse(++logins === 1 ? "b" : "c");
    posts++;
    if (posts === 1)
      return new Response("{}", {
        status: 403,
        headers: { "x-nova-app-access": "required" },
      });
    return Response.json({ reply: "ok" });
  };
  assert.deepEqual(await request("/api/chat", { message: "Status" }), {
    reply: "ok",
  });
  assert.equal(logins, 2);
  assert.equal(posts, 2);
  posts = 0;
  global.fetch = async () => {
    posts++;
    return new Response("{}", { status: 403 });
  };
  await assert.rejects(request("/api/chat", { message: "Status" }), /HTTP 403/);
  assert.equal(posts, 1);
  posts = 0;
  global.fetch = async () => {
    posts++;
    throw new Error("connection ended");
  };
  await assert.rejects(
    request("/api/chat", { message: "Status" }),
    /connection ended/,
  );
  assert.equal(posts, 1);
});
test("proactive and event bearer calls never exchange the broader app token", async () => {
  process.env.NOVA_APP_TOKEN = "fixture-app-three";
  let calls = 0;
  global.fetch = async (url, options) => {
    calls++;
    assert.equal(url.endsWith("/access/unlock"), false);
    assert.equal(options.headers.authorization, "Bearer event-only");
    assert.equal(options.headers.cookie, undefined);
    return Response.json({ ok: true });
  };
  await request(
    "/api/proactive/ask",
    { message: "Status" },
    { token: "event-only" },
  );
  assert.equal(calls, 1);
});
test("failed unlock does not dispatch the requested action or disclose the app token", async () => {
  process.env.NOVA_APP_TOKEN = "fixture-app-four";
  let calls = 0;
  global.fetch = async () => {
    calls++;
    return new Response("{}", { status: 401 });
  };
  await assert.rejects(
    request("/api/chat", { message: "Status" }),
    (error) =>
      !error.message.includes("fixture-app-four") &&
      /app access/.test(error.message),
  );
  assert.equal(calls, 1);
});
