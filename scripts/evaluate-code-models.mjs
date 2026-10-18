#!/usr/bin/env node
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { createEvaluationRuntime } from "./model-evaluation-runtime.mjs";

const ROOT = path.resolve(import.meta.dirname, "..");
const hash = (value) => crypto.createHash("sha256").update(value).digest("hex");
const MODEL = /^[A-Za-z0-9@][A-Za-z0-9@/._:-]{0,199}$/;

export function parseCases(markdown) {
  const cases = markdown.split("\n").flatMap((line) => {
    const columns = line.split("|").map((part) => part.trim());
    return /^C\d{2}$/.test(columns[1] ?? "")
      ? [
          {
            id: columns[1],
            role: columns[2],
            task: columns[3],
            acceptance: columns[4],
          },
        ]
      : [];
  });
  if (
    cases.length !== 10 ||
    cases.some(
      (item, index) =>
        item.id !== `C${String(index + 1).padStart(2, "0")}` ||
        !item.task ||
        !item.acceptance,
    )
  )
    throw new Error("INVALID_CASES");
  return cases;
}

export function parseArguments(args) {
  if (args.length === 1 && args[0] === "--help") return { help: true };
  if (args.length !== 3 || !args.includes("--run"))
    throw new Error("INVALID_ARGUMENTS");
  const modelsArg = args.find((arg) => arg.startsWith("--models="));
  const outputArg = args.find((arg) => arg.startsWith("--output="));
  const models = modelsArg?.slice(9).split(",") ?? [];
  const output = outputArg?.slice(9);
  if (
    !output ||
    !models.length ||
    models.length > 8 ||
    new Set(models).size !== models.length ||
    models.some((model) => !MODEL.test(model) || model.includes("://"))
  )
    throw new Error("INVALID_ARGUMENTS");
  return { models, output: path.resolve(output) };
}

export function writeCheckpoint(output, report) {
  fs.mkdirSync(path.dirname(output), { recursive: true, mode: 0o700 });
  const temporary = `${output}.${process.pid}.${crypto.randomUUID()}.tmp`;
  try {
    const fd = fs.openSync(temporary, "wx", 0o600);
    try {
      fs.writeFileSync(fd, JSON.stringify(report, null, 2));
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    fs.renameSync(temporary, output);
  } finally {
    fs.rmSync(temporary, { force: true });
  }
}

export function failure(error) {
  if (error?.name === "FreeRoutingBlockedError") return "POLICY_BLOCKED";
  if (error?.name === "IncompleteModelResponseError") return "INCOMPLETE";
  if (/OmniRoute request failed \(429\)/.test(error?.message ?? ""))
    return "RATE_LIMITED";
  if (error?.name === "AbortError" || error?.name === "TimeoutError")
    return "TIMEOUT";
  return "MODEL_UNAVAILABLE";
}

/** The gateway may omit exactly the requested provider prefix, including for @cf paths. */
export function modelAttribution(requested, answer) {
  const separator = requested.indexOf("/");
  const provider = separator < 0 ? null : requested.slice(0, separator);
  const suffix = separator < 0 ? requested : requested.slice(separator + 1);
  const raw =
    typeof answer.model === "string" && MODEL.test(answer.model)
      ? answer.model
      : null;
  const reportedProvider = answer.metadata?.provider;
  const providerMatches =
    reportedProvider == null || reportedProvider === provider;
  const matched = providerMatches && (raw === requested || raw === suffix);
  return {
    rawActualModel: raw,
    actualModel: matched ? requested : null,
    actualProvider:
      reportedProvider == null
        ? null
        : reportedProvider === provider
          ? provider
          : "OTHER_PROVIDER",
    matched,
  };
}

/** Dependency-injected runner: never executes tools or generated code. */
export async function runEvaluation({
  models,
  cases,
  output,
  createRunner,
  liveGate,
  prompt,
  hashes,
  sanitize = (value) => value,
  checkpoint = writeCheckpoint,
  now = Date.now,
}) {
  const report = {
    version: 1,
    startedAt: new Date(now()).toISOString(),
    finishedAt: null,
    temperature: 0,
    maxTokens: 1800,
    hashes,
    models,
    cases,
    results: [],
    complete: false,
  };
  checkpoint(output, report);
  for (const model of models) {
    let runner;
    let paused = false;
    try {
      for (const item of cases) {
        const row = {
          caseId: item.id,
          requestedModel: model,
          actualModel: null,
          rawActualModel: null,
          actualProvider: null,
          latencyMs: 0,
          reply: null,
          error: null,
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
            const answer = await runner.call(
              [
                ...prompt.map((content) => ({ role: "system", content })),
                { role: "user", content: item.task },
              ],
              {
                roleModel: { role: "code", modelId: model },
                temperature: 0,
                maxTokens: 1800,
                tools: [],
                stream: false,
              },
            );
            const attribution = modelAttribution(model, answer);
            row.actualModel = attribution.actualModel;
            row.rawActualModel = attribution.rawActualModel;
            row.actualProvider = attribution.actualProvider;
            if (
              !attribution.matched ||
              (answer.metadata?.fallback != null &&
                answer.metadata.fallback !== false)
            )
              row.error = "MODEL_MISMATCH";
            else if (answer.assistant?.tool_calls?.length)
              row.error = "UNEXPECTED_TOOL_CALL";
            else if (
              typeof answer.assistant?.content !== "string" ||
              !answer.assistant.content.trim()
            )
              row.error = "EMPTY_REPLY";
            else row.reply = sanitize(answer.assistant.content);
          } catch (error) {
            row.error = failure(error);
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
      "Private synthetic Code-role evaluation. Build API first. --run --models=id,id --output=/private/report.json. Ten fixed cases per model; no tools or generated-code execution. HTTP429 pauses that model. --help sends no inference.",
    );
    return;
  }
  if (fs.existsSync(options.output)) throw new Error("OUTPUT_EXISTS");
  const {
    config,
    policy,
    liveGate,
    createRunner,
    SYSTEM_PROMPT,
    responseStyle,
    codeResponseStyle,
    sanitize,
  } = await createEvaluationRuntime(options.models);
  const markdown = fs.readFileSync(
    path.join(ROOT, "docs/evaluation.md"),
    "utf8",
  );
  const cases = parseCases(markdown);
  const prompt = [
    SYSTEM_PROMPT,
    responseStyle("text", false),
    codeResponseStyle("en"),
  ];
  const sourceFiles = [
    "chat/omniroute-client.service.js",
    "chat/orchestrator.service.js",
    "chat/prompt.js",
    "routing/routing.service.js",
  ];
  const hashes = {
    novaVersion: config.version,
    casesSha256: hash(markdown),
    promptSha256: hash(JSON.stringify(prompt)),
    policySha256: hash(policy),
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
  };
  const report = await runEvaluation({
    ...options,
    cases,
    prompt,
    hashes,
    liveGate,
    createRunner,
    sanitize,
  });
  console.log(
    JSON.stringify({
      complete: report.complete,
      recordedCases: report.results.length,
      successfulCases: report.results.filter((row) => row.reply !== null)
        .length,
    }),
  );
  if (!report.complete) process.exitCode = 1;
}

if (
  process.argv[1] &&
  pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url
) {
  main(process.argv.slice(2)).catch(() => {
    console.error(
      "Code evaluation stopped; check configuration, compiled API, output destination and verified route. Private diagnostics were not printed.",
    );
    process.exitCode = 1;
  });
}
