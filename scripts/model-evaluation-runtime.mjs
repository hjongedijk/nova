import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

const ROOT = path.resolve(import.meta.dirname, "..");
const MODEL = /^[A-Za-z0-9@][A-Za-z0-9@/._:-]{0,199}$/;
const load = (file) =>
  import(pathToFileURL(path.join(ROOT, "apps/api/dist", file)));

/** Isolated policy/settings; every internal route check also observes the live gate. */
export function createRunnerFactory({
  models,
  role,
  config,
  policy,
  RoutingService,
  OmniRouteClient,
  liveGate,
}) {
  return (model) => {
    if (!models.includes(model)) throw new Error("POLICY_BLOCKED");
    liveGate(model);
    const scratch = fs.mkdtempSync(
      path.join(os.tmpdir(), `nova-${role}-evaluation-`),
    );
    try {
      fs.chmodSync(scratch, 0o700);
      fs.writeFileSync(path.join(scratch, "free-routing-policy.json"), policy, {
        mode: 0o600,
      });
      fs.writeFileSync(
        path.join(scratch, "settings.json"),
        JSON.stringify({
          modelRoles: { [role]: { preferred: [model], fallback: null } },
        }),
        { mode: 0o600 },
      );
      const isolated = Object.create(config);
      isolated.dataFile = (name) => path.join(scratch, name);
      const routing = new RoutingService(isolated);
      const checkScratch = routing.assertFree.bind(routing);
      routing.assertFree = () => {
        liveGate(model);
        return checkScratch();
      };
      const client = new OmniRouteClient(isolated, routing);
      return {
        call: client.call.bind(client),
        close: () => fs.rmSync(scratch, { recursive: true, force: true }),
      };
    } catch (error) {
      fs.rmSync(scratch, { recursive: true, force: true });
      throw error;
    }
  };
}

/** Deferred imports keep module import and evaluator --help free of API initialization. */
export async function createEvaluationRuntime(models, role = "code") {
  if (
    !["conversation", "code"].includes(role) ||
    !Array.isArray(models) ||
    !models.length ||
    models.length > 8 ||
    new Set(models).size !== models.length ||
    models.some(
      (model) =>
        typeof model !== "string" ||
        !MODEL.test(model) ||
        model.includes("://"),
    )
  )
    throw new Error("INVALID_ARGUMENTS");
  if (
    !process.env.NOVA_DATA_DIR ||
    !process.env.OMNIROUTE_DATABASE ||
    !process.env.OMNIROUTE_API_KEY
  )
    throw new Error("MISSING_CONFIGURATION");
  const [
    { NovaConfig },
    { RoutingService },
    { OmniRouteClient },
    { SYSTEM_PROMPT },
    { codeResponseStyle, responseStyle },
    { sanitize },
  ] = await Promise.all([
    load("core/config/nova-config.js"),
    load("routing/routing.service.js"),
    load("chat/omniroute-client.service.js"),
    load("chat/prompt.js"),
    load("chat/orchestrator.service.js"),
    load("core/security/sanitize.js"),
  ]);
  const config = new NovaConfig();
  const live = new RoutingService(config);
  const liveGate = (model) => {
    const status = live.assertFree();
    if (
      !status.freeOnly ||
      !status.policyVerified ||
      !status.explicitModels?.includes(model) ||
      status.embeddingModels?.includes(model)
    )
      throw new Error("POLICY_BLOCKED");
  };
  models.forEach(liveGate);
  const policy = fs.readFileSync(config.dataFile("free-routing-policy.json"));
  const createRunner = createRunnerFactory({
    models,
    role,
    config,
    policy,
    RoutingService,
    OmniRouteClient,
    liveGate,
  });
  return {
    config,
    policy,
    liveGate,
    createRunner,
    SYSTEM_PROMPT,
    responseStyle,
    codeResponseStyle,
    sanitize,
    load,
  };
}
