#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { pathToFileURL } from "node:url";
import {
  parseArguments,
  writeCheckpoint,
  modelAttribution,
  failure,
} from "./evaluate-code-models.mjs";
import { createEvaluationRuntime } from "./model-evaluation-runtime.mjs";
import {
  parsePersonaCases,
  toolsFor,
  mockTool,
  fixtureSystemMessages,
} from "./persona-fixtures.mjs";

const ROOT = path.resolve(import.meta.dirname, "..");
const hash = (value) => crypto.createHash("sha256").update(value).digest("hex");
const LIMIT = 1024;

export function checkedMockCall(call, tools) {
  const definition = tools.find(
    (tool) => tool.function.name === call?.function?.name,
  );
  if (
    !definition ||
    typeof call.id !== "string" ||
    !call.id ||
    call.id.length > 200 ||
    typeof call.function.arguments !== "string" ||
    call.function.arguments.length > 4096
  )
    throw new Error("INVALID_MOCK_CALL");
  let args;
  try {
    args = JSON.parse(call.function.arguments || "{}");
  } catch {
    throw new Error("INVALID_MOCK_CALL");
  }
  const schema = definition.function.parameters;
  if (
    !args ||
    typeof args !== "object" ||
    Array.isArray(args) ||
    schema.required.some((key) => !Object.hasOwn(args, key)) ||
    Object.entries(args).some(([key, value]) => {
      const rule = schema.properties[key];
      return (
        !rule ||
        (rule.type === "string"
          ? typeof value !== "string" || value.length > 200
          : rule.type === "integer"
            ? !Number.isInteger(value) ||
              (rule.minimum !== undefined && value < rule.minimum) ||
              (rule.maximum !== undefined && value > rule.maximum)
            : true)
      );
    })
  )
    throw new Error("INVALID_MOCK_CALL");
  return {
    name: call.function.name,
    args,
    result: mockTool(call.function.name, args),
  };
}

/** Synthetic tools only: no execution API, device, file, memory or personal account access. */
export async function personaAnswer({
  model,
  testCase,
  runner,
  prompt,
  liveGate,
  confirmationQuestion,
  sanitize = (v) => v,
}) {
  const tools = toolsFor(testCase.id);
  const messages = [
    ...prompt.map((content) => ({ role: "system", content })),
    ...fixtureSystemMessages(testCase.id),
    { role: "user", content: testCase.user },
  ];
  const calls = [],
    attributions = [],
    caches = [];
  for (let round = 0; round < 3; round++) {
    await liveGate(model);
    const answer = await runner.call(messages, {
      roleModel: { role: "conversation", modelId: model },
      temperature: 0,
      maxTokens: LIMIT,
      tools,
      stream: false,
    });
    const attribution = modelAttribution(model, answer);
    attributions.push(attribution);
    caches.push(
      ["hit", "miss", "bypass"].includes(answer.metadata?.cache)
        ? answer.metadata.cache
        : null,
    );
    if (
      !attribution.matched ||
      (answer.metadata?.fallback != null && answer.metadata.fallback !== false)
    )
      throw new Error("MODEL_MISMATCH");
    const requested = answer.assistant?.tool_calls ?? [];
    if (!Array.isArray(requested) || requested.length > 4)
      throw new Error("INVALID_MOCK_CALL");
    if (!requested.length) {
      if (
        typeof answer.assistant?.content !== "string" ||
        !answer.assistant.content.trim()
      )
        throw new Error("EMPTY_REPLY");
      return {
        reply: sanitize(answer.assistant.content.trim()),
        toolCalls: sanitize(calls),
        attributions,
        cache: caches,
        confirmationIntercepted: false,
      };
    }
    // Validate the complete batch before feeding any result back; never pretend an unoffered tool ran.
    const parsed = requested.map((call) => checkedMockCall(call, tools));
    messages.push({
      ...answer.assistant,
      role: "assistant",
      tool_calls: requested,
    });
    for (let index = 0; index < parsed.length; index++) {
      const { name, args, result } = parsed[index];
      calls.push({ name, arguments: args });
      if (result.requiresConfirmation && result.action)
        return {
          reply: sanitize(confirmationQuestion(result.action, false)),
          toolCalls: sanitize(calls),
          attributions,
          cache: caches,
          confirmationIntercepted: true,
        };
      messages.push({
        role: "tool",
        name,
        tool_call_id: requested[index].id,
        content: JSON.stringify(result),
      });
    }
  }
  throw new Error("TOOL_ROUND_LIMIT");
}

function classify(error) {
  return [
    "MODEL_MISMATCH",
    "INVALID_MOCK_CALL",
    "EMPTY_REPLY",
    "TOOL_ROUND_LIMIT",
    "POLICY_BLOCKED",
  ].includes(error?.message)
    ? error.message
    : failure(error);
}

export async function runPersonaEvaluation({
  models,
  cases,
  output,
  createRunner,
  liveGate,
  prompt,
  hashes,
  confirmationQuestion,
  sanitize = (v) => v,
  checkpoint = writeCheckpoint,
  now = Date.now,
}) {
  const report = {
    version: 1,
    suite: "persona",
    startedAt: new Date(now()).toISOString(),
    finishedAt: null,
    temperature: 0,
    maxTokens: LIMIT,
    maxRounds: 3,
    maxToolsPerRound: 4,
    hashes,
    models,
    cases,
    results: [],
    complete: false,
  };
  checkpoint(output, report);
  for (const model of models) {
    let runner,
      paused = false;
    try {
      for (const testCase of cases) {
        const row = {
          caseId: testCase.id,
          requestedModel: model,
          reply: null,
          error: null,
          latencyMs: 0,
          toolCalls: [],
          attributions: [],
          confirmationIntercepted: false,
        };
        if (paused) row.error = "RATE_LIMIT_PAUSED";
        else {
          try {
            await liveGate(model);
          } catch {
            row.error = "POLICY_BLOCKED";
            report.results.push(row);
            checkpoint(output, report);
            return report;
          }
          const started = now();
          try {
            runner ??= await createRunner(model);
            Object.assign(
              row,
              await personaAnswer({
                model,
                testCase,
                runner,
                prompt,
                liveGate,
                confirmationQuestion,
                sanitize,
              }),
            );
          } catch (error) {
            row.error = classify(error);
            paused = row.error === "RATE_LIMITED";
          }
          row.latencyMs = Math.max(0, now() - started);
        }
        report.results.push(row);
        checkpoint(output, report);
        if (row.error === "POLICY_BLOCKED") return report;
      }
    } finally {
      await runner?.close?.();
    }
  }
  report.finishedAt = new Date(now()).toISOString();
  report.complete = true;
  checkpoint(output, report);
  return report;
}

async function main(args) {
  const options = parseArguments(args);
  if (options.help) {
    console.log(
      "Private 30-case persona model comparison. --run --models=id,id --output=/private/report.json. Synthetic mocked tools only; no real actions. Explicit verified-free conversation roles, no fallback; 429 pauses that model. --help sends no inference.",
    );
    return;
  }
  if (fs.existsSync(options.output)) throw new Error("OUTPUT_EXISTS");
  const runtime = await createEvaluationRuntime(options.models, "conversation");
  const markdown = fs.readFileSync(
    path.join(ROOT, "docs/evaluation.md"),
    "utf8",
  );
  const cases = parsePersonaCases(markdown),
    prompt = [runtime.SYSTEM_PROMPT, runtime.responseStyle("text", false)];
  const { confirmationQuestion } = await runtime.load(
    "confirmations/confirmation-words.js",
    "core/security/sanitize.js",
  );
  const sourceFiles = [
    "chat/omniroute-client.service.js",
    "chat/orchestrator.service.js",
    "chat/prompt.js",
    "routing/routing.service.js",
    "confirmations/confirmation-words.js",
    "core/security/sanitize.js",
  ];
  const hashes = {
    novaVersion: runtime.config.version,
    casesDocumentSha256: hash(markdown),
    parsedCasesSha256: hash(JSON.stringify(cases)),
    promptSha256: hash(JSON.stringify(prompt)),
    policySha256: hash(runtime.policy),
    sourcesSha256: Object.fromEntries(
      sourceFiles.map((file) => [
        file,
        hash(fs.readFileSync(path.join(ROOT, "apps/api/dist", file))),
      ]),
    ),
    evaluatorSha256: hash(fs.readFileSync(new URL(import.meta.url))),
    runtimeSha256: hash(
      fs.readFileSync(
        new URL("./model-evaluation-runtime.mjs", import.meta.url),
      ),
    ),
    fixturesSha256: hash(
      fs.readFileSync(new URL("./persona-fixtures.mjs", import.meta.url)),
    ),
  };
  const report = await runPersonaEvaluation({
    ...options,
    ...runtime,
    cases,
    prompt,
    hashes,
    confirmationQuestion,
  });
  console.log(
    JSON.stringify({
      complete: report.complete,
      recordedCases: report.results.length,
      successfulReplies: report.results.filter((row) => row.reply !== null)
        .length,
    }),
  );
  if (!report.complete) process.exitCode = 1;
}
if (
  process.argv[1] &&
  pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url
)
  main(process.argv.slice(2)).catch(() => {
    console.error(
      "Persona evaluation stopped. Check private configuration, compiled API, route and output destination. Diagnostics were not printed.",
    );
    process.exitCode = 1;
  });
