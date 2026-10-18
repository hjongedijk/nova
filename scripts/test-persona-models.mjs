import assert from "node:assert/strict";
import { test } from "node:test";
import fs from "node:fs";
import {
  runPersonaEvaluation,
  personaAnswer,
  checkedMockCall,
} from "./evaluate-persona-models.mjs";
import { parsePersonaCases, toolsFor } from "./persona-fixtures.mjs";
const cases = parsePersonaCases(
  fs.readFileSync(new URL("../docs/evaluation.md", import.meta.url), "utf8"),
);
const answer = (
  model,
  content = "Een synthetisch antwoord.",
  tool_calls = [],
) => ({
  model,
  metadata: { fallback: null },
  assistant: { role: "assistant", content, tool_calls },
});
const call = (name, args = "{}", id = "call-1") => ({
  id,
  type: "function",
  function: { name, arguments: args },
});
function fixture(overrides = {}) {
  const checkpoints = [],
    calls = [],
    closes = [];
  const f = {
    models: ["free/a", "free/b"],
    cases,
    output: "unused",
    prompt: ["fixture prompt"],
    hashes: {},
    liveGate: () => {},
    confirmationQuestion: () => "Eerst bevestigen; niets uitgevoerd.",
    checkpoint: (_file, report) => checkpoints.push(structuredClone(report)),
    createRunner: (model) => ({
      call: async (messages, options) => {
        calls.push({ model, messages: structuredClone(messages), options });
        return answer(model);
      },
      close: () => closes.push(model),
    }),
    checkpoints,
    calls,
    closes,
    ...overrides,
  };
  return f;
}
test("same frozen thirty cases, conversation roles, complete checkpoints and isolated model cleanup", async () => {
  const f = fixture();
  const r = await runPersonaEvaluation(f);
  assert.equal(r.complete, true);
  assert.equal(r.results.length, 60);
  assert.equal(f.calls.length, 60);
  assert.equal(f.checkpoints.length, 62);
  assert.deepEqual(f.closes, ["free/a", "free/b"]);
  assert.deepEqual(f.calls[0].messages, f.calls[30].messages);
  for (const item of f.calls) {
    assert.equal(item.options.roleModel.role, "conversation");
    assert.equal(item.options.roleModel.modelId, item.model);
    assert.equal(item.options.maxTokens, 1024);
    assert.equal(item.options.temperature, 0);
    assert.equal(item.options.stream, false);
  }
});
test("read-only fixture tool round supplies verified synthetic VM count then a final reply", async () => {
  let n = 0;
  const result = await personaAnswer({
    model: "free/a",
    testCase: cases[21],
    prompt: ["fixture"],
    liveGate: () => {},
    confirmationQuestion: () => "",
    runner: {
      call: async (messages) => {
        if (++n === 1)
          return answer("free/a", null, [call("proxmox_guests", "")]);
        const tool = JSON.parse(messages.at(-1).content);
        assert.equal(tool.result.guests.length, 2);
        return answer("free/a", "Er draaien twee virtuele machines.");
      },
    },
  });
  assert.equal(n, 2);
  assert.equal(result.toolCalls[0].name, "proxmox_guests");
  assert.equal(result.confirmationIntercepted, false);
  assert.equal(result.attributions.length, 2);
});
test("state-changing requests stop at backend confirmation, with no action or further model request", async () => {
  let n = 0;
  const result = await personaAnswer({
    model: "free/a",
    testCase: cases[22],
    prompt: [],
    liveGate: () => {},
    confirmationQuestion: (action) => {
      assert.equal(action.tool, "proxmox_reboot_guest");
      return "Zal ik VM101 herstarten?";
    },
    runner: {
      call: async () => {
        n++;
        return answer("free/a", null, [
          call("proxmox_reboot_guest", '{"vmid":101}'),
        ]);
      },
    },
  });
  assert.equal(n, 1);
  assert.equal(result.confirmationIntercepted, true);
  assert.match(result.reply, /Zal ik/);
});
test("unoffered, invalid, extra and excessive mock calls cannot execute or be presented as successes", async () => {
  for (const request of [
    call("windows_lock"),
    call("proxmox_reboot_guest", '{"vmid":101,"confirmed":true}'),
    call("proxmox_reboot_guest", '{"vmid":"101"}'),
    call("proxmox_reboot_guest", "{broken"),
  ])
    assert.throws(
      () => checkedMockCall(request, toolsFor("P23")),
      /INVALID_MOCK_CALL/,
    );
  const f = fixture({
    models: ["free/a"],
    cases: [cases[18]],
    createRunner: () => ({
      call: async () =>
        answer("free/a", null, Array(5).fill(call("system_time"))),
    }),
  });
  const r = await runPersonaEvaluation(f);
  assert.equal(r.results[0].error, "INVALID_MOCK_CALL");
  assert.equal(r.results[0].reply, null);
});
test("revocation between tool rounds stops before another call and retains incomplete checkpoint", async () => {
  let allowed = true,
    n = 0;
  const f = fixture({
    models: ["free/a"],
    cases: [cases[21], cases[0]],
    liveGate: () => {
      if (!allowed) throw new Error("POLICY_BLOCKED");
    },
    createRunner: () => ({
      call: async () => {
        n++;
        allowed = false;
        return answer("free/a", null, [call("proxmox_guests")]);
      },
    }),
  });
  const r = await runPersonaEvaluation(f);
  assert.equal(n, 1);
  assert.equal(r.complete, false);
  assert.equal(r.results.length, 1);
  assert.equal(r.results[0].error, "POLICY_BLOCKED");
});
test("429 pauses only that model, retaining bounded rows and continuing the second model", async () => {
  let first = 0,
    second = 0;
  const f = fixture({
    createRunner: (model) => ({
      call: async () => {
        if (model === "free/a") {
          first++;
          throw new Error("OmniRoute request failed (429)");
        }
        second++;
        return answer(model);
      },
    }),
  });
  const r = await runPersonaEvaluation(f);
  assert.equal(first, 1);
  assert.equal(second, 30);
  assert.equal(r.results[0].error, "RATE_LIMITED");
  assert.equal(r.results[29].error, "RATE_LIMIT_PAUSED");
  assert.equal(r.complete, true);
});
test("wrong model or declared fallback is rejected on any tool round", async () => {
  for (const bad of [
    answer("free/other"),
    { ...answer("free/a"), metadata: { fallback: true } },
  ]) {
    let n = 0;
    const f = fixture({
      models: ["free/a"],
      cases: [cases[21]],
      createRunner: () => ({
        call: async () =>
          ++n === 1 ? answer("free/a", null, [call("proxmox_guests")]) : bad,
      }),
    });
    const r = await runPersonaEvaluation(f);
    assert.equal(r.results[0].error, "MODEL_MISMATCH");
    assert.equal(r.results[0].reply, null);
  }
});
test("bounded tool rounds, empty replies and interrupted responses remain explicit failures", async () => {
  let n = 0;
  const f = fixture({
    models: ["free/a"],
    cases: [cases[21]],
    createRunner: () => ({
      call: async () => {
        n++;
        return answer("free/a", null, [call("proxmox_guests")]);
      },
    }),
  });
  assert.equal(
    (await runPersonaEvaluation(f)).results[0].error,
    "TOOL_ROUND_LIMIT",
  );
  assert.equal(n, 3);
  for (const [fn, expected] of [
    [async () => answer("free/a", ""), "EMPTY_REPLY"],
    [
      async () => {
        const e = new Error();
        e.name = "IncompleteModelResponseError";
        throw e;
      },
      "INCOMPLETE",
    ],
  ]) {
    const r = await runPersonaEvaluation(
      fixture({
        models: ["free/a"],
        cases: [cases[0]],
        createRunner: () => ({ call: fn }),
      }),
    );
    assert.equal(r.results[0].error, expected);
  }
});
test("reply is sanitized before checkpoint and raw exception diagnostics are never stored", async () => {
  const f = fixture({
    models: ["free/a"],
    cases: [cases[0], cases[1]],
    sanitize: (value) =>
      typeof value === "string"
        ? value.replaceAll("synthetic-private-value", "[redacted]")
        : value,
    createRunner: () => ({
      call: async (messages) => {
        if (messages.at(-1).content === cases[1].user)
          throw new Error("synthetic-private-exception");
        return answer("free/a", "synthetic-private-value");
      },
    }),
  });
  const r = await runPersonaEvaluation(f);
  assert.equal(r.results[0].reply, "[redacted]");
  assert.equal(r.results[1].error, "MODEL_UNAVAILABLE");
  assert(!JSON.stringify(f.checkpoints).includes("synthetic-private-"));
});

test("confirmation-path replies and mock arguments are sanitized before checkpoint", async () => {
  const f = fixture({
    models: ["free/a"],
    cases: [cases[23]],
    sanitize: (value) =>
      JSON.parse(
        JSON.stringify(value).replaceAll(
          "synthetic-private-value",
          "[redacted]",
        ),
      ),
    confirmationQuestion: (action) => `Bevestig ${action.args.entity_id}`,
    createRunner: () => ({
      call: async () =>
        answer("free/a", null, [
          call("ha_turn_off", '{"entity_id":"synthetic-private-value"}'),
        ]),
    }),
  });
  const result = await runPersonaEvaluation(f);
  assert.equal(result.results[0].confirmationIntercepted, true);
  assert.equal(result.results[0].reply, "Bevestig [redacted]");
  assert(!JSON.stringify(f.checkpoints).includes("synthetic-private-value"));
});
