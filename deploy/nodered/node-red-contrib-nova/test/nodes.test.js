"use strict";

const assert = require("node:assert/strict");
const { afterEach, describe, it } = require("node:test");

const savedFetch = global.fetch;
const savedApiUrl = process.env.NOVA_API_URL;
const savedEventToken = process.env.NODE_RED_EVENT_TOKEN;
const handlers = new Map();
let sent;
let errors;
let lastRequest;

function installFetch(responseFactory) {
  global.fetch = async (url, options) => {
    lastRequest = { url: String(url), options };
    return responseFactory(url, options);
  };
}

function nodeFor(type, config = {}) {
  let constructor;
  const RED = {
    nodes: {
      createNode(node) {
        node.id = "node.fixture-1";
        node.on = (event, callback) =>
          handlers.set(`${type}:${event}`, callback);
        node.send = (message) => {
          sent = message;
        };
        node.error = (error) => errors.push(String(error));
      },
      registerType(name, value) {
        if (name === type) constructor = value;
      },
    },
  };
  require(`../${type.replace("nova-", "")}`)(RED);
  assert.equal(typeof constructor, "function");
  new constructor(config);
  return handlers.get(`${type}:input`);
}

async function invoke(type, input, config = {}) {
  sent = undefined;
  errors = [];
  let doneError;
  await nodeFor(type, config)(
    input,
    (message) => (sent = message),
    (error) => {
      doneError = error;
    },
  );
  return { sent, errors, doneError };
}

afterEach(() => {
  global.fetch = savedFetch;
  if (savedApiUrl === undefined) delete process.env.NOVA_API_URL;
  else process.env.NOVA_API_URL = savedApiUrl;
  if (savedEventToken === undefined) delete process.env.NODE_RED_EVENT_TOKEN;
  else process.env.NODE_RED_EVENT_TOKEN = savedEventToken;
  handlers.clear();
});

describe("node-red-contrib-nova", () => {
  it("returns bounded MPEG audio from NOVA TTS", async () => {
    process.env.NOVA_API_URL = "http://nova:8080";
    const audio = Buffer.from("fake-mpeg");
    installFetch(async (_url, options) => {
      assert.equal(options.method, "POST");
      assert.deepEqual(JSON.parse(options.body), {
        text: "Hallo",
        voice: "nl",
      });
      return new Response(audio, {
        headers: { "content-type": "audio/mpeg" },
      });
    });
    const result = await invoke(
      "nova-say",
      { payload: "Hallo" },
      { voice: "nl" },
    );
    assert.equal(lastRequest.url, "http://nova:8080/api/tts");
    assert.deepEqual(result.sent.payload, audio);
    assert.deepEqual(result.sent.nova, {
      text: "Hallo",
      contentType: "audio/mpeg",
    });
    assert.deepEqual(result.errors, []);
  });

  it("asks through NOVA chat without accepting approval or routing overrides", async () => {
    installFetch(async (_url, options) => {
      const body = JSON.parse(options.body);
      assert.equal(body.sessionId, "nova_node_fixture-1");
      assert.equal(body.message, "Status?");
      assert.equal(body.confirmationId, undefined);
      assert.equal(body.confirmedTools, undefined);
      assert.equal(body.model, undefined);
      return Response.json({ reply: "Alles goed", action: { pending: true } });
    });
    const result = await invoke("nova-ask", {
      payload: "Status?",
      confirmationId: "cannot-pass-through",
      confirmedTools: ["anything"],
      model: "external",
    });
    assert.equal(lastRequest.url, "http://nova:8080/api/chat");
    assert.equal(result.sent.payload, "Alles goed");
    assert.deepEqual(result.sent.nova.action, { pending: true });
    assert.deepEqual(result.errors, []);
  });

  it("routes proactive asks through the token-protected read-only endpoint", async () => {
    process.env.NODE_RED_EVENT_TOKEN =
      "fixture-event-token-that-is-32-characters";
    installFetch(async (_url, options) => {
      assert.equal(
        options.headers.authorization,
        `Bearer ${process.env.NODE_RED_EVENT_TOKEN}`,
      );
      assert.deepEqual(JSON.parse(options.body), {
        sessionId: "nova_node_fixture-1",
        message: "Geef een briefing",
        inputMode: "text",
        modelRole: "summary",
        responseLanguage: "nl",
      });
      return Response.json({ reply: "Alles rustig" });
    });
    const result = await invoke(
      "nova-ask",
      { payload: "Geef een briefing" },
      { proactive: true },
    );
    assert.equal(lastRequest.url, "http://nova:8080/api/proactive/ask");
    assert.equal(result.sent.payload, "Alles rustig");
    assert.deepEqual(result.errors, []);
  });

  it("posts alerts using only the runtime event token", async () => {
    process.env.NODE_RED_EVENT_TOKEN =
      "fixture-event-token-that-is-32-characters";
    installFetch(async (_url, options) => {
      assert.equal(
        options.headers.authorization,
        `Bearer ${process.env.NODE_RED_EVENT_TOKEN}`,
      );
      assert.deepEqual(JSON.parse(options.body), {
        type: "alert",
        title: "Deur open",
        detail: "Hal",
        severity: "warning",
      });
      return Response.json({ accepted: true });
    });
    const result = await invoke("nova-notify", {
      payload: { title: "Deur open", detail: "Hal", severity: "warning" },
    });
    assert.equal(
      lastRequest.url,
      "http://nova:8080/api/integrations/node-red/events",
    );
    assert.deepEqual(result.sent.nova, { accepted: true });
    assert.deepEqual(result.errors, []);
  });

  it("preserves the explicit briefing category for scheduled summaries", async () => {
    process.env.NODE_RED_EVENT_TOKEN =
      "fixture-event-token-that-is-32-characters";
    installFetch(async (_url, options) => {
      assert.deepEqual(JSON.parse(options.body), {
        type: "alert",
        title: "Ochtendbriefing",
        detail: "Vandaag is het helder.",
        severity: "info",
        category: "briefing",
      });
      return Response.json({ accepted: true });
    });
    const result = await invoke("nova-notify", {
      payload: {
        title: "Ochtendbriefing",
        detail: "Vandaag is het helder.",
        severity: "info",
        category: "briefing",
      },
    });
    assert.deepEqual(result.errors, []);
  });

  it("records bounded runtime errors and rejects non-local API URLs", async () => {
    process.env.NODE_RED_EVENT_TOKEN =
      "fixture-event-token-that-is-32-characters";
    installFetch(async (_url, options) => {
      assert.deepEqual(JSON.parse(options.body), {
        type: "runtime_error",
        detail: "Flow failed",
        flowId: "flow-1",
      });
      return Response.json({ accepted: true });
    });
    const result = await invoke("nova-event", {
      payload: { detail: "Flow failed", flowId: "flow-1" },
    });
    assert.deepEqual(result.errors, []);

    process.env.NOVA_API_URL = "https://example.org";
    const blocked = await invoke("nova-ask", { payload: "status" });
    assert.equal(blocked.sent, undefined);
    assert.match(blocked.doneError.message, /local NOVA service/);
    assert.deepEqual(blocked.errors, []);
  });
});
