import { chromium } from "playwright-core";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
/* global document, getComputedStyle, window */
const base = process.env.NOVA_SETTINGS_TEST_URL ?? "https://localhost:5173";
const screenshots = path.resolve("docs/img");
fs.mkdirSync(screenshots, { recursive: true });
const sections = [
  "setup",
  "general",
  "voice",
  "personality",
  "models",
  "code",
  "abilities",
  "skills",
  "automation",
  "connections",
  "services",
  "devices",
  "memory",
  "safety",
  "system",
];
const overview = {
  persona: "Spreek kort en duidelijk.",
  personaStyle: "friendly",
  personaProfile: {
    name: "NOVA",
    character: "warm en nieuwsgierig",
    address: "je/jij",
    avoid: "menselijke ervaringen verzinnen",
  },
  householdProfiles: [
    {
      id: "person-a",
      label: "Profiel A",
      personaProfile: {
        name: "NOVA",
        character: "warm en nieuwsgierig",
        address: "je/jij",
        avoid: "menselijke ervaringen verzinnen",
      },
      communicationPreferences: [],
    },
    {
      id: "person-b",
      label: "Profiel B",
      personaProfile: {
        name: "NOVA",
        character: "warm en nieuwsgierig",
        address: "u",
        avoid: "menselijke ervaringen verzinnen",
      },
      communicationPreferences: [],
    },
  ],
  activeHouseholdProfileId: "person-a",
  quickActions: [{ label: "Het weer", prompt: "Hoe is het weer?" }],
  quickActionsAreDefault: false,
  skills: [
    {
      id: "ochtend",
      name: "Ochtend",
      type: "instruction",
      description: "Een rustige start",
      examples: ["Goedemorgen"],
      instructions: "Bekijk het weer.",
      enabled: true,
      createdAt: "2026-10-09",
      updatedAt: "2026-10-09",
      version: 2,
    },
  ],
  widgets: [
    {
      id: "notitie",
      type: "note",
      title: "Mijn notitie",
      text: "Vergeet de planten niet.",
      enabled: true,
    },
    {
      id: "aantal",
      type: "value",
      title: "Aantal bezoekers",
      source: { url: "https://data.example.invalid/count", extract: "count" },
      unit: "personen",
      refreshMinutes: 15,
      enabled: true,
    },
  ],
  sidebar: [
    { id: "w:notitie", shown: true, column: "left", page: 1 },
    { id: "w:aantal", shown: true, column: "left", page: 1 },
  ],
  builtinPanels: [],
  maxPages: { left: 3, right: 3 },
  abilities: [],
  tools: [],
  pinRequired: false,
  standingApprovals: [],
};
const initialOverviewWidgets = structuredClone(overview.widgets);
const initialOverviewSidebar = structuredClone(overview.sidebar);
const initialServices = [
  {
    id: "omniroute",
    label: "OmniRoute",
    fields: [
      {
        key: "url",
        label: "Gateway-adres",
        kind: "url",
        source: "environment",
        value: "http://omniroute:20128/v1",
      },
      {
        key: "apiKey",
        label: "Toegangssleutel",
        kind: "secret",
        source: "environment",
        set: true,
      },
    ],
    restartRequired: false,
  },
  {
    id: "home-assistant",
    label: "Home Assistant",
    fields: [
      {
        key: "url",
        label: "Adres",
        kind: "url",
        source: "environment",
        value: "http://home.example:8123",
      },
      {
        key: "token",
        label: "Toegangstoken",
        kind: "secret",
        source: "environment",
        set: true,
      },
    ],
    restartRequired: false,
  },
  {
    id: "windows",
    label: "Windows-agent",
    fields: [
      {
        key: "url",
        label: "Agent-adres",
        kind: "url",
        source: "environment",
        value: "http://windows.example:18999",
      },
      {
        key: "token",
        label: "Agent-token",
        kind: "secret",
        source: "environment",
        set: false,
      },
    ],
    restartRequired: false,
  },
  {
    id: "mqtt",
    label: "MQTT",
    fields: [
      {
        key: "url",
        label: "Broker-adres",
        kind: "url",
        source: "environment",
        value: "mqtt://mqtt:1883",
      },
      {
        key: "username",
        label: "Gebruikersnaam",
        kind: "text",
        source: "environment",
        value: "nova",
      },
      {
        key: "password",
        label: "Wachtwoord",
        kind: "secret",
        source: "environment",
        set: true,
      },
    ],
    restartRequired: false,
  },
  {
    id: "qdrant",
    label: "Qdrant",
    fields: [
      {
        key: "url",
        label: "Adres",
        kind: "url",
        source: "environment",
        value: "http://qdrant:6333",
      },
      {
        key: "apiKey",
        label: "Toegangssleutel",
        kind: "secret",
        source: "environment",
        set: false,
      },
      {
        key: "collection",
        label: "Geheugencollectie",
        kind: "text",
        source: "environment",
        value: "nova_memory",
      },
    ],
    restartRequired: false,
  },
  {
    id: "node-red",
    label: "Node-RED",
    fields: [
      {
        key: "url",
        label: "Adres",
        kind: "url",
        source: "environment",
        value: "http://node-red:1880",
      },
    ],
    restartRequired: false,
  },
];
const browser = await chromium.launch({
  headless: true,
  args: ["--no-sandbox"],
});
try {
  for (const [width, scale] of [
    [1280, 1],
    [1280, 2],
    [390, 1],
  ]) {
    overview.widgets = structuredClone(initialOverviewWidgets);
    overview.sidebar = structuredClone(initialOverviewSidebar);
    overview.skills[0] = {
      ...overview.skills[0],
      version: 2,
      description: "Een rustige start",
    };
    const context = await browser.newContext({
      ignoreHTTPSErrors: true,
      viewport: { width, height: 960 },
      deviceScaleFactor: scale,
    });
    const page = await context.newPage();
    page.on("dialog", (dialog) => dialog.accept());
    await page.clock.install();
    const errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    let pinned = false;
    const services = structuredClone(initialServices);
    let tested = false;
    let mqttReads = 0;
    let qdrantReads = 0;
    let qdrantMaintenanceRuns = 0;
    let qdrantReindexRuns = 0;
    let qdrantRollbackRuns = 0;
    let qdrantReindexed = false;
    let homeAccessWrites = 0;
    let homeAccessHistory = [];
    let homeAccessRollbackRuns = 0;
    let homeAccessPolicy = {
      mode: "all",
      areaIds: [],
      deviceIds: [],
      entityIds: [],
    };
    let managedTargetAccessWrites = 0;
    let managedTargetAccessRollbacks = 0;
    const managedTargetPolicy = {
      mode: "all",
      proxmoxNodeIds: [],
      proxmoxGuestIds: [],
      termixHostIds: [],
      pangolinSiteIds: [],
      pangolinResourceIds: [],
    };
    let managedTargetHistory = [];
    let persona = overview.persona;
    let personaStyle = overview.personaStyle;
    let personaProfile = overview.personaProfile;
    let updateChecks = 0;
    let accountsReads = 0;
    let omniUsageReads = 0;
    let apiKeyInventoryReads = 0;
    let tokenLimitReads = 0;
    let tokenLimitWrites = 0;
    let preparedTokenLimit = 0;
    let tokenLimit = 0;
    let keyActivationWrites = 0;
    let keyEnabled = true;
    let keyHistory = [];
    let keyTargetEnabled = false;
    let keyRollbackPrepared = false;
    let keyModelMode = "all";
    let keyModelAllowed = ["free/one", "free/two"];
    let keyModelTargetMode = "restricted";
    let keyModelTarget = ["free/one"];
    let keyModelRollbackFrom = "";
    let keyModelWrites = 0;
    let keyModelHistory = [];
    let accountCreateWrites = 0;
    let accountKeyUpdateWrites = 0;
    let accountRenameWrites = 0;
    let accountRenameHistoryReads = 0;
    let accountRenameRollbackPrepares = 0;
    let accountRenameTarget = "";
    let accountName = "Voorbeeldaccount";
    let comboCreateWrites = 0;
    let comboUpdateWrites = 0;
    let comboName = "example-route";
    let comboRemovalWrites = 0;
    let modelVisibilityReads = 0;
    let accountInventoryGate = null;
    let releaseAccountInventory;
    let accountWrites = 0;
    let accountActivationWrites = 0;
    let accountActivationHistoryReads = 0;
    let accountActivationRollbackPrepares = 0;
    let accountActive = true;
    let comboWrites = 0;
    let comboHistoryReads = 0;
    let comboRollbackPrepares = 0;
    let comboActive = true;
    let preparedComboEnabled = false;
    let accountRemoved = false;
    let policyReads = 0;
    let policyHistoryReads = 0;
    let policyWrites = 0;
    let modelRoleWrites = 0;
    let modelRoleHistoryRollbacks = 0;
    const emptyModelRoles = Object.fromEntries(
      [
        "conversation",
        "code",
        "planning",
        "summary",
        "vision",
        "embedding",
      ].map((id) => [id, { preferred: [], fallback: null }]),
    );
    let modelRoles = structuredClone(emptyModelRoles);
    let modelRoleHistory = [];
    let workspaceProjectWrites = 0;
    let workspaceActiveId = null;
    let workspaceProjects = [];
    let workspaceProjectHistory = [];
    let workspaceHistorySequence = 0;
    let workspaceRollbackTarget = null;
    let importPrepares = 0;
    let importWrites = 0;
    let usageReads = 0;
    let skillVersionReads = 0;
    let helperAgentWrites = 0;
    let helperPreferenceHistoryReads = 0;
    let personaHistoryReads = 0;
    let personaPreferencesHistoryReads = 0;
    let personaPreferencesHistoryWrites = 0;
    let householdProfileHistoryReads = 0;
    let householdProfileHistoryWrites = 0;
    let householdDefinitionHistoryReads = 0;
    let householdDefinitionHistoryWrites = 0;
    let helperPreferenceHistoryWrites = 0;
    let toolSwitchHistoryReads = 0;
    let toolSwitchHistoryWrites = 0;
    let sidebarHistoryReads = 0;
    let sidebarHistoryWrites = 0;
    let noteHistoryReads = 0;
    let noteHistoryWrites = 0;
    let widgetDisplayHistoryReads = 0;
    let widgetDisplayHistoryWrites = 0;
    let restartRequests = 0;
    let restartAvailable = true;
    let helperModeHistoryReads = 0;
    let wallpaperHistoryReads = 0;
    let wallpaperHistoryWrites = 0;
    let nodeRedFlowReads = 0;
    let hotkeyHistoryReads = 0;
    let helperDebugReads = 0;
    const backup = {
      format: "nova-settings",
      version: 1,
      exportedAt: "2026-10-10",
      persona: "Spreek warm en helder.",
      quickActions: overview.quickActions,
      toolOverrides: {},
      skills: overview.skills,
      widgets: [],
      sidebar: null,
      helper: { mode: "helper", display: 1 },
      helperPreferences: {
        autohide: false,
        contrast: true,
        shape: "orb",
        wardrobe: { theme: "gold", seasonal: false, birthday: "" },
        cues: {
          enabled: false,
          volume: 0.15,
          theme: "minimal",
          quiet: { enabled: true, start: "22:00", end: "07:00" },
        },
      },
      lists: {
        boodschappen: [
          {
            id: "1234abcd",
            text: "brood",
            addedAt: "2026-10-10T10:00:00.000Z",
          },
        ],
      },
      connections: {
        omniroute: { url: "http://omniroute:20128/v1" },
        "home-assistant": { url: "http://source.invalid:8123" },
        proxmox: { url: "https://proxmox.invalid:8006", verifyTls: true },
        qdrant: { url: "http://qdrant:6333", collection: "jarvis_memory" },
        mqtt: { url: "mqtt://mqtt:1883" },
        "node-red": { url: "http://node-red:1880" },
        windows: { url: "http://windows-agent:3001" },
        termix: { url: "http://termix:8080" },
        pangolin: {
          url: "https://pangolin.invalid",
          host: "pangolin.invalid",
          orgId: "nova",
          insecureTls: false,
        },
      },
    };
    const missingHeaders = [
      {
        skill: "<script>globalThis.backupLabelRan = true</script>",
        headers: ["Authorization"],
      },
      {
        skill: "<script>globalThis.backupLabelRan = true</script>",
        headers: ["X-API-Key"],
      },
    ];
    const policyAccountId = "77777777-7777-4777-8777-777777777777";
    let nativeMode = "off";
    let nativePreparedMode = "off";
    let nativeWrites = 0;
    let nativeRemovalWrites = 0;
    let nativeModeHistory = [];
    let globalNativeMode = "off";
    let globalPreparedMode = "off";
    let globalNativeWrites = 0;
    let gatewayMemoryEnabled = false;
    let gatewayMemoryWrites = 0;
    let gatewayMemoryTarget = true;
    let gatewayMemoryHistory = [];
    let nativeMemoryRecordsReads = 0;
    let nativeMemoryDeleteWrites = 0;
    let nativeMemoryBulkDeleteWrites = 0;
    let nativeMemoryUpdateWrites = 0;
    let nativeMemoryText = "NOVA onthoudt dat de plant water nodig heeft.";
    let promptWrites = 0;
    let mcpActivityReads = 0;
    let mcpEnabled = true;
    let mcpPendingEnabled = false;
    let mcpHistoryReads = 0;
    let mcpHistory = { revisions: [], truncated: false };
    let mcpTogglePrepares = 0;
    let mcpToggleConfirms = 0;
    let mcpRiskPrepares = 0;
    let mcpRiskConfirms = 0;
    let mcpToolRisk = "SAFE";
    let mcpPendingRisk = "SAFE";
    let mcpCatalogInstalled = false;
    let mcpCatalogOperation = "add";
    let mcpCatalogRollback = false;
    let mcpCatalogConfirms = 0;
    const mcpCatalogRevision = {
      id: "00000000-0000-4000-8000-000000000101",
      at: "2026-10-11T09:00:00Z",
      server: "context7",
      change: { kind: "catalog", operation: "add" },
    };
    const mcpCatalogHistory = {
      revisions: [],
      truncated: false,
    };
    let mcpSecretWrites = 0;
    let mcpSecretValues = {};
    let skillVersion = 2;
    let skillContentReads = 0;
    let skillContentRollbacks = 0;
    let stackRestartPrepares = 0;
    let stackRestartConfirms = 0;
    let stackRestartService = "qdrant";
    let stackRestartResult = { ok: true, service: "qdrant" };
    let nodeRedFlowRuns = 0;
    let nodeRedFlowConfirms = 0;
    let nodeRedFlowTemplates = 0;
    let nodeRedFlowRunSession = "";
    let gatewayPrompt = {
      enabled: false,
      prefixPrompt: "private-existing-prefix",
      suffixPrompt: "private-existing-suffix",
    };
    let promptDraft;
    let hotkeys = {
      open: "Ctrl+Alt+N",
      speak: "Ctrl+Alt+Space",
      mute: "Ctrl+Alt+M",
      desktop: "Ctrl+Alt+D",
    };
    let hotkeyHistory = { revisions: [], truncated: false };
    await page.route(/^https?:\/\/[^/]+\/api\//, async (route) => {
      const request = route.request();
      const url = new URL(request.url());
      const endpoint = url.pathname.slice(4);
      if (
        request.method() !== "GET" &&
        (endpoint === "/settings/helper" ||
          endpoint.startsWith("/settings/helper/") ||
          endpoint === "/settings/wallpaper" ||
          endpoint.startsWith("/windows/"))
      )
        helperAgentWrites++;
      let data = {};
      if (endpoint === "/actions/execute") {
        const body = request.postDataJSON();
        assert.ok(
          [
            "node_red_flow",
            "node_red_flow_state",
            "node_red_flow_create",
          ].includes(body.tool),
        );
        const isStateChange = body.tool === "node_red_flow_state";
        const isTemplate = body.tool === "node_red_flow_create";
        if (isStateChange)
          assert.deepEqual(body.args, { tabId: "tab-home", enabled: false });
        else if (isTemplate) {
          assert.equal(body.args.flow, "tab-home");
          assert.ok(
            ["alert_on_error", "morning_briefing"].includes(body.args.kind),
          );
          if (body.args.kind === "morning_briefing")
            assert.deepEqual(body.args, {
              flow: "tab-home",
              kind: "morning_briefing",
              time: "07:45",
            });
          nodeRedFlowTemplates++;
        } else {
          assert.deepEqual(body.args, { flow: "lights-on", payload: {} });
          nodeRedFlowRuns++;
        }
        nodeRedFlowRunSession = body.sessionId;
        const now = await page.evaluate(() => Date.now());
        const confirmationId = isStateChange
          ? "cdcdcdcd-cdcd-4dcd-8dcd-cdcdcdcdcdcd"
          : isTemplate
            ? nodeRedFlowTemplates === 1
              ? "efefefef-efef-4fef-8fef-efefefefefef"
              : "f0f0f0f0-f0f0-40f0-80f0-f0f0f0f0f0f0"
            : "abababab-abab-4bab-8bab-abababababab";
        data = {
          ok: false,
          requiresConfirmation: true,
          action: {
            confirmationId,
            sessionId: body.sessionId,
            tool: body.tool,
            args: body.args,
            risk: isStateChange || isTemplate ? "DANGEROUS" : "CONFIRM",
            allowAlways: false,
            createdAt: now,
            expiresAt: now + 60000,
          },
        };
      } else if (endpoint === "/actions/confirm") {
        const body = request.postDataJSON();
        assert.equal(body.sessionId, nodeRedFlowRunSession);
        assert.ok(
          [
            "abababab-abab-4bab-8bab-abababababab",
            "cdcdcdcd-cdcd-4dcd-8dcd-cdcdcdcdcdcd",
            "efefefef-efef-4fef-8fef-efefefefefef",
            "f0f0f0f0-f0f0-40f0-80f0-f0f0f0f0f0f0",
          ].includes(body.confirmationId),
        );
        assert.equal(body.approve, true);
        nodeRedFlowConfirms++;
        data = {
          reply:
            body.confirmationId === "efefefef-efef-4fef-8fef-efefefefefef"
              ? "Foutmelding toegevoegd aan Home automation."
              : body.confirmationId === "f0f0f0f0-f0f0-40f0-80f0-f0f0f0f0f0f0"
                ? "Ochtendbriefing toegevoegd aan Home automation."
                : "Flow is uitgevoerd.",
        };
      } else if (endpoint === "/settings/windows/status")
        data = {
          available: true,
          version: "2026-10-10.fixture",
          helperOpen: true,
          paused: false,
          mode: "helper",
          display: 0,
        };
      else if (endpoint === "/settings/windows/helper-debug") {
        helperDebugReads++;
        data = {
          available: true,
          helper:
            "window=0,0,640,340 monitor=-1920,0,0,1080 work=-1920,0,0,1040 dpi=144 scale=1.5 topmost=True",
          view: "chat",
          display: 0,
          checkedAt: "2026-10-11T10:00:00.000Z",
        };
      } else if (endpoint === "/settings/tools/usage") {
        usageReads++;
        data = {
          scannedEntries: 20,
          entryLimit: 500,
          logByteLimit: 2000000,
          oldestAt: "2026-10-10T08:00:00Z",
          latestAt: "2026-10-10T09:00:00Z",
          toolsTruncated: false,
          tools: [
            {
              name: "echo",
              source: "builtin",
              risk: "SAFE",
              enabled: true,
              attempts: 3,
              okResults: 2,
              failedResults: 1,
              lastAt: "2026-10-10T09:00:00Z",
              averageDurationMs: 100,
              contexts: { chat: 2, settings: 1, background: 0, unknown: 0 },
              args: { private: "private-usage-argument" },
              sessionId: "private-usage-session",
            },
            {
              name: "settings_persona_set",
              source: "<script>globalThis.toolUsageSourceRan = true</script>",
              risk: "CONFIRM",
              enabled: false,
              attempts: 1,
              okResults: 1,
              failedResults: 0,
              lastAt: "2026-10-10T08:30:00Z",
              averageDurationMs: 50,
              contexts: { chat: 0, settings: 1, background: 0, unknown: 0 },
            },
            {
              name: "never_called",
              source: "extension",
              risk: "READ_ONLY",
              enabled: true,
              attempts: 0,
              okResults: 0,
              failedResults: 0,
              lastAt: null,
              averageDurationMs: null,
              contexts: { chat: 0, settings: 0, background: 0, unknown: 0 },
            },
          ],
        };
      } else if (endpoint === "/settings/mcp/servers") {
        data = {
          workers: [
            {
              server: "filesystem",
              state: "running",
              workerCount: 1,
              connected: true,
            },
            {
              server: "sequential-thinking",
              state: "running",
              workerCount: 1,
              connected: true,
            },
            {
              server: "context7",
              state: "mixed",
              workerCount: 2,
              connected: false,
            },
            {
              server: "workspace-git",
              state: "missing",
              workerCount: 0,
              connected: null,
            },
          ],
          servers: [
            {
              id: "echo",
              enabled: mcpEnabled,
              connected: mcpEnabled,
              toolCount: mcpEnabled ? 2 : 0,
              defaultRisk: "CONFIRM",
              tools: mcpEnabled
                ? [
                    { name: "echo", risk: "READ_ONLY" },
                    { name: "write_note", risk: mcpToolRisk },
                  ]
                : [],
            },
            ...(mcpCatalogInstalled
              ? [
                  {
                    id: "context7",
                    enabled: false,
                    connected: false,
                    toolCount: 0,
                    defaultRisk: "CONFIRM",
                    tools: [],
                  },
                ]
              : []),
            {
              id: "imap",
              enabled: false,
              connected: false,
              toolCount: 0,
              defaultRisk: "READ_ONLY",
              tools: [],
            },
            {
              id: "github",
              description:
                "Leest issues, pull requests en CI-status van één repository.",
              enabled: false,
              connected: false,
              toolCount: 0,
              defaultRisk: "READ_ONLY",
              tools: [],
            },
          ],
        };
      } else if (endpoint === "/settings/mcp/servers/catalog") {
        data = {
          installed: mcpCatalogInstalled ? ["context7"] : [],
          available: mcpCatalogInstalled
            ? []
            : [
                {
                  id: "context7",
                  label: "Context7",
                  description: "Documentatie opzoeken.",
                  rights: "Alleen documentatie lezen.",
                  risk: "CONFIRM",
                },
              ],
        };
      } else if (
        /^\/settings\/mcp\/servers\/(imap|caldav|github)\/config$/.test(
          endpoint,
        )
      ) {
        const serverId = endpoint.match(
          /^\/settings\/mcp\/servers\/(imap|caldav|github)\/config$/,
        )?.[1];
        if (request.method() === "POST") {
          const body = request.postDataJSON();
          assert.deepEqual(Object.keys(body).sort(), ["clear", "values"]);
          assert.equal(body.clear, false);
          mcpSecretValues = body.values;
          mcpSecretWrites++;
        }
        const fields =
          serverId === "github"
            ? [
                "GITHUB_REPOSITORY_OWNER",
                "GITHUB_REPOSITORY_NAME",
                "GITHUB_PERSONAL_ACCESS_TOKEN",
              ]
            : serverId === "caldav"
              ? ["CALDAV_URL", "CALDAV_USERNAME", "CALDAV_PASSWORD"]
              : ["IMAP_HOST", "IMAP_USER", "IMAP_PASSWORD"];
        data = {
          fields: fields.map((key) => ({
            key,
            configured: request.method() === "POST",
            ...(serverId === "github" &&
            key !== "GITHUB_PERSONAL_ACCESS_TOKEN" &&
            request.method() === "POST"
              ? { value: mcpSecretValues[key] }
              : {}),
          })),
        };
      } else if (
        endpoint === "/settings/mcp/servers/context7/prepare-catalog" &&
        request.method() === "POST"
      ) {
        mcpCatalogOperation = request.postDataJSON().operation;
        mcpCatalogRollback = false;
        assert.ok(["add", "remove"].includes(mcpCatalogOperation));
        data = {
          ok: true,
          warning: "De beoordeelde MCP-server blijft uitgeschakeld.",
          action: {
            confirmationId: "12121212-1212-4121-8121-121212121212",
            sessionId:
              "settings-mcp-catalog:13131313-1313-4131-8131-131313131313",
            tool: "settings_mcp_catalog_change",
            args: { server: "context7", operation: "add" },
            risk: "DANGEROUS",
            allowAlways: false,
            createdAt: 1791630000000,
            expiresAt: 1791630060000,
          },
        };
      } else if (
        endpoint === "/settings/mcp/servers/confirm-catalog" &&
        request.method() === "POST"
      ) {
        assert.equal(request.postDataJSON().approve, true);
        mcpCatalogConfirms++;
        const catalogBody = request.postDataJSON();
        mcpCatalogOperation = catalogBody.operation ?? mcpCatalogOperation;
        mcpCatalogInstalled = mcpCatalogOperation === "add";
        mcpCatalogHistory.revisions.unshift({
          id: `00000000-0000-4000-8000-${String(100 + mcpCatalogConfirms).padStart(12, "0")}`,
          at: `2026-10-11T09:0${mcpCatalogConfirms}:00Z`,
          server: "context7",
          change: {
            kind: "catalog",
            operation: mcpCatalogOperation,
            ...(mcpCatalogRollback
              ? { rollbackOf: mcpCatalogRevision.id }
              : {}),
          },
        });
        mcpCatalogRollback = false;
        data = {
          ok: true,
          verified: true,
          server: "context7",
          operation: mcpCatalogOperation,
        };
      } else if (
        endpoint ===
          "/settings/mcp/servers/echo/tools/write_note/prepare-risk" &&
        request.method() === "POST"
      ) {
        mcpPendingRisk = request.postDataJSON().risk;
        mcpRiskPrepares++;
        data = {
          ok: true,
          warning: "Dit wijzigt het risiconiveau van één MCP-gereedschap.",
          action: {
            confirmationId: "77777777-7777-4777-8777-777777777777",
            sessionId: "settings-mcp:66666666-6666-4666-8666-666666666666",
            tool: "settings_mcp_tool_risk",
            args: { server: "echo", tool: "write_note", risk: mcpPendingRisk },
            risk: "DANGEROUS",
            allowAlways: false,
            createdAt: 1791630000000,
            expiresAt: 1791630060000,
          },
        };
      } else if (
        endpoint === "/settings/mcp/servers/confirm-tool-risk" &&
        request.method() === "POST"
      ) {
        assert.equal(request.postDataJSON().approve, true);
        mcpRiskConfirms++;
        const previousRisk = mcpToolRisk;
        const rollbackRevisionId = request.postDataJSON().rollbackRevisionId;
        const rollbackRevision = mcpHistory.revisions.find(
          (revision) => revision.id === rollbackRevisionId,
        );
        mcpToolRisk = rollbackRevision
          ? rollbackRevision.change.before
          : mcpPendingRisk;
        mcpHistory.revisions.unshift({
          id: `00000000-0000-4000-8000-0000000000${10 + mcpRiskConfirms}`,
          at: `2026-10-10T09:1${mcpRiskConfirms}:00Z`,
          server: "echo",
          change: {
            kind: "tool-risk",
            tool: "write_note",
            before: previousRisk,
            after: mcpToolRisk,
          },
        });
        data = { ok: true, risk: mcpToolRisk };
      } else if (
        endpoint === "/settings/mcp/servers/echo/prepare-toggle" &&
        request.method() === "POST"
      ) {
        assert.equal(request.postDataJSON().enabled, false);
        mcpTogglePrepares++;
        mcpPendingEnabled = request.postDataJSON().enabled;
        data = {
          ok: true,
          warning: "Uitschakelen stopt het ingestelde programma.",
          action: {
            confirmationId: "88888888-8888-4888-8888-888888888888",
            sessionId: "settings-mcp:99999999-9999-4999-8999-999999999999",
            tool: "settings_mcp_server_toggle",
            args: { server: "echo", enabled: false },
            risk: "DANGEROUS",
            allowAlways: false,
            createdAt: 1791630000000,
            expiresAt: 1791630060000,
          },
        };
      } else if (
        endpoint === "/settings/mcp/servers/confirm-toggle" &&
        request.method() === "POST"
      ) {
        assert.equal(request.postDataJSON().approve, true);
        mcpToggleConfirms++;
        const before = mcpEnabled;
        mcpEnabled = mcpPendingEnabled;
        mcpHistory.revisions.unshift({
          id: `00000000-0000-4000-8000-${String(mcpToggleConfirms).padStart(12, "0")}`,
          at: `2026-10-10T09:0${mcpToggleConfirms}:00Z`,
          server: "echo",
          change: { kind: "enabled", before, after: mcpEnabled },
        });
        data = { ok: true, server: "echo", enabled: mcpEnabled };
      } else if (
        endpoint.startsWith("/settings/mcp/servers/echo/history/") &&
        endpoint.endsWith("/prepare-rollback") &&
        request.method() === "POST"
      ) {
        const revisionId = endpoint.split("/").at(-2);
        const revision = mcpHistory.revisions.find(
          (item) => item.id === revisionId,
        );
        assert.ok(revision, "rollback only prepares a visible history item");
        if (revision.change.kind === "tool-risk") {
          mcpPendingRisk = revision.change.before;
          data = {
            ok: true,
            warning: "Dit zet het eerdere MCP-gereedschapsrisico terug.",
            action: {
              confirmationId: "44444444-4444-4444-8444-444444444444",
              sessionId: "settings-mcp:55555555-5555-4555-8555-555555555555",
              tool: "settings_mcp_tool_risk",
              args: {
                server: "echo",
                tool: "write_note",
                risk: mcpPendingRisk,
                rollbackRevisionId: revisionId,
              },
              risk: "DANGEROUS",
              allowAlways: false,
              createdAt: 1791630000000,
              expiresAt: 1791630060000,
            },
          };
        } else {
          mcpPendingEnabled = true;
          data = {
            ok: true,
            warning:
              "Dit zet de eerdere MCP-stand terug en start of stopt de MCP-server.",
            action: {
              confirmationId: "33333333-3333-4333-8333-333333333333",
              sessionId: "settings-mcp:22222222-2222-4222-8222-222222222222",
              tool: "settings_mcp_server_toggle",
              args: {
                server: "echo",
                enabled: true,
                rollbackRevisionId: "00000000-0000-4000-8000-000000000001",
              },
              risk: "DANGEROUS",
              allowAlways: false,
              createdAt: 1791630000000,
              expiresAt: 1791630060000,
            },
          };
        }
      } else if (endpoint === "/settings/mcp/servers/echo/history") {
        mcpHistoryReads++;
        data = mcpHistory;
      } else if (endpoint === "/settings/mcp/servers/context7/history") {
        data = mcpCatalogHistory;
      } else if (
        endpoint ===
          `/settings/mcp/servers/context7/history/${mcpCatalogRevision.id}/prepare-rollback` &&
        request.method() === "POST"
      ) {
        mcpCatalogOperation = "remove";
        mcpCatalogRollback = true;
        data = {
          ok: true,
          warning:
            "NOVA-toevoeging verwijderen; server moet uitgeschakeld zijn.",
          action: {
            confirmationId: "15151515-1515-4151-8151-151515151515",
            sessionId:
              "settings-mcp-catalog:16161616-1616-4161-8161-161616161616",
            tool: "settings_mcp_catalog_change",
            args: {
              server: "context7",
              operation: "remove",
              rollbackRevisionId: mcpCatalogRevision.id,
            },
            risk: "DANGEROUS",
            allowAlways: false,
            createdAt: 1791630000000,
            expiresAt: 1791630060000,
          },
        };
      } else if (endpoint === "/settings/mcp/servers/echo/activity") {
        mcpActivityReads++;
        data = {
          truncated: true,
          events: [
            {
              at: "2026-10-10T09:00:00Z",
              kind: "tool_succeeded",
              tool: "echo",
            },
            { at: "2026-10-10T08:59:00Z", kind: "connected" },
          ],
        };
      } else if (endpoint === "/settings/stack-control/services") {
        data = {
          available: true,
          services: [
            ["nova", "NOVA"],
            ["node-red", "Node-RED"],
            ["omniroute", "OmniRoute"],
            ["mqtt", "MQTT"],
            ["qdrant", "Qdrant"],
            ["home-assistant", "Home Assistant"],
            ["stack-control", "Stackbeheer"],
          ].map(([id, label]) => ({
            id,
            label,
            state: "running",
            health: "healthy",
            canRestart: id !== "stack-control",
            revision: "a".repeat(64),
          })),
        };
      } else if (endpoint === "/settings/helper/hotkeys") {
        if (request.method() === "PUT") {
          hotkeyHistory = {
            revisions: [
              {
                id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
                at: "2026-10-10T08:30:00Z",
                before: { ...hotkeys },
                after: { ...request.postDataJSON().hotkeys },
              },
            ],
            truncated: false,
          };
          hotkeys = request.postDataJSON().hotkeys;
        }
        data = {
          ok: true,
          preferences: { hotkeys, warnings: [], paused: false },
        };
      } else if (endpoint === "/settings/helper/hotkeys/history") {
        hotkeyHistoryReads++;
        data = hotkeyHistory;
      } else if (
        endpoint ===
        "/settings/helper/hotkeys/history/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa/rollback"
      ) {
        hotkeys = { ...hotkeyHistory.revisions[0].before };
        data = { ok: true, hotkeys, warnings: [] };
      } else if (endpoint === "/settings/updates")
        data = {
          running: "v0.1.10",
          checkedAt: null,
          updateAvailable: null,
          latest: null,
        };
      else if (endpoint === "/settings/updates/check") {
        updateChecks++;
        data = {
          running: "v0.1.10",
          checkedAt: "2026-10-10T09:00:00Z",
          updateAvailable: true,
          latest: {
            version: "v0.1.11",
            url: "https://github.com/hjongedijk/nova/releases/tag/v0.1.11",
            publishedAt: "2026-10-10T08:00:00Z",
            notes:
              "Fixture changes <script>window.fixtureInjected = true</script>",
          },
        };
      } else if (endpoint === "/settings/omniroute/accounts") {
        accountsReads++;
        if (accountInventoryGate) await accountInventoryGate;
        data = {
          available: true,
          truncated: false,
          billingVerified: false,
          connections: accountRemoved
            ? []
            : [
                {
                  id: "fixture-account",
                  provider: "fixture",
                  name: accountName,
                  active: true,
                  credentialPresent: true,
                },
              ],
          models: [
            {
              provider: "fixture",
              modelId: "example:free",
              name: "<script>globalThis.accountCatalogRan = true</script>",
              freeType: "trial",
              monthlyTokens: 10000,
              creditTokens: null,
            },
          ],
          combos: [
            {
              id: "fixture-combo",
              name: comboName,
              displayName: "Voorbeeldroute",
              active: comboActive,
              strategy: "priority",
              models: ["fixture/example:free"],
              systemMessage: "private combo text",
            },
          ],
        };
      } else if (endpoint === "/settings/omniroute/accounts/usage") {
        omniUsageReads++;
        data = {
          available: true,
          truncated: false,
          intervalMinutes: 70,
          lastAutoSyncAt: "2026-10-10T10:00:00.000Z",
          billingVerified: false,
          connections: [
            {
              id: "fixture-account",
              provider: "fixture",
              name: "Voorbeeldaccount",
              fetchedAt: "2026-10-10T10:00:00.000Z",
              stale: false,
              quotas: [
                {
                  window: "daily",
                  limit: 1000,
                  remaining: 750,
                  remainingPercentage: 75,
                  resetAt: "2026-10-11T10:00:00.000Z",
                  unlimited: false,
                },
              ],
            },
          ],
        };
      } else if (endpoint === "/settings/omniroute/accounts/model-visibility") {
        modelVisibilityReads++;
        data = {
          available: true,
          truncated: false,
          hidden: [{ provider: "fixture", modelId: "hidden-model" }],
        };
      } else if (endpoint === "/settings/omniroute/accounts/keys") {
        apiKeyInventoryReads++;
        data = {
          available: true,
          truncated: false,
          keys: [
            {
              id: "fixture-key",
              name: "NOVA local key",
              active: true,
              isNovaKey: true,
              accessMode: "restricted",
              allowedModelCount: 1,
              allowedComboCount: 0,
              allowedConnectionCount: 1,
              expiresAt: null,
              key: "private-fixture-secret",
            },
            {
              id: "fixture-client-key",
              name: "Client key",
              active: keyEnabled,
              isNovaKey: false,
              accessMode: "all",
              allowedModelCount: 0,
              allowedComboCount: 0,
              allowedConnectionCount: 0,
              expiresAt: null,
            },
          ],
        };
      } else if (
        endpoint ===
        "/settings/omniroute/accounts/keys/fixture-client-key/token-limits"
      ) {
        assert.equal(request.headers()["x-nova-admin"], "1");
        tokenLimitReads++;
        data = {
          available: true,
          keyId: "fixture-client-key",
          keyName: "Client key",
          truncated: false,
          limits: tokenLimitWrites
            ? [
                {
                  id: "abababab-abab-4bab-8bab-abababababab",
                  scopeType: "global",
                  scopeValue: "",
                  tokenLimit,
                  resetInterval: "weekly",
                  resetTime: "00:00",
                  enabled: true,
                },
              ]
            : [],
        };
      } else if (
        endpoint ===
        "/settings/omniroute/accounts/keys/fixture-client-key/token-limits/prepare"
      ) {
        assert.equal(request.headers()["x-nova-admin"], "1");
        assert.deepEqual(request.postDataJSON(), {
          tokenLimit: 5000,
          resetInterval: "weekly",
          acknowledgeGlobalEffect: true,
        });
        preparedTokenLimit = 5000;
        const now = await page.evaluate(() => Date.now());
        data = {
          ok: true,
          oldLimit: null,
          tokenLimit: preparedTokenLimit,
          resetInterval: "weekly",
          action: {
            confirmationId: "abababab-cccc-4bab-8bab-abababababab",
            sessionId:
              "settings-token-limit:abababab-cccc-4bab-8bab-abababababab",
            tool: "omniroute_token_limit",
            args: {
              keyId: "fixture-client-key",
              tokenLimit: preparedTokenLimit,
            },
            risk: "DANGEROUS",
            allowAlways: false,
            createdAt: now,
            expiresAt: now + 60000,
          },
        };
      } else if (
        endpoint ===
        "/settings/omniroute/accounts/keys/fixture-client-key/token-limits/confirm"
      ) {
        assert.equal(request.headers()["x-nova-admin"], "1");
        assert.equal(request.postDataJSON().approve, true);
        tokenLimitWrites++;
        tokenLimit = preparedTokenLimit;
        data = { ok: true, verified: true };
      } else if (
        endpoint ===
        "/settings/omniroute/accounts/keys/fixture-client-key/model-access"
      ) {
        data = {
          available: true,
          accessMode: keyModelMode,
          allowedModels: keyModelAllowed,
          verifiedFreeModels: ["free/one", "free/two"],
          revision: String(keyModelWrites + 1).padStart(64, "a"),
        };
      } else if (
        endpoint ===
        "/settings/omniroute/accounts/keys/fixture-client-key/model-access/history"
      ) {
        data = { revisions: keyModelHistory, truncated: false };
      } else if (
        endpoint ===
        "/settings/omniroute/accounts/keys/fixture-client-key/model-access/prepare"
      ) {
        assert.equal(request.headers()["x-nova-admin"], "1");
        const body = request.postDataJSON();
        assert.equal(body.acknowledgeGlobalEffect, true);
        assert.equal(
          body.revision,
          String(keyModelWrites + 1).padStart(64, "a"),
        );
        keyModelTarget = body.allowedModels;
        keyModelTargetMode = "restricted";
        keyModelRollbackFrom = "";
        const now = await page.evaluate(() => Date.now());
        data = {
          ok: true,
          name: "Client key",
          modelCount: keyModelTarget.length,
          action: {
            confirmationId: "14141414-1414-4141-8141-141414141414",
            sessionId:
              "settings-key-model-access:14141414-1414-4141-8141-141414141414",
            tool: "omniroute_key_model_access",
            args: { id: "fixture-client-key", mode: "restricted" },
            risk: "DANGEROUS",
            allowAlways: false,
            createdAt: now,
            expiresAt: now + 60000,
          },
        };
      } else if (
        endpoint ===
        "/settings/omniroute/accounts/keys/fixture-client-key/model-access/prepare-rollback"
      ) {
        assert.equal(request.headers()["x-nova-admin"], "1");
        assert.deepEqual(request.postDataJSON(), {
          revisionId: "15151515-1515-4151-8151-151515151515",
          acknowledgeGlobalEffect: true,
        });
        keyModelTargetMode = "all";
        keyModelTarget = [];
        keyModelRollbackFrom = "15151515-1515-4151-8151-151515151515";
        const now = await page.evaluate(() => Date.now());
        data = {
          ok: true,
          name: "Client key",
          modelCount: 0,
          warning:
            "Dit herstelt onbeperkte modeltoegang voor alle clients met deze sleutel.",
          action: {
            confirmationId: "16161616-1616-4161-8161-161616161616",
            sessionId:
              "settings-key-model-access:16161616-1616-4161-8161-161616161616",
            tool: "omniroute_key_model_access",
            args: { id: "fixture-client-key", mode: "all" },
            risk: "DANGEROUS",
            allowAlways: false,
            createdAt: now,
            expiresAt: now + 60000,
          },
        };
      } else if (
        endpoint ===
        "/settings/omniroute/accounts/keys/fixture-client-key/model-access/confirm"
      ) {
        assert.equal(request.headers()["x-nova-admin"], "1");
        if (request.postDataJSON().approve) {
          keyModelWrites++;
          const beforeMode = keyModelMode;
          const beforeModels = [...keyModelAllowed];
          keyModelMode = keyModelTargetMode;
          keyModelAllowed =
            keyModelTargetMode === "all"
              ? ["free/one", "free/two"]
              : [...keyModelTarget];
          keyModelHistory.unshift({
            id:
              keyModelWrites === 1
                ? "15151515-1515-4151-8151-151515151515"
                : "17171717-1717-4171-8171-171717171717",
            at: "2026-10-11T10:05:00.000Z",
            keyId: "fixture-client-key",
            name: "Client key",
            beforeMode,
            beforeModels: beforeMode === "all" ? [] : beforeModels,
            afterMode: keyModelMode,
            afterModels: keyModelMode === "all" ? [] : [...keyModelTarget],
            ...(keyModelRollbackFrom
              ? { revertedFrom: keyModelRollbackFrom }
              : {}),
          });
          data = {
            ok: true,
            verified: true,
            routeReady: true,
            allowedModels: keyModelMode === "all" ? [] : keyModelAllowed,
          };
        } else data = { ok: true, cancelled: true };
      } else if (
        endpoint ===
        "/settings/omniroute/accounts/keys/fixture-client-key/activation/prepare"
      ) {
        assert.equal(request.headers()["x-nova-admin"], "1");
        keyTargetEnabled = false;
        keyRollbackPrepared = false;
        assert.deepEqual(request.postDataJSON(), {
          enabled: false,
          acknowledgeGlobalEffect: true,
        });
        const now = await page.evaluate(() => Date.now());
        data = {
          ok: true,
          name: "Client key",
          currentEnabled: true,
          enabled: false,
          action: {
            confirmationId: "abababab-abab-4bab-8bab-abababababab",
            sessionId:
              "settings-key-activation:abababab-abab-4bab-8bab-abababababab",
            tool: "omniroute_key_activation",
            args: {
              id: "fixture-client-key",
              enabled: false,
              revision: "fixture-key-hash",
            },
            risk: "DANGEROUS",
            allowAlways: false,
            createdAt: now,
            expiresAt: now + 60000,
          },
        };
      } else if (
        endpoint ===
        "/settings/omniroute/accounts/keys/fixture-client-key/activation/history"
      ) {
        data = { revisions: keyHistory };
      } else if (
        endpoint ===
        "/settings/omniroute/accounts/keys/fixture-client-key/activation/history/eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee/prepare-rollback"
      ) {
        assert.equal(request.headers()["x-nova-admin"], "1");
        keyTargetEnabled = true;
        keyRollbackPrepared = true;
        const now = await page.evaluate(() => Date.now());
        data = {
          ok: true,
          name: "Client key",
          currentEnabled: false,
          enabled: true,
          action: {
            confirmationId: "cdcdcdcd-cdcd-4dcd-8dcd-cdcdcdcdcdcd",
            sessionId:
              "settings-key-activation:cdcdcdcd-cdcd-4dcd-8dcd-cdcdcdcdcdcd",
            tool: "omniroute_key_activation",
            args: {
              id: "fixture-client-key",
              enabled: true,
              revision: "fixture-key-hash-after",
            },
            risk: "DANGEROUS",
            allowAlways: false,
            createdAt: now,
            expiresAt: now + 60000,
          },
        };
      } else if (
        endpoint ===
        "/settings/omniroute/accounts/keys/fixture-client-key/activation/confirm"
      ) {
        assert.equal(request.headers()["x-nova-admin"], "1");
        if (request.postDataJSON().approve) {
          keyActivationWrites++;
          const beforeEnabled = keyEnabled;
          keyEnabled = keyTargetEnabled;
          keyHistory.unshift({
            id:
              keyActivationWrites === 1
                ? "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee"
                : "ffffffff-ffff-4fff-8fff-ffffffffffff",
            kind: "key",
            entityId: "fixture-client-key",
            name: "Client key",
            at: "2026-10-11T10:00:00.000Z",
            beforeEnabled,
            afterEnabled: keyEnabled,
          });
          data = {
            ok: true,
            verified: true,
            enabled: keyEnabled,
            routeReady: true,
            ...(keyRollbackPrepared
              ? {
                  historyWarning: "Geschiedeniswaarschuwing proef",
                  auditWarning: "Actielogwaarschuwing proef",
                }
              : {}),
          };
        } else data = { ok: true };
      } else if (endpoint === "/settings/omniroute/accounts/create/prepare") {
        assert.equal(request.headers()["x-nova-admin"], "1");
        assert.deepEqual(request.postDataJSON(), {
          provider: "mistral",
          name: "Mijn Mistral",
          apiKey: "provider-key-test-secret",
          acknowledgeEffects: true,
        });
        const now = await page.evaluate(() => Date.now());
        data = {
          ok: true,
          provider: "mistral",
          name: "Mijn Mistral",
          action: {
            confirmationId: "cacacaca-caca-4aca-8aca-cacacacacaca",
            sessionId:
              "settings-account-create:cacacaca-caca-4aca-8aca-cacacacacaca",
            tool: "omniroute_account_create",
            args: {
              requestId: "fixture-account-create",
              provider: "mistral",
              name: "Mijn Mistral",
            },
            risk: "DANGEROUS",
            allowAlways: false,
            createdAt: now,
            expiresAt: now + 60000,
          },
        };
      } else if (endpoint === "/settings/omniroute/accounts/create/confirm") {
        assert.equal(request.headers()["x-nova-admin"], "1");
        if (request.postDataJSON().approve) {
          accountCreateWrites++;
          data = {
            ok: true,
            verified: true,
            id: "created-account",
            provider: "mistral",
            name: "Mijn Mistral",
            active: false,
            routeReady: true,
          };
        } else data = { ok: true };
      } else if (
        endpoint === "/settings/omniroute/accounts/key-update/prepare"
      ) {
        assert.equal(request.headers()["x-nova-admin"], "1");
        assert.deepEqual(request.postDataJSON(), {
          id: "fixture-account",
          apiKey: "replacement-key-test-secret",
          acknowledgeEffects: true,
        });
        const now = await page.evaluate(() => Date.now());
        data = {
          ok: true,
          id: "fixture-account",
          provider: "fixture",
          name: "Voorbeeldaccount",
          action: {
            confirmationId: "dededede-dede-4ede-8ede-dededededede",
            sessionId:
              "settings-account-key-update:dededede-dede-4ede-8ede-dededededede",
            tool: "omniroute_account_key_update",
            args: { requestId: "fixture-key-rotation", id: "fixture-account" },
            risk: "DANGEROUS",
            allowAlways: false,
            createdAt: now,
            expiresAt: now + 60000,
          },
        };
      } else if (
        endpoint === "/settings/omniroute/accounts/key-update/confirm"
      ) {
        assert.equal(request.headers()["x-nova-admin"], "1");
        if (request.postDataJSON().approve) {
          accountKeyUpdateWrites++;
          data = {
            ok: true,
            verified: true,
            id: "fixture-account",
            routeReady: true,
          };
        } else data = { ok: true };
      } else if (
        endpoint ===
        "/settings/omniroute/accounts/rename/fixture-account/history"
      ) {
        accountRenameHistoryReads++;
        data = {
          revisions:
            accountRenameWrites === 0
              ? []
              : accountRenameWrites === 1
                ? [
                    {
                      id: "77777777-7777-4777-8777-777777777777",
                      at: "2026-10-11T10:00:00.000Z",
                      accountId: "fixture-account",
                      provider: "fixture",
                      beforeName: "Voorbeeldaccount",
                      afterName: "Nieuwe naam",
                    },
                  ]
                : [
                    {
                      id: "88888888-8888-4888-8888-888888888888",
                      at: "2026-10-11T10:01:00.000Z",
                      accountId: "fixture-account",
                      provider: "fixture",
                      beforeName: "Nieuwe naam",
                      afterName: "Voorbeeldaccount",
                      revertedFrom: "77777777-7777-4777-8777-777777777777",
                    },
                    {
                      id: "77777777-7777-4777-8777-777777777777",
                      at: "2026-10-11T10:00:00.000Z",
                      accountId: "fixture-account",
                      provider: "fixture",
                      beforeName: "Voorbeeldaccount",
                      afterName: "Nieuwe naam",
                    },
                  ],
        };
      } else if (
        endpoint ===
          "/settings/omniroute/accounts/rename/fixture-account/history/77777777-7777-4777-8777-777777777777/prepare-rollback" &&
        request.method() === "POST"
      ) {
        accountRenameRollbackPrepares++;
        assert.equal(request.headers()["x-nova-admin"], "1");
        assert.deepEqual(request.postDataJSON(), { acknowledgeEffects: true });
        accountRenameTarget = "Voorbeeldaccount";
        const now = await page.evaluate(() => Date.now());
        data = {
          ok: true,
          id: "fixture-account",
          provider: "fixture",
          oldName: "Nieuwe naam",
          newName: "Voorbeeldaccount",
          action: {
            confirmationId: "99999999-7777-4777-8777-777777777777",
            sessionId:
              "settings-account-rename:99999999-7777-4777-8777-777777777777",
            tool: "omniroute_account_rename",
            args: {
              id: "fixture-account",
              provider: "fixture",
              oldName: "Nieuwe naam",
              newName: "Voorbeeldaccount",
              rollbackRevisionId: "77777777-7777-4777-8777-777777777777",
            },
            risk: "DANGEROUS",
            allowAlways: false,
            createdAt: now,
            expiresAt: now + 60000,
          },
        };
      } else if (endpoint === "/settings/omniroute/accounts/rename/prepare") {
        assert.equal(request.headers()["x-nova-admin"], "1");
        assert.deepEqual(request.postDataJSON(), {
          id: "fixture-account",
          name: "Nieuwe naam",
          acknowledgeEffects: true,
        });
        accountRenameTarget = "Nieuwe naam";
        const now = await page.evaluate(() => Date.now());
        data = {
          ok: true,
          id: "fixture-account",
          provider: "fixture",
          oldName: "Voorbeeldaccount",
          newName: "Nieuwe naam",
          action: {
            confirmationId: "99999999-6666-4666-8666-666666666666",
            sessionId:
              "settings-account-rename:99999999-6666-4666-8666-666666666666",
            tool: "omniroute_account_rename",
            args: {
              id: "fixture-account",
              provider: "fixture",
              oldName: "Voorbeeldaccount",
              newName: "Nieuwe naam",
            },
            risk: "DANGEROUS",
            allowAlways: false,
            createdAt: now,
            expiresAt: now + 60000,
          },
        };
      } else if (endpoint === "/settings/omniroute/accounts/rename/confirm") {
        assert.equal(request.headers()["x-nova-admin"], "1");
        if (request.postDataJSON().approve) {
          accountRenameWrites++;
          accountName = accountRenameTarget;
          data = {
            ok: true,
            verified: true,
            id: "fixture-account",
            provider: "fixture",
            name: accountName,
          };
        } else data = { ok: true };
      } else if (endpoint === "/settings/omniroute/combos/create/prepare") {
        assert.equal(request.headers()["x-nova-admin"], "1");
        assert.deepEqual(request.postDataJSON(), {
          name: "Mijn testcombo",
          models: ["fixture/example:free"],
          acknowledgeGlobalEffect: true,
        });
        const now = await page.evaluate(() => Date.now());
        data = {
          ok: true,
          name: "Mijn testcombo",
          models: ["fixture/example:free"],
          action: {
            confirmationId: "cdcdcdcd-cdcd-4dcd-8dcd-cdcdcdcdcdcd",
            sessionId:
              "settings-combo-create:cdcdcdcd-cdcd-4dcd-8dcd-cdcdcdcdcdcd",
            tool: "omniroute_combo_create",
            args: {
              name: "Mijn testcombo",
              models: [{ provider: "fixture", modelId: "example:free" }],
            },
            risk: "DANGEROUS",
            allowAlways: false,
            createdAt: now,
            expiresAt: now + 60000,
          },
        };
      } else if (endpoint === "/settings/omniroute/combos/create/confirm") {
        assert.equal(request.headers()["x-nova-admin"], "1");
        if (request.postDataJSON().approve) {
          comboCreateWrites++;
          data = {
            ok: true,
            verified: true,
            id: "fixture-created-combo",
            name: "Mijn testcombo",
            routeReady: true,
          };
        } else data = { ok: true };
      } else if (
        endpoint === "/settings/omniroute/combos/fixture-combo/update/history"
      ) {
        assert.equal(request.headers()["x-nova-admin"], "1");
        data = {
          revisions: [
            {
              id: "abababab-abab-4bab-8bab-abababababab",
              at: "2026-10-11T18:00:00.000Z",
              comboId: "fixture-combo",
              beforeName: "Oorspronkelijke route",
              afterName: "Bewerkte route",
              beforeModels: ["fixture/original:free"],
              afterModels: ["fixture/example:free"],
            },
          ],
        };
      } else if (
        endpoint ===
        "/settings/omniroute/combos/fixture-combo/update/history/abababab-abab-4bab-8bab-abababababab/prepare-rollback"
      ) {
        assert.equal(request.headers()["x-nova-admin"], "1");
        assert.deepEqual(request.postDataJSON(), {});
        const now = await page.evaluate(() => Date.now());
        data = {
          ok: true,
          name: "Oorspronkelijke route",
          models: ["fixture/original:free"],
          action: {
            confirmationId: "cdcdcdcd-cdcd-4dcd-8dcd-cdcdcdcdcdcd",
            sessionId:
              "settings-combo-update:cdcdcdcd-cdcd-4dcd-8dcd-cdcdcdcdcdcd",
            tool: "omniroute_combo_update",
            args: { id: "fixture-combo", revision: "fixture-combo-revision" },
            risk: "DANGEROUS",
            allowAlways: false,
            createdAt: now,
            expiresAt: now + 60000,
          },
        };
      } else if (
        endpoint === "/settings/omniroute/combos/fixture-combo/update/prepare"
      ) {
        assert.equal(request.headers()["x-nova-admin"], "1");
        assert.deepEqual(request.postDataJSON(), {
          name: "Bewerkte route",
          models: ["fixture/example:free"],
          acknowledgeGlobalEffect: true,
        });
        const now = await page.evaluate(() => Date.now());
        data = {
          ok: true,
          name: "Bewerkte route",
          models: ["fixture/example:free"],
          action: {
            confirmationId: "dededede-dede-4ded-8ded-dededededede",
            sessionId:
              "settings-combo-update:dededede-dede-4ded-8ded-dededededede",
            tool: "omniroute_combo_update",
            args: { id: "fixture-combo", revision: "fixture-combo-revision" },
            risk: "DANGEROUS",
            allowAlways: false,
            createdAt: now,
            expiresAt: now + 60000,
          },
        };
      } else if (
        endpoint === "/settings/omniroute/combos/fixture-combo/update/confirm"
      ) {
        assert.equal(request.headers()["x-nova-admin"], "1");
        if (request.postDataJSON().approve) {
          comboUpdateWrites++;
          comboName =
            comboUpdateWrites === 1
              ? "Bewerkte route"
              : "Oorspronkelijke route";
          data = {
            ok: true,
            verified: true,
            routeReady: true,
            ...(comboUpdateWrites > 1
              ? { historyWarning: "Testgeschiedenis bijgewerkt." }
              : {}),
          };
        } else data = { ok: true };
      } else if (
        endpoint === "/settings/omniroute/combos/fixture-combo/removal/prepare"
      ) {
        assert.equal(request.headers()["x-nova-admin"], "1");
        assert.deepEqual(request.postDataJSON(), { acknowledgeEffects: true });
        const now = await page.evaluate(() => Date.now());
        data = {
          ok: true,
          name: "Voorbeeldroute",
          action: {
            confirmationId: "efefefef-efef-4fef-8fef-efefefefefef",
            sessionId:
              "settings-combo-remove:efefefef-efef-4fef-8fef-efefefefefef",
            tool: "omniroute_combo_remove",
            args: { id: "fixture-combo", revision: "fixture-combo-revision" },
            risk: "DANGEROUS",
            allowAlways: false,
            createdAt: now,
            expiresAt: now + 60000,
          },
        };
      } else if (
        endpoint === "/settings/omniroute/combos/fixture-combo/removal/confirm"
      ) {
        assert.equal(request.headers()["x-nova-admin"], "1");
        if (request.postDataJSON().approve) {
          comboRemovalWrites++;
          data = { ok: true, verified: true, routeReady: false };
        } else data = { ok: true };
      } else if (
        endpoint ===
        "/settings/omniroute/accounts/fixture-account/activation/history"
      ) {
        accountActivationHistoryReads++;
        data = {
          revisions:
            accountActivationWrites === 0
              ? []
              : [
                  {
                    id: "44444444-4444-4444-8444-444444444444",
                    kind: "account",
                    entityId: "fixture-account",
                    name: "Voorbeeldaccount",
                    at: "2026-10-10T10:00:00.000Z",
                    beforeEnabled: true,
                    afterEnabled: false,
                  },
                ],
        };
      } else if (
        endpoint ===
          "/settings/omniroute/accounts/fixture-account/activation/history/44444444-4444-4444-8444-444444444444/prepare-rollback" &&
        request.method() === "POST"
      ) {
        accountActivationRollbackPrepares++;
        const now = await page.evaluate(() => Date.now());
        data = {
          ok: true,
          name: "Voorbeeldaccount",
          currentEnabled: false,
          enabled: true,
          action: {
            confirmationId: "33333333-3333-4333-8333-333333333333",
            sessionId:
              "settings-account-activation:22222222-2222-4222-8222-222222222222",
            tool: "omniroute_account_activation",
            args: {
              id: "fixture-account",
              enabled: true,
              revision: "fixture-account-current-hash",
            },
            risk: "DANGEROUS",
            allowAlways: false,
            createdAt: now,
            expiresAt: now + 60000,
          },
        };
      } else if (
        endpoint ===
        "/settings/omniroute/accounts/fixture-account/activation/prepare"
      ) {
        assert.equal(request.headers()["x-nova-admin"], "1");
        assert.deepEqual(request.postDataJSON(), {
          enabled: false,
          acknowledgeGlobalEffect: true,
        });
        const now = await page.evaluate(() => Date.now());
        data = {
          ok: true,
          name: "Voorbeeldaccount",
          currentEnabled: true,
          enabled: false,
          action: {
            confirmationId: "99999999-9999-4999-8999-999999999999",
            sessionId:
              "settings-account-activation:aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
            tool: "omniroute_account_activation",
            args: {
              id: "fixture-account",
              enabled: false,
              revision: "fixture-account-hash",
            },
            risk: "DANGEROUS",
            allowAlways: false,
            createdAt: now,
            expiresAt: now + 60000,
          },
        };
      } else if (
        endpoint ===
        "/settings/omniroute/accounts/fixture-account/activation/confirm"
      ) {
        assert.equal(request.headers()["x-nova-admin"], "1");
        if (request.postDataJSON().approve) {
          accountActivationWrites++;
          accountActive = !accountActive;
          data = {
            ok: true,
            verified: true,
            enabled: accountActive,
            routeReady: true,
          };
        } else data = { ok: true };
      } else if (
        endpoint ===
        "/settings/omniroute/accounts/fixture-account/removal/prepare"
      ) {
        assert.equal(request.headers()["x-nova-admin"], "1");
        assert.equal(request.postDataJSON().acknowledgeEffects, true);
        const now = await page.evaluate(() => Date.now());
        data = {
          ok: true,
          name: "Voorbeeldaccount",
          action: {
            confirmationId: "55555555-5555-4555-8555-555555555555",
            sessionId: "settings-account:66666666-6666-4666-8666-666666666666",
            tool: "omniroute_account_remove",
            args: {
              id: "fixture-account",
              revision: "private-fixture-revision",
            },
            risk: "DANGEROUS",
            allowAlways: false,
            createdAt: now,
            expiresAt: now + 60000,
          },
        };
      } else if (
        endpoint ===
        "/settings/omniroute/accounts/fixture-account/removal/confirm"
      ) {
        assert.equal(request.headers()["x-nova-admin"], "1");
        if (request.postDataJSON().approve) {
          accountWrites++;
          accountRemoved = true;
          data = { ok: true, verified: true, routeReady: false };
        } else data = { ok: true };
      } else if (
        endpoint ===
        "/settings/omniroute/combos/fixture-combo/activation/history"
      ) {
        assert.equal(request.headers()["x-nova-admin"], "1");
        comboHistoryReads++;
        data = {
          revisions: [
            {
              id: "99999999-9999-4999-8999-999999999999",
              kind: "combo",
              entityId: "fixture-combo",
              name: "Voorbeeldroute",
              at: "2026-10-11T10:00:00.000Z",
              beforeEnabled: true,
              afterEnabled: false,
            },
          ],
        };
      } else if (
        endpoint ===
        "/settings/omniroute/combos/fixture-combo/activation/history/99999999-9999-4999-8999-999999999999/prepare-rollback"
      ) {
        assert.equal(request.headers()["x-nova-admin"], "1");
        comboRollbackPrepares++;
        preparedComboEnabled = true;
        const now = await page.evaluate(() => Date.now());
        data = {
          ok: true,
          name: "Voorbeeldroute",
          currentEnabled: false,
          enabled: true,
          action: {
            confirmationId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
            sessionId: "settings-combo:bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
            tool: "omniroute_combo_activation",
            args: {
              id: "fixture-combo",
              enabled: true,
              revision: "fixture-hash",
            },
            risk: "DANGEROUS",
            allowAlways: false,
            createdAt: now,
            expiresAt: now + 60000,
          },
        };
      } else if (
        endpoint ===
        "/settings/omniroute/combos/fixture-combo/activation/prepare"
      ) {
        assert.equal(request.headers()["x-nova-admin"], "1");
        preparedComboEnabled = request.postDataJSON().enabled;
        assert.deepEqual(request.postDataJSON(), {
          enabled: false,
          acknowledgeGlobalEffect: true,
        });
        const now = await page.evaluate(() => Date.now());
        data = {
          ok: true,
          name: "Voorbeeldroute",
          currentEnabled: true,
          enabled: false,
          action: {
            confirmationId: "77777777-7777-4777-8777-777777777777",
            sessionId: "settings-combo:88888888-8888-4888-8888-888888888888",
            tool: "omniroute_combo_activation",
            args: {
              id: "fixture-combo",
              enabled: false,
              revision: "fixture-hash",
            },
            risk: "DANGEROUS",
            allowAlways: false,
            createdAt: now,
            expiresAt: now + 60000,
          },
        };
      } else if (
        endpoint ===
        "/settings/omniroute/combos/fixture-combo/activation/confirm"
      ) {
        assert.equal(request.headers()["x-nova-admin"], "1");
        if (request.postDataJSON().approve) {
          comboWrites++;
          comboActive = preparedComboEnabled;
          data = {
            ok: true,
            verified: true,
            enabled: comboActive,
            routeReady: true,
          };
        } else data = { ok: true };
      } else if (endpoint === "/settings/omniroute/policy/history") {
        policyHistoryReads++;
        data = {
          revisions: [
            {
              id: "aaaaaaa1-aaaa-4aaa-8aaa-aaaaaaaaaaa1",
              at: Date.now(),
              before: {
                settings: { freeAccessPolicy: "off" },
                key: {},
                policy: { enabledModels: [] },
              },
              after: {
                settings: { freeAccessPolicy: "strict" },
                key: {},
                policy: { enabledModels: ["groq/fixture-free-model"] },
              },
            },
          ],
          truncated: false,
        };
      } else if (endpoint === "/settings/omniroute/policy") {
        policyReads++;
        data = {
          available: true,
          verified: false,
          inventoryToken: "fixture-policy-inventory-token",
          accounts: [
            {
              id: policyAccountId,
              provider: "groq",
              name: "Gratis Groq-account",
            },
          ],
          models: [
            {
              provider: "groq",
              modelId: "fixture-free-model",
              name: "<script>globalThis.freePolicyLabelRan = true</script>",
              freeType: "recurring-daily",
              tos: "ok",
            },
          ],
        };
      } else if (endpoint === "/settings/omniroute/policy/prepare") {
        assert.equal(request.headers()["x-nova-admin"], "1");
        assert.deepEqual(request.postDataJSON(), {
          inventoryToken: "fixture-policy-inventory-token",
          selection: [
            {
              connectionId: policyAccountId,
              modelId: "fixture-free-model",
              officialSource: "https://groq.example/free-account-terms",
            },
          ],
          acknowledgeBillingDisabled: true,
          acknowledgeHardStop: true,
          acknowledgeTerms: true,
          acknowledgeAllClients: true,
          acknowledgeQuotaRefresh: true,
        });
        const now = await page.evaluate(() => Date.now());
        data = {
          ok: true,
          action: {
            confirmationId: "88888888-8888-4888-8888-888888888888",
            sessionId: "settings-policy:99999999-9999-4999-8999-999999999999",
            tool: "free_policy_replace",
            args: { accountCount: 1, modelCount: 1 },
            risk: "DANGEROUS",
            allowAlways: false,
            createdAt: now,
            expiresAt: now + 60000,
          },
        };
      } else if (endpoint === "/settings/omniroute/policy/confirm") {
        assert.equal(request.headers()["x-nova-admin"], "1");
        const confirmation = request.postDataJSON();
        assert.equal(
          confirmation.sessionId,
          "settings-policy:99999999-9999-4999-8999-999999999999",
        );
        assert.equal(
          confirmation.confirmationId,
          "88888888-8888-4888-8888-888888888888",
        );
        if (confirmation.approve) {
          policyWrites++;
          data = {
            ok: true,
            verified: true,
            evidenceSource: "operator-account",
            nativeQuotaVerified: false,
            routeReady: true,
          };
        } else data = { ok: true };
      } else if (endpoint === "/settings/omniroute/native")
        data = {
          available: true,
          truncated: false,
          skills: [
            {
              id: "fixture-owned",
              name: "NOVA voorbeeldskill",
              version: "1.0.0",
              scope: "nova",
              enabled: nativeMode !== "off",
              mode: nativeMode,
            },
            {
              id: "fixture-native",
              name: "Gedeelde voorbeeldskill",
              version: "1.0.0",
              scope: "global",
              enabled: globalNativeMode !== "off",
              mode: globalNativeMode,
            },
          ],
          documentation: [
            {
              id: "fixture-doc",
              name: "Gateway-documentatie",
              description: "Vaste API-documentatie",
            },
          ],
          prompt: {
            enabled: gatewayPrompt.enabled,
            prefixCharacters: gatewayPrompt.prefixPrompt.length,
            suffixCharacters: gatewayPrompt.suffixPrompt.length,
          },
          memory: {
            enabled: gatewayMemoryEnabled,
            backend: "sqlite",
            maxTokens: 1200,
          },
        };
      else if (
        endpoint === "/settings/omniroute/native/memories/update/prepare"
      ) {
        assert.equal(request.headers()["x-nova-admin"], "1");
        assert.equal(request.postDataJSON().id, "fixture-memory");
        assert.equal(
          request.postDataJSON().content,
          "NOVA onthoudt dat de plant water nodig heeft. (aangepast)",
        );
        const now = await page.evaluate(() => Date.now());
        data = {
          ok: true,
          action: {
            confirmationId: "12121212-1212-4212-8212-121212121212",
            sessionId:
              "settings-memory-record:13131313-1313-4313-8313-131313131313",
            tool: "native_memory_record_update",
            args: { id: "fixture-memory" },
            risk: "DANGEROUS",
            allowAlways: false,
            createdAt: now,
            expiresAt: now + 60000,
          },
        };
      } else if (
        endpoint === "/settings/omniroute/native/memories/update/confirm"
      ) {
        assert.equal(request.headers()["x-nova-admin"], "1");
        assert.equal(request.postDataJSON().approve, true);
        nativeMemoryUpdateWrites++;
        nativeMemoryText =
          "NOVA onthoudt dat de plant water nodig heeft. (aangepast)";
        data = { ok: true, verified: true };
      } else if (
        endpoint === "/settings/omniroute/native/memories/delete-many/prepare"
      ) {
        assert.equal(request.headers()["x-nova-admin"], "1");
        assert.deepEqual(request.postDataJSON(), { ids: ["fixture-memory"] });
        const now = await page.evaluate(() => Date.now());
        data = {
          ok: true,
          count: 1,
          action: {
            confirmationId: "abababab-abab-4bab-8bab-abababababab",
            sessionId:
              "settings-memory-record:cdcdcdcd-cdcd-4dcd-8dcd-cdcdcdcdcdcd",
            tool: "native_memory_records_delete",
            args: { records: [{ id: "fixture-memory", revision: "digest" }] },
            risk: "DANGEROUS",
            allowAlways: false,
            createdAt: now,
            expiresAt: now + 60000,
          },
        };
      } else if (
        endpoint === "/settings/omniroute/native/memories/delete-many/confirm"
      ) {
        assert.equal(request.headers()["x-nova-admin"], "1");
        if (request.postDataJSON().approve) nativeMemoryBulkDeleteWrites++;
        data = { ok: true, verified: true };
      } else if (
        endpoint === "/settings/omniroute/native/memories/delete/prepare"
      ) {
        assert.equal(request.headers()["x-nova-admin"], "1");
        assert.deepEqual(request.postDataJSON(), { id: "fixture-memory" });
        const now = await page.evaluate(() => Date.now());
        data = {
          ok: true,
          action: {
            confirmationId: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee",
            sessionId:
              "settings-memory-record:ffffffff-ffff-4fff-8fff-ffffffffffff",
            tool: "native_memory_record_delete",
            args: { id: "fixture-memory" },
            risk: "DANGEROUS",
            allowAlways: false,
            createdAt: now,
            expiresAt: now + 60000,
          },
        };
      } else if (
        endpoint === "/settings/omniroute/native/memories/delete/confirm"
      ) {
        assert.equal(request.headers()["x-nova-admin"], "1");
        assert.equal(request.postDataJSON().approve, true);
        nativeMemoryDeleteWrites++;
        data = { ok: true, verified: true };
      } else if (endpoint.startsWith("/settings/omniroute/native/memories")) {
        assert.equal(request.headers()["x-nova-admin"], "1");
        nativeMemoryRecordsReads++;
        data = {
          memories: [
            {
              id: "fixture-memory",
              text: nativeMemoryText,
              created_at: "2026-10-11T10:00:00.000Z",
            },
          ],
          next: null,
        };
      } else if (endpoint === "/settings/omniroute/native/memory/prepare") {
        assert.equal(request.headers()["x-nova-admin"], "1");
        assert.equal(request.postDataJSON().acknowledgeGlobal, true);
        const now = await page.evaluate(() => Date.now());
        gatewayMemoryTarget = request.postDataJSON().enabled;
        data = {
          ok: true,
          enabled: request.postDataJSON().enabled,
          action: {
            confirmationId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
            sessionId: "settings-memory:bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
            tool: "native_memory_settings",
            args: { enabled: gatewayMemoryTarget },
            risk: "DANGEROUS",
            allowAlways: false,
            createdAt: now,
            expiresAt: now + 60000,
          },
        };
      } else if (endpoint === "/settings/omniroute/native/memory/history")
        data = { revisions: gatewayMemoryHistory, truncated: false };
      else if (
        endpoint === "/settings/omniroute/native/memory/rollback/prepare"
      ) {
        assert.equal(request.headers()["x-nova-admin"], "1");
        assert.equal(request.postDataJSON().acknowledgeGlobal, true);
        const now = await page.evaluate(() => Date.now());
        gatewayMemoryTarget = false;
        data = {
          ok: true,
          enabled: false,
          action: {
            confirmationId: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
            sessionId: "settings-memory:dddddddd-dddd-4ddd-8ddd-dddddddddddd",
            tool: "native_memory_settings",
            args: { enabled: false },
            risk: "DANGEROUS",
            allowAlways: false,
            createdAt: now,
            expiresAt: now + 60000,
          },
        };
      } else if (endpoint === "/settings/omniroute/native/memory/confirm") {
        assert.equal(request.headers()["x-nova-admin"], "1");
        if (request.postDataJSON().approve) {
          gatewayMemoryWrites++;
          const before = gatewayMemoryEnabled;
          gatewayMemoryEnabled = gatewayMemoryTarget;
          gatewayMemoryHistory = [
            {
              id: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee",
              at: "2026-10-11T10:00:00.000Z",
              before,
              after: gatewayMemoryEnabled,
            },
          ];
          data = { ok: true, verified: true, enabled: gatewayMemoryEnabled };
        } else data = { ok: true };
      } else if (
        endpoint === "/settings/omniroute/native/skills/fixture-native/prepare"
      ) {
        assert.equal(request.headers()["x-nova-admin"], "1");
        assert.equal(request.postDataJSON().acknowledgeGlobal, true);
        globalPreparedMode = request.postDataJSON().mode;
        const now = await page.evaluate(() => Date.now());
        data = {
          ok: true,
          name: "Gedeelde voorbeeldskill",
          scope: "global",
          action: {
            confirmationId: "66666666-6666-4666-8666-666666666666",
            sessionId: "settings-native:77777777-7777-4777-8777-777777777777",
            tool: "native_skill_mode",
            args: { id: "fixture-native", mode: globalPreparedMode },
            risk: "DANGEROUS",
            allowAlways: false,
            createdAt: now,
            expiresAt: now + 60000,
          },
        };
      } else if (
        endpoint === "/settings/omniroute/native/skills/fixture-native/confirm"
      ) {
        assert.equal(request.headers()["x-nova-admin"], "1");
        if (request.postDataJSON().approve) {
          globalNativeWrites++;
          globalNativeMode = globalPreparedMode;
          data = {
            ok: true,
            verified: true,
            mode: globalNativeMode,
            enabled: globalNativeMode !== "off",
          };
        } else data = { ok: true };
      } else if (
        endpoint === "/settings/omniroute/native/documentation/fixture-doc"
      )
        data = {
          available: true,
          id: "fixture-doc",
          name: "Gateway-documentatie",
          documentation:
            "<script>globalThis.nativeDocumentRan = true</script>\nDocumentatie is tekst.",
        };
      else if (
        endpoint === "/settings/omniroute/native/skills/fixture-owned/history"
      )
        data = { revisions: nativeModeHistory, truncated: false };
      else if (
        endpoint ===
        "/settings/omniroute/native/skills/fixture-owned/rollback/prepare"
      ) {
        assert.equal(request.headers()["x-nova-admin"], "1");
        assert.equal(request.postDataJSON().acknowledgeGlobal, false);
        nativePreparedMode = "off";
        const now = await page.evaluate(() => Date.now());
        data = {
          ok: true,
          name: "NOVA voorbeeldskill",
          scope: "nova",
          action: {
            confirmationId: "33333333-3333-4333-8333-333333333333",
            sessionId: "settings-native:44444444-4444-4444-8444-444444444444",
            tool: "native_skill_mode",
            args: { id: "fixture-owned", mode: "off" },
            risk: "CONFIRM",
            allowAlways: false,
            createdAt: now,
            expiresAt: now + 60000,
          },
        };
      } else if (
        endpoint === "/settings/omniroute/native/skills/fixture-owned/prepare"
      ) {
        assert.equal(request.headers()["x-nova-admin"], "1");
        nativePreparedMode = request.postDataJSON().mode;
        const now = await page.evaluate(() => Date.now());
        data = {
          ok: true,
          name: "NOVA voorbeeldskill",
          action: {
            confirmationId: "11111111-1111-4111-8111-111111111111",
            sessionId: "settings-native:22222222-2222-4222-8222-222222222222",
            tool: "native_skill_mode",
            args: {
              id: "fixture-owned",
              mode: nativePreparedMode,
              revision: "fixture-revision",
            },
            risk: nativePreparedMode === "off" ? "CONFIRM" : "DANGEROUS",
            allowAlways: false,
            createdAt: now,
            expiresAt: now + 60000,
          },
        };
      } else if (
        endpoint === "/settings/omniroute/native/skills/fixture-owned/confirm"
      ) {
        assert.equal(request.headers()["x-nova-admin"], "1");
        if (request.postDataJSON().approve) {
          nativeWrites++;
          const before = nativeMode;
          nativeMode = nativePreparedMode;
          nativeModeHistory = [
            {
              id: "55555555-5555-4555-8555-555555555555",
              at: "2026-10-11T10:00:00.000Z",
              before,
              after: nativeMode,
              scope: "nova",
            },
          ];
          data = {
            ok: true,
            verified: true,
            mode: nativeMode,
            enabled: nativeMode !== "off",
          };
        } else data = { ok: true };
      } else if (
        endpoint ===
        "/settings/omniroute/native/skills/fixture-owned/remove/prepare"
      ) {
        assert.equal(request.headers()["x-nova-admin"], "1");
        const now = await page.evaluate(() => Date.now());
        data = {
          ok: true,
          name: "NOVA voorbeeldskill",
          action: {
            confirmationId: "88888888-8888-4888-8888-888888888888",
            sessionId:
              "settings-native-remove:99999999-9999-4999-8999-999999999999",
            tool: "native_skill_remove",
            args: { id: "fixture-owned", revision: "fixture-revision" },
            risk: "DANGEROUS",
            allowAlways: false,
            createdAt: now,
            expiresAt: now + 60000,
          },
        };
      } else if (
        endpoint ===
        "/settings/omniroute/native/skills/fixture-owned/remove/confirm"
      ) {
        assert.equal(request.headers()["x-nova-admin"], "1");
        if (request.postDataJSON().approve) {
          nativeRemovalWrites++;
          data = { ok: true, verified: true };
        } else data = { ok: true };
      } else if (endpoint === "/settings/omniroute/native/prompt/prepare") {
        assert.equal(request.headers()["x-nova-admin"], "1");
        promptDraft = request.postDataJSON();
        assert.equal(promptDraft.acknowledgeGlobal, true);
        const now = await page.evaluate(() => Date.now());
        data = {
          ok: true,
          action: {
            confirmationId: "33333333-3333-4333-8333-333333333333",
            sessionId: "settings-prompt:44444444-4444-4444-8444-444444444444",
            tool: "native_prompt_replace",
            args: {
              enabled: promptDraft.enabled,
              prefixCharacters: promptDraft.prefixPrompt.length,
              suffixCharacters: promptDraft.suffixPrompt.length,
            },
            risk: "DANGEROUS",
            allowAlways: false,
            createdAt: now,
            expiresAt: now + 60000,
          },
        };
      } else if (endpoint === "/settings/omniroute/native/prompt/history") {
        assert.equal(request.headers()["x-nova-admin"], "1");
        data = {
          revisions: [
            {
              id: "55555555-5555-4555-8555-555555555555",
              at: "2026-10-10T09:00:00.000Z",
              before: {
                enabled: false,
                prefixPrompt: "Older safe prompt",
                suffixPrompt: "Older ending",
              },
              after: {
                enabled: true,
                prefixPrompt: "Current safe prompt",
                suffixPrompt: "Current ending",
              },
            },
          ],
          truncated: false,
        };
      } else if (endpoint === "/settings/omniroute/native/prompt/confirm") {
        assert.equal(request.headers()["x-nova-admin"], "1");
        if (request.postDataJSON().approve) {
          promptWrites++;
          gatewayPrompt = {
            enabled: promptDraft.enabled,
            prefixPrompt: promptDraft.prefixPrompt,
            suffixPrompt: promptDraft.suffixPrompt,
          };
          data = { ok: true, verified: true };
        } else data = { ok: true };
      } else if (endpoint === "/settings/models/metrics")
        data = {
          updatedAt: "2026-10-10T09:00:00Z",
          available: true,
          windowHours: 24,
          routeReady: true,
          lastResponse: {
            model: "fixture:free",
            provider: "fixture",
            latencyMs: 500,
            at: "2026-10-10T08:59:00Z",
          },
          models: [
            {
              provider: "fixture",
              model: "fixture:free",
              requests: 5,
              failures: 1,
              averageMs: 1200,
              firstTokenMs: 200,
              tokensPerSecond: 20,
              enabled: true,
            },
          ],
        };
      else if (
        endpoint === "/settings/workspace/projects" &&
        request.method() === "POST"
      ) {
        assert.equal(request.headers()["x-nova-admin"], "1");
        workspaceProjectWrites++;
        const name = request.postDataJSON().name;
        const id = name.toLowerCase().replace(/[^a-z0-9]+/g, "-");
        const previousId = workspaceActiveId;
        workspaceProjects.push({
          id,
          name,
          createdAt: "2026-10-11T00:00:00.000Z",
        });
        workspaceActiveId = id;
        workspaceProjectHistory.unshift({
          id: `11111111-1111-4111-8111-${String(++workspaceHistorySequence).padStart(12, "0")}`,
          at: "2026-10-11T00:00:00.000Z",
          beforeId: previousId,
          afterId: id,
        });
        data = {
          version: 1,
          activeId: workspaceActiveId,
          projects: workspaceProjects,
        };
      } else if (endpoint === "/settings/workspace/projects/active") {
        assert.equal(request.headers()["x-nova-admin"], "1");
        workspaceProjectWrites++;
        const previousId = workspaceActiveId;
        workspaceActiveId = request.postDataJSON().id;
        workspaceProjectHistory.unshift({
          id: `11111111-1111-4111-8111-${String(++workspaceHistorySequence).padStart(12, "0")}`,
          at: "2026-10-11T00:00:00.000Z",
          beforeId: previousId,
          afterId: workspaceActiveId,
        });
        data = {
          version: 1,
          activeId: workspaceActiveId,
          projects: workspaceProjects,
        };
      } else if (endpoint === "/settings/workspace/projects/history")
        data = { revisions: workspaceProjectHistory, truncated: false };
      else if (
        /^\/settings\/workspace\/projects\/history\/[0-9a-f-]+\/prepare-rollback$/.test(
          endpoint,
        )
      ) {
        assert.equal(request.headers()["x-nova-admin"], "1");
        const revisionId = endpoint.split("/")[5];
        workspaceRollbackTarget = workspaceProjectHistory.find(
          (item) => item.id === revisionId,
        );
        const now = await page.evaluate(() => Date.now());
        data = workspaceRollbackTarget
          ? {
              ok: true,
              fromName: workspaceProjects.find(
                (item) => item.id === workspaceRollbackTarget.afterId,
              )?.name,
              toName:
                workspaceProjects.find(
                  (item) => item.id === workspaceRollbackTarget.beforeId,
                )?.name ?? "Geen actief project",
              action: {
                confirmationId: "12121212-1212-4212-8212-121212121212",
                sessionId:
                  "settings-workspace-project:13131313-1313-4313-8313-131313131313",
                tool: "workspace_project_selection_rollback",
                args: {
                  revisionId,
                  beforeId: workspaceRollbackTarget.beforeId,
                  afterId: workspaceRollbackTarget.afterId,
                },
                risk: "DANGEROUS",
                allowAlways: false,
                createdAt: now,
                expiresAt: now + 60000,
              },
            }
          : { ok: false, error: "Herstel alleen de nieuwste projectkeuze." };
      } else if (
        endpoint === "/settings/workspace/projects/history/confirm-rollback"
      ) {
        assert.equal(request.headers()["x-nova-admin"], "1");
        if (request.postDataJSON().approve && workspaceRollbackTarget) {
          const beforeId = workspaceActiveId;
          workspaceActiveId = workspaceRollbackTarget.beforeId;
          workspaceProjectWrites++;
          workspaceProjectHistory.unshift({
            id: `11111111-1111-4111-8111-${String(++workspaceHistorySequence).padStart(12, "0")}`,
            at: "2026-10-11T00:01:00.000Z",
            beforeId,
            afterId: workspaceActiveId,
          });
          data = { ok: true, verified: true };
        } else data = { ok: true };
      } else if (endpoint === "/settings/workspace/projects")
        data = {
          version: 1,
          activeId: workspaceActiveId,
          projects: workspaceProjects,
        };
      else if (
        endpoint === "/settings/model-roles" &&
        request.method() === "PUT"
      ) {
        assert.equal(request.headers()["x-nova-admin"], "1");
        modelRoleWrites++;
        const previous = modelRoles;
        modelRoles = request.postDataJSON();
        modelRoleHistory.unshift({
          id: "55555555-5555-4555-8555-555555555555",
          at: "2026-10-10T09:00:00.000Z",
          before: previous,
          after: modelRoles,
        });
        data = {
          available: true,
          verifiedFreeModels: ["free/provider-a", "free/provider-b"],
          roles: modelRoles,
        };
      } else if (
        endpoint ===
          "/settings/model-roles/history/55555555-5555-4555-8555-555555555555/rollback" &&
        request.method() === "POST"
      ) {
        modelRoleHistoryRollbacks++;
        const revision = modelRoleHistory.find(
          (item) => item.id === "55555555-5555-4555-8555-555555555555",
        );
        modelRoles = revision.before;
        data = {
          available: true,
          verifiedFreeModels: ["free/provider-a", "free/provider-b"],
          roles: modelRoles,
        };
      } else if (endpoint === "/settings/model-roles/history")
        data = { revisions: modelRoleHistory, truncated: false };
      else if (endpoint === "/settings/model-roles")
        data = {
          available: true,
          verifiedFreeModels: ["free/provider-a", "free/provider-b"],
          roles: modelRoles,
        };
      else if (endpoint === "/settings/helper/preferences/history") {
        helperPreferenceHistoryReads++;
        data = {
          truncated: false,
          revisions: [
            {
              id: "55555555-5555-4555-8555-555555555555",
              at: "2026-10-10T10:00:00Z",
              before: {
                autohide: true,
                contrast: false,
                shape: "orb",
                wardrobe: { theme: "nova", seasonal: false, birthday: "" },
                cues: { enabled: true, volume: 0.35, theme: "soft" },
              },
              after: {
                autohide: false,
                contrast: true,
                shape: "ring",
                wardrobe: { theme: "violet", seasonal: false, birthday: "" },
                cues: { enabled: true, volume: 0.35, theme: "soft" },
              },
            },
          ],
        };
      } else if (endpoint === "/settings/helper/history") {
        helperModeHistoryReads++;
        data = {
          truncated: false,
          revisions: [
            {
              id: "66666666-6666-4666-8666-666666666666",
              at: "2026-10-10T10:00:00Z",
              before: { mode: "wallpaper", display: 0 },
              after: { mode: "helper", display: 1 },
            },
          ],
        };
      } else if (endpoint === "/settings/wallpaper/history") {
        wallpaperHistoryReads++;
        data = {
          truncated: false,
          revisions: [
            {
              id: "77777777-7777-4777-8777-777777777777",
              at: "2026-10-10T10:30:00Z",
              display: 1,
              before: "off",
              after: "sphere",
            },
          ],
        };
      } else if (endpoint === "/settings/node-red/flows") {
        nodeRedFlowReads++;
        data = {
          revision: "fixture-rev",
          flows: [
            {
              id: "tab-home",
              label: "Home automation",
              disabled: false,
              nodeCount: 4,
              lastRun: "2026-10-11T10:00:00.000Z",
              lastError: "Fixture flow failed",
              runnableFlowId: "lights-on",
              manageable: true,
              templates: [
                "alert_on_error",
                "alert_on_offline",
                "morning_briefing",
              ],
            },
          ],
          truncated: false,
          editorUrl: "https://flows.example.test/editor",
        };
      } else if (
        endpoint.startsWith("/settings/wallpaper/history/") &&
        endpoint.endsWith("/rollback")
      ) {
        assert.equal(request.headers()["x-nova-admin"], "1");
        wallpaperHistoryWrites++;
        assert.equal(
          endpoint,
          "/settings/wallpaper/history/77777777-7777-4777-8777-777777777777/rollback",
        );
        data = {
          available: true,
          displays: [
            {
              index: 1,
              name: "Primary",
              primary: true,
              width: 1920,
              height: 1080,
              mode: "off",
            },
          ],
        };
      } else if (
        endpoint.startsWith("/settings/helper/preferences/history/") &&
        endpoint.endsWith("/rollback")
      ) {
        assert.equal(request.headers()["x-nova-admin"], "1");
        helperPreferenceHistoryWrites++;
        data = {
          ok: true,
          preferences: {
            autohide: true,
            contrast: false,
            shape: "orb",
            wardrobe: { theme: "nova", seasonal: false, birthday: "" },
            cues: { enabled: true, volume: 0.35, theme: "soft" },
          },
        };
      } else if (endpoint === "/settings/tools/history") {
        toolSwitchHistoryReads++;
        data = {
          truncated: false,
          revisions: [
            {
              id: "66666666-6666-4666-8666-666666666666",
              at: "2026-10-10T11:00:00Z",
              before: { weather_forecast: true },
              after: { weather_forecast: false },
            },
          ],
        };
      } else if (
        endpoint.startsWith("/settings/helper/history/") &&
        endpoint.endsWith("/rollback")
      ) {
        assert.equal(request.headers()["x-nova-admin"], "1");
        assert.equal(
          endpoint,
          "/settings/helper/history/66666666-6666-4666-8666-666666666666/rollback",
        );
        data = {
          settings: { mode: "wallpaper", display: 0 },
          desktop: { available: false, reason: "no-agent" },
          applied: false,
          error: "Geen verbinding",
        };
      } else if (
        endpoint.startsWith("/settings/tools/history/") &&
        endpoint.endsWith("/rollback")
      ) {
        assert.equal(request.headers()["x-nova-admin"], "1");
        toolSwitchHistoryWrites++;
        data = { ok: true };
      } else if (endpoint === "/settings/sidebar/history") {
        sidebarHistoryReads++;
        data = {
          truncated: false,
          revisions: [
            {
              id: "77777777-7777-4777-8777-777777777777",
              at: "2026-10-10T12:00:00Z",
              before: [{ id: "chat", column: "left", page: 1, shown: true }],
              after: [{ id: "chat", column: "left", page: 1, shown: false }],
            },
          ],
        };
      } else if (
        endpoint.startsWith("/settings/sidebar/history/") &&
        endpoint.endsWith("/rollback")
      ) {
        assert.equal(request.headers()["x-nova-admin"], "1");
        sidebarHistoryWrites++;
        data = {
          ok: true,
          sidebar: [{ id: "chat", column: "left", page: 1, shown: true }],
        };
      } else if (endpoint === "/settings/widgets/notitie/history") {
        noteHistoryReads++;
        data = {
          truncated: true,
          revisions: [
            {
              id: "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
              at: "2026-10-10T10:00:00.000Z",
              before: "Oude notitie",
              after: "Vergeet de planten niet.",
              beforeSnapshot: {
                title: "Oude titel",
                enabled: true,
                text: "Oude notitie",
              },
              afterSnapshot: {
                title: "Mijn notitie",
                enabled: false,
                text: "Vergeet de planten niet.",
              },
            },
            {
              id: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee",
              at: "2026-10-09T10:00:00.000Z",
              before: "",
              after: "Vergeet de planten niet.",
              createdSnapshot: {
                title: "Mijn notitie",
                enabled: true,
                text: "Vergeet de planten niet.",
              },
            },
          ],
        };
      } else if (
        endpoint ===
        "/settings/widgets/notitie/history/dddddddd-dddd-4ddd-8ddd-dddddddddddd/rollback"
      ) {
        assert.equal(request.headers()["x-nova-admin"], "1");
        noteHistoryWrites++;
        data = {
          ok: true,
          widget: {
            id: "notitie",
            type: "note",
            title: "Oude titel",
            text: "Oude notitie",
            enabled: true,
          },
        };
      } else if (
        endpoint ===
        "/settings/widgets/notitie/history/eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee/rollback"
      ) {
        assert.equal(request.headers()["x-nova-admin"], "1");
        noteHistoryWrites++;
        overview.widgets = overview.widgets.filter(
          (widget) => widget.id !== "notitie",
        );
        overview.sidebar = overview.sidebar.filter(
          (item) => item.id !== "w:notitie",
        );
        data = { ok: true, removed: true };
      } else if (endpoint === "/settings/widgets/aantal/display-history") {
        assert.equal(request.headers()["x-nova-admin"], "1");
        widgetDisplayHistoryReads++;
        data = {
          truncated: false,
          revisions: [
            {
              id: "abababab-abab-4bab-8bab-abababababab",
              at: "2026-10-10T13:00:00.000Z",
              widgetId: "aantal",
              before: {
                type: "value",
                title: "Aantal bezoekers",
                unit: "personen",
              },
              after: { type: "value", title: "Bezoekers", unit: "mensen" },
            },
          ],
        };
      } else if (
        endpoint ===
        "/settings/widgets/aantal/display-history/abababab-abab-4bab-8bab-abababababab/rollback"
      ) {
        assert.equal(request.headers()["x-nova-admin"], "1");
        widgetDisplayHistoryWrites++;
        data = {
          ok: true,
          widget: {
            id: "aantal",
            type: "value",
            title: "Bezoekers",
            source: {
              url: "https://data.example.invalid/count",
              extract: "count",
            },
            unit: "mensen",
            refreshMinutes: 15,
            enabled: true,
          },
        };
      } else if (endpoint === "/settings/services/restart") {
        if (request.method() === "POST") {
          assert.equal(request.headers()["x-nova-admin"], "1");
          restartRequests++;
          data = { ok: true, scheduled: true };
        } else {
          data = {
            available: restartAvailable,
            pendingChanges: services.some((service) => service.restartRequired),
            restartPending: restartRequests > 0,
            ...(restartAvailable
              ? {}
              : { reason: "Gecontroleerd herstarten is uitgeschakeld." }),
          };
        }
      } else if (endpoint === "/settings/stack-control/restart/prepare") {
        assert.equal(request.method(), "POST");
        assert.equal(request.postDataJSON().service, stackRestartService);
        stackRestartPrepares++;
        data = {
          ok: true,
          service: stackRestartService,
          label: stackRestartService === "nova" ? "NOVA" : "Qdrant",
          action: {
            sessionId:
              "settings-stack-restart:aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
            confirmationId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
            risk: "DANGEROUS",
            args: { service: stackRestartService, revision: "a".repeat(64) },
          },
        };
      } else if (endpoint === "/settings/stack-control/restart/confirm") {
        assert.equal(request.method(), "POST");
        assert.equal(request.postDataJSON().approve, true);
        stackRestartConfirms++;
        data = stackRestartResult;
      } else if (endpoint === "/settings/services") data = { services };
      else if (
        endpoint.endsWith("/status") &&
        endpoint.startsWith("/settings/services/")
      )
        data = {
          test: {
            ok: true,
            message: "Fixture test",
            checkedAt: "2026-10-10T09:00:00Z",
          },
        };
      else if (endpoint === "/settings/services/mqtt/overview") {
        mqttReads++;
        data = {
          connected: true,
          topics: ["jarvis/events/tool", "jarvis/events/timer"],
          recent: [
            {
              topic: "jarvis/events/timer",
              at: "2026-10-10T10:00:00Z",
              summary: "Timergebeurtenis · label verborgen",
              delivery: "accepted",
            },
            {
              topic: "jarvis/events/timer",
              at: "2026-10-10T10:00:00Z",
              summary: "Timergebeurtenis · label verborgen",
              delivery: "accepted",
            },
          ],
        };
      } else if (endpoint === "/settings/services/qdrant/overview") {
        qdrantReads++;
        data = {
          ok: true,
          message: "Alleen collectiegegevens gelezen; er is niets gewijzigd.",
          truncated: false,
          activeMemoryCollection: qdrantReindexed
            ? "nova_mem_fixture"
            : "nova_memory",
          collections: [
            {
              name: "nova_memory",
              points: 12,
              indexedVectors: 10,
              segments: 2,
              diskBytes: 4567,
              ramBytes: 1234,
              status: "green",
            },
          ],
        };
      } else if (endpoint === "/settings/services/qdrant/maintenance") {
        assert.equal(request.headers()["x-nova-admin"], "1");
        qdrantMaintenanceRuns++;
        data = { ok: true, scanned: 12, archived: 3, more: false };
      } else if (endpoint === "/settings/services/qdrant/reindex") {
        assert.equal(request.headers()["x-nova-admin"], "1");
        qdrantReindexRuns++;
        qdrantReindexed = true;
        data = { ok: true, points: 12, collection: "nova_mem_fixture" };
      } else if (endpoint === "/settings/services/qdrant/index-history") {
        data = {
          activeCollection: qdrantReindexed
            ? "nova_mem_fixture"
            : "nova_memory",
          revisions: qdrantReindexed
            ? [
                {
                  id: "11111111-1111-4111-8111-111111111111",
                  at: "2026-10-10T10:00:00Z",
                  points: 12,
                  current: true,
                },
              ]
            : [],
        };
      } else if (
        endpoint ===
        "/settings/services/qdrant/index-history/11111111-1111-4111-8111-111111111111/rollback"
      ) {
        assert.equal(request.headers()["x-nova-admin"], "1");
        qdrantRollbackRuns++;
        qdrantReindexed = false;
        data = { ok: true, collection: "nova_memory" };
      } else if (endpoint === "/settings/home-assistant/inventory") {
        data = {
          syncedAt: "2026-10-10T09:00:00Z",
          areas: [{ id: "kitchen", name: "Keuken" }],
          devices: [
            { id: "device-light", name: "Keukenlamp", areaId: "kitchen" },
          ],
          entities: [
            {
              id: "light.kitchen",
              name: "Plafondlamp",
              domain: "light",
              areaId: "kitchen",
              deviceId: "device-light",
            },
          ],
        };
      } else if (endpoint === "/settings/home-assistant/access") {
        assert.equal(request.headers()["x-nova-admin"], "1");
        if (request.method() === "PUT") {
          homeAccessWrites++;
          assert.deepEqual(request.postDataJSON(), {
            mode: "allowlist",
            areaIds: ["kitchen"],
            deviceIds: [],
            entityIds: [],
          });
          const before = structuredClone(homeAccessPolicy);
          homeAccessPolicy = request.postDataJSON();
          homeAccessHistory = [
            {
              id: "12121212-1212-4121-8121-121212121212",
              at: "2026-10-10T09:00:00Z",
              before,
              after: structuredClone(homeAccessPolicy),
            },
          ];
        }
        data =
          request.method() === "PUT"
            ? {
                ok: true,
                policy: request.postDataJSON(),
                historyWarning: undefined,
              }
            : homeAccessPolicy;
      } else if (endpoint === "/settings/home-assistant/access/history") {
        data = { revisions: homeAccessHistory, truncated: false };
      } else if (
        /^\/settings\/home-assistant\/access\/history\/[0-9a-f-]+\/prepare-rollback$/.test(
          endpoint,
        )
      ) {
        data = {
          ok: true,
          warning: "Terugzetten kan opnieuw toegang geven.",
          action: {
            confirmationId: "abababab-abab-4bab-8bab-abababababab",
            sessionId:
              "settings-ha-access-history:cdcdcdcd-cdcd-4dcd-8dcd-cdcdcdcdcdcd",
            tool: "home_assistant_access_rollback",
            args: {},
            risk: "DANGEROUS",
            allowAlways: false,
            createdAt: Date.now(),
            expiresAt: Date.now() + 60000,
          },
        };
      } else if (
        endpoint === "/settings/home-assistant/access/history/confirm-rollback"
      ) {
        homeAccessRollbackRuns++;
        assert.equal(request.postDataJSON().approve, true);
        homeAccessPolicy = {
          mode: "all",
          areaIds: [],
          deviceIds: [],
          entityIds: [],
        };
        data = { ok: true, policy: homeAccessPolicy };
      } else if (endpoint === "/settings/managed-targets/inventory") {
        data = {
          checkedAt: "2026-10-10T09:00:00Z",
          proxmox: {
            configured: true,
            nodes: [{ id: "pve-node", name: "pve-node" }],
            guests: [{ id: "101", name: "guest-one" }],
          },
          termix: { configured: true, hosts: [{ id: "7", name: "nas" }] },
          pangolin: {
            configured: true,
            sites: [{ id: "site-1", name: "tunnel" }],
            resources: [{ id: "resource-1", name: "app" }],
          },
        };
      } else if (endpoint === "/settings/managed-targets/access/history") {
        data = { revisions: managedTargetHistory, truncated: false };
      } else if (
        /^\/settings\/managed-targets\/access\/history\/[0-9a-f-]+\/prepare-rollback$/.test(
          endpoint,
        )
      ) {
        data = {
          ok: true,
          warning: "Terugzetten kan NOVA opnieuw toegang geven.",
          action: {
            confirmationId: "abababab-abab-4bab-8bab-abababababab",
            sessionId:
              "settings-targets-history:cdcdcdcd-cdcd-4dcd-8dcd-cdcdcdcdcdcd",
            tool: "managed_targets_access_rollback",
            args: {},
            risk: "DANGEROUS",
            allowAlways: false,
            createdAt: Date.now(),
            expiresAt: Date.now() + 60000,
          },
        };
      } else if (
        endpoint === "/settings/managed-targets/access/history/confirm-rollback"
      ) {
        managedTargetAccessRollbacks++;
        assert.equal(request.postDataJSON().approve, true);
        data = {
          ok: true,
          policy: managedTargetPolicy,
          historyWarning: "Geschiedenis kon niet worden opgeslagen.",
        };
      } else if (endpoint === "/settings/managed-targets/access") {
        assert.equal(request.headers()["x-nova-admin"], "1");
        if (request.method() === "PUT") {
          managedTargetAccessWrites++;
          assert.deepEqual(request.postDataJSON(), {
            ...managedTargetPolicy,
            mode: "allowlist",
            proxmoxNodeIds: ["pve-node"],
          });
          const before = structuredClone(managedTargetPolicy);
          Object.assign(managedTargetPolicy, request.postDataJSON());
          managedTargetHistory = [
            {
              id: "abababab-abab-4bab-8bab-abababababab",
              at: "2026-10-10T09:00:00Z",
              before,
              after: structuredClone(managedTargetPolicy),
            },
          ];
          data = { ok: true, policy: structuredClone(managedTargetPolicy) };
        } else data = structuredClone(managedTargetPolicy);
      } else if (endpoint === "/settings/skills/ochtend/versions") {
        skillVersionReads++;
        data = {
          currentVersion: skillVersion,
          scannedEntries: 2,
          truncated: false,
          versions: [
            { version: 1, at: "2026-10-09T10:00:00Z", action: "created" },
            {
              version: skillVersion,
              at: "2026-10-10T10:00:00Z",
              action: "updated",
            },
          ],
        };
      } else if (endpoint === "/settings/skills/ochtend/content-history") {
        skillContentReads++;
        data = {
          currentVersion: skillVersion,
          truncated: false,
          revisions:
            skillVersion === 2
              ? [
                  {
                    id: "55555555-5555-4555-8555-555555555555",
                    skillId: "ochtend",
                    at: "2026-10-10T10:00:00Z",
                    before: {
                      version: 1,
                      name: "Ochtend",
                      description: "Oude ochtendbeschrijving",
                      examples: ["Goedemorgen"],
                      enabled: true,
                      instructions: "Bekijk het weer.",
                    },
                    after: {
                      version: 2,
                      name: "Ochtend",
                      description: "Een rustige start",
                      examples: ["Goedemorgen"],
                      enabled: true,
                      instructions: "Bekijk het weer.",
                    },
                  },
                  {
                    id: "66666666-6666-4666-8666-666666666666",
                    skillId: "ochtend",
                    at: "2026-10-09T10:00:00Z",
                    before: null,
                    after: {
                      version: 1,
                      name: "Ochtend",
                      description: "Een rustige start",
                      examples: ["Goedemorgen"],
                      enabled: true,
                      instructions: "Bekijk het weer.",
                    },
                  },
                ]
              : [],
        };
      } else if (
        endpoint ===
          "/settings/skills/ochtend/content-history/55555555-5555-4555-8555-555555555555/rollback" &&
        request.method() === "POST"
      ) {
        skillContentRollbacks++;
        skillVersion = 3;
        overview.skills[0] = {
          ...overview.skills[0],
          version: skillVersion,
          description: "Oude ochtendbeschrijving",
        };
        data = { ok: true, skill: structuredClone(overview.skills[0]) };
      } else if (endpoint === "/settings/services/history")
        data = { revisions: [] };
      else if (
        endpoint.endsWith("/test") &&
        endpoint.startsWith("/settings/services/")
      ) {
        assert.equal(
          request.postDataJSON().values.token,
          "secret-test-fixture",
        );
        tested = true;
        data = {
          ok: true,
          message: "De koppeling antwoordt. Er is geen wijziging uitgevoerd.",
          checkedAt: "2026-10-10",
        };
      } else if (
        request.method() === "PUT" &&
        endpoint.startsWith("/settings/services/")
      ) {
        const service = services.find(
          (item) => item.id === endpoint.split("/").at(-1),
        );
        for (const field of service.fields) {
          if (field.kind === "secret") field.set = true;
          else field.value = request.postDataJSON().values[field.key];
          field.source = "settings";
        }
        service.restartRequired = true;
        data = { ok: true, services };
      } else if (endpoint === "/settings") {
        if (pinned && request.headers()["x-nova-pin"] !== "4321") {
          await route.fulfill({
            status: 401,
            json: { error: "PIN vereist", pinRequired: true },
          });
          return;
        }
        data = { ...overview, persona, personaStyle, pinRequired: pinned };
      } else if (endpoint === "/settings/persona") {
        persona = request.postDataJSON().text;
        data = { ok: true, persona };
      } else if (endpoint === "/settings/persona/style") {
        personaStyle = request.postDataJSON().style;
        data = { ok: true, personaStyle };
      } else if (endpoint === "/settings/persona/profile") {
        personaProfile = request.postDataJSON().profile;
        data = { ok: true, personaProfile };
      } else if (endpoint === "/settings/household-profiles") {
        overview.householdProfiles = request.postDataJSON().profiles;
        overview.activeHouseholdProfileId =
          request.postDataJSON().activeProfileId;
        personaProfile =
          overview.householdProfiles.find(
            (item) => item.id === overview.activeHouseholdProfileId,
          )?.personaProfile ?? personaProfile;
        data = {
          ok: true,
          householdProfiles: overview.householdProfiles,
          activeHouseholdProfileId: overview.activeHouseholdProfileId,
        };
      } else if (endpoint === "/settings/household-profiles/history") {
        householdProfileHistoryReads++;
        data = {
          revisions: [
            {
              id: "33333333-3333-4333-8333-333333333333",
              at: "2026-10-10T12:00:00.000Z",
              beforeProfileId: "person-a",
              afterProfileId: "person-b",
            },
          ],
          truncated: false,
        };
      } else if (
        endpoint ===
        "/settings/household-profiles/history/33333333-3333-4333-8333-333333333333/rollback"
      ) {
        householdProfileHistoryWrites++;
        overview.activeHouseholdProfileId = "person-a";
        data = { ok: true, activeHouseholdProfileId: "person-a" };
      } else if (
        endpoint === "/settings/household-profiles/definitions/history"
      ) {
        householdDefinitionHistoryReads++;
        data = {
          revisions: [
            {
              id: "44444444-4444-4444-8444-444444444444",
              at: "2026-10-10T13:00:00.000Z",
              beforeCount: 2,
              afterCount: 2,
              changedProfileIds: ["person-b"],
            },
          ],
          truncated: false,
        };
      } else if (
        endpoint ===
        "/settings/household-profiles/definitions/history/44444444-4444-4444-8444-444444444444/rollback"
      ) {
        householdDefinitionHistoryWrites++;
        overview.householdProfiles[1].label = "Profiel B hersteld";
        data = {
          ok: true,
          householdProfiles: overview.householdProfiles,
          activeHouseholdProfileId: overview.activeHouseholdProfileId,
        };
      } else if (endpoint === "/settings/persona/history") {
        personaHistoryReads++;
        data = {
          revisions: [
            {
              id: "11111111-1111-4111-8111-111111111111",
              at: "2026-10-10T10:00:00.000Z",
              before: "Wees helder.",
              after: "Wees warm en duidelijk.",
            },
          ],
          truncated: false,
        };
      } else if (endpoint === "/settings/persona/preferences/history") {
        personaPreferencesHistoryReads++;
        data = {
          revisions: [
            {
              id: "22222222-2222-4222-8222-222222222222",
              at: "2026-10-10T11:00:00.000Z",
              before: {
                style: "friendly",
                profile: {
                  name: "NOVA",
                  character: "warm, nieuwsgierig en met af en toe droge humor",
                  address: "je/jij",
                  avoid:
                    "doen alsof ik een mens ben of gevoelens en ervaringen verzinnen",
                },
              },
              after: {
                style: "playful",
                profile: {
                  name: "Nova",
                  character: "warm, nieuwsgierig en met af en toe droge humor",
                  address: "je/jij",
                  avoid:
                    "doen alsof ik een mens ben of gevoelens en ervaringen verzinnen",
                },
              },
            },
          ],
          truncated: false,
        };
      } else if (
        endpoint ===
        "/settings/persona/preferences/history/22222222-2222-4222-8222-222222222222/rollback"
      ) {
        personaPreferencesHistoryWrites++;
        personaStyle = "friendly";
        personaProfile = {
          name: "NOVA",
          character: "warm, nieuwsgierig en met af en toe droge humor",
          address: "je/jij",
          avoid:
            "doen alsof ik een mens ben of gevoelens en ervaringen verzinnen",
        };
        data = {
          ok: true,
          snapshot: { style: personaStyle, profile: personaProfile },
        };
      } else if (endpoint === "/providers")
        data = {
          ready: true,
          enabledModels: ["gratis-voorbeeld"],
          providers: [{ provider: "mistral", enabledModels: 1 }],
        };
      else if (endpoint === "/gateway")
        data = {
          online: true,
          memory: { keyword: true },
          skills: { count: 2 },
          compression: { enabled: false },
          cache: {},
        };
      else if (endpoint === "/integrations")
        data = {
          homeAssistant: { online: true, configured: true, entities: 8 },
          proxmox: { online: true },
          mqtt: { online: false },
          actions: { enabled: true },
        };
      else if (endpoint === "/memories")
        data = {
          memories: [],
          items: [],
          unavailable: "Geen geheugen in deze test.",
        };
      else if (endpoint === "/audit") data = { entries: [] };
      else if (endpoint === "/settings/helper")
        data = {
          settings: { mode: "helper", display: 0 },
          desktop: { available: false, reason: "no-agent" },
          applied: false,
        };
      else if (endpoint === "/settings/wallpaper")
        data = { available: false, reason: "no-agent" };
      else if (endpoint === "/settings/import/prepare") {
        importPrepares++;
        assert.equal(request.headers()["x-nova-admin"], "1");
        assert.deepEqual(request.postDataJSON(), {
          data: backup,
          mode: "replace",
          acknowledgeEffects: true,
        });
        const now = await page.evaluate(() => Date.now());
        data = {
          ok: true,
          summary: {
            mode: "replace",
            incomingSkills: 1,
            totalSkills: 1,
            incomingWidgets: 0,
            totalWidgets: 0,
            incomingLists: 1,
            totalLists: 1,
            removedLists: 0,
            replacedSkills: 1,
            removedSkills: 0,
            removedWidgets: 1,
            personaChanged: true,
            quickActionsChanged: false,
            toolOverridesChanged: false,
            sidebarChanged: true,
            helperChanged: true,
            helperPreferencesChanged: true,
            listsChanged: true,
            connectionsChanged: true,
            changedConnections: 1,
            connectionChanges: [
              {
                service: "home-assistant",
                before: { url: "http://destination.invalid:8123" },
                after: { url: "http://source.invalid:8123" },
              },
            ],
            missingSecrets: missingHeaders,
          },
          action: {
            confirmationId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
            sessionId: "settings-import:bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
            tool: "settings_import",
            args: {
              mode: "replace",
              incomingSkills: 1,
              incomingWidgets: 0,
              incomingLists: 1,
              totalLists: 1,
              removedLists: 0,
              changedConnections: 1,
            },
            risk: "DANGEROUS",
            allowAlways: false,
            createdAt: now,
            expiresAt: now + 60000,
          },
        };
      } else if (endpoint === "/settings/import") {
        assert.equal(request.headers()["x-nova-admin"], "1");
        const confirmation = request.postDataJSON();
        assert.equal(
          confirmation.sessionId,
          "settings-import:bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
        );
        assert.equal(
          confirmation.confirmationId,
          "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
        );
        if (confirmation.approve) {
          importWrites++;
          data = {
            ok: true,
            imported: 1,
            importedLists: 1,
            changedConnections: 1,
            missingSecrets: missingHeaders,
          };
        } else
          data = {
            ok: true,
            cancelled: true,
            imported: 0,
            importedLists: 0,
            missingSecrets: [],
          };
      } else if (endpoint === "/settings/export")
        data = {
          ...overview,
          format: "nova-settings",
          version: 1,
          exportedAt: "2026-10-09",
        };
      await route.fulfill({ json: data });
    });
    await page.goto(`${base}/settings?section=general`);
    await page
      .locator("#settingsSearch")
      .waitFor()
      .catch(async (error) => {
        console.error(errors, await page.locator("body").innerText());
        throw error;
      });
    await page.getByText("Mijn notitie", { exact: true }).waitFor();
    await page.screenshot({
      path: path.join(
        screenshots,
        `settings-general-${width === 390 ? "mobile" : `${scale}x`}.png`,
      ),
    });
    await page
      .getByRole("button", { name: "Bewerken", exact: true })
      .first()
      .click();
    await page.getByText("Notitiegeschiedenis", { exact: true }).click();
    await page.getByRole("button", { name: "Geschiedenis laden" }).click();
    await page
      .getByText("Alleen de 50 recentste wijzigingen zijn bewaard.")
      .waitFor();
    await page
      .getByRole("button", { name: "Terugzetten", exact: true })
      .click();
    await page
      .getByRole("button", {
        name: "Nogmaals klikken om terug te zetten",
        exact: true,
      })
      .click();
    await page.waitForFunction(
      () => document.querySelector("#wText")?.value === "Oude notitie",
    );
    await page.waitForFunction(
      () => document.querySelector("#wTitle")?.value === "Oude titel",
    );
    await page
      .getByRole("button", {
        name: "Aangemaakte notitie verwijderen",
        exact: true,
      })
      .click();
    await page
      .getByRole("button", {
        name: "Nogmaals klikken om terug te zetten",
        exact: true,
      })
      .click();
    await page
      .getByText("De ongewijzigde, aangemaakte notitie is verwijderd.")
      .waitFor();
    await page.locator("#wText").waitFor({ state: "detached" });
    assert.equal(noteHistoryReads, 2);
    assert.equal(noteHistoryWrites, 2);
    await page
      .getByRole("button", { name: "Bewerken", exact: true })
      .first()
      .click();
    await page.getByText("Geschiedenis weergave", { exact: true }).click();
    await page.getByRole("button", { name: "Geschiedenis laden" }).click();
    await page.getByText("Aantal bezoekers (personen)").waitFor();
    await page.getByText("Bezoekers (mensen)").waitFor();
    assert.equal(widgetDisplayHistoryReads, 1);
    await page
      .getByRole("button", { name: "Terugzetten", exact: true })
      .click();
    await page
      .getByRole("button", {
        name: "Nogmaals klikken om terug te zetten",
        exact: true,
      })
      .click();
    await page.waitForFunction(
      () => document.querySelector("#wTitle")?.value === "Bezoekers",
    );
    assert.equal(widgetDisplayHistoryReads, 2);
    assert.equal(widgetDisplayHistoryWrites, 1);
    await page.locator("#settingsSearch").fill("model");
    assert.equal(await page.locator(".settings-sidebar nav a").count(), 1);
    await page.locator("#settingsSearch").press("Enter");
    await page.waitForURL("**/settings?section=models");
    assert.equal(
      accountsReads,
      0,
      "Opening models must not fetch account metadata",
    );
    assert.equal(policyReads, 0, "Opening models must not load policy options");
    assert.equal(policyWrites, 0);
    const conversationRole = page.getByRole("group", { name: "Gesprek" });
    await conversationRole
      .getByLabel("free/provider-a", { exact: true })
      .check();
    await page.getByRole("button", { name: "Voorkeuren opslaan" }).click();
    await page.getByText("Modelrolvoorkeuren opgeslagen.").waitFor();
    assert.equal(modelRoleWrites, 1);
    await page.getByText("0 → 1 modelkeuzes", { exact: false }).waitFor();
    await page
      .getByRole("button", { name: "Terugzetten", exact: true })
      .click();
    await page.getByText("Modelrolvoorkeuren teruggezet.").waitFor();
    assert.equal(modelRoleHistoryRollbacks, 1);
    await conversationRole
      .getByLabel("free/provider-a", { exact: true })
      .waitFor();
    assert.equal(
      await conversationRole
        .getByLabel("free/provider-a", { exact: true })
        .isChecked(),
      false,
    );
    await page
      .getByRole("button", { name: "Accounts en catalogus laden", exact: true })
      .click();
    const accounts = page.getByRole("region", {
      name: "OmniRoute-accounts en modelcatalogus",
    });
    await accounts.getByText("Voorbeeldaccount", { exact: true }).waitFor();
    assert.equal(accountsReads, 1);
    assert.equal(omniUsageReads, 0, "provider limits load only on request");
    assert.match(
      await accounts.innerText(),
      /Facturering en harde gratis limieten zijn niet gecontroleerd/,
    );
    await accounts.locator("summary").nth(0).click();
    await accounts
      .getByText("<script>globalThis.accountCatalogRan = true</script>", {
        exact: true,
      })
      .waitFor();
    await accounts.locator("summary").nth(1).click();
    await accounts.getByText("Voorbeeldroute", { exact: true }).waitFor();
    assert.doesNotMatch(await accounts.innerText(), /private combo text/);
    assert.equal(
      await page.evaluate(() => globalThis.accountCatalogRan),
      undefined,
    );
    await accounts
      .getByRole("button", { name: "Gebruik en limieten laden", exact: true })
      .click();
    await accounts
      .getByText("Gecachete providerlimieten", { exact: true })
      .waitFor();
    await accounts.getByText(/daily: resterend 750; limiet 1.000/).waitFor();
    assert.equal(omniUsageReads, 1);
    assert.match(await accounts.innerText(), /bevestigen geen gratis toegang/);
    await accounts
      .getByRole("button", { name: "API-sleutelrechten bekijken", exact: true })
      .click();
    await accounts
      .getByRole("region", { name: "OmniRoute API-sleutelrechten" })
      .getByText("NOVA local key", { exact: true })
      .waitFor();
    assert.equal(apiKeyInventoryReads, 1);
    assert.doesNotMatch(await accounts.innerText(), /private-fixture-secret/);
    const accountCreator = accounts.getByRole("region", {
      name: "Provideraccount toevoegen",
    });
    await accountCreator.getByLabel("Provider-ID").fill("mistral");
    await accountCreator.getByLabel("Accountnaam").fill("Mijn Mistral");
    await accountCreator
      .getByLabel("API-sleutel")
      .fill("provider-key-test-secret");
    await accountCreator
      .getByRole("button", { name: "Controleren en voorbereiden" })
      .click();
    await accountCreator.getByText(/Toe te voegen: Mijn Mistral/).waitFor();
    assert.equal(await accountCreator.getByLabel("API-sleutel").count(), 0);
    assert.doesNotMatch(
      await accountCreator.innerText(),
      /provider-key-test-secret/,
    );
    const accountCreateConfirm = accountCreator.getByRole("button", {
      name: "Account toevoegen",
      exact: true,
    });
    assert.equal(await accountCreateConfirm.isDisabled(), true);
    await accountCreator.getByRole("checkbox").check();
    await accountCreateConfirm.click();
    await accounts
      .getByText(
        /Provideraccount Mijn Mistral toegevoegd en gecontroleerd; de gratis route blijft geverifieerd/,
      )
      .waitFor();
    assert.equal(accountCreateWrites, 1);
    assert.doesNotMatch(await accounts.innerText(), /provider-key-test-secret/);
    const accountKeyUpdater = accounts.getByRole("region", {
      name: "API-sleutel vervangen",
    });
    await accountKeyUpdater
      .getByLabel("Account")
      .selectOption("fixture-account");
    await accountKeyUpdater
      .getByLabel("Nieuwe API-sleutel")
      .fill("replacement-key-test-secret");
    await accountKeyUpdater
      .getByRole("button", { name: "Controleren en voorbereiden" })
      .click();
    await accountKeyUpdater
      .getByText(/Nieuwe sleutel voor Voorbeeldaccount/)
      .waitFor();
    assert.equal(
      await accountKeyUpdater.getByLabel("Nieuwe API-sleutel").count(),
      0,
    );
    assert.doesNotMatch(
      await accountKeyUpdater.innerText(),
      /replacement-key-test-secret/,
    );
    const accountKeyUpdateConfirm = accountKeyUpdater.getByRole("button", {
      name: "Sleutel vervangen",
      exact: true,
    });
    assert.equal(await accountKeyUpdateConfirm.isDisabled(), true);
    await accountKeyUpdater.getByRole("checkbox").check();
    await accountKeyUpdateConfirm.click();
    await accounts
      .getByText(
        /API-sleutel vervangen en gecontroleerd; de gratis route blijft geverifieerd/,
      )
      .waitFor();
    assert.equal(accountKeyUpdateWrites, 1);
    assert.doesNotMatch(
      await accounts.innerText(),
      /replacement-key-test-secret/,
    );
    const accountRenamer = accounts.getByRole("region", {
      name: "Accountnaam wijzigen fixture",
    });
    await accountRenamer
      .getByRole("button", { name: "Naam wijzigen", exact: true })
      .click();
    await accountRenamer.getByLabel("Nieuwe accountnaam").fill("Nieuwe naam");
    await accountRenamer
      .getByRole("button", { name: "Controleren", exact: true })
      .click();
    await accountRenamer.getByText(/Wijzigen:/).waitFor();
    const renameConfirm = accountRenamer.getByRole("button", {
      name: "Naam wijzigen",
      exact: true,
    });
    assert.equal(await renameConfirm.isDisabled(), true);
    await accountRenamer.getByRole("checkbox").check();
    await renameConfirm.click();
    await accounts
      .getByText(/Accountnaam gewijzigd en gecontroleerd voor Nieuwe naam/)
      .waitFor();
    assert.equal(accountRenameWrites, 1);
    await accountRenamer
      .getByRole("button", { name: "Geschiedenis laden", exact: true })
      .click();
    await accountRenamer.getByText("Voorbeeldaccount → Nieuwe naam").waitFor();
    await accountRenamer
      .getByRole("button", {
        name: "Nieuwste wijziging herstellen",
        exact: true,
      })
      .click();
    await accountRenamer.getByText(/Herstellen:/).waitFor();
    const renameRollbackConfirm = accountRenamer.getByRole("button", {
      name: "Naam wijzigen",
      exact: true,
    });
    assert.equal(await renameRollbackConfirm.isDisabled(), true);
    await accountRenamer.getByRole("checkbox").check();
    await renameRollbackConfirm.click();
    await accounts
      .getByText(/Accountnaam gewijzigd en gecontroleerd voor Voorbeeldaccount/)
      .waitFor();
    assert.equal(accountRenameWrites, 2);
    assert.equal(accountRenameRollbackPrepares, 1);
    assert(accountRenameHistoryReads >= 2);
    assert.doesNotMatch(await accounts.innerText(), /private-fixture-secret/);
    await accounts
      .getByText("NOVA’s eigen sleutel is beschermd.", { exact: true })
      .waitFor();
    const keyApproval = accounts.getByRole("group", {
      name: "API-sleutel in- of uitschakelen",
    });
    await accounts
      .getByRole("button", { name: "Sleutel uitschakelen", exact: true })
      .click();
    await keyApproval
      .getByText("Client key. Dit geldt voor alle OmniRoute-clients.")
      .waitFor();
    const keyConfirm = keyApproval.getByRole("button", {
      name: "Bevestig uitschakelen",
      exact: true,
    });
    assert.equal(await keyConfirm.isDisabled(), true);
    await keyApproval
      .getByRole("checkbox", {
        name: "Ik begrijp dat dit alle OmniRoute-clients met deze sleutel raakt.",
      })
      .check();
    await keyConfirm.click();
    await accounts
      .getByText(
        /API-sleutel uitgeschakeld en gecontroleerd; gratis route blijft geverifieerd/,
      )
      .waitFor();
    assert.equal(keyActivationWrites, 1);
    await keyApproval
      .getByRole("button", { name: "Wijzigingsgeschiedenis", exact: true })
      .click();
    await keyApproval
      .getByRole("button", { name: "Zet terug", exact: true })
      .click();
    await keyApproval
      .getByRole("checkbox", {
        name: "Ik begrijp dat dit alle OmniRoute-clients met deze sleutel raakt.",
      })
      .check();
    await keyApproval
      .getByRole("button", { name: "Bevestig inschakelen", exact: true })
      .click();
    await accounts
      .getByText(/API-sleutel ingeschakeld en gecontroleerd/, { exact: false })
      .waitFor();
    await accounts.getByText("Geschiedeniswaarschuwing proef").waitFor();
    await accounts.getByText("Actielogwaarschuwing proef").waitFor();
    assert.equal(keyActivationWrites, 2);
    assert.equal(keyEnabled, true);
    const clientKey = accounts
      .getByRole("listitem")
      .filter({ hasText: "Client key" });
    await clientKey
      .getByRole("button", { name: "Modelrechten instellen" })
      .click();
    await clientKey.getByLabel("free/two").uncheck();
    await clientKey
      .getByLabel(
        "Ik begrijp dat dit modeltoegang wijzigt voor alle OmniRoute-clients die deze sleutel gebruiken.",
      )
      .check();
    await clientKey
      .getByRole("button", { name: "Wijziging voorbereiden" })
      .click();
    await clientKey.getByRole("button", { name: "Bevestigen" }).click();
    await accounts
      .getByText(/Modeltoegang gewijzigd en gecontroleerd/)
      .waitFor();
    assert.equal(keyModelWrites, 1);
    assert.equal(keyModelMode, "restricted");
    assert.deepEqual(keyModelAllowed, ["free/one"]);
    await clientKey
      .getByRole("button", { name: "Wijzigingsgeschiedenis" })
      .click();
    const modelAccessHistory = accounts.getByRole("region", {
      name: "Modelrechtenhistorie",
    });
    await modelAccessHistory.getByText(/alle modellen → free\/one/).waitFor();
    await modelAccessHistory
      .getByRole("button", { name: "Herstellen" })
      .click();
    await clientKey.getByRole("button", { name: "Bevestigen" }).click();
    await accounts
      .getByText(/Modeltoegang gewijzigd en gecontroleerd/)
      .waitFor();
    assert.equal(keyModelWrites, 2);
    assert.equal(keyModelMode, "all");
    assert.deepEqual(keyModelAllowed, ["free/one", "free/two"]);
    assert.equal(keyModelHistory[0].revertedFrom, keyModelHistory[1].id);
    await clientKey
      .getByRole("button", { name: "Tokenlimieten laden" })
      .click();
    const tokenBudget = clientKey.getByRole("region", {
      name: "Tokenlimieten per API-sleutel",
    });
    await tokenBudget.getByLabel("Globale tokenlimiet").fill("5000");
    assert.equal(tokenLimitReads, 1);
    await tokenBudget.getByLabel("Periode").selectOption("weekly");
    const tokenLimitImpact = page.getByLabel(
      "Ik begrijp dat dit alle clients met deze sleutel kan raken.",
    );
    await tokenLimitImpact.click({ force: true, noWaitAfter: true });
    assert.equal(await tokenLimitImpact.isChecked(), true);
    await tokenBudget
      .getByRole("button", { name: "Controleren en voorbereiden" })
      .click();
    const tokenLimitConfirm = tokenBudget.getByRole("button", {
      name: "Tokenlimiet bevestigen",
    });
    assert.equal(await tokenLimitConfirm.isDisabled(), true);
    const tokenLimitConfirmImpact = page.getByLabel(
      "Ik begrijp dat deze limiet alle clients met deze sleutel raakt.",
    );
    await tokenLimitConfirmImpact.click({ force: true, noWaitAfter: true });
    assert.equal(await tokenLimitConfirmImpact.isChecked(), true);
    await tokenLimitConfirm.click();
    await accounts
      .getByText("Tokenlimiet opgeslagen en gecontroleerd.", { exact: true })
      .waitFor();
    assert.equal(tokenLimitWrites, 1);
    assert.equal(tokenLimitReads, 2);
    assert.match(await tokenBudget.innerText(), /5\.000 tokens \/ weekly/);
    await accounts
      .getByRole("button", { name: "Verborgen modellen bekijken", exact: true })
      .click();
    assert.equal(
      modelVisibilityReads,
      1,
      "hidden-model metadata loads only on request",
    );
    await accounts
      .getByRole("region", { name: "Modellen verborgen uit de catalogus" })
      .getByText("fixture · hidden-model", { exact: true })
      .waitFor();
    assert.equal(modelVisibilityReads, 1);
    assert.match(
      await accounts.innerText(),
      /schakelt modelaanroepen niet uit/,
    );
    const comboCreator = accounts.locator("details").nth(1).locator(".creator");
    await comboCreator
      .locator('input:not([type="checkbox"])')
      .fill("Mijn testcombo");
    await comboCreator.locator('input[type="checkbox"]').first().check();
    await comboCreator
      .getByRole("button", { name: "Controleren en voorbereiden" })
      .click();
    const comboCreateConfirm = comboCreator.getByRole("button", {
      name: "Combo aanmaken",
      exact: true,
    });
    assert.equal(await comboCreateConfirm.isDisabled(), true);
    await comboCreator.locator('input[type="checkbox"]').last().check();
    await comboCreateConfirm.click();
    await accounts
      .getByText(/Combo Mijn testcombo aangemaakt en opslag gecontroleerd/)
      .waitFor();
    assert.equal(comboCreateWrites, 1);
    await accounts
      .getByRole("button", { name: "Combo bewerken", exact: true })
      .click();
    const comboEditor = accounts.locator(".editor");
    await comboEditor
      .locator('input:not([type="checkbox"])')
      .fill("Bewerkte route");
    await comboEditor.getByRole("button", { name: "Controleren" }).click();
    const comboUpdateConfirm = comboEditor.getByRole("button", {
      name: "Wijziging bevestigen",
    });
    assert.equal(await comboUpdateConfirm.isDisabled(), true);
    await comboEditor.getByRole("checkbox").check();
    await comboUpdateConfirm.click();
    await accounts
      .getByText(
        /Combo bijgewerkt en gecontroleerd; gratis route blijft geverifieerd/,
      )
      .waitFor();
    assert.equal(comboUpdateWrites, 1);
    await accounts
      .getByRole("button", { name: "Wijzigingsgeschiedenis laden" })
      .click();
    await accounts
      .getByText("Oorspronkelijke route → Bewerkte route")
      .waitFor();
    await accounts
      .getByRole("list", { name: "Combo-wijzigingsgeschiedenis" })
      .getByRole("button", { name: "Nieuwste wijziging herstellen" })
      .click();
    const comboRollbackEditor = accounts.locator(".editor");
    const comboRollbackConfirm = comboRollbackEditor.getByRole("button", {
      name: "Herstel bevestigen",
    });
    assert.equal(await comboRollbackConfirm.isDisabled(), true);
    await comboRollbackEditor.getByRole("checkbox").check();
    await comboRollbackConfirm.click();
    await accounts.getByText(/Testgeschiedenis bijgewerkt/).waitFor();
    assert.equal(comboUpdateWrites, 2);
    assert.equal(comboName, "Oorspronkelijke route");
    await accounts
      .getByRole("button", { name: "Account uitschakelen", exact: true })
      .click();
    const accountApproval = accounts.getByRole("group", {
      name: "Provideraccount in- of uitschakelen",
    });
    await accountApproval
      .getByText("het account voor alle OmniRoute-clients")
      .waitFor();
    await accountApproval
      .getByRole("button", { name: "Bevestig uitschakelen", exact: true })
      .click();
    await accounts
      .getByText(
        /Provideraccount uitgeschakeld en gecontroleerd; gratis route blijft geverifieerd/,
      )
      .waitFor();
    assert.equal(accountActivationWrites, 1);
    assert.equal(accountActive, false);
    await accounts
      .getByRole("button", { name: "Herstel", exact: true })
      .click();
    await accountApproval
      .getByText("Dit wijzigt het account voor alle OmniRoute-clients")
      .waitFor();
    await accountApproval
      .getByRole("button", { name: "Bevestig inschakelen", exact: true })
      .click();
    await accounts
      .getByText(
        /Provideraccount ingeschakeld en gecontroleerd; gratis route blijft geverifieerd/,
      )
      .waitFor();
    assert.equal(accountActivationRollbackPrepares, 1);
    assert.equal(accountActivationHistoryReads, 2);
    assert.equal(accountActivationWrites, 2);
    assert.equal(accountActive, true);
    await accounts.locator("summary").nth(1).click();
    await accounts.screenshot({
      path: path.join(
        screenshots,
        `settings-accounts-${width === 390 ? "mobile" : `${scale}x`}.png`,
      ),
    });
    await accounts.locator("summary").nth(1).click();
    await accounts.screenshot({
      path: path.join(
        screenshots,
        `settings-combos-${width === 390 ? "mobile" : `${scale}x`}.png`,
      ),
    });
    await accounts
      .getByRole("button", { name: "Combo uitschakelen", exact: true })
      .click();
    const comboApproval = accounts.getByRole("group", {
      name: "Combo-route in- of uitschakelen",
    });
    await comboApproval
      .locator("p")
      .filter({ hasText: "Dit wijzigt de route voor alle OmniRoute-clients." })
      .waitFor();
    await comboApproval.screenshot({
      path: path.join(
        screenshots,
        `settings-combo-confirm-${width === 390 ? "mobile" : `${scale}x`}.png`,
      ),
    });
    await comboApproval
      .getByRole("button", { name: "Bevestig uitschakelen", exact: true })
      .click();
    await accounts
      .getByText(
        /Combo uitgeschakeld en opslag gecontroleerd; gratis route blijft geverifieerd/,
      )
      .waitFor();
    assert.equal(comboWrites, 1);
    assert.equal(comboActive, false);
    await comboApproval
      .getByRole("button", { name: "Wijzigingsgeschiedenis" })
      .click();
    await comboApproval
      .getByRole("button", { name: "Herstel", exact: true })
      .click();
    await comboApproval
      .getByRole("button", { name: "Bevestig inschakelen", exact: true })
      .click();
    await accounts
      .getByText(/Combo ingeschakeld en opslag gecontroleerd/)
      .waitFor();
    assert.equal(comboHistoryReads, 3);
    assert.equal(comboRollbackPrepares, 1);
    assert.equal(comboWrites, 2);
    assert.equal(comboActive, true);
    const comboRemoval = accounts.getByRole("group", {
      name: "Combo-route verwijderen",
    });
    await comboRemoval
      .getByRole("button", { name: "Combo verwijderen", exact: true })
      .click();
    await comboRemoval
      .getByRole("checkbox", {
        name: "Ik begrijp dat dit alle OmniRoute-clients kan raken.",
      })
      .check();
    await comboRemoval.screenshot({
      path: path.join(
        screenshots,
        `settings-combo-removal-confirm-${width === 390 ? "mobile" : `${scale}x`}.png`,
      ),
    });
    await comboRemoval
      .getByRole("button", { name: "Combo verwijderen", exact: true })
      .click();
    await accounts.getByText(/Combo verwijderd en gecontroleerd/).waitFor();
    assert.equal(comboRemovalWrites, 1);
    accountInventoryGate = new Promise((resolve) => {
      releaseAccountInventory = resolve;
    });
    await accounts
      .getByRole("button", { name: "Accounts en catalogus laden", exact: true })
      .click();
    await accounts
      .getByRole("button", { name: "Laden…", exact: true })
      .waitFor();
    assert.equal(
      await accounts
        .getByRole("button", {
          name: "Verwijder Voorbeeldaccount",
          exact: true,
        })
        .isDisabled(),
      true,
    );
    releaseAccountInventory();
    accountInventoryGate = null;
    await accounts
      .getByRole("button", { name: "Accounts en catalogus laden", exact: true })
      .waitFor();
    assert.equal(
      await accounts
        .getByRole("button", {
          name: "Verwijder Voorbeeldaccount",
          exact: true,
        })
        .isDisabled(),
      false,
    );
    const removal = page.getByRole("group", {
      name: "Gateway-account verwijderen",
    });
    const chooseRemoval = async () => {
      await accounts
        .getByRole("button", {
          name: "Verwijder Voorbeeldaccount",
          exact: true,
        })
        .click();
      assert.equal(
        await removal
          .getByRole("button", {
            name: "Accountverwijdering voorbereiden",
            exact: true,
          })
          .isDisabled(),
        true,
      );
      await removal.getByRole("checkbox").check();
      await removal
        .getByRole("button", {
          name: "Accountverwijdering voorbereiden",
          exact: true,
        })
        .click();
      await removal
        .getByRole("button", {
          name: "Bevestig accountverwijdering",
          exact: true,
        })
        .waitFor();
    };
    await chooseRemoval();
    assert.equal(accountWrites, 0);
    assert.equal(
      await accounts
        .getByRole("button", {
          name: "Accounts en catalogus laden",
          exact: true,
        })
        .isDisabled(),
      true,
    );
    await removal.screenshot({
      path: path.join(
        screenshots,
        `settings-account-removal-${width === 390 ? "mobile" : `${scale}x`}.png`,
      ),
    });
    await removal
      .getByRole("button", {
        name: "Annuleer accountverwijdering",
        exact: true,
      })
      .click();
    await removal.waitFor({ state: "hidden" });
    assert.equal(accountWrites, 0);
    await chooseRemoval();
    await page.clock.fastForward(60001);
    assert.equal(
      await removal
        .getByRole("button", {
          name: "Bevestig accountverwijdering",
          exact: true,
        })
        .isDisabled(),
      true,
    );
    await removal
      .getByRole("button", {
        name: "Annuleer accountverwijdering",
        exact: true,
      })
      .click();
    await removal.waitFor({ state: "hidden" });
    await chooseRemoval();
    await removal
      .getByRole("button", {
        name: "Bevestig accountverwijdering",
        exact: true,
      })
      .click();
    await accounts
      .getByText("Geen accounts gevonden.", { exact: true })
      .waitFor();
    assert.equal(accountWrites, 1);
    assert.match(await accounts.innerText(), /AI blijft geblokkeerd/);

    const policy = page.getByRole("region", { name: "Gratis beleid maken" });
    assert.equal(policyReads, 0);
    await policy
      .getByRole("button", {
        name: "Keuzes voor gratis beleid laden",
        exact: true,
      })
      .click();
    await policy
      .getByRole("combobox", { name: "Account", exact: true })
      .waitFor();
    assert.equal(policyReads, 1);
    await policy
      .getByRole("combobox", { name: "Account", exact: true })
      .selectOption(policyAccountId);
    const policyModel = policy.getByRole("combobox", {
      name: "Model",
      exact: true,
    });
    await policyModel.selectOption("fixture-free-model");
    assert.equal(
      await policyModel
        .locator('option[value="fixture-free-model"]')
        .textContent(),
      "<script>globalThis.freePolicyLabelRan = true</script> (fixture-free-model)",
    );
    assert.equal(
      await page.evaluate(() => globalThis.freePolicyLabelRan),
      undefined,
    );
    await policy
      .getByRole("textbox", {
        name: "Officiële bron voor gratis account en harde limiet",
        exact: true,
      })
      .fill("https://groq.example/free-account-terms");
    const selectionAcknowledgements = policy.getByRole("checkbox");
    assert.equal(await selectionAcknowledgements.count(), 5);
    for (let index = 0; index < 5; index++)
      await selectionAcknowledgements.nth(index).check();
    await policy
      .getByRole("button", { name: "Model toevoegen aan beleid", exact: true })
      .click();
    await policy
      .getByRole("button", { name: "Verwijder keuze 1", exact: true })
      .waitFor();
    for (let index = 0; index < 5; index++) {
      assert.equal(
        await selectionAcknowledgements.nth(index).isChecked(),
        false,
        "Adding a model must reset every account attestation",
      );
      await selectionAcknowledgements.nth(index).check();
    }
    await policy
      .getByRole("button", { name: "Verwijder keuze 1", exact: true })
      .click();
    await policy
      .getByRole("button", { name: "Verwijder keuze 1", exact: true })
      .waitFor({ state: "detached" });
    for (let index = 0; index < 5; index++)
      assert.equal(
        await selectionAcknowledgements.nth(index).isChecked(),
        false,
        "Removing a model must reset every account attestation",
      );
    await policy
      .getByRole("button", { name: "Model toevoegen aan beleid", exact: true })
      .click();
    await policy
      .getByRole("button", { name: "Verwijder keuze 1", exact: true })
      .waitFor();
    const preparePolicy = policy.getByRole("button", {
      name: "Gratis beleid voorbereiden",
      exact: true,
    });
    const prepareChosenPolicy = async () => {
      assert.equal(await preparePolicy.isDisabled(), true);
      const acknowledgements = policy.getByRole("checkbox");
      assert.equal(await acknowledgements.count(), 5);
      for (let index = 0; index < 5; index++) {
        assert.equal(await preparePolicy.isDisabled(), true);
        await acknowledgements.nth(index).check();
      }
      assert.equal(await preparePolicy.isDisabled(), false);
      await preparePolicy.click();
      await policy
        .getByRole("heading", {
          name: "Beleidswijziging bevestigen",
          exact: true,
        })
        .waitFor();
      assert.equal(
        policyWrites,
        0,
        "Preparing policy must not persist changes",
      );
      assert.equal(
        await policy
          .getByRole("combobox", { name: "Account", exact: true })
          .isDisabled(),
        true,
      );
      assert.equal(
        await policy
          .getByRole("button", {
            name: "Keuzes voor gratis beleid laden",
            exact: true,
          })
          .isDisabled(),
        true,
      );
    };
    await prepareChosenPolicy();
    await policy.screenshot({
      path: path.join(
        screenshots,
        `settings-free-policy-${width === 390 ? "mobile" : `${scale}x`}.png`,
      ),
    });
    const cancelPolicy = policy.getByRole("button", {
      name: "Annuleer gratis beleid",
      exact: true,
    });
    await cancelPolicy.click();
    await policy
      .getByRole("status")
      .filter({ hasText: "Beleidswijziging geannuleerd." })
      .waitFor();
    assert.equal(policyWrites, 0);
    await prepareChosenPolicy();
    await page.clock.fastForward(60001);
    const confirmPolicy = policy.getByRole("button", {
      name: "Bevestig gratis beleid",
      exact: true,
    });
    assert.equal(await confirmPolicy.isDisabled(), true);
    await policy
      .getByText("Toestemming verlopen. Annuleer en bereid opnieuw voor.", {
        exact: true,
      })
      .waitFor();
    assert.equal(policyWrites, 0);
    await cancelPolicy.click();
    await policy
      .getByRole("heading", {
        name: "Beleidswijziging bevestigen",
        exact: true,
      })
      .waitFor({ state: "detached" });
    await prepareChosenPolicy();
    await confirmPolicy.click();
    await policy
      .getByRole("status")
      .filter({ hasText: "native quota is niet geverifieerd." })
      .waitFor();
    assert.equal(policyWrites, 1);
    assert.match(
      await policy.innerText(),
      /Facturering en harde limiet zijn door jou bevestigd/,
    );
    assert.doesNotMatch(
      await policy.innerText(),
      /De gratis route blijft geblokkeerd/,
    );
    const policyHistory = page.getByRole("region", {
      name: "Gratis beleidsgeschiedenis",
    });
    assert.equal(policyHistoryReads, 0);
    await policyHistory
      .getByRole("button", { name: "Beleidsgeschiedenis laden", exact: true })
      .click();
    await policyHistory
      .getByText(/Van: off · 0 modellen → Naar: strict · 1 modellen/)
      .waitFor();
    await policyHistory
      .getByText(/Terugzetten is geblokkeerd totdat OmniRoute sleutelrechten/)
      .waitFor();
    assert.equal(policyHistoryReads, 1);

    await page
      .getByRole("button", { name: "OmniRoute-overzicht laden", exact: true })
      .click();
    await page.getByText("Gedeelde voorbeeldskill", { exact: true }).waitFor();
    const sharedEnable = page.getByRole("button", {
      name: "Aan Gedeelde voorbeeldskill",
      exact: true,
    });
    assert.equal(await sharedEnable.isDisabled(), true);
    await page
      .getByRole("checkbox", {
        name: "Ik begrijp dat dit alle OmniRoute-clients raakt.",
        exact: true,
      })
      .check();
    assert.equal(globalNativeWrites, 0);
    await sharedEnable.click();
    await page
      .getByText("voor alle gateway-clients.", { exact: false })
      .waitFor();
    assert.equal(
      await page
        .getByRole("checkbox", {
          name: "Ik begrijp dat dit alle OmniRoute-clients raakt.",
          exact: true,
        })
        .isChecked(),
      false,
    );
    await page
      .getByRole("button", {
        name: "Bevestig skillmodus voor alle clients",
        exact: true,
      })
      .click();
    await page
      .getByText("Modus opgeslagen en gecontroleerd.", { exact: false })
      .waitFor();
    assert.equal(globalNativeWrites, 1);
    assert.equal(globalNativeMode, "on");
    await page
      .getByRole("checkbox", {
        name: "Ik begrijp dat deze geheugenschakelaar alle OmniRoute-clients raakt.",
        exact: true,
      })
      .check();
    await page
      .getByRole("button", {
        name: "Gateway-geheugen inschakelen",
        exact: true,
      })
      .click();
    await page
      .getByRole("group", { name: "Gateway-geheugenwijziging bevestigen" })
      .waitFor();
    assert.equal(gatewayMemoryWrites, 0);
    await page
      .getByRole("button", { name: "Bevestig voor alle clients", exact: true })
      .click();
    await page
      .getByText("Gateway-geheugen ingeschakeld voor alle clients.", {
        exact: false,
      })
      .waitFor();
    assert.equal(gatewayMemoryWrites, 1);
    assert.equal(gatewayMemoryEnabled, true);
    await page
      .getByRole("checkbox", {
        name: "Ik begrijp dat deze geheugenschakelaar alle OmniRoute-clients raakt.",
        exact: true,
      })
      .check();
    await page
      .getByRole("region", { name: "OmniRoute-skills en prompts" })
      .getByRole("heading", { name: "Wijzigingsgeschiedenis", exact: true })
      .waitFor();
    await page
      .getByRole("list", { name: "Gateway-geheugengeschiedenis" })
      .getByRole("button", { name: "Zet terug", exact: true })
      .click();
    await page
      .getByRole("group", { name: "Gateway-geheugenwijziging bevestigen" })
      .waitFor();
    await page
      .getByRole("button", { name: "Bevestig voor alle clients", exact: true })
      .click();
    await page
      .getByText("Gateway-geheugen uitgeschakeld voor alle clients.", {
        exact: false,
      })
      .waitFor();
    assert.equal(gatewayMemoryWrites, 2);
    assert.equal(gatewayMemoryEnabled, false);
    await page
      .getByRole("button", { name: "Aan NOVA voorbeeldskill", exact: true })
      .click();
    await page
      .getByRole("group", { name: "Native skillwijziging bevestigen" })
      .waitFor();
    assert.equal(nativeWrites, 0);
    await page
      .getByRole("group", { name: "Native skillwijziging bevestigen" })
      .screenshot({
        path: path.join(
          screenshots,
          `settings-native-confirm-${width === 390 ? "mobile" : `${scale}x`}.png`,
        ),
      });
    await page
      .getByRole("button", { name: "Annuleer skillmodus", exact: true })
      .click();
    await page
      .getByRole("group", { name: "Native skillwijziging bevestigen" })
      .waitFor({ state: "detached" });
    assert.equal(nativeWrites, 0);
    await page
      .getByRole("button", {
        name: "Automatisch NOVA voorbeeldskill",
        exact: true,
      })
      .click();
    await page
      .getByRole("group", { name: "Native skillwijziging bevestigen" })
      .waitFor();
    await page.clock.fastForward(60001);
    assert.equal(
      await page
        .getByRole("button", {
          name: "Bevestig skillmodus voor NOVA",
          exact: true,
        })
        .isDisabled(),
      true,
    );
    await page
      .getByRole("button", { name: "Annuleer skillmodus", exact: true })
      .click();
    await page
      .getByRole("group", { name: "Native skillwijziging bevestigen" })
      .waitFor({ state: "detached" });
    await page
      .getByRole("button", { name: "Aan NOVA voorbeeldskill", exact: true })
      .click();
    await page
      .getByRole("button", {
        name: "Bevestig skillmodus voor NOVA",
        exact: true,
      })
      .click();
    await page
      .getByText("Modus opgeslagen en gecontroleerd.", { exact: false })
      .waitFor();
    assert.equal(nativeWrites, 1);
    assert.equal(nativeMode, "on");
    await page
      .getByRole("button", {
        name: "Geschiedenis NOVA voorbeeldskill",
        exact: true,
      })
      .click();
    const skillHistory = page.getByRole("list", {
      name: "Skillgeschiedenis NOVA voorbeeldskill",
    });
    await skillHistory.getByText(/Uit → Aan/).waitFor();
    await skillHistory
      .getByRole("button", { name: "Zet terug", exact: true })
      .click();
    await page
      .getByRole("group", { name: "Native skillwijziging bevestigen" })
      .waitFor();
    assert.equal(nativeWrites, 1);
    await page
      .getByRole("button", {
        name: "Bevestig skillmodus voor NOVA",
        exact: true,
      })
      .click();
    await page
      .getByText("Modus opgeslagen en gecontroleerd.", { exact: false })
      .waitFor();
    assert.equal(nativeWrites, 2);
    assert.equal(nativeMode, "off");
    await page
      .getByRole("button", { name: "Verwijder NOVA-skill", exact: true })
      .click();
    const removalPrompt = page.getByRole("group", {
      name: "NOVA-skill verwijderen bevestigen",
    });
    await removalPrompt.waitFor();
    assert.match(
      await removalPrompt.innerText(),
      /kan niet vanuit NOVA ongedaan/,
    );
    assert.equal(
      await page
        .getByRole("button", { name: "Uit NOVA voorbeeldskill", exact: true })
        .isDisabled(),
      true,
      "Mode changes should stay locked while removal confirmation is open",
    );
    assert.equal(nativeRemovalWrites, 0);
    await removalPrompt
      .getByRole("button", { name: "Verwijder skill definitief", exact: true })
      .click();
    await page
      .getByText("Skill verwijderd en gecontroleerd.", { exact: false })
      .waitFor();
    assert.equal(nativeRemovalWrites, 1);
    assert.equal(
      await page.getByText("NOVA voorbeeldskill", { exact: true }).count(),
      0,
    );
    await page
      .getByRole("button", { name: "Gateway-prompt vervangen", exact: true })
      .click();
    assert.equal(
      await page
        .getByRole("textbox", {
          name: "Nieuw gateway-voorvoegsel",
          exact: true,
        })
        .inputValue(),
      "",
    );
    assert.equal(
      await page
        .getByRole("button", {
          name: "Promptvervanging voorbereiden",
          exact: true,
        })
        .isDisabled(),
      true,
    );
    await page.getByText("Eerdere veilige versies (1)").click();
    await page
      .getByRole("button", {
        name: "Laad vorige versie als concept",
        exact: true,
      })
      .click();
    assert.equal(
      await page
        .getByRole("textbox", {
          name: "Nieuw gateway-voorvoegsel",
          exact: true,
        })
        .inputValue(),
      "Older safe prompt",
    );
    assert.equal(
      await page
        .getByRole("button", {
          name: "Promptvervanging voorbereiden",
          exact: true,
        })
        .isDisabled(),
      true,
    );
    await page
      .getByRole("textbox", { name: "Nieuw gateway-voorvoegsel", exact: true })
      .fill("");
    await page
      .getByRole("textbox", {
        name: "Nieuw gateway-achtervoegsel",
        exact: true,
      })
      .fill("");
    await page
      .getByRole("textbox", { name: "Nieuw gateway-voorvoegsel", exact: true })
      .fill("Spreek helder.");
    await page
      .getByRole("checkbox", {
        name: "Extra gateway-prompt inschakelen",
        exact: true,
      })
      .check();
    await page
      .getByRole("checkbox", {
        name: "Ik vervang beide velden voor alle gateway-clients.",
        exact: true,
      })
      .check();
    await page
      .getByRole("button", {
        name: "Promptvervanging voorbereiden",
        exact: true,
      })
      .click();
    await page
      .getByRole("group", { name: "Gateway-prompt vervangen bevestigen" })
      .waitFor();
    assert.equal(promptWrites, 0);
    assert.equal(
      await page
        .getByRole("textbox", {
          name: "Nieuw gateway-voorvoegsel",
          exact: true,
        })
        .isDisabled(),
      true,
    );
    await page.locator(".prompt-editor").screenshot({
      path: path.join(
        screenshots,
        `settings-prompt-confirm-${width === 390 ? "mobile" : `${scale}x`}.png`,
      ),
    });
    await page
      .getByRole("button", { name: "Annuleer gateway-prompt", exact: true })
      .click();
    await page
      .getByRole("group", { name: "Gateway-prompt vervangen bevestigen" })
      .waitFor({ state: "detached" });
    assert.equal(promptWrites, 0);
    await page
      .getByRole("checkbox", {
        name: "Ik vervang beide velden voor alle gateway-clients.",
        exact: true,
      })
      .check();
    await page
      .getByRole("button", {
        name: "Promptvervanging voorbereiden",
        exact: true,
      })
      .click();
    await page
      .getByRole("group", { name: "Gateway-prompt vervangen bevestigen" })
      .waitFor();
    await page.clock.fastForward(60001);
    assert.equal(
      await page
        .getByRole("button", { name: "Bevestig gateway-prompt", exact: true })
        .isDisabled(),
      true,
    );
    await page
      .getByRole("button", { name: "Annuleer gateway-prompt", exact: true })
      .click();
    await page
      .getByRole("group", { name: "Gateway-prompt vervangen bevestigen" })
      .waitFor({ state: "detached" });
    await page
      .getByRole("checkbox", {
        name: "Ik vervang beide velden voor alle gateway-clients.",
        exact: true,
      })
      .check();
    await page
      .getByRole("button", {
        name: "Promptvervanging voorbereiden",
        exact: true,
      })
      .click();
    await page
      .getByRole("button", { name: "Bevestig gateway-prompt", exact: true })
      .click();
    await page
      .getByText("Gateway-prompt opgeslagen en gecontroleerd.", { exact: true })
      .waitFor();
    assert.equal(promptWrites, 1);
    assert.deepEqual(gatewayPrompt, {
      enabled: true,
      prefixPrompt: "Spreek helder.",
      suffixPrompt: "",
    });
    assert.doesNotMatch(
      await page.locator("body").innerText(),
      /private-existing/,
    );
    await page
      .getByRole("button", { name: "Gateway-prompt vervangen", exact: true })
      .click();
    await page.getByText("Eerdere veilige versies (1)").click();
    await page
      .getByRole("button", {
        name: "Laad vorige versie als concept",
        exact: true,
      })
      .click();
    await page
      .getByRole("checkbox", {
        name: "Ik vervang beide velden voor alle gateway-clients.",
        exact: true,
      })
      .check();
    await page
      .getByRole("button", {
        name: "Promptvervanging voorbereiden",
        exact: true,
      })
      .click();
    await page
      .getByRole("button", { name: "Bevestig gateway-prompt", exact: true })
      .click();
    await page
      .getByText("Gateway-prompt opgeslagen en gecontroleerd.", { exact: true })
      .waitFor();
    assert.equal(promptWrites, 2);
    assert.deepEqual(gatewayPrompt, {
      enabled: false,
      prefixPrompt: "Older safe prompt",
      suffixPrompt: "Older ending",
    });

    await page
      .getByRole("button", { name: "Lees Gateway-documentatie", exact: true })
      .click();
    assert.match(
      await page
        .locator('section[aria-label="OmniRoute-skills en prompts"] pre')
        .innerText(),
      /<script>/,
    );
    assert.equal(
      await page.evaluate(() => globalThis.nativeDocumentRan),
      undefined,
    );
    assert.equal(nativeMemoryRecordsReads, 0);
    await page.getByText("Eigen geheugenrecords bekijken").click();
    await page.getByRole("button", { name: "Records laden" }).click();
    await page
      .getByRole("list", { name: "NOVA-geheugenrecords" })
      .getByText("NOVA onthoudt dat de plant water nodig heeft.")
      .waitFor();
    assert.equal(nativeMemoryRecordsReads, 1);
    await page
      .getByRole("button", { name: "Bewerk dit record", exact: true })
      .click();
    await page
      .getByRole("textbox", { name: "Geheugentekst" })
      .fill("NOVA onthoudt dat de plant water nodig heeft. (aangepast)");
    await page
      .getByRole("button", { name: "Wijziging controleren", exact: true })
      .click();
    await page
      .getByRole("group", { name: "Geheugenrecord wijzigen bevestigen" })
      .waitFor();
    assert.equal(nativeMemoryUpdateWrites, 0);
    await page
      .getByRole("button", { name: "Bevestig wijziging", exact: true })
      .click();
    await page
      .getByText("Geheugenrecord bijgewerkt.", { exact: true })
      .waitFor();
    assert.equal(nativeMemoryUpdateWrites, 1);
    await page
      .getByRole("button", { name: "Verwijder dit record", exact: true })
      .click();
    await page
      .getByRole("group", { name: "Geheugenrecord verwijderen bevestigen" })
      .waitFor();
    assert.equal(nativeMemoryDeleteWrites, 0);
    await page
      .getByRole("button", { name: "Verwijder record", exact: true })
      .click();
    await page
      .getByText("Geheugenrecord verwijderd.", { exact: true })
      .waitFor();
    assert.equal(nativeMemoryDeleteWrites, 1);
    await page
      .getByRole("checkbox", { name: "Selecteer record fixture-memory" })
      .check();
    await page
      .getByText("1 record(s) geselecteerd (maximaal 25).", { exact: true })
      .waitFor();
    await page
      .getByRole("button", { name: "Verwijder selectie" })
      .first()
      .click();
    await page
      .getByRole("group", { name: "Geheugenrecords verwijderen bevestigen" })
      .waitFor();
    assert.equal(nativeMemoryBulkDeleteWrites, 0);
    await page
      .getByRole("button", { name: "Annuleer bulkverwijdering", exact: true })
      .click();
    assert.equal(nativeMemoryBulkDeleteWrites, 0);
    await page
      .getByRole("checkbox", { name: "Selecteer record fixture-memory" })
      .check();
    await page
      .getByText("1 record(s) geselecteerd (maximaal 25).", { exact: true })
      .waitFor();
    await page
      .getByRole("button", { name: "Verwijder selectie" })
      .first()
      .click();
    await page
      .getByRole("group", { name: "Geheugenrecords verwijderen bevestigen" })
      .waitFor();
    await page
      .getByRole("button", { name: "Verwijder selectie" })
      .last()
      .click();
    await page
      .getByText("Geselecteerde geheugenrecords verwijderd.", { exact: true })
      .waitFor();
    assert.equal(nativeMemoryBulkDeleteWrites, 1);
    await page
      .getByRole("button", { name: "OmniRoute-overzicht laden", exact: true })
      .click();
    await page
      .locator('section[aria-label="OmniRoute-skills en prompts"] pre')
      .waitFor({ state: "detached" });
    await page
      .locator('section[aria-label="OmniRoute-skills en prompts"]')
      .screenshot({
        path: path.join(
          screenshots,
          `settings-native-${width === 390 ? "mobile" : `${scale}x`}.png`,
        ),
      });
    await page
      .getByText("Geverifieerde gratis route beschikbaar", { exact: true })
      .waitFor();
    assert.equal(await page.locator("#adminDialog").count(), 0);
    assert.equal(await page.locator(".admin-embedded").count(), 2);
    await page
      .getByText("5 aanvragen · 1 mislukt · gemiddeld 1.200 ms")
      .waitFor();
    await page.getByRole("button", { name: "Metingen vernieuwen" }).click();
    await page.getByRole("button", { name: "Metingen vernieuwen" }).waitFor();
    await page.screenshot({
      path: path.join(
        screenshots,
        `settings-models-${width === 390 ? "mobile" : `${scale}x`}.png`,
      ),
    });
    await page.locator("#settingsSearch").fill("bestaatniet");
    await page
      .getByText("Geen instelling gevonden. Probeer een ander woord.")
      .waitFor();
    await page.locator("#settingsSearch").fill("");
    let documentScrollTested = false;
    for (const section of sections) {
      await page
        .locator(`.settings-sidebar a[href="/settings?section=${section}"]`)
        .click();
      await page.waitForURL(`**/settings?section=${section}`);
      assert(await page.locator(".settings-content h1").isVisible());
      const scroll = await page.evaluate(() => ({
        overflowY: getComputedStyle(document.body).overflowY,
        maxScroll: document.documentElement.scrollHeight - window.innerHeight,
        widthFits:
          document.documentElement.scrollWidth <=
          document.documentElement.clientWidth,
      }));
      assert.notEqual(
        scroll.overflowY,
        "hidden",
        `Document scrolling is locked in ${section} at ${width}`,
      );
      assert(scroll.widthFits, `Horizontal overflow in ${section} at ${width}`);
      if (scroll.maxScroll > 0) {
        await page.evaluate(() =>
          window.scrollTo(0, document.documentElement.scrollHeight),
        );
        assert(
          (await page.evaluate(() => window.scrollY)) > 0,
          `Long settings content cannot scroll in ${section} at ${width}`,
        );
        documentScrollTested = true;
        await page.evaluate(() => window.scrollTo(0, 0));
      }
    }
    assert(
      documentScrollTested,
      `No long settings section could be scrolled at ${width}`,
    );
    await page.goto(`${base}/settings?section=code`);
    await page.locator("#workspaceProjectName").fill("Demo Project");
    await page.getByRole("button", { name: "Aanmaken", exact: true }).click();
    await page.getByText("Demo Project", { exact: true }).waitFor();
    await page.locator("#workspaceProjectName").fill("Second Project");
    await page.getByRole("button", { name: "Aanmaken", exact: true }).click();
    await page.getByText("Second Project", { exact: true }).waitFor();
    await page
      .getByRole("button", { name: "Projectgeschiedenis", exact: true })
      .click();
    const projectHistory = page.getByRole("list", {
      name: "Projectkeuzegeschiedenis",
    });
    await projectHistory
      .getByRole("button", { name: "Zet terug", exact: true })
      .click();
    const projectRollback = page.getByRole("group", {
      name: "Projectkeuze terugzetten bevestigen",
    });
    await projectRollback
      .getByText("Second Project → Demo Project", { exact: false })
      .waitFor();
    assert.equal(
      workspaceActiveId,
      "second-project",
      "project remains selected before approval",
    );
    await projectRollback
      .getByRole("button", { name: "Projectkeuze terugzetten", exact: true })
      .click();
    await page
      .getByText("Projectkeuze hersteld en gecontroleerd.", { exact: true })
      .waitFor();
    assert.equal(workspaceActiveId, "demo-project");
    assert.equal(workspaceProjectWrites, 3);
    await page
      .locator('.settings-sidebar a[href="/settings?section=connections"]')
      .click();
    const stack = page.getByRole("region", { name: "Containerstatus" });
    await stack.getByText("Qdrant — actief", { exact: false }).waitFor();
    await stack.getByRole("button", { name: "Qdrant herstarten" }).click();
    await stack.getByRole("button", { name: "Bevestig herstart" }).click();
    assert.equal(stackRestartPrepares, 1);
    assert.equal(stackRestartConfirms, 1);
    await page.getByText(/Qdrant herstart aangevraagd/).waitFor();
    stackRestartService = "nova";
    stackRestartResult = { ok: false, error: "Containerstatus is gewijzigd." };
    await stack.getByRole("button", { name: "NOVA herstarten" }).click();
    await stack.getByRole("button", { name: "Bevestig herstart" }).click();
    await page.getByText(/That did not work|Dat is niet gelukt/).waitFor();
    assert.equal(
      (await stack.innerText()).includes("Containerstatus is gewijzigd."),
      false,
      "unexpected broker details must not appear in settings",
    );
    assert.equal(
      (await stack.innerText()).includes(
        "NOVA herstart. De verbinding komt zo terug.",
      ),
      false,
      "a stale NOVA restart must be reported as failure, not success",
    );
    stackRestartService = "qdrant";
    stackRestartResult = { ok: true, service: "qdrant" };
    const mcp = page.getByRole("region", { name: "MCP-servers" });
    await mcp.getByRole("button", { name: "Status ophalen" }).click();
    const workers = mcp.getByRole("region", {
      name: "MCP-workers",
      exact: true,
    });
    await workers
      .getByRole("row", { name: /filesystem.*Actief.*1.*Verbonden/ })
      .waitFor();
    await workers.getByText("Meerdere workers", { exact: true }).waitFor();
    await workers
      .getByRole("row", {
        name: /workspace-git.*Op aanvraag.*0.*Op aanvraag/,
      })
      .waitFor();
    await workers.screenshot({
      path: path.join(
        screenshots,
        `settings-mcp-workers-${width === 390 ? "mobile" : `${scale}x`}.png`,
      ),
    });

    const catalogUrl = "**/api/settings/mcp/servers/catalog";
    await page.route(catalogUrl, (route) =>
      route.fulfill({
        status: 400,
        contentType: "application/json",
        body: JSON.stringify({ error: "Catalog not locally editable" }),
      }),
    );
    await mcp.getByRole("button", { name: "Status ophalen" }).click();
    await mcp
      .getByText(
        "De MCP-catalogus is niet lokaal beheerbaar. Verbindingsstatus blijft beschikbaar.",
        { exact: true },
      )
      .waitFor();
    assert.equal(
      await workers.isVisible(),
      true,
      "catalog failure must preserve worker connection status",
    );
    await workers
      .getByRole("row", { name: /filesystem.*Actief.*1.*Verbonden/ })
      .waitFor();
    await page.unroute(catalogUrl);
    await mcp.getByRole("button", { name: "Status ophalen" }).click();

    await mcp.getByText("echo", { exact: true }).waitFor();
    const imap = mcp
      .getByRole("list")
      .first()
      .getByRole("listitem")
      .filter({ hasText: "imap" });
    await imap.getByRole("button", { name: "Koppeling instellen" }).click();
    await imap.getByLabel("IMAP-hostnaam").fill("mail.example.test");
    await imap
      .getByLabel("E-mailadres / gebruikersnaam")
      .fill("nova@example.test");
    await imap.getByLabel("Wachtwoord").fill("fixture-secret-not-real");
    await imap.getByRole("button", { name: "Opslaan" }).click();
    await imap.getByText("ingesteld", { exact: true }).first().waitFor();
    assert.equal(mcpSecretWrites, 1);
    assert.deepEqual(mcpSecretValues, {
      IMAP_HOST: "mail.example.test",
      IMAP_USER: "nova@example.test",
      IMAP_PASSWORD: "fixture-secret-not-real",
    });
    assert.equal(await imap.getByLabel("Wachtwoord").inputValue(), "");
    assert.doesNotMatch(await imap.innerText(), /fixture-secret-not-real/);
    const github = mcp
      .getByRole("list")
      .first()
      .getByRole("listitem")
      .filter({ hasText: /^github/ });
    await github.getByRole("button", { name: "Koppeling instellen" }).click();
    await github
      .getByLabel("GitHub-gebruiker of organisatie")
      .fill("example-owner");
    await github.getByLabel("Repository").fill("nova");
    await github
      .getByLabel("Fijnmazige read-only token")
      .fill("github_pat_fixture_not_real");
    await github.getByRole("button", { name: "Opslaan" }).click();
    await github.getByText("ingesteld", { exact: true }).first().waitFor();
    assert.match(await github.innerText(), /example-owner/);
    assert.match(await github.innerText(), /nova/);
    assert.equal(mcpSecretWrites, 2);
    assert.deepEqual(mcpSecretValues, {
      GITHUB_REPOSITORY_OWNER: "example-owner",
      GITHUB_REPOSITORY_NAME: "nova",
      GITHUB_PERSONAL_ACCESS_TOKEN: "github_pat_fixture_not_real",
    });
    assert.equal(
      await github.getByLabel("Fijnmazige read-only token").inputValue(),
      "",
    );
    assert.doesNotMatch(
      await github.innerText(),
      /github_pat_fixture_not_real/,
    );
    const echo = mcp
      .getByRole("list")
      .first()
      .getByRole("listitem")
      .filter({ hasText: /^echo/ });
    await mcp
      .getByText(
        "Standaardrisico voor gereedschappen zonder eigen instelling: CONFIRM.",
      )
      .waitFor();
    assert.equal(await mcp.getByLabel("Risico echo").inputValue(), "READ_ONLY");
    assert.equal(
      await mcp.getByLabel("Risico write_note").inputValue(),
      "SAFE",
    );
    await mcp.getByLabel("Risico write_note").selectOption("DANGEROUS");
    await page
      .getByText("Risico voor write_note gewijzigd naar DANGEROUS.")
      .waitFor();
    assert.equal(mcpRiskPrepares, 1);
    assert.equal(mcpRiskConfirms, 1);
    await echo.getByRole("button", { name: "Wijzigingsgeschiedenis" }).click();
    const riskRevision = mcp
      .getByRole("list", { name: "MCP-wijzigingsgeschiedenis echo" })
      .getByRole("listitem")
      .filter({ hasText: "write_note · SAFE → DANGEROUS" });
    await riskRevision.waitFor();
    await riskRevision.getByRole("button", { name: "Herstellen" }).click();
    await page.getByText(/Eerder risico voor write_note teruggezet/).waitFor();
    assert.equal(mcpRiskConfirms, 2);
    assert.equal(mcpToolRisk, "SAFE");
    await echo.getByRole("button", { name: "Activiteit" }).click();
    await mcp
      .getByText("gereedschap geslaagd: echo", { exact: false })
      .waitFor();
    await mcp.getByText(/Alleen de nieuwste 50 activiteiten/).waitFor();
    assert.equal(mcpActivityReads, 1);
    await echo.getByRole("button", { name: "Uitschakelen" }).click();
    await page.getByText(/MCP-server echo uitgeschakeld/).waitFor();
    assert.equal(mcpTogglePrepares, 1);
    assert.equal(mcpToggleConfirms, 1);
    await echo.getByRole("button", { name: "Wijzigingsgeschiedenis" }).click();
    await mcp.getByText(/aan → uit/).waitFor();
    const disabledRevision = mcp
      .getByRole("list", { name: "MCP-wijzigingsgeschiedenis echo" })
      .getByRole("listitem")
      .filter({ hasText: "aan → uit" });
    await disabledRevision.getByRole("button", { name: "Herstellen" }).click();
    await page.getByText(/Eerdere MCP-stand van echo hersteld/).waitFor();
    assert.equal(mcpHistoryReads, 4);
    assert.equal(mcpToggleConfirms, 2);
    assert.equal(mcpEnabled, true);
    const reviewedCatalog = mcp.getByRole("region", {
      name: "Beoordeelde MCP-catalogus",
    });
    await reviewedCatalog.getByRole("button", { name: "Toevoegen" }).click();
    await page
      .getByText("MCP-server context7 toegevoegd en uitgeschakeld.")
      .waitFor();
    assert.equal(mcpCatalogConfirms, 1);
    let context7 = mcp
      .getByRole("list")
      .first()
      .getByRole("listitem")
      .filter({ hasText: "context7" });
    await context7
      .getByRole("button", { name: "Wijzigingsgeschiedenis" })
      .click();
    const catalogRevision = mcp
      .getByRole("list", { name: "MCP-wijzigingsgeschiedenis context7" })
      .getByRole("listitem")
      .filter({ hasText: "door NOVA toegevoegd" });
    await catalogRevision.getByRole("button", { name: "Herstellen" }).click();
    await page.getByText(/NOVA-toevoeging context7 teruggedraaid/).waitFor();
    assert.equal(mcpCatalogConfirms, 2);
    assert.equal(mcpCatalogInstalled, false);
    assert.equal(mcpCatalogHistory.revisions[0].change.operation, "remove");
    await reviewedCatalog.getByRole("button", { name: "Toevoegen" }).click();
    await page
      .getByText("MCP-server context7 toegevoegd en uitgeschakeld.")
      .waitFor();
    assert.equal(mcpCatalogConfirms, 3);
    context7 = mcp
      .getByRole("list")
      .first()
      .getByRole("listitem")
      .filter({ hasText: "context7" });
    await context7
      .getByRole("button", { name: "Wijzigingsgeschiedenis" })
      .click();
    const refreshedCatalogHistory = mcp.getByRole("list", {
      name: "MCP-wijzigingsgeschiedenis context7",
    });
    await refreshedCatalogHistory
      .getByText("uit catalogus verwijderd", { exact: false })
      .waitFor();
    const removalRevision = refreshedCatalogHistory
      .getByRole("listitem")
      .filter({ hasText: "uit catalogus verwijderd" });
    assert.equal(
      await removalRevision.getByRole("button", { name: "Herstellen" }).count(),
      0,
      "catalog removal is not offered as a rollback",
    );
    await context7
      .getByRole("button", { name: "Uit catalogus verwijderen" })
      .click();
    await page
      .getByText("MCP-server context7 verwijderd en verbinding gesloten.")
      .waitFor();
    assert.equal(mcpCatalogConfirms, 4);
    assert.equal(mcpCatalogInstalled, false);
    assert.doesNotMatch(
      await mcp.innerText(),
      /private-input|secret-arg|command/,
    );
    await page
      .locator('.settings-sidebar a[href="/settings?section=voice"]')
      .click();
    await page
      .getByText(/Ik ben er\. Wat wil je als eerste aanpakken\?/)
      .waitFor();
    await page.locator("#wakeSensitivity").selectOption("high");
    assert.equal(
      await page.evaluate(() => localStorage.getItem("novaWakeSensitivity")),
      "high",
      "wake sensitivity selection should persist in this browser",
    );
    await page.locator("#wakeSensitivity").selectOption("normal");
    await page.goto(`${base}/settings?section=setup`);
    await page
      .getByRole("heading", { name: /Stap 1: Verbind OmniRoute/ })
      .waitFor();
    assert.equal(
      await page.getByRole("link", { name: "Open Modellen" }).count(),
      2,
      "Setup should route gateway and policy steps to existing settings",
    );
    const firstSetupCheck = page
      .getByLabel("Ik heb deze stap gecontroleerd")
      .first();
    await firstSetupCheck.check();
    await page.reload();
    await page
      .getByText("1 van 4 verplichte stappen door jou afgevinkt.")
      .waitFor();
    await page.getByRole("button", { name: "Eindcontrole uitvoeren" }).click();
    await page
      .getByText("De gecontroleerde gratis route is beschikbaar.")
      .waitFor();
    await page.getByText(/Home Assistant: geslaagd/).waitFor();
    await page.getByRole("button", { name: "Voortgang wissen" }).click();
    await page
      .getByText("0 van 4 verplichte stappen door jou afgevinkt.")
      .waitFor();
    assert.equal(updateChecks, 0, "Opening settings must not contact GitHub");
    assert.equal(
      usageReads,
      0,
      "Opening abilities must not fetch tool audit history",
    );
    await page
      .locator('.settings-sidebar a[href="/settings?section=skills"]')
      .click();
    const skillRow = page.locator(".set-row").filter({ hasText: "Ochtend" });
    assert.equal(skillVersionReads, 0, "Skill versions load only on request");
    await skillRow
      .getByRole("button", { name: "Versies", exact: true })
      .click();
    await skillRow.getByText("Huidige versie 2", { exact: true }).waitFor();
    assert.equal(skillVersionReads, 1);
    assert.equal(skillContentReads, 1);
    assert.doesNotMatch(await skillRow.innerText(), /Bekijk het weer\./);
    await skillRow.locator("details summary").nth(1).click();
    await skillRow
      .getByRole("button", { name: "Verwijder aangemaakte vaardigheid" })
      .waitFor();
    await skillRow.locator("details summary").nth(1).click();
    await skillRow.locator("details summary").first().click();
    await skillRow.getByRole("button", { name: "Herstel deze versie" }).click();
    await page.getByText("Wijzigingen aan “Ochtend” hersteld.").waitFor();
    assert.equal(skillContentRollbacks, 1);
    await skillRow.screenshot({
      path: path.join(
        screenshots,
        `settings-skill-versions-${width === 390 ? "mobile" : `${scale}x`}.png`,
      ),
    });
    await page
      .locator('.settings-sidebar a[href="/settings?section=abilities"]')
      .click();
    const usage = page.getByRole("region", {
      name: "Gebruik van gereedschappen",
      exact: true,
    });
    await usage
      .getByRole("heading", { name: "Gebruik van gereedschappen", exact: true })
      .waitFor();
    assert.equal(usageReads, 0);
    await page
      .getByRole("heading", {
        name: "Altijd goedgekeurde handelingen",
        exact: true,
      })
      .waitFor();
    await page
      .getByText("Geen blijvende toestemmingen.", { exact: true })
      .waitFor();
    assert.match(
      await page.locator(".settings-content").innerText(),
      /Risicovolle handelingen blijven bevestiging vragen/,
    );
    await usage
      .getByRole("button", { name: "Gebruiksstatistieken laden", exact: true })
      .click();
    await usage.getByRole("heading", { name: "echo", exact: true }).waitFor();
    assert.equal(usageReads, 1);
    assert.equal(await usage.locator("ul > li > h3").count(), 2);
    assert.equal(
      await usage
        .getByRole("heading", { name: "never_called", exact: true })
        .count(),
      0,
    );
    const echoUsage = usage.locator("li").filter({
      has: page.getByRole("heading", { name: "echo", exact: true }),
    });
    assert.match(
      await usage.innerText(),
      /maximaal 500 recente auditregels, binnen de laatste 2 MB/,
    );
    assert.match(await usage.innerText(), /20 auditregels bekeken/);
    assert.match(
      await usage.innerText(),
      /Het bewijst geen wijziging op een apparaat/,
    );
    assert.match(
      await echoUsage.innerText(),
      /builtin · direct uitvoeren · aan/,
    );
    assert.match(
      await echoUsage.innerText(),
      /3 afgeronde pogingen · 2 OK-resultaten · 1 foutresultaten/,
    );
    assert.match(
      await echoUsage.innerText(),
      /Aanroepcontext: gesprek 2, instellingen 1, achtergrond 0, onbekend 0/,
    );
    assert.match(await echoUsage.innerText(), /Gemiddelde duur: 100 ms/);
    const settingsUsage = usage.locator("li").filter({
      has: page.getByRole("heading", {
        name: "settings_persona_set",
        exact: true,
      }),
    });
    assert.match(
      await settingsUsage.innerText(),
      /<script>globalThis.toolUsageSourceRan = true<\/script> · vraagt bevestiging · uit/,
    );
    assert.equal(
      await page.evaluate(() => globalThis.toolUsageSourceRan),
      undefined,
    );
    assert.doesNotMatch(
      await usage.innerText(),
      /private-usage-argument|private-usage-session/,
    );
    const usageSearch = usage.getByRole("searchbox", {
      name: "Zoek in gebruik",
      exact: true,
    });
    await usageSearch.fill("builtin");
    assert.equal(await usage.locator("ul > li > h3").count(), 1);
    await usage.getByRole("heading", { name: "echo", exact: true }).waitFor();
    await usageSearch.fill("settings_persona_set");
    assert.equal(await usage.locator("ul > li > h3").count(), 1);
    await usage
      .getByRole("heading", { name: "settings_persona_set", exact: true })
      .waitFor();
    await usageSearch.fill("");
    const unusedUsage = usage.getByRole("checkbox", {
      name: "Toon ook zonder geregistreerd gebruik",
      exact: true,
    });
    await unusedUsage.check();
    await usage
      .getByRole("heading", { name: "never_called", exact: true })
      .waitFor();
    assert.equal(await usage.locator("ul > li > h3").count(), 3);
    await usageSearch.fill("extension");
    assert.equal(await usage.locator("ul > li > h3").count(), 1);
    assert.match(
      await usage.innerText(),
      /Laatste: geen geregistreerde aanroep. Gemiddelde duur: onbekend/,
    );
    await usageSearch.fill("");
    await unusedUsage.uncheck();
    assert.equal(await usage.locator("ul > li > h3").count(), 2);
    const usageLoadBounds = await usage
      .getByRole("button", { name: "Gebruiksstatistieken laden", exact: true })
      .boundingBox();
    const usageSearchBounds = await usageSearch.boundingBox();
    assert(usageLoadBounds?.height >= 44);
    assert(usageSearchBounds?.height >= 44);
    assert(
      await page.evaluate(
        () =>
          document.documentElement.scrollWidth <=
          document.documentElement.clientWidth,
      ),
      `Tool usage overflow at ${width}`,
    );
    await usage.screenshot({
      path: path.join(
        screenshots,
        `settings-tool-usage-${width === 390 ? "mobile" : `${scale}x`}.png`,
      ),
    });
    await page
      .locator('.settings-sidebar a[href="/settings?section=system"]')
      .click();
    await page
      .getByRole("button", { name: "Controleer op nieuwe release" })
      .click();
    await page
      .getByText("Een nieuwe versie is beschikbaar.", { exact: false })
      .waitFor();
    assert.equal(updateChecks, 1);
    await page.getByText("Wat is veranderd?", { exact: true }).click();
    assert(
      (await page.locator(".updates pre").innerText()).includes("<script>"),
    );
    assert.equal(
      await page.evaluate(() => Object.hasOwn(globalThis, "fixtureInjected")),
      false,
    );
    await page.screenshot({
      path: path.join(
        screenshots,
        `settings-system-${width === 390 ? "mobile" : `${scale}x`}.png`,
      ),
    });
    const backupFile = page.getByLabel("Back-upbestand", { exact: true });
    await page.getByText(/Node-RED-flowlogica/).waitFor();
    const helperWritesBeforeImport = helperAgentWrites;
    const backupMode = page.getByRole("combobox", {
      name: "Hoe importeren",
      exact: true,
    });
    const acknowledgeImport = page.getByRole("checkbox", {
      name: "Ik wil deze instellingen en vaardigheden importeren en controleer eerst de wijzigingen.",
      exact: true,
    });
    const checkBackup = page.getByRole("button", {
      name: "Back-up controleren",
      exact: true,
    });
    await page.evaluate(() => {
      globalThis.backupFileReads = 0;
      const original = globalThis.File.prototype.text;
      globalThis.restoreBackupFileText = () => {
        globalThis.File.prototype.text = original;
      };
      globalThis.File.prototype.text = function () {
        globalThis.backupFileReads++;
        return original.call(this);
      };
    });
    await backupFile.setInputFiles({
      name: "oversize.json",
      mimeType: "application/json",
      buffer: Buffer.alloc(1_000_001),
    });
    assert.equal(await checkBackup.isDisabled(), true);
    await acknowledgeImport.check();
    await checkBackup.click();
    await page
      .locator("#settingsMessage")
      .filter({ hasText: "De back-up is te groot (maximaal 1 MB)." })
      .waitFor();
    assert.equal(
      await page.evaluate(() => globalThis.backupFileReads),
      0,
      "Oversized backups must be rejected before file reads",
    );
    assert.equal(importPrepares, 0);
    await backupFile.setInputFiles({
      name: "invalid.json",
      mimeType: "application/json",
      buffer: Buffer.from("not-json"),
    });
    assert.equal(
      await acknowledgeImport.isChecked(),
      false,
      "Changing the file must reset acknowledgement",
    );
    await acknowledgeImport.check();
    await checkBackup.click();
    await page
      .locator("#settingsMessage")
      .filter({ hasText: "Dit bestand is geen geldige JSON." })
      .waitFor();
    assert.equal(
      importPrepares,
      0,
      "Invalid JSON must not reach the import API",
    );
    assert.equal(importWrites, 0);
    await backupFile.setInputFiles({
      name: "backup.json",
      mimeType: "application/json",
      buffer: Buffer.from(JSON.stringify(backup)),
    });
    await acknowledgeImport.check();
    await backupMode.selectOption("replace");
    assert.equal(
      await acknowledgeImport.isChecked(),
      false,
      "Changing import mode must reset acknowledgement",
    );
    const importReview = page.getByRole("group", {
      name: "Back-upimport controleren",
      exact: true,
    });
    const prepareImport = async () => {
      assert.equal(await checkBackup.isDisabled(), true);
      await acknowledgeImport.check();
      await checkBackup.click();
      await importReview.waitFor();
      assert.equal(
        importWrites,
        0,
        "Preview must not persist imported settings",
      );
      assert.equal(
        helperAgentWrites,
        helperWritesBeforeImport,
        "Import previews must not apply helper settings on the PC",
      );
      assert.equal(await backupFile.isDisabled(), true);
      assert.equal(await backupMode.isDisabled(), true);
    };
    await prepareImport();
    assert.match(
      await importReview.innerText(),
      /Vervangen: 1 inkomende vaardigheden, 0 inkomende panelen/,
    );
    assert.match(
      await importReview.innerText(),
      /Na import: 1 vaardigheden en 0 panelen/,
    );
    assert.match(
      await importReview.innerText(),
      /1 vaardigheden worden vervangen; 0 vaardigheden en 1 panelen en 0 lijsten worden verwijderd/,
    );
    assert.match(await importReview.innerText(), /Eigen regels: wijzigen/);
    assert.match(
      await importReview.innerText(),
      /Snelle opdrachten: blijven gelijk/,
    );
    assert.match(
      await importReview.innerText(),
      /Gereedschapsinstellingen: blijven gelijk/,
    );
    assert.match(await importReview.innerText(), /Zijbalkindeling: wijzigt/);
    assert.match(
      await importReview.innerText(),
      /Gewenste schermmodus: wijzigt/,
    );
    assert.match(
      await importReview.innerText(),
      /Helperinstellingen: wijzigen/,
    );
    assert.match(
      await importReview.innerText(),
      /Servicekoppelingen: 1 wijzigen/,
    );
    assert.match(await importReview.innerText(), /home-assistant/);
    assert.match(
      await importReview.innerText(),
      /Bestaande geheimen blijven op deze server staan/,
    );
    assert.match(
      await importReview.innerText(),
      /De schermmodus wordt alleen bewaard. Pas die op de pc toe via Apparaten/,
    );
    assert.match(
      await importReview.innerText(),
      /Geïmporteerde webhooks kunnen actief worden/,
    );
    await importReview
      .getByText(`${missingHeaders[0].skill}: Authorization`, { exact: true })
      .waitFor();
    await importReview
      .getByText(`${missingHeaders[1].skill}: X-API-Key`, { exact: true })
      .waitFor();
    assert.equal(
      await importReview
        .locator("li")
        .filter({ hasText: missingHeaders[0].skill })
        .count(),
      2,
      "Duplicate escaped skill names must both render their missing headers",
    );
    assert.equal(
      await page.evaluate(() => globalThis.backupLabelRan),
      undefined,
    );
    await importReview.screenshot({
      path: path.join(
        screenshots,
        `settings-backup-confirm-${width === 390 ? "mobile" : `${scale}x`}.png`,
      ),
    });
    const cancelImport = importReview.getByRole("button", {
      name: "Annuleer back-upimport",
      exact: true,
    });
    await cancelImport.click();
    await importReview.waitFor({ state: "detached" });
    await page
      .locator("#settingsMessage")
      .filter({ hasText: "Import geannuleerd." })
      .waitFor();
    assert.equal(importWrites, 0);
    await prepareImport();
    await page.clock.fastForward(60001);
    const confirmImport = importReview.getByRole("button", {
      name: "Bevestig back-upimport",
      exact: true,
    });
    assert.equal(await confirmImport.isDisabled(), true);
    await importReview
      .getByRole("status")
      .filter({ hasText: "Toestemming verlopen." })
      .waitFor();
    assert.equal(importWrites, 0);
    await cancelImport.click();
    await importReview.waitFor({ state: "detached" });
    await prepareImport();
    await confirmImport.click();
    await importReview.waitFor({ state: "detached" });
    await page
      .locator("#settingsMessage")
      .filter({
        hasText:
          "1 vaardigheden, 1 lijsten en 0 Node-RED-flows geïmporteerd; 1 servicekoppeling gewijzigd.",
      })
      .waitFor();
    assert.equal(importWrites, 1);
    assert.equal(importPrepares, 3);
    assert.equal(
      helperAgentWrites,
      helperWritesBeforeImport,
      "Confirming an import must store the desired helper mode without applying it on the PC",
    );
    assert.equal(
      await page.evaluate(() => globalThis.backupLabelRan),
      undefined,
    );
    await page.evaluate(() => globalThis.restoreBackupFileText());
    await page.goto(`${base}/settings?section=devices`);
    await page.getByText("2026-10-10.fixture", { exact: true }).waitFor();
    const helperDebugPanel = page.locator("details").filter({
      has: page.locator("summary", { hasText: "Helpervenster meten" }),
    });
    assert.equal(
      helperDebugReads,
      0,
      "helper measurements load only on request",
    );
    await helperDebugPanel.locator("summary").click();
    await helperDebugPanel
      .getByRole("button", { name: "Meet helpervenster", exact: true })
      .click();
    await helperDebugPanel
      .getByLabel("Helpervenstermeting")
      .getByText(/monitor=-1920,0,0,1080/)
      .waitFor();
    assert.equal(helperDebugReads, 1);
    await page
      .getByText("Sneltoetsen op de Windows-pc", { exact: true })
      .click();
    await page
      .getByLabel("Sneltoets Openen", { exact: true })
      .fill("Ctrl+Alt+J");
    await page
      .getByRole("button", { name: "Sneltoetsen opslaan", exact: true })
      .click();
    await page
      .getByText("Sneltoetsen opgeslagen op de Windows-pc.", { exact: true })
      .waitFor();
    assert.equal(hotkeys.open, "Ctrl+Alt+J");
    const hotkeyHistoryPanel = page.locator("details").filter({
      has: page.locator("summary", {
        hasText: "Wijzigingsgeschiedenis sneltoetsen",
      }),
    });
    await hotkeyHistoryPanel.locator("summary").click();
    assert.equal(hotkeyHistoryReads, 0);
    await hotkeyHistoryPanel
      .getByRole("button", { name: "Laad sneltoetshistorie", exact: true })
      .click();
    await hotkeyHistoryPanel.getByText(/Van: Ctrl\+Alt\+N/).waitFor();
    assert.equal(hotkeyHistoryReads, 1);
    await hotkeyHistoryPanel
      .getByRole("button", { name: "Herstel deze sneltoetsen", exact: true })
      .click();
    await hotkeyHistoryPanel
      .getByRole("group", { name: "Sneltoetsen herstellen bevestigen" })
      .getByRole("button", { name: "Herstel en controleer op pc", exact: true })
      .click();
    await page
      .getByText(
        "Sneltoetsen zijn op de Windows-pc hersteld en gecontroleerd.",
        { exact: true },
      )
      .waitFor();
    assert.equal(hotkeys.open, "Ctrl+Alt+N");
    await page.screenshot({
      path: path.join(
        screenshots,
        `settings-devices-${width === 390 ? "mobile" : `${scale}x`}.png`,
      ),
    });
    assert.equal(helperModeHistoryReads, 0);
    const helperHistoryPanel = page.getByRole("region", {
      name: "Helpergeschiedenis",
    });
    await helperHistoryPanel
      .getByRole("button", { name: "Geschiedenis laden" })
      .click();
    await helperHistoryPanel.getByText(/helper, scherm 1/).waitFor();
    assert.equal(helperModeHistoryReads, 1);
    await helperHistoryPanel
      .getByRole("button", { name: "Terugzetten" })
      .click();
    await page
      .getByText(/Helperkeuze opgeslagen, maar niet op de pc toegepast/)
      .waitFor();
    const wallpaperHistoryPanel = page.getByRole("region", {
      name: "Achtergrondgeschiedenis",
    });
    assert.equal(wallpaperHistoryReads, 0);
    await wallpaperHistoryPanel
      .getByRole("button", { name: "Geschiedenis laden" })
      .click();
    await wallpaperHistoryPanel.locator("ol li").waitFor();
    assert.equal(wallpaperHistoryReads, 1);
    await wallpaperHistoryPanel
      .getByRole("button", { name: "Terugzetten" })
      .click();
    await wallpaperHistoryPanel.locator("ol li").waitFor();
    assert.equal(wallpaperHistoryWrites, 1);
    await page.goto(`${base}/settings?section=connections`);
    await page.getByRole("button", { name: "Doelen laden" }).click();
    await page.getByText(/guest-one/).waitFor();
    await page.getByText(/tunnel/).waitFor();
    await page.getByText(/Resource · app/).waitFor();
    await page
      .getByRole("radio", { name: "Alleen geselecteerde doelen" })
      .check();
    await page.getByRole("checkbox", { name: "pve-node", exact: true }).check();
    await page.getByRole("button", { name: "Doeltoegang opslaan" }).click();
    await page.getByText("Doeltoegang opgeslagen.").waitFor();
    assert.equal(managedTargetAccessWrites, 1);
    const targetRollback = page
      .locator(".mqtt-overview")
      .getByRole("button", { name: "Herstellen" });
    await targetRollback.waitFor();
    await targetRollback.click();
    await page
      .getByText(
        /Doeltoegang teruggezet\. Geschiedenis kon niet worden opgeslagen\./,
      )
      .waitFor();
    assert.equal(managedTargetAccessRollbacks, 1);
    const nodeRedCard = page.locator(".connection-editor").filter({
      has: page.locator("summary", { hasText: "Node-RED" }),
    });
    await nodeRedCard.locator("summary").click();
    assert.equal(nodeRedFlowReads, 0, "Node-RED flows load only on request");
    await nodeRedCard.getByRole("button", { name: "Flows laden" }).click();
    await nodeRedCard.getByText("Home automation", { exact: true }).waitFor();
    await nodeRedCard.getByText(/4 nodes/).waitFor();
    await nodeRedCard.getByText(/laatste fout: Fixture flow failed/).waitFor();
    await nodeRedCard
      .getByRole("link", { name: "Open Node-RED-editor" })
      .waitFor();
    await nodeRedCard.getByText("deploy/nodered/flows.json").waitFor();
    assert.equal(nodeRedFlowReads, 1);
    const automationPanel = nodeRedCard.locator("#node-red-flows");
    await automationPanel.scrollIntoViewIfNeeded();
    const automationBounds = await automationPanel.boundingBox();
    assert.ok(automationBounds, "Node-RED flow list is visible for capture");
    await page.screenshot({
      path: path.join(screenshots, "automation-node-red.png"),
      clip: {
        x: Math.max(0, automationBounds.x),
        y: Math.max(0, automationBounds.y),
        width: Math.min(automationBounds.width, 1100),
        height: Math.min(automationBounds.height, 500),
      },
    });
    await nodeRedCard.getByRole("button", { name: "Nu starten" }).click();
    await nodeRedCard.getByRole("button", { name: "Bevestigen" }).waitFor();
    assert.equal(nodeRedFlowRuns, 1);
    await nodeRedCard.getByRole("button", { name: "Bevestigen" }).click();
    await nodeRedCard.getByText("Flow is uitgevoerd.").waitFor();
    assert.equal(nodeRedFlowConfirms, 1);
    assert.equal(nodeRedFlowReads, 2);
    await nodeRedCard.getByRole("button", { name: "Uitschakelen" }).click();
    await nodeRedCard.getByRole("button", { name: "Bevestigen" }).waitFor();
    await nodeRedCard.getByRole("button", { name: "Bevestigen" }).click();
    await nodeRedCard.getByText("Flow is uitgevoerd.").waitFor();
    assert.equal(nodeRedFlowReads, 3);
    await nodeRedCard
      .getByRole("button", { name: "Foutmelding toevoegen" })
      .click();
    await nodeRedCard.getByRole("button", { name: "Bevestigen" }).waitFor();
    assert.equal(nodeRedFlowTemplates, 1);
    await nodeRedCard.getByRole("button", { name: "Bevestigen" }).click();
    await nodeRedCard
      .getByText("Foutmelding toegevoegd aan Home automation.")
      .waitFor();
    assert.equal(nodeRedFlowReads, 4);
    await nodeRedCard.getByLabel("Tijd voor ochtendbriefing").fill("07:45");
    await nodeRedCard
      .getByRole("button", { name: "Ochtendbriefing toevoegen" })
      .click();
    await nodeRedCard.getByRole("button", { name: "Bevestigen" }).waitFor();
    await nodeRedCard.getByText(/07:45/).waitFor();
    assert.equal(nodeRedFlowTemplates, 2);
    await nodeRedCard.getByRole("button", { name: "Bevestigen" }).click();
    await nodeRedCard
      .getByText("Ochtendbriefing toegevoegd aan Home automation.")
      .waitFor();
    assert.equal(nodeRedFlowReads, 5);
    await page.goto(
      `${base}/settings?section=connections&nodeRedFlow=tab-home`,
    );
    await page.locator("#node-red-failed-flow").waitFor();
    assert.equal(
      nodeRedFlowReads,
      6,
      "a flow error link loads and highlights its flow",
    );
    await page.goto(`${base}/settings?section=connections`);
    await page.getByRole("button", { name: "Doelen laden" }).waitFor();
    const mqtt = page
      .locator(".connection-editor")
      .filter({ has: page.locator("summary", { hasText: "MQTT" }) });
    if (!(await mqtt.evaluate((details) => details.open)))
      await mqtt.locator("summary").click();
    assert.equal(mqttReads, 0, "MQTT history loads only on request");
    await mqtt.getByRole("button", { name: "Berichten laden" }).click();
    assert.equal(mqttReads, 1);
    assert.equal(await mqtt.evaluate((details) => details.open), true);
    await mqtt
      .getByText("Timergebeurtenis · label verborgen")
      .first()
      .waitFor();
    await mqtt.scrollIntoViewIfNeeded();
    await page.screenshot({
      path: path.join(
        screenshots,
        `settings-mqtt-${width === 390 ? "mobile" : `${scale}x`}.png`,
      ),
    });
    const qdrant = page
      .locator(".connection-editor")
      .filter({ has: page.locator("summary", { hasText: "Qdrant" }) });
    await qdrant.locator("summary").click();
    assert.equal(qdrantReads, 0, "Qdrant inspection runs only on request");
    await qdrant
      .getByRole("button", { name: "Collecties controleren" })
      .click();
    await qdrant.getByText("nova_memory", { exact: true }).waitFor();
    await qdrant.getByText(/4,5 KiB op schijf/).waitFor();
    await qdrant.getByText(/1,2 KiB RAM-data/).waitFor();
    assert.equal(qdrantReads, 1);
    await qdrant
      .getByRole("button", { name: "Oude herinneringen archiveren" })
      .click();
    await qdrant.getByText(/Controle: 12 herinneringen/).waitFor();
    assert.equal(qdrantMaintenanceRuns, 1);
    await qdrant
      .getByRole("button", { name: "Geheugenindex herindexeren" })
      .click();
    await qdrant.getByText(/Index vernieuwd: 12 herinneringen/).waitFor();
    await qdrant.getByText(/Actieve geheugenindex: nova_mem_fixture/).waitFor();
    assert.equal(qdrantReindexRuns, 1);
    await qdrant
      .getByRole("button", { name: "Indexgeschiedenis bekijken" })
      .click();
    await qdrant
      .getByText(/12 herinneringen/)
      .last()
      .waitFor();
    await qdrant
      .getByRole("button", { name: "Deze index terugzetten" })
      .click();
    await qdrant.getByText(/Actieve geheugenindex: nova_memory/).waitFor();
    assert.equal(qdrantRollbackRuns, 1);
    await qdrant.scrollIntoViewIfNeeded();
    await page.screenshot({
      path: path.join(
        screenshots,
        `settings-qdrant-${width === 390 ? "mobile" : `${scale}x`}.png`,
      ),
    });
    const connection = page
      .locator(".connection-editor")
      .filter({ has: page.locator("summary", { hasText: "Home Assistant" }) });
    await connection.locator("summary").click();
    await connection.getByRole("button", { name: "Apparaten laden" }).click();
    await connection.getByText(/Plafondlamp/).waitFor();
    await connection
      .getByRole("radio", { name: /Alleen de geselecteerde gebieden/ })
      .check();
    await connection
      .getByRole("checkbox", { name: "Keuken", exact: true })
      .check();
    await connection.getByRole("button", { name: "Toegang opslaan" }).click();
    await connection
      .getByText("Toegang voor Home Assistant opgeslagen.")
      .waitFor();
    assert.equal(homeAccessWrites, 1);
    const haRollback = connection.getByRole("button", { name: "Herstellen" });
    await haRollback.waitFor();
    await haRollback.click();
    await connection
      .getByText("Home Assistant-toegang teruggezet en gecontroleerd.")
      .waitFor();
    assert.equal(homeAccessRollbackRuns, 1);
    await page
      .locator("#home-assistant-url")
      .fill("http://home-new.example:8123");
    await page.locator("#home-assistant-token").fill("secret-test-fixture");
    await connection.getByRole("button", { name: "Verbinding testen" }).click();
    await connection
      .getByText("De koppeling antwoordt. Er is geen wijziging uitgevoerd.")
      .waitFor();
    assert(tested);
    assert.equal(services[1].restartRequired, false);
    await connection
      .getByRole("button", { name: "Opslaan", exact: true })
      .click();
    await connection
      .getByText(
        "Herstart nodig. De draaiende service gebruikt nog de vorige verbinding.",
      )
      .waitFor();
    await page
      .getByRole("button", { name: "Herstart NOVA", exact: true })
      .click();
    await page
      .getByRole("button", { name: "Herstart aangevraagd", exact: true })
      .waitFor();
    assert.equal(restartRequests, 1);
    assert.equal(await page.locator("#home-assistant-token").inputValue(), "");
    assert.equal(
      (await page.locator("body").innerText()).includes("secret-test-fixture"),
      false,
    );
    await page.screenshot({
      path: path.join(
        screenshots,
        `settings-connections-${width === 390 ? "mobile" : `${scale}x`}.png`,
      ),
    });
    restartAvailable = false;
    await page.reload();
    await page
      .getByText("Gecontroleerd herstarten is uitgeschakeld.")
      .waitFor();
    await page.getByRole("button", { name: "Herstart NOVA" }).waitFor({
      state: "detached",
    });
    await page.goto(`${base}/settings?section=personality`);
    await page.locator("#behaviorText").fill("Wees warm en duidelijk.");
    await page.getByRole("button", { name: "Opslaan", exact: true }).click();
    await page.getByText("De eigen regels zijn opgeslagen.").waitFor();
    assert.equal(persona, "Wees warm en duidelijk.");
    await page.getByRole("button", { name: "Grappig" }).click();
    await page.getByText("Gespreksstijl opgeslagen.").waitFor();
    assert.equal(personaStyle, "playful");
    await page.getByLabel("Naam", { exact: true }).fill("Nova");
    await page.getByLabel("Aanspreekvorm").fill("je/jij");
    await page.getByRole("button", { name: "Profiel opslaan" }).click();
    await page.getByText("Gezinsprofiel opgeslagen.").waitFor();
    assert.equal(personaProfile.name, "Nova");
    const personaPreferences = page.getByRole("region", {
      name: "Profielgeschiedenis",
    });
    await personaPreferences
      .getByRole("button", { name: "Profielgeschiedenis laden" })
      .click();
    await personaPreferences.getByText("Voor en na bekijken").click();
    await personaPreferences.getByText('"name": "Nova"').first().waitFor();
    await personaPreferences
      .getByRole("button", { name: "Deze profielwijziging terugdraaien" })
      .click();
    await personaPreferences
      .getByText("NOVA's stijl en profiel hersteld.")
      .waitFor();
    assert.equal(personaPreferencesHistoryReads, 2);
    assert.equal(personaPreferencesHistoryWrites, 1);
    assert.equal(personaStyle, "friendly");
    assert.equal(personaProfile.name, "NOVA");
    const householdHistory = page.getByRole("region", {
      name: "Geschiedenis actieve gezinsprofielen",
    });
    await householdHistory
      .getByRole("button", { name: "Profielwissels laden" })
      .click();
    await householdHistory.getByText("Van Profiel A naar Profiel B").waitFor();
    const switchHistoryReload = page.waitForResponse(
      (response) =>
        response.url().endsWith("/settings/household-profiles/history") &&
        response.request().method() === "GET",
    );
    await householdHistory
      .getByRole("button", { name: "Deze profielwissel terugdraaien" })
      .click();
    await switchHistoryReload;
    await householdHistory
      .getByText("Actief gezinsprofiel hersteld.")
      .waitFor();
    assert.equal(householdProfileHistoryReads, 2);
    assert.equal(householdProfileHistoryWrites, 1);
    assert.equal(overview.activeHouseholdProfileId, "person-a");
    const contentHistory = page.getByRole("region", {
      name: "Geschiedenis gezinsprofielinhoud",
    });
    const contentHistoryLoad = page.waitForResponse(
      (response) =>
        response
          .url()
          .endsWith("/settings/household-profiles/definitions/history") &&
        response.request().method() === "GET",
    );
    await contentHistory
      .getByRole("button", { name: "Profielwijzigingen laden" })
      .click();
    await contentHistoryLoad;
    await contentHistory
      .getByRole("button", { name: "Deze profielwijziging terugdraaien" })
      .waitFor();
    assert.match(await contentHistory.innerText(), /gewijzigd:/);
    assert.equal(householdDefinitionHistoryReads, 1);
    const contentHistoryReload = page.waitForResponse(
      (response) =>
        response
          .url()
          .endsWith("/settings/household-profiles/definitions/history") &&
        response.request().method() === "GET",
    );
    await contentHistory
      .getByRole("button", { name: "Deze profielwijziging terugdraaien" })
      .click();
    await contentHistoryReload;
    await contentHistory.getByText("Gezinsprofielen hersteld.").waitFor();
    assert.equal(householdDefinitionHistoryReads, 2);
    assert.equal(householdDefinitionHistoryWrites, 1);
    const personaHistory = page.getByRole("region", {
      name: "Eigen-regelsgeschiedenis",
    });
    await personaHistory
      .getByRole("button", { name: "Geschiedenis laden" })
      .click();
    await personaHistory.getByText("Voor en na bekijken").click();
    await personaHistory.getByText("Wees helder.", { exact: true }).waitFor();
    assert.equal(personaHistoryReads, 1);
    await personaHistory
      .getByText("Wees helder.", { exact: true })
      .scrollIntoViewIfNeeded();
    await page.screenshot({
      path: path.join(
        screenshots,
        `settings-personality-${width === 390 ? "mobile" : `${scale}x`}.png`,
      ),
    });
    await page
      .locator('.settings-sidebar a[href="/settings?section=system"]')
      .click();
    const helperHistory = page.getByRole("region", {
      name: "Helper wijzigingsgeschiedenis",
    });
    assert.equal(
      helperPreferenceHistoryReads,
      0,
      "Helper history loads only on request",
    );
    await helperHistory
      .getByRole("button", { name: "Helpergeschiedenis laden" })
      .click();
    await helperHistory.getByText(/orb, hoog contrast uit/).waitFor();
    await helperHistory.screenshot({
      path: path.join(
        screenshots,
        `settings-helper-history-${width === 390 ? "mobile" : `${scale}x`}.png`,
      ),
    });
    await helperHistory
      .getByRole("button", { name: "Deze wijziging terugdraaien" })
      .click();
    await helperHistory
      .getByText("Helperinstellingen teruggedraaid.", { exact: true })
      .waitFor();
    assert.equal(helperPreferenceHistoryReads, 2);
    assert.equal(helperPreferenceHistoryWrites, 1);
    const toolHistory = page.getByRole("region", {
      name: "Gereedschap wijzigingsgeschiedenis",
    });
    assert.equal(
      toolSwitchHistoryReads,
      0,
      "Tool history loads only on request",
    );
    await toolHistory
      .getByRole("button", { name: "Gereedschapsgeschiedenis laden" })
      .click();
    await toolHistory.getByText(/weather_forecast: aan → uit/).waitFor();
    await toolHistory.screenshot({
      path: path.join(
        screenshots,
        `settings-tool-history-${width === 390 ? "mobile" : `${scale}x`}.png`,
      ),
    });
    await toolHistory
      .getByRole("button", { name: "Deze wijziging terugdraaien" })
      .click();
    await toolHistory
      .getByText("Gereedschapswijziging teruggedraaid.", { exact: true })
      .waitFor();
    assert.equal(toolSwitchHistoryReads, 2);
    assert.equal(toolSwitchHistoryWrites, 1);
    const sidebarHistory = page.getByRole("region", {
      name: "Zijbalk wijzigingsgeschiedenis",
    });
    assert.equal(
      sidebarHistoryReads,
      0,
      "Sidebar history loads only on request",
    );
    await sidebarHistory
      .getByRole("button", { name: "Indelingsgeschiedenis laden" })
      .click();
    await sidebarHistory
      .getByText("1 panelen · 1 zichtbaar → 1 panelen · 0 zichtbaar")
      .waitFor();
    await sidebarHistory.screenshot({
      path: path.join(
        screenshots,
        `settings-sidebar-history-${width === 390 ? "mobile" : `${scale}x`}.png`,
      ),
    });
    await sidebarHistory
      .getByRole("button", { name: "Deze wijziging terugdraaien" })
      .click();
    await sidebarHistory
      .getByText("Zijbalkindeling teruggedraaid.", { exact: true })
      .waitFor();
    assert.equal(sidebarHistoryReads, 2);
    assert.equal(sidebarHistoryWrites, 1);
    await page.goto(`${base}/settings?section=personality`);
    await page.locator("#behaviorText").waitFor();
    pinned = true;
    await page.reload();
    await page.locator("#pinInput").waitFor();
    await page.locator("#pinInput").fill("4321");
    await page.locator("#pinInput").press("Enter");
    await page.locator("#behaviorText").waitFor();
    assert.equal(
      await page.evaluate(() => localStorage.getItem("novaPin")),
      null,
    );
    await page.clock.fastForward(15 * 60 * 1000 + 1000);
    await page.locator("#pinInput").waitFor();
    await page.locator("#pinInput").fill("4321");
    await page
      .getByRole("button", { name: "Ontgrendelen", exact: true })
      .click();
    await page
      .getByRole("button", { name: "Instellingen vergrendelen" })
      .click();
    await page.locator("#pinInput").waitFor();
    assert.deepEqual(errors, []);
    await context.close();
  }
  console.log(
    "Settings browser checks passed: all sections, search/keyboard/deep links, mobile, save, memory-only PIN expiry/lock, model metrics and explicit release checks, Windows shortcuts, native gateway skills and on-demand native memory record editing, single deletion and selected bulk deletion with cancellation, note text rollback and unchanged-note creation undo, value-widget history rollback, persona style/profile history rollback, instruction skill update and creation history, prompt and client-wide memory controls, confirmed native modes and NOVA-skill removal, global prompt replacement, private account/catalog inventory, cached quota display and API-key rights without secret exposure, confirmed account activation and status-history rollback, account deletion/creation and key replacement with secret privacy and client-wide impact acknowledgement, API-key activation with NOVA-owner protection, impact acknowledgement, status-history rollback and warning display, scoped combo creation and update, globally scoped combo activation and history rollback, confirmed combo deletion, PIN-protected Qdrant archive maintenance, explicit free-policy options and acknowledged/cancelled/expired/confirmed policy changes with honest quota evidence, bounded backup parsing and reviewed/cancelled/expired/confirmed imports with provider-account exclusion and Node-RED credential omission, explicit helper/tool/sidebar settings history and rollback, confirmed container restart flow with DANGEROUS confirmation, MCP catalog add/remove with disabled-by-default and fresh confirmation, CalDAV/IMAP and GitHub secret entry with cleared secret fields and secret-free status, MCP server activity, per-tool risk change and history rollback, server disable and history rollback with privacy filtering, source/name filters and unused tools.",
  );
} finally {
  await browser.close();
}
