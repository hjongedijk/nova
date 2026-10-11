#!/usr/bin/env node
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import ts from "typescript";

const BASELINE = "34aaec142be2944fdfbb77998edc68cfca1a9a95";
const PROMPT_PATH = "apps/api/src/chat/prompt.ts";
const EVALUATION_PATH = "docs/persona-evaluation.md";
const args = new Set(process.argv.slice(2));

if (args.has("--help")) {
  console.log(
    "Build the API first, then run with --run and env from the configured NOVA install. This sends only synthetic cases through NOVA's verified-free OmniRoute route. Tool calls are mocked and never executed.",
  );
  process.exit(0);
}
if (!args.has("--run")) {
  console.error("No model calls made. Pass --run to start the evaluation.");
  process.exit(2);
}
if (
  !process.env.NOVA_DATA_DIR ||
  !fs.statSync(process.env.NOVA_DATA_DIR).isDirectory()
)
  throw new Error("Set NOVA_DATA_DIR to an existing NOVA data directory.");
if (
  !process.env.OMNIROUTE_DATABASE ||
  !fs.existsSync(process.env.OMNIROUTE_DATABASE)
)
  throw new Error(
    "Set OMNIROUTE_DATABASE to the verified read-only gateway database.",
  );
if (!process.env.OMNIROUTE_API_KEY)
  throw new Error("OMNIROUTE_API_KEY is not configured.");

const root = process.cwd();
function promptFromSource(sourceText) {
  const source = ts.createSourceFile(
    "prompt.ts",
    sourceText,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );
  let prompt;
  const visit = (node) => {
    if (
      ts.isVariableDeclaration(node) &&
      node.name.getText(source) === "SYSTEM_PROMPT" &&
      node.initializer
    ) {
      const value =
        ts.isCallExpression(node.initializer) &&
        ts.isPropertyAccessExpression(node.initializer.expression) &&
        node.initializer.expression.name.text === "trim"
          ? node.initializer.expression.expression
          : node.initializer;
      if (!ts.isNoSubstitutionTemplateLiteral(value))
        throw new Error("SYSTEM_PROMPT must remain a plain template literal.");
      prompt = value.text.trim();
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  if (!prompt) throw new Error("SYSTEM_PROMPT was not found.");
  return prompt;
}

function digest(text) {
  return crypto.createHash("sha256").update(text).digest("hex");
}

function toolsFor(id) {
  const definitions = {
    system_time: ["Current local time fixture; read-only."],
    weather_forecast: [
      "Current weather fixture. Empty location means the configured home; this test has no home location.",
      {
        location: { type: "string" },
        days: { type: "integer", minimum: 1, maximum: 7 },
      },
    ],
    home_status: ["Read-only fixture of actual home devices."],
    ha_search_entities: [
      "Find matching actual home entities in the fixture.",
      { query: { type: "string" } },
      ["query"],
    ],
    ha_get_state: [
      "Read a current entity state from the fixture.",
      { entity_id: { type: "string" } },
      ["entity_id"],
    ],
    proxmox_status: ["Read-only Proxmox host status fixture."],
    proxmox_guests: ["Read-only virtual machine inventory fixture."],
    proxmox_reboot_guest: [
      "Request a restart of one VM. This harness never executes it; the result only says confirmation is required.",
      { vmid: { type: "integer", minimum: 1 } },
      ["vmid"],
    ],
    ha_turn_off: [
      "Request turning off one actual home device. This harness never executes it; the result only says confirmation is required.",
      { entity_id: { type: "string" } },
      ["entity_id"],
    ],
  };
  const byCase = {
    P19: ["system_time"],
    P20: ["weather_forecast"],
    P21: ["home_status", "ha_search_entities", "ha_get_state"],
    P22: ["proxmox_guests"],
    P23: ["proxmox_status", "proxmox_guests", "proxmox_reboot_guest"],
    P24: ["home_status", "ha_search_entities", "ha_turn_off"],
  };
  return (byCase[id] ?? []).map((name) => {
    const [description, properties = {}, required = []] = definitions[name];
    return {
      type: "function",
      function: {
        name,
        description,
        parameters: {
          type: "object",
          properties,
          required,
          additionalProperties: false,
        },
      },
    };
  });
}

function mockTool(name, args) {
  switch (name) {
    case "system_time":
      return {
        ok: true,
        result: {
          local: {
            spoken: "kwart over tien",
            time: "10:15",
            timezone: "Europe/Amsterdam",
          },
        },
      };
    case "weather_forecast":
      return {
        ok: false,
        error: args.location
          ? "Geen weerfixture voor deze locatie."
          : "Thuislocatie niet ingesteld; vraag de gebruiker om een plaats.",
      };
    case "home_status":
      return {
        ok: true,
        result: {
          devices: [
            {
              entity_id: "light.woonkamer",
              name: "Woonkamerlamp",
              state: "on",
            },
            { entity_id: "light.gang", name: "Ganglamp", state: "on" },
            { entity_id: "light.keuken", name: "Keukenlamp", state: "on" },
          ],
        },
      };
    case "ha_search_entities":
      return {
        ok: true,
        result: [
          {
            entity_id: "light.woonkamer",
            name: "Woonkamerlamp",
            area: "Woonkamer",
          },
          { entity_id: "light.gang", name: "Ganglamp", area: "Gang" },
          { entity_id: "light.keuken", name: "Keukenlamp", area: "Keuken" },
        ],
      };
    case "ha_get_state":
      return {
        ok: args.entity_id === "light.woonkamer",
        result: { entity_id: args.entity_id, state: "on" },
        error:
          args.entity_id === "light.woonkamer" ? undefined : "Entity not found",
      };
    case "proxmox_status":
      return { ok: true, result: { status: "online", nodes: 1 } };
    case "proxmox_guests":
      return {
        ok: true,
        result: {
          guests: [
            { vmid: 101, name: "web-test", status: "running", cpu: 0.72 },
            { vmid: 102, name: "db-test", status: "running", cpu: 0.21 },
          ],
        },
      };
    case "proxmox_reboot_guest":
    case "ha_turn_off":
      return {
        ok: false,
        executed: false,
        requiresConfirmation: true,
        action: { tool: name, args },
        message: "Geen actie uitgevoerd; eerst expliciete bevestiging nodig.",
      };
    default:
      return { ok: false, error: "Unknown mock tool." };
  }
}

async function answer(client, systemPrompt, testCase) {
  const tools = toolsFor(testCase.id);
  const messages = [
    { role: "system", content: systemPrompt },
    ...(testCase.id === "P25"
      ? [
          {
            role: "system",
            content:
              "Testfixture: agenda niet gekoppeld; er zijn geen agenda-tools beschikbaar.",
          },
        ]
      : []),
    ...(testCase.id === "P26"
      ? [
          {
            role: "system",
            content:
              "Testfixture: er is geen bestand in deze conversatie beschikbaar.",
          },
        ]
      : []),
    ...(testCase.id === "P30"
      ? [
          {
            role: "system",
            content:
              "Testfixture: geen serverherstart aangevraagd of uitgevoerd.",
          },
        ]
      : []),
    { role: "user", content: testCase.user },
  ];
  const calls = [];
  let response;
  for (let round = 0; round < 3; round++) {
    response = await client.call(messages, {
      temperature: 0,
      maxTokens: 240,
      tools,
      sessionId: `persona-eval-${testCase.id}`,
    });
    const requested = (response.assistant.tool_calls ?? []).slice(0, 4);
    if (!requested.length) break;
    const parsedCalls = requested.map((call) => {
      try {
        return {
          call,
          args: JSON.parse(call.function.arguments || "{}"),
        };
      } catch {
        return { call, args: {} };
      }
    });
    messages.push({
      ...response.assistant,
      role: "assistant",
      tool_calls: requested,
    });
    for (const { call, args } of parsedCalls) {
      calls.push({ name: call.function.name, arguments: args });
      const result = mockTool(call.function.name, args);
      // Match Orchestrator: a pending confirmation is returned immediately and
      // never passed back to the model as though the action had run.
      if (result.requiresConfirmation && result.action) {
        return {
          model: response?.model ?? null,
          provider: response?.metadata?.provider ?? null,
          answer: confirmationQuestion(result.action, false),
          toolCalls: calls,
          confirmationIntercepted: true,
        };
      }
      messages.push({
        role: "tool",
        name: call.function.name,
        tool_call_id: call.id,
        content: JSON.stringify(result),
      });
    }
  }
  return {
    model: response?.model ?? null,
    provider: response?.metadata?.provider ?? null,
    answer: String(response?.assistant.content ?? "").trim(),
    toolCalls: calls,
    confirmationIntercepted: false,
  };
}

function parseCases(markdown) {
  return [
    ...markdown.matchAll(
      /^\|\s*(P\d{2})\s*\|\s*([^|]+)\|\s*([^|]+)\|\s*([^|]+)\|/gm,
    ),
  ].map((match) => ({
    id: match[1],
    category: match[2].trim(),
    user: match[3].trim(),
    check: match[4].trim(),
  }));
}

const evaluation = fs.readFileSync(EVALUATION_PATH, "utf8");
const cases = parseCases(evaluation);
if (cases.length !== 30)
  throw new Error(`Expected 30 cases, found ${cases.length}.`);
const baselineSource = execFileSync(
  "git",
  ["show", `${BASELINE}:${PROMPT_PATH}`],
  {
    cwd: root,
    encoding: "utf8",
  },
);
const baselinePrompt = promptFromSource(baselineSource);
const { NovaConfig } = await import(
  pathToFileURL(path.join(root, "apps/api/dist/core/config/nova-config.js"))
);
const { RoutingService } = await import(
  pathToFileURL(path.join(root, "apps/api/dist/routing/routing.service.js"))
);
const { OmniRouteClient } = await import(
  pathToFileURL(
    path.join(root, "apps/api/dist/chat/omniroute-client.service.js"),
  )
);
const { SYSTEM_PROMPT } = await import(
  pathToFileURL(path.join(root, "apps/api/dist/chat/prompt.js"))
);
const { confirmationQuestion } = await import(
  pathToFileURL(
    path.join(root, "apps/api/dist/confirmations/confirmation-words.js"),
  )
);
const currentPrompt = String(SYSTEM_PROMPT).trim();
const currentSource = promptFromSource(
  fs.readFileSync(path.join(root, PROMPT_PATH), "utf8"),
);
if (digest(currentSource) !== digest(currentPrompt))
  throw new Error(
    "The compiled API prompt is stale. Build the API before evaluating; no model request sent.",
  );
const config = new NovaConfig();
const routing = new RoutingService(config);
const route = routing.assertFree();
if (!route.ready || !route.freeOnly || route.policyVerified !== true)
  throw new Error(
    `Verified-free route unavailable (${route.status}). No model request sent.`,
  );
if (args.has("--preflight")) {
  console.log(
    JSON.stringify({
      ready: route.ready,
      freeOnly: route.freeOnly,
      policyVerified: route.policyVerified,
      status: route.status,
      model: config.omniModel,
      cases: cases.length,
      modelRequests: 0,
    }),
  );
  process.exit(0);
}
const client = new OmniRouteClient(config, routing);
const stamp = new Date().toISOString().replace(/[:.]/g, "-");
const outputDirectory = path.join(root, "docs/persona-evaluation-runs");
fs.mkdirSync(outputDirectory, { recursive: true });
const outputFile = path.join(outputDirectory, `${stamp}.json`);
const result = {
  harnessVersion: 2,
  status: "in_progress",
  startedAt: new Date().toISOString(),
  baseline: {
    revision: BASELINE,
    promptSha256: digest(baselinePrompt),
    status: args.has("--current-only") ? "not_run" : "pending",
    answers: [],
  },
  current: {
    revision: "worktree",
    promptSha256: digest(currentPrompt),
    answers: [],
  },
  toolPolicy:
    "Mock results only; mirrors Orchestrator's immediate confirmation interception; confirmation-required actions are never executed.",
  temperature: 0,
};
const writeProgress = () =>
  fs.writeFileSync(outputFile, `${JSON.stringify(result, null, 2)}\n`, {
    mode: 0o600,
  });
writeProgress();

for (const testCase of cases) {
  if (!args.has("--current-only")) {
    const baselineAnswer = await answer(client, baselinePrompt, testCase);
    result.baseline.answers.push({ ...testCase, ...baselineAnswer });
    await new Promise((resolve) => setTimeout(resolve, 1250));
  }
  const currentAnswer = await answer(client, currentPrompt, testCase);
  result.current.answers.push({ ...testCase, ...currentAnswer });
  writeProgress();
  const count = result.current.answers.length;
  if (count % 5 === 0)
    console.log(
      `Saved ${count}/30 ${args.has("--current-only") ? "current" : "paired"} cases.`,
    );
  await new Promise((resolve) => setTimeout(resolve, 1250));
}
result.status = "complete";
result.finishedAt = new Date().toISOString();
result.baseline.status = args.has("--current-only") ? "not_run" : "complete";
result.comparison = args.has("--current-only")
  ? null
  : result.baseline.answers.map((before, index) => {
      const after = result.current.answers[index];
      return {
        id: before.id,
        sameModelAndProvider:
          before.model === after.model && before.provider === after.provider,
      };
    });
writeProgress();
console.log(
  `Completed 30 ${args.has("--current-only") ? "current" : "paired"} cases. Results saved to ${path.relative(root, outputFile)}.`,
);
