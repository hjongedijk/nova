import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { createRequire } from "node:module";

// Exercise the pinned gateway's real compiled sanitizer and content gate. No server,
// production data, credentials or provider connections are initialized.
const root = process.argv[2] || "/app";
const require = createRequire(import.meta.url);
const runtime = require(
  path.join(root, ".build/next/server/webpack-runtime.js"),
);
const chunks = path.join(root, ".build/next/server/chunks");
for (const file of fs.readdirSync(chunks)) {
  if (file.endsWith(".js")) runtime.C(require(path.join(chunks, file)));
}
const sanitize = runtime(997365).LM;
const valuable = runtime(927285).c2;
const format = runtime(124729).h.OPENAI;
const fragments = [19, ":", 53, ":", "07"];
const text = [];
for (const content of fragments) {
  const clean = sanitize({
    id: "fixture-numeric-stream",
    object: "chat.completion.chunk",
    choices: [{ index: 0, delta: { content }, finish_reason: null }],
  });
  assert.equal(valuable(clean, format), true);
  assert.equal(typeof clean.choices[0].delta.content, "string");
  text.push(clean.choices[0].delta.content);
}
assert.equal(text.join(""), "19:53:07");
for (const content of [0, -4, 2.5, "00", "Antwoord.", null, false, [], {}]) {
  const tool = {
    index: 0,
    id: "call_fixture",
    type: "function",
    function: { name: "fixture", arguments: "{}" },
  };
  const clean = sanitize({
    id: "fixture-metadata",
    object: "chat.completion.chunk",
    choices: [
      {
        index: 0,
        delta: { content, tool_calls: [tool] },
        finish_reason: "tool_calls",
      },
    ],
    usage: { prompt_tokens: 10, completion_tokens: 4, total_tokens: 14 },
  });
  assert.deepEqual(
    clean.choices[0].delta.content,
    typeof content === "number" ? String(content) : content,
  );
  assert.deepEqual(clean.choices[0].delta.tool_calls, [tool]);
  assert.equal(clean.choices[0].finish_reason, "tool_calls");
  assert.equal(clean.usage.total_tokens, 14);
}

// Do not mistake a repaired in-memory object for corrected bytes on the wire.
// Native passthrough normally forwards the original SSE line unchanged.
const scratch = fs.mkdtempSync(
  path.join(os.tmpdir(), "nova-gateway-stream-proof-"),
);
process.env.DATA_DIR = scratch;
try {
  // Route files define Node external-module adapters absent from shared chunks.
  // Register them without executing the route entry point or starting a server.
  const executeEntry = runtime.X;
  runtime.X = () => undefined;
  try {
    require(
      path.join(
        root,
        ".build/next/server/app/api/v1/chat/completions/route.js",
      ),
    );
  } finally {
    runtime.X = executeEntry;
  }
  const { l2: passthrough } = await runtime(820902);
  for (const values of [
    [19, ":", 53, ":", "07"],
    ["19", ":", "53", ":", "07"],
    [0, ":", 0, ":", "00"],
  ]) {
    const wire =
      values
        .map(
          (content) =>
            `data: ${JSON.stringify({
              id: "fixture-wire-content",
              object: "chat.completion.chunk",
              choices: [{ index: 0, delta: { content }, finish_reason: null }],
            })}\n\n`,
        )
        .join("") +
      'data: {"id":"fixture-wire-content","object":"chat.completion.chunk","choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n';
    const encode = new TextEncoder();
    const input = new ReadableStream({
      start(controller) {
        // Split protocol bytes inside a JSON field, independently of text-token boundaries.
        controller.enqueue(encode.encode(wire.slice(0, 31)));
        controller.enqueue(encode.encode(wire.slice(31)));
        controller.close();
      },
    });
    const transform = passthrough(
      "cloudflare-ai",
      null,
      null,
      "@cf/meta/llama-3.3-70b-instruct-fp8-fast",
      null,
      null,
      () => {},
      null,
      null,
      format,
    );
    const output = await new Response(input.pipeThrough(transform)).text();
    assert.ok(output.includes("data: [DONE]"));
    const visible = [];
    for (const line of output.split("\n")) {
      if (!line.startsWith("data:") || line.includes("[DONE]")) continue;
      const event = JSON.parse(line.slice(5));
      for (const choice of event.choices || []) {
        if (choice.delta?.content !== undefined) {
          assert.equal(typeof choice.delta.content, "string");
          visible.push(choice.delta.content);
        }
      }
    }
    assert.equal(visible.join(""), values.map(String).join(""));
  }
} finally {
  fs.rmSync(scratch, { recursive: true, force: true });
}
console.log(
  "Gateway numeric content, metadata and full SSE wire verification passed (17 cases; no provider connections or production data).",
);
