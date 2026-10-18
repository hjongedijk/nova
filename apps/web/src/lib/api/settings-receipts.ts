import type { ActionReceipt } from "../stores/chat.svelte.ts";

type Shape =
  | "ok"
  | "roles"
  | "workspace"
  | "widget"
  | "wallpaper"
  | "helper"
  | "mcp-config";
interface ReceiptPolicy {
  kind: "receipt";
  family: string;
  shape: Shape;
  confirm: boolean;
  verifiedContract: boolean;
}
type Route = ReceiptPolicy & { method: string; path: string };
const routes: Route[] = [];
function add(
  method: string,
  paths: string[],
  family: string,
  shape: Shape = "ok",
  verifiedContract = false,
  confirm = false,
): void {
  for (const path of paths)
    routes.push({
      kind: "receipt",
      method,
      path,
      family,
      shape,
      verifiedContract,
      confirm,
    });
}
add("PUT", ["/model-roles"], "Modelrollen", "roles");
add("POST", ["/model-roles/history/:id/rollback"], "Modelrollen", "roles");
add("POST", ["/workspace/projects"], "Werkruimte", "workspace");
add("PUT", ["/workspace/projects/active"], "Werkruimte", "workspace");
add(
  "POST",
  ["/workspace/projects/history/confirm-rollback"],
  "Werkruimte",
  "ok",
  true,
  true,
);
add("PUT", ["/persona/profile", "/household-profiles"], "Gedrag en profielen");
add(
  "POST",
  [
    "/household-profiles/history/:id/rollback",
    "/household-profiles/definitions/history/:id/rollback",
    "/persona/preferences/history/:id/rollback",
    "/persona/history/:id/rollback",
  ],
  "Gedrag en profielen",
);
add(
  "POST",
  [
    "/tools/:id/description-history/:id/rollback",
    "/tools/history/:id/rollback",
  ],
  "Gereedschapsinstellingen",
);
add("DELETE", ["/tools/:id"], "Gereedschapsinstellingen");
add("PUT", ["/abilities/:id"], "Vaardigheden");
add(
  "POST",
  ["/skills", "/skills/:id/content-history/:id/rollback"],
  "Vaardigheden",
);
add("PUT", ["/skills/:id"], "Vaardigheden");
add("DELETE", ["/skills/:id"], "Vaardigheden");
add("POST", ["/widgets"], "Zijpanelen", "widget");
add("PUT", ["/widgets/:id"], "Zijpanelen", "widget");
add("DELETE", ["/widgets/:id"], "Zijpanelen");
add(
  "POST",
  [
    "/widgets/:id/history/:id/rollback",
    "/widgets/:id/display-history/:id/rollback",
  ],
  "Zijpanelen",
);
add("POST", ["/sidebar/history/:id/rollback"], "Zijbalk");
add(
  "POST",
  ["/wallpaper", "/wallpaper/history/:id/rollback"],
  "Achtergrond",
  "wallpaper",
);
add(
  "POST",
  ["/node-red/palette/confirm"],
  "Node-RED-palette",
  "ok",
  true,
  true,
);
add(
  "POST",
  ["/node-red/flow-revisions/:id/confirm-restore"],
  "Node-RED-flows",
  "ok",
  false,
  true,
);
add(
  "POST",
  ["/helper", "/helper/history/:id/rollback"],
  "Desktophelper",
  "helper",
);
add("PUT", ["/helper/hotkeys", "/helper/preferences"], "Desktophelper");
add(
  "POST",
  [
    "/helper/hotkeys/history/:id/rollback",
    "/helper/preferences/history/:id/rollback",
  ],
  "Desktophelper",
);
add("POST", ["/import"], "Instellingen herstellen", "ok", false, true);
add("DELETE", ["/standing-approvals/:id"], "Toestemmingen");
add("POST", ["/services/restart"], "Services herstarten");
add(
  "POST",
  ["/stack-control/restart/confirm"],
  "Services herstarten",
  "ok",
  false,
  true,
);
add("POST", ["/mcp/servers/:id/config"], "MCP-instellingen", "mcp-config");
add(
  "POST",
  ["/mcp/servers/confirm-catalog"],
  "MCP-instellingen",
  "ok",
  true,
  true,
);
add(
  "POST",
  ["/mcp/servers/confirm-toggle", "/mcp/servers/confirm-tool-risk"],
  "MCP-instellingen",
  "ok",
  false,
  true,
);
add(
  "POST",
  [
    "/services/qdrant/maintenance",
    "/services/qdrant/reindex",
    "/services/qdrant/index-history/:id/rollback",
  ],
  "Geheugenindex",
);
add(
  "PUT",
  ["/managed-targets/access", "/home-assistant/access"],
  "Apparaattoegang",
);
add(
  "POST",
  [
    "/managed-targets/access/history/confirm-rollback",
    "/home-assistant/access/history/confirm-rollback",
  ],
  "Apparaattoegang",
  "ok",
  false,
  true,
);
add("PUT", ["/services/:id"], "Serviceverbindingen");
add("POST", ["/services/windows/pair"], "Serviceverbindingen");
add(
  "POST",
  ["/services/history/confirm-rollback"],
  "Serviceverbindingen",
  "ok",
  false,
  true,
);
add(
  "POST",
  [
    "/omniroute/native/memories/update/confirm",
    "/omniroute/native/memories/delete/confirm",
    "/omniroute/native/memories/delete-many/confirm",
    "/omniroute/native/memory/confirm",
  ],
  "AI-geheugen",
  "ok",
  true,
  true,
);
add(
  "POST",
  ["/omniroute/native/prompt/confirm"],
  "AI-instructies",
  "ok",
  true,
  true,
);
add(
  "POST",
  [
    "/omniroute/native/skills/:id/confirm",
    "/omniroute/native/skills/:id/remove/confirm",
  ],
  "AI-vaardigheden",
  "ok",
  true,
  true,
);
add(
  "POST",
  [
    "/omniroute/accounts/:id/activation/confirm",
    "/omniroute/accounts/:id/removal/confirm",
    "/omniroute/accounts/create/confirm",
    "/omniroute/accounts/key-update/confirm",
    "/omniroute/accounts/rename/confirm",
  ],
  "AI-accounts",
  "ok",
  true,
  true,
);
add(
  "POST",
  [
    "/omniroute/accounts/keys/:id/model-access/confirm",
    "/omniroute/accounts/keys/:id/activation/confirm",
    "/omniroute/accounts/keys/:id/token-limits/confirm",
  ],
  "AI-sleutels",
  "ok",
  true,
  true,
);
add(
  "POST",
  [
    "/omniroute/combos/create/confirm",
    "/omniroute/combos/:id/removal/confirm",
    "/omniroute/combos/:id/update/confirm",
    "/omniroute/combos/:id/activation/confirm",
  ],
  "AI-modelcombinaties",
  "ok",
  true,
  true,
);
add(
  "POST",
  ["/omniroute/policy/confirm"],
  "Gratis AI-routering",
  "ok",
  true,
  true,
);

const excludedRoutes: readonly (readonly [string, string])[] = [
  ["POST", "/omniroute/native/memory/prepare"],
  ["POST", "/omniroute/native/memories/delete/prepare"],
  ["POST", "/omniroute/native/memories/delete-many/prepare"],
  ["POST", "/omniroute/native/memories/update/prepare"],
  ["POST", "/omniroute/native/memory/rollback/prepare"],
  ["POST", "/omniroute/native/prompt/prepare"],
  ["POST", "/omniroute/native/skills/:id/prepare"],
  ["POST", "/omniroute/native/skills/:id/rollback/prepare"],
  ["POST", "/omniroute/native/skills/:id/remove/prepare"],
  ["POST", "/workspace/projects/history/:id/prepare-rollback"],
  ["POST", "/updates/check"],
  ["POST", "/skills/draft"],
  ["POST", "/skills/test"],
  ["POST", "/skills/improve"],
  ["POST", "/widgets/preview"],
  ["POST", "/node-red/palette/prepare"],
  ["POST", "/node-red/flows/export"],
  ["POST", "/node-red/flow-revisions/capture"],
  ["POST", "/node-red/flow-revisions/:id/prepare-restore"],
  ["POST", "/import/prepare"],
  ["POST", "/stack-control/restart/prepare"],
  ["POST", "/mcp/servers/:id/prepare-catalog"],
  ["POST", "/mcp/servers/:id/history/:id/prepare-rollback"],
  ["POST", "/mcp/servers/:id/test"],
  ["POST", "/mcp/servers/:id/prepare-toggle"],
  ["POST", "/mcp/servers/:id/tools/:id/prepare-risk"],
  ["POST", "/managed-targets/access/history/:id/prepare-rollback"],
  ["POST", "/home-assistant/access/history/:id/prepare-rollback"],
  ["POST", "/services/:id/test"],
  ["POST", "/services/history/:id/prepare-rollback"],
  ["POST", "/omniroute/accounts/keys/:id/model-access/prepare-rollback"],
  ["POST", "/omniroute/accounts/keys/:id/model-access/prepare"],
  ["POST", "/omniroute/accounts/:id/activation/prepare"],
  ["POST", "/omniroute/accounts/keys/:id/activation/prepare"],
  [
    "POST",
    "/omniroute/accounts/keys/:id/activation/history/:id/prepare-rollback",
  ],
  ["POST", "/omniroute/combos/create/prepare"],
  ["POST", "/omniroute/combos/:id/removal/prepare"],
  ["POST", "/omniroute/combos/:id/update/prepare"],
  ["POST", "/omniroute/combos/:id/update/history/:id/prepare-rollback"],
  ["POST", "/omniroute/accounts/keys/:id/token-limits/prepare"],
  ["POST", "/omniroute/accounts/:id/removal/prepare"],
  ["POST", "/omniroute/accounts/create/prepare"],
  ["POST", "/omniroute/accounts/key-update/prepare"],
  ["POST", "/omniroute/accounts/rename/prepare"],
  ["POST", "/omniroute/accounts/rename/:id/history/:id/prepare-rollback"],
  ["POST", "/omniroute/combos/:id/activation/prepare"],
  ["POST", "/omniroute/combos/:id/activation/history/:id/prepare-rollback"],
  ["POST", "/omniroute/policy/prepare"],
  ["POST", "/omniroute/accounts/:id/activation/history/:id/prepare-rollback"],
];

function matches(template: string, path: string): boolean {
  const expected = template.split("/"),
    actual = path.split("/");
  return (
    expected.length === actual.length &&
    expected.every((part, index) =>
      part === ":id"
        ? actual[index]!.length > 0 && actual[index]!.length <= 2048
        : part === actual[index],
    )
  );
}
/** Explicit route ownership only; unknown future settings writes receive no completion claim. */
export function classifySettingsWrite(
  method: string,
  path: string,
): ReceiptPolicy | { kind: "excluded" } | null {
  if (path.length > 4096 || path.includes("?") || path.includes("#"))
    return null;
  if (
    (method === "PUT" &&
      ["/persona", "/persona/style", "/sidebar", "/quick-actions"].includes(
        path,
      )) ||
    (method === "PUT" && matches("/tools/:id", path)) ||
    (method === "POST" && matches("/quick-actions/history/:id/rollback", path))
  )
    return { kind: "excluded" };
  if (
    excludedRoutes.some(
      ([expectedMethod, expectedPath]) =>
        expectedMethod === method && matches(expectedPath, path),
    )
  )
    return { kind: "excluded" };
  const route = routes.find(
    (route) => route.method === method && matches(route.path, path),
  );
  if (!route) return null;
  return {
    kind: "receipt",
    family: route.family,
    shape: route.shape,
    confirm: route.confirm,
    verifiedContract: route.verifiedContract,
  };
}
function object(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}
function helperState(response: Record<string, unknown>): boolean {
  const settings = object(response.settings),
    desktop = object(response.desktop);
  return (
    !!settings &&
    !!desktop &&
    ["wallpaper", "helper", "both"].includes(String(settings.mode)) &&
    typeof settings.display === "number" &&
    Number.isSafeInteger(settings.display) &&
    settings.display >= 0 &&
    typeof desktop.available === "boolean"
  );
}
let sequence = 0;
/** Fixed public labels only. Successful HTTP is not evidence of an independently verified effect. */
export function settingsWriteReceipt(
  method: string,
  path: string,
  body: unknown,
  result: unknown,
): ActionReceipt | null {
  const policy = classifySettingsWrite(method, path),
    response = object(result),
    request = object(body);
  const helperSavedOnly =
    policy?.kind === "receipt" &&
    policy.shape === "helper" &&
    response !== null &&
    response.applied === false &&
    helperState(response);
  if (
    !policy ||
    policy.kind !== "receipt" ||
    !response ||
    request?.approve === false ||
    (policy.confirm && request?.approve !== true) ||
    response.ok === false ||
    (response.error != null && !helperSavedOnly) ||
    response.executed === false ||
    response.cancelled === true ||
    response.requiresConfirmation === true ||
    response.pendingConfirmation === true ||
    object(response.action) ||
    object(response.confirmation)
  )
    return null;
  const success =
    policy.shape === "ok"
      ? response.ok === true
      : policy.shape === "roles"
        ? object(response.roles) !== null &&
          typeof response.available === "boolean"
        : policy.shape === "workspace"
          ? response.version === 1 &&
            Array.isArray(response.projects) &&
            (response.activeId === null ||
              typeof response.activeId === "string")
          : policy.shape === "widget"
            ? object(response.widget) !== null
            : policy.shape === "wallpaper"
              ? response.available === true && Array.isArray(response.displays)
              : policy.shape === "helper"
                ? helperState(response)
                : Array.isArray(response.fields);
  if (!success) return null;
  const staged =
    response.pendingRestart === true || response.restartRequired === true;
  const requested = `${policy.family} aanpassen`;
  const performed = staged
    ? `${policy.family}: klaargezet; herstart nodig`
    : response.scheduled === true ||
        response.accepted === true ||
        policy.family === "Services herstarten"
      ? `${policy.family}: wijziging aangevraagd`
      : policy.shape === "helper" && response.applied === false
        ? `${policy.family}: keuze opgeslagen; toepassen niet bevestigd`
        : `${policy.family}: wijziging verwerkt`;
  const verified =
    !staged && policy.verifiedContract && response.verified === true;
  const recoverHref =
    policy.family === "Modelrollen"
      ? "/settings?section=models#model-role-history-title"
      : policy.family === "Zijbalk"
        ? "/settings?section=system#sidebar-history"
        : matches("/persona/history/:id/rollback", path)
          ? "/settings?section=personality#persona-history"
          : matches("/persona/preferences/history/:id/rollback", path)
            ? "/settings?section=personality#persona-preferences-history"
            : matches("/tools/history/:id/rollback", path)
              ? "/settings?section=system#tool-switch-history"
              : undefined;
  return {
    id: `settings-write-${Date.now()}-${++sequence}`,
    requested,
    performed,
    ...(recoverHref ? { recoverHref } : {}),
    verification: verified
      ? "De API heeft het resultaat gecontroleerd en bevestigd."
      : "Het effect is niet apart gecontroleerd.",
  };
}
