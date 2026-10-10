import { chromium } from "playwright-core";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
/* global document */
const base = process.env.NOVA_SETTINGS_TEST_URL ?? "https://localhost:5173";
const screenshots = path.resolve("docs/img");
fs.mkdirSync(screenshots, { recursive: true });
const sections = [
  "general",
  "voice",
  "personality",
  "models",
  "abilities",
  "skills",
  "automation",
  "connections",
  "devices",
  "memory",
  "safety",
  "system",
];
const overview = {
  persona: "Spreek kort en duidelijk.",
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
  ],
  sidebar: [{ id: "w:notitie", shown: true, column: "left", page: 1 }],
  builtinPanels: [],
  maxPages: { left: 3, right: 3 },
  abilities: [],
  tools: [],
  pinRequired: false,
  standingApprovals: [],
};
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
    let persona = overview.persona;
    let updateChecks = 0;
    let accountsReads = 0;
    let accountInventoryGate = null;
    let releaseAccountInventory;
    let accountWrites = 0;
    let accountRemoved = false;
    let policyReads = 0;
    let policyWrites = 0;
    let importPrepares = 0;
    let importWrites = 0;
    let usageReads = 0;
    let skillVersionReads = 0;
    let helperAgentWrites = 0;
    let helperPreferenceHistoryReads = 0;
    let helperPreferenceHistoryWrites = 0;
    let toolSwitchHistoryReads = 0;
    let toolSwitchHistoryWrites = 0;
    let restartRequests = 0;
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
    let promptWrites = 0;
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
      if (endpoint === "/settings/windows/status")
        data = {
          available: true,
          version: "2026-10-10.fixture",
          helperOpen: true,
          paused: false,
          mode: "helper",
          display: 0,
        };
      else if (endpoint === "/settings/tools/usage") {
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
      } else if (endpoint === "/settings/helper/hotkeys") {
        if (request.method() === "PUT")
          hotkeys = request.postDataJSON().hotkeys;
        data = {
          ok: true,
          preferences: { hotkeys, warnings: [], paused: false },
        };
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
                  name: "Voorbeeldaccount",
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
              name: "example-route",
              displayName: "Voorbeeldroute",
              active: true,
              strategy: "priority",
              models: ["fixture/example:free"],
              systemMessage: "private combo text",
            },
          ],
        };
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
              enabled: false,
              mode: "off",
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
        };
      else if (
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
          nativeMode = nativePreparedMode;
          data = {
            ok: true,
            verified: true,
            mode: nativeMode,
            enabled: nativeMode !== "off",
          };
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
        endpoint.startsWith("/settings/tools/history/") &&
        endpoint.endsWith("/rollback")
      ) {
        assert.equal(request.headers()["x-nova-admin"], "1");
        toolSwitchHistoryWrites++;
        data = { ok: true };
      } else if (endpoint === "/settings/services/restart") {
        if (request.method() === "POST") {
          assert.equal(request.headers()["x-nova-admin"], "1");
          restartRequests++;
          data = { ok: true, scheduled: true };
        } else {
          data = {
            available: true,
            pendingChanges: services.some((service) => service.restartRequired),
            restartPending: restartRequests > 0,
          };
        }
      } else if (endpoint === "/settings/services") data = { services };
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
          collections: [
            {
              name: "nova_memory",
              points: 12,
              indexedVectors: 10,
              segments: 2,
              status: "green",
            },
          ],
        };
      } else if (endpoint === "/settings/skills/ochtend/versions") {
        skillVersionReads++;
        data = {
          currentVersion: 2,
          scannedEntries: 2,
          truncated: false,
          versions: [
            { version: 1, at: "2026-10-09T10:00:00Z", action: "created" },
            { version: 2, at: "2026-10-10T10:00:00Z", action: "updated" },
          ],
        };
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
        data = { ...overview, persona, pinRequired: pinned };
      } else if (endpoint === "/settings/persona") {
        persona = request.postDataJSON().text;
        data = { ok: true, persona };
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
            replacedSkills: 1,
            removedSkills: 0,
            removedWidgets: 1,
            personaChanged: true,
            quickActionsChanged: false,
            toolOverridesChanged: false,
            sidebarChanged: true,
            helperChanged: true,
            helperPreferencesChanged: true,
            missingSecrets: missingHeaders,
          },
          action: {
            confirmationId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
            sessionId: "settings-import:bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
            tool: "settings_import",
            args: { mode: "replace", incomingSkills: 1, incomingWidgets: 0 },
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
          data = { ok: true, imported: 1, missingSecrets: missingHeaders };
        } else
          data = { ok: true, cancelled: true, imported: 0, missingSecrets: [] };
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
    await page
      .getByRole("button", { name: "Accounts en catalogus laden", exact: true })
      .click();
    const accounts = page.getByRole("region", {
      name: "OmniRoute-accounts en modelcatalogus",
    });
    await accounts.getByText("Voorbeeldaccount", { exact: true }).waitFor();
    assert.equal(accountsReads, 1);
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

    await page
      .getByRole("button", { name: "OmniRoute-overzicht laden", exact: true })
      .click();
    await page.getByText("Gedeelde voorbeeldskill", { exact: true }).waitFor();
    assert.equal(
      await page
        .getByRole("button", {
          name: "Aan Gedeelde voorbeeldskill",
          exact: true,
        })
        .count(),
      0,
    );
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
        .getByRole("button", { name: "Bevestig skillmodus", exact: true })
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
      .getByRole("button", { name: "Bevestig skillmodus", exact: true })
      .click();
    await page
      .getByText("Modus opgeslagen en gecontroleerd.", { exact: false })
      .waitFor();
    assert.equal(nativeWrites, 1);
    assert.equal(nativeMode, "on");
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
    for (const section of sections) {
      await page
        .locator(`.settings-sidebar a[href="/settings?section=${section}"]`)
        .click();
      await page.waitForURL(`**/settings?section=${section}`);
      assert(await page.locator(".settings-content h1").isVisible());
      assert(
        await page.evaluate(
          () =>
            document.documentElement.scrollWidth <=
            document.documentElement.clientWidth,
        ),
        `Horizontal overflow in ${section} at ${width}`,
      );
    }
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
    assert.doesNotMatch(await skillRow.innerText(), /Bekijk het weer\./);
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
    assert.equal(await usage.getByRole("heading", { level: 3 }).count(), 2);
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
    assert.equal(await usage.getByRole("heading", { level: 3 }).count(), 1);
    await usage.getByRole("heading", { name: "echo", exact: true }).waitFor();
    await usageSearch.fill("settings_persona_set");
    assert.equal(await usage.getByRole("heading", { level: 3 }).count(), 1);
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
    assert.equal(await usage.getByRole("heading", { level: 3 }).count(), 3);
    await usageSearch.fill("extension");
    assert.equal(await usage.getByRole("heading", { level: 3 }).count(), 1);
    assert.match(
      await usage.innerText(),
      /Laatste: geen geregistreerde aanroep. Gemiddelde duur: onbekend/,
    );
    await usageSearch.fill("");
    await unusedUsage.uncheck();
    assert.equal(await usage.getByRole("heading", { level: 3 }).count(), 2);
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
      /1 vaardigheden worden vervangen; 0 vaardigheden en 1 panelen worden verwijderd/,
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
      .filter({ hasText: "1 vaardigheden geïmporteerd." })
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
    await page.screenshot({
      path: path.join(
        screenshots,
        `settings-devices-${width === 390 ? "mobile" : `${scale}x`}.png`,
      ),
    });
    await page.goto(`${base}/settings?section=connections`);
    const mqtt = page
      .locator(".connection-editor")
      .filter({ has: page.locator("summary", { hasText: "MQTT" }) });
    await mqtt.locator("summary").click();
    assert.equal(mqttReads, 0, "MQTT history loads only on request");
    await mqtt.getByRole("button", { name: "Berichten laden" }).click();
    await mqtt
      .getByText("Timergebeurtenis · label verborgen")
      .first()
      .waitFor();
    assert.equal(mqttReads, 1);
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
    assert.equal(qdrantReads, 1);
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
    await page.goto(`${base}/settings?section=personality`);
    await page.locator("#behaviorText").fill("Wees warm en duidelijk.");
    await page.getByRole("button", { name: "Opslaan", exact: true }).click();
    await page.getByText("De eigen regels zijn opgeslagen.").waitFor();
    assert.equal(persona, "Wees warm en duidelijk.");
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
    "Settings browser checks passed: all sections, search/keyboard/deep links, mobile, save, memory-only PIN expiry/lock, model metrics and explicit release checks, Windows shortcuts, native gateway documentation and confirmed native modes and global prompt replacement, explicit private account/catalog inventory and confirmed deletion, explicit free-policy options and acknowledged/cancelled/expired/confirmed policy changes with honest quota evidence, bounded backup parsing and reviewed/cancelled/expired/confirmed imports, explicit helper/tool settings history and rollback, bounded tool usage history, source/name filters and unused tools.",
  );
} finally {
  await browser.close();
}
