import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import { test } from "node:test";

const source = fs.readFileSync(
  new URL("../apps/web/static/sw.js", import.meta.url),
  "utf8",
);
for (const failCache of [false, true]) {
  test(`shell caching clones before page consumption; cache failure=${failCache}`, async () => {
    const listeners = {};
    let releaseCache;
    let stored;
    const cacheReady = new Promise((resolve) => {
      releaseCache = resolve;
    });
    vm.runInNewContext(source, {
      self: {
        addEventListener: (name, handler) => {
          listeners[name] = handler;
        },
      },
      URL,
      location: { origin: "https://nova.test" },
      fetch: async () => new Response("shell body"),
      caches: { open: () => cacheReady },
    });
    let response;
    const pending = [];
    listeners.fetch({
      request: { url: "https://nova.test/", method: "GET", mode: "navigate" },
      respondWith: (value) => {
        response = value;
      },
      waitUntil: (value) => pending.push(value),
    });
    assert.equal(await (await response).text(), "shell body");
    releaseCache({
      put: async (_request, copy) => {
        if (failCache) throw Error("quota");
        stored = await copy.text();
      },
    });
    await Promise.all(pending);
    assert.equal(stored, failCache ? undefined : "shell body");
  });
}
