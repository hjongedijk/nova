import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import {
  parseArguments,
  parseCases,
  modelAttribution,
  runEvaluation,
  writeCheckpoint,
} from "./evaluate-code-models.mjs";

const cases = parseCases(
  fs.readFileSync(
    new URL("../docs/code-evaluation.md", import.meta.url),
    "utf8",
  ),
);
const answer = (model, content = "fixture answer") => ({
  model,
  assistant: { role: "assistant", content },
  metadata: { fallback: null },
});
function fixture(overrides = {}) {
  const checkpoints = [],
    calls = [],
    closes = [];
  return {
    models: ["free/a", "free/b"],
    cases,
    output: "unused",
    prompt: ["fixture prompt"],
    hashes: {},
    liveGate: () => {},
    checkpoint: (_output, report) => checkpoints.push(structuredClone(report)),
    createRunner: (model) => ({
      call: async (messages, options) => {
        calls.push({ model, messages, options });
        return answer(model);
      },
      close: () => closes.push(model),
    }),
    checkpoints,
    calls,
    closes,
    ...overrides,
  };
}

test("parses exactly ten frozen cases and requires explicit bounded run arguments", () => {
  assert.equal(cases.length, 10);
  assert.match(cases[0].task, /clamp/);
  assert.match(cases[9].acceptance, /race/);
  assert.throws(() => parseCases("| C01 | Code | task | check |"));
  assert.deepEqual(parseArguments(["--help"]), { help: true });
  assert.throws(() => parseArguments([]));
  assert.throws(() =>
    parseArguments(["--run", "--models=free/a,free/a", "--output=x"]),
  );
  assert.throws(() =>
    parseArguments(["--run", "--models=https://private", "--output=x"]),
  );
  assert.equal(
    parseArguments(["--run", "--models=free/a,free/b", "--output=x"]).models
      .length,
    2,
  );
});

test("runs each model's identical isolated cases with no tools and checkpoints every result", async () => {
  const f = fixture();
  const report = await runEvaluation(f);
  assert.equal(report.complete, true);
  assert.equal(f.calls.length, 20);
  assert.deepEqual(
    f.calls.map((call) => call.model),
    [...Array(10).fill("free/a"), ...Array(10).fill("free/b")],
  );
  assert.equal(f.checkpoints.length, 22);
  assert.equal(f.checkpoints[1].results.length, 1);
  assert.equal(f.checkpoints[20].results.length, 20);
  assert.deepEqual(f.closes, ["free/a", "free/b"]);
  for (const call of f.calls) {
    assert.deepEqual(call.options.tools, []);
    assert.equal(call.options.maxTokens, 1800);
    assert.equal(call.options.temperature, 0);
    assert.equal(call.options.roleModel.modelId, call.model);
  }
  assert.deepEqual(f.calls[0].messages, f.calls[10].messages);
});

test("attributes exact gateway-native suffixes without confusing Cloudflare path segments", async () => {
  for (const model of [
    "gemini/gemini-3.1-flash-lite",
    "cloudflare-ai/@cf/meta/llama-3.3-70b-instruct-fp8-fast",
  ]) {
    const separator = model.indexOf("/");
    const raw = model.slice(separator + 1);
    const provider = model.slice(0, separator);
    for (const reportedProvider of [undefined, provider]) {
      const f = fixture({
        models: [model],
        createRunner: () => ({
          call: async () => ({
            ...answer(raw),
            metadata: { provider: reportedProvider },
          }),
        }),
      });
      const report = await runEvaluation(f);
      assert.equal(report.results[0].error, null);
      assert.equal(report.results[0].actualModel, model);
      assert.equal(report.results[0].rawActualModel, raw);
      assert.equal(report.results[0].actualProvider, reportedProvider ?? null);
    }
    assert.equal(modelAttribution(model, answer(model)).matched, true);
    assert.equal(
      modelAttribution(model, answer(raw + "-preview")).matched,
      false,
    );
    assert.equal(
      modelAttribution(model, answer(raw.slice(raw.lastIndexOf("/") + 1)))
        .matched,
      !raw.includes("/"),
    );
    assert.equal(
      modelAttribution(model, {
        ...answer(raw),
        metadata: { provider: "unrelated-provider" },
      }).matched,
      false,
    );
    assert.equal(
      modelAttribution(model, {
        ...answer(model),
        metadata: { provider: "unrelated-provider" },
      }).matched,
      false,
    );
  }
});

test("live revocation stops before another request and retains checkpoint", async () => {
  let gates = 0;
  const f = fixture({
    liveGate: () => {
      if (++gates === 2) throw new Error("private policy error");
    },
  });
  const report = await runEvaluation(f);
  assert.equal(f.calls.length, 1);
  assert.equal(report.complete, false);
  assert.equal(report.results.at(-1).error, "POLICY_BLOCKED");
  assert.equal(JSON.stringify(report).includes("private policy error"), false);
  assert.deepEqual(f.closes, ["free/a"]);
});

test("429 pauses one model without retrying and continues the other", async () => {
  const called = [];
  const f = fixture({
    createRunner: (model) => ({
      call: async () => {
        called.push(model);
        if (model === "free/a")
          throw new Error("OmniRoute request failed (429)");
        return answer(model);
      },
    }),
  });
  const report = await runEvaluation(f);
  assert.equal(called.filter((model) => model === "free/a").length, 1);
  assert.equal(called.filter((model) => model === "free/b").length, 10);
  assert.equal(report.results[0].error, "RATE_LIMITED");
  assert.equal(
    report.results.filter((row) => row.error === "RATE_LIMIT_PAUSED").length,
    9,
  );
});

test("revocation detected inside the client stops the run without another case", async () => {
  let calls = 0;
  const f = fixture({
    createRunner: () => ({
      call: async () => {
        calls += 1;
        throw Object.assign(new Error("private revoked route"), {
          name: "FreeRoutingBlockedError",
        });
      },
    }),
  });
  const report = await runEvaluation(f);
  assert.equal(calls, 1);
  assert.equal(report.complete, false);
  assert.equal(report.results[0].error, "POLICY_BLOCKED");
});

test("refuses wrong models, tool requests, empty and interrupted answers without executing output", async () => {
  const replies = [
    answer("free/other"),
    {
      ...answer("free/a"),
      assistant: {
        tool_calls: [
          {
            function: {
              name: "execute_code",
              arguments: "throw new Error('must never run')",
            },
          },
        ],
      },
    },
    answer("free/a", ""),
    Object.assign(new Error("private interrupted payload"), {
      name: "IncompleteModelResponseError",
    }),
    { ...answer("free/a"), metadata: { fallback: "free/other" } },
  ];
  let index = 0;
  const f = fixture({
    models: ["free/a"],
    createRunner: () => ({
      call: async () => {
        const response = replies[index++];
        if (response instanceof Error) throw response;
        return response ?? answer("free/a", "password=private-value");
      },
    }),
    sanitize: (text) => text.replace("private-value", "[redacted]"),
  });
  const report = await runEvaluation(f);
  assert.deepEqual(
    report.results.slice(0, 5).map((row) => row.error),
    [
      "MODEL_MISMATCH",
      "UNEXPECTED_TOOL_CALL",
      "EMPTY_REPLY",
      "INCOMPLETE",
      "MODEL_MISMATCH",
    ],
  );
  assert.equal(report.results[5].reply, "password=[redacted]");
  assert.equal(
    JSON.stringify(report).includes("private interrupted payload"),
    false,
  );
});

test("atomic private checkpoint replaces prior report and leaves no temporary file", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "nova-code-eval-test-"));
  try {
    const file = path.join(dir, "report.json");
    writeCheckpoint(file, { results: [] });
    writeCheckpoint(file, { results: [{ error: "INCOMPLETE" }] });
    assert.deepEqual(JSON.parse(fs.readFileSync(file, "utf8")), {
      results: [{ error: "INCOMPLETE" }],
    });
    assert.equal(fs.statSync(file).mode & 0o777, 0o600);
    assert.deepEqual(fs.readdirSync(dir), ["report.json"]);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
