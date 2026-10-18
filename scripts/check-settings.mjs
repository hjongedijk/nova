import { chromium } from "playwright-core";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { clickSection } from "./check-settings-nav.mjs";
/* global document, window */
const base = process.env.NOVA_SETTINGS_TEST_URL ?? "https://localhost:5173";
const screenshots = path.resolve(
  process.env.NOVA_SETTINGS_SCREENSHOTS ?? "docs/img",
);
fs.mkdirSync(screenshots, { recursive: true });
const sections = [
  "gesprek",
  "huis",
  "windows",
  "telefoon",
  "modellen",
  "zelf",
  "geheugen",
  "geavanceerd",
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
// A browser integration gate, with synthetic data only. Every API request is
// intercepted: an unrecognised mutation fails the gate and never reaches NOVA.
// API/unit suites cover individual provider editors and backend validation.
const initialOverview = structuredClone(overview);
const revisionId = "11111111-1111-4111-8111-111111111111";
const privateSecret = "fixture-private-token-do-not-render";
const browser = await chromium.launch({
  headless: true,
  args: ["--no-sandbox"],
});
try {
  const only = process.env.NOVA_SETTINGS_WIDTHS?.split(",").map(Number);
  for (const [width, scale] of [
    [1280, 1],
    [1280, 2],
    [390, 1],
  ].filter(([w]) => !only || only.includes(w))) {
    const state = structuredClone(initialOverview);
    state.tools = Array.from({ length: 25 }, (_, index) => ({
      name: `fixture_tool_${String(index).padStart(2, "0")}`,
      description: `Synthetic tool ${index}`,
      enabled: true,
      risk: "SAFE",
      source: "builtin",
      parameters: {},
    }));
    const services = structuredClone(initialServices);
    const desktopSettings = {
      viewEnabled: true,
      controlEnabled: true,
      cacheEnabled: false,
    };
    const runtimeGroups = [
      {
        id: "ntfy",
        label: "Pushmeldingen (ntfy)",
        fields: [
          {
            key: "url",
            label: "Adres",
            kind: "url",
            value: "https://notify.example.invalid",
            source: "environment",
          },
          {
            key: "topic",
            label: "Topic",
            kind: "text",
            value: "nova",
            source: "environment",
          },
          {
            key: "token",
            label: "Publiceertoken",
            kind: "secret",
            configured: true,
            source: "environment",
          },
        ],
      },
    ];
    const writes = [],
      failures = [],
      errors = [];
    let failNextSave = false;
    let memoryEnabled = false;
    let memoryRevision = null;
    let quickRevision = null;
    const context = await browser.newContext({
      ignoreHTTPSErrors: true,
      locale: "nl-NL",
      viewport: { width, height: 960 },
      deviceScaleFactor: scale,
    });
    const page = await context.newPage();
    page.on("pageerror", (error) => {
      errors.push(error.message);
      console.error(`Settings browser error: ${error.message}`);
    });
    page.on("console", (entry) => {
      // SvelteKit catches render errors and logs them rather than emitting
      // window.onerror. Network errors for unavailable optional integrations
      // are expected; JavaScript exceptions are always failures.
      if (
        entry.type() === "error" &&
        /(?:Type|Reference|Syntax)Error:|svelte\.dev\/e\//.test(entry.text())
      ) {
        errors.push(entry.text());
        console.error(`Settings render error: ${entry.text()}`);
      }
    });
    page.on("dialog", async (dialog) => {
      failures.push(`Unexpected browser dialog: ${dialog.type()}`);
      await dialog.dismiss();
    });
    await context.route(/^https?:\/\/[^/]+\/api(?:\/|$)/, async (route) => {
      const request = route.request();
      const url = new URL(request.url());
      const endpoint = url.pathname.slice(4);
      const method = request.method();
      const send = (data, status = 200) =>
        route.fulfill({ status, json: data });
      if (method !== "GET") {
        const body = request.postData() ? request.postDataJSON() : {};
        // SoundSection mirrors local playback preferences on mount.
        if (method === "PUT" && endpoint === "/settings/voice-profile")
          return send({ ok: true });
        writes.push({ method, endpoint, body });
        if (
          /prepare|confirm|unlock/.test(endpoint) ||
          /"(?:sessionId|confirmationId|approve|acknowledge)"/.test(
            JSON.stringify(body),
          )
        ) {
          failures.push(`Obsolete confirmation request: ${method} ${endpoint}`);
          return send({ message: "Confirmation endpoints are retired" }, 410);
        }
        if (method === "PUT" && endpoint === "/settings/desktop") {
          assert.equal(Object.keys(body).length, 1);
          assert.ok(
            Object.keys(body).every((key) => ["cacheEnabled"].includes(key)),
          );
          assert.ok(
            Object.values(body).every((value) => typeof value === "boolean"),
          );
          Object.assign(desktopSettings, body);
          return send({ settings: desktopSettings });
        }
        if (method === "PUT" && endpoint === "/settings/runtime/ntfy") {
          assert.deepEqual(body.reset, []);
          assert.equal(body.values.topic, "nova-browser-fixture");
          assert.equal(body.values.token, "");
          for (const field of runtimeGroups[0].fields) {
            if (field.kind !== "secret") field.value = body.values[field.key];
            field.source = "settings";
          }
          return send({ groups: runtimeGroups });
        }
        if (method === "PUT" && endpoint === "/settings/quick-actions") {
          if (failNextSave) {
            failNextSave = false;
            return send({ message: "Synthetic save failed; try again." }, 503);
          }
          const before = structuredClone(state.quickActions);
          state.quickActions = body.reset
            ? initialOverview.quickActions
            : body.items;
          quickRevision = {
            id: revisionId,
            at: "2026-10-18T10:00:00.000Z",
            before: { items: before },
            after: { items: structuredClone(state.quickActions) },
          };
          return send({ ok: true, quickActions: state.quickActions });
        }
        if (
          method === "POST" &&
          endpoint === `/settings/quick-actions/history/${revisionId}/rollback`
        ) {
          assert.deepEqual(body, {});
          state.quickActions = structuredClone(quickRevision.before.items);
          return send({ ok: true, quickActions: state.quickActions });
        }
        if (
          method === "POST" &&
          endpoint === "/settings/omniroute/native/memory"
        ) {
          assert.equal(typeof body.enabled, "boolean");
          memoryRevision = {
            id: revisionId,
            at: "2026-10-18T10:00:00.000Z",
            before: memoryEnabled,
            after: body.enabled,
          };
          memoryEnabled = body.enabled;
          return send({ ok: true, verified: true, enabled: memoryEnabled });
        }
        if (
          method === "POST" &&
          endpoint === "/settings/omniroute/native/memory/rollback"
        ) {
          assert.deepEqual(body, { revisionId });
          memoryEnabled = memoryRevision.before;
          return send({ ok: true, verified: true, enabled: memoryEnabled });
        }
        if (
          method === "POST" &&
          endpoint === "/settings/omniroute/native/prompt"
        ) {
          assert.deepEqual(body, {
            enabled: true,
            prefixPrompt: "Synthetic prefix",
            suffixPrompt: "Synthetic suffix",
          });
          return send({ ok: true, verified: true });
        }
        if (
          method === "PUT" &&
          endpoint === "/settings/services/home-assistant"
        ) {
          const service = services.find((item) => item.id === "home-assistant");
          assert.equal(body.values.token, privateSecret);
          for (const field of service.fields) {
            if (field.kind === "secret") field.set = true;
            else field.value = body.values[field.key];
          }
          service.restartRequired = true;
          return send({ ok: true, services });
        }
        failures.push(`Unmocked mutation: ${method} ${endpoint}`);
        return send(
          { message: "Unmocked mutation blocked by browser gate" },
          501,
        );
      }
      if (endpoint === "/settings") return send(state);
      if (endpoint === "/settings/services") return send({ services });
      if (endpoint.endsWith("/history")) {
        const revisions =
          endpoint === "/settings/quick-actions/history"
            ? quickRevision
              ? [quickRevision]
              : []
            : endpoint === "/settings/omniroute/native/memory/history"
              ? memoryRevision
                ? [memoryRevision]
                : []
              : [];
        return send({ revisions, truncated: false });
      }
      const data = {
        "/settings/services/restart": {
          available: false,
          pendingChanges: false,
          restartPending: false,
        },
        "/settings/desktop": {
          configured: true,
          settings: desktopSettings,
          session: null,
          agent: { viewAvailable: true, controlAvailable: true, armed: false },
          disarmPending: false,
          audit: [],
        },
        "/settings/windows/status": {
          configured: false,
          available: false,
          paused: false,
        },
        "/settings/runtime": { groups: runtimeGroups },
        "/settings/public": state,
        "/settings/helper": {
          settings: { mode: "wallpaper", display: 0 },
          desktop: { available: false, reason: "unreachable" },
        },
        "/settings/wallpaper": { available: false, reason: "unreachable" },
        "/settings/omniroute/native": {
          available: true,
          skills: [],
          documentation: [],
          prompt: { enabled: false, prefixCharacters: 0, suffixCharacters: 0 },
          memory: {
            enabled: memoryEnabled,
            backend: "sqlite",
            maxTokens: 1200,
          },
        },
        "/settings/conversation": {
          settings: {
            version: 1,
            enabled: false,
            language: "nl",
            greeting: "Hallo",
            idleSeconds: 20,
            maxMinutes: 15,
          },
          status: {
            enabled: false,
            listening: false,
            speechToText: { ready: false },
            active: null,
            calls: 0,
          },
        },
        "/telephony/status": {
          enabled: false,
          connected: false,
          extensions: [],
          contacts: [],
          ringExtensions: [],
          trunk: { configured: false },
          events: [],
          voice: "edge",
        },
        "/objectives": { objectives: [] },
        "/agent/runs": { runs: [] },
        "/autonomy/tasks": { tasks: [] },
        "/settings/home-assistant/inventory": {
          configured: false,
          areas: [],
          devices: [],
          entities: [],
        },
        "/settings/home-assistant/access": {
          mode: "all",
          areaIds: [],
          deviceIds: [],
          entityIds: [],
        },
        "/settings/managed-targets/inventory": {
          checkedAt: "2026-10-18",
          proxmox: { configured: false, nodes: [], guests: [] },
          termix: { configured: false, hosts: [] },
          pangolin: { configured: false, sites: [], resources: [] },
        },
        "/settings/managed-targets/access": {
          mode: "all",
          proxmoxNodeIds: [],
          proxmoxGuestIds: [],
          termixHostIds: [],
          pangolinSiteIds: [],
          pangolinResourceIds: [],
        },
        "/settings/workspace/projects": {
          version: 1,
          activeId: null,
          projects: [],
        },
        "/settings/stack-control": { available: false, services: [] },
        "/settings/mcp": { servers: [], workers: [] },
        "/nova/health": { version: "0.1.74", ok: true },
      };
      if (Object.hasOwn(data, endpoint)) return send(data[endpoint]);
      // An unavailable optional integration must render an error rather than
      // break settings. Do not invent successful replies with invalid shapes.
      return send(
        { message: "Synthetic optional integration unavailable" },
        503,
      );
    });

    async function noConfirmation() {
      assert.equal(await page.locator('[role="dialog"]:visible').count(), 0);
      assert.equal(
        await page
          .locator('input[type="password"][autocomplete="one-time-code"]')
          .count(),
        0,
      );
      assert.deepEqual(failures, []);
    }
    async function layout() {
      const result = await page.evaluate(() => ({
        overflow: document.documentElement.scrollWidth > window.innerWidth + 2,
        duplicates: [...document.querySelectorAll("[id]")]
          .map((n) => n.id)
          .filter((id, index, all) => all.indexOf(id) !== index),
        height: document.querySelector("#settingsBody")?.getBoundingClientRect()
          .height,
        openGroups: document.querySelectorAll(
          'details[name="settings-section"][open]',
        ).length,
      }));
      assert.equal(
        result.overflow,
        false,
        `Horizontal overflow at ${width}px on ${page.url()}`,
      );
      assert.deepEqual(result.duplicates, [], `Duplicate IDs on ${page.url()}`);
      assert.ok(
        result.openGroups <= 1,
        "Only one main settings section should be open",
      );
    }
    async function openSummary(name) {
      const summary = page.locator("summary").filter({ hasText: name }).first();
      await summary.waitFor();
      if (!(await summary.evaluate((node) => node.parentElement.open)))
        await summary.click();
    }
    async function waitWrite(endpoint, action) {
      const previous = writes.length;
      const response = page.waitForResponse(
        (res) =>
          new URL(res.url()).pathname === `/api${endpoint}` &&
          res.request().method() !== "GET",
      );
      await action();
      await response;
      assert.equal(
        writes.length,
        previous + 1,
        "One user action sends exactly one mutation",
      );
      assert.equal(writes.at(-1).endpoint, endpoint);
      await noConfirmation();
    }

    // Default layouts remain compact; no test auto-opens all disclosures.
    await page.goto(`${base}/settings?section=gesprek`);
    await page.locator("#settingsSearch").waitFor();
    for (const section of sections) {
      await clickSection(page, section);
      await page.locator(".settings-content").waitFor();
      const height = await page
        .locator("#settingsBody")
        .evaluate((node) => node.getBoundingClientRect().height);
      assert.ok(
        height < (width < 600 ? 6000 : 4000),
        `Default ${section} settings too tall: ${height}px`,
      );
      assert.deepEqual(errors, [], `Browser error on ${section}`);
      await layout();
      await page.screenshot({
        path: path.join(
          screenshots,
          `settings-${section}-${width === 390 ? "mobile" : `${scale}x`}.png`,
        ),
        fullPage: true,
      });
    }
    // Every advanced group mounts independently, preserving the accordion.
    const advanced = await page
      .locator('details[name="settings-section"] > summary')
      .allTextContents();
    for (const [index, title] of advanced.entries()) {
      await openSummary(title.trim());
      await layout();
      await page.screenshot({
        path: path.join(
          screenshots,
          `settings-advanced-${index + 1}-${width === 390 ? "mobile" : `${scale}x`}.png`,
        ),
      });
    }
    await clickSection(page, "gesprek");
    await page.locator("#settingsSearch").fill("windows");
    await page.locator(".settings-results a").first().click();
    await page.waitForURL(/section=windows/);
    assert.equal(await page.locator("#settingsSearch").inputValue(), "");
    await layout();
    // Canonical and old service links must land on their single current page.
    for (const [old, current] of [
      ["devices", "windows"],
      ["desktop", "windows"],
      ["windowsagent", "windows"],
      ["services", "huis"],
      ["models", "modellen"],
    ]) {
      await page.goto(`${base}/settings?section=${old}`);
      await page.waitForURL(new RegExp(`section=${current}(?:#|$)`));
      await noConfirmation();
    }

    // Failed saves retain the draft; retry persists and survives navigation.
    await page.goto(`${base}/settings?section=gesprek#snelle-opdrachten`);
    const quick = page.locator("#quick-actions-history");
    await quick
      .getByLabel("Knoptekst", { exact: true })
      .first()
      .fill("Fixture gewijzigd");
    failNextSave = true;
    await waitWrite("/settings/quick-actions", () =>
      quick.getByRole("button", { name: "Opslaan", exact: true }).click(),
    );
    await page
      .locator("#settingsMessage")
      .filter({ hasText: /NOVA kon een gekoppelde dienst niet bereiken/ })
      .waitFor();
    assert.equal(
      await quick.getByLabel("Knoptekst", { exact: true }).first().inputValue(),
      "Fixture gewijzigd",
    );
    assert.equal(state.quickActions[0].label, "Het weer");
    await waitWrite("/settings/quick-actions", () =>
      quick.getByRole("button", { name: "Opslaan", exact: true }).click(),
    );
    assert.equal(state.quickActions[0].label, "Fixture gewijzigd");
    await quick
      .getByRole("button", { name: "Geschiedenis", exact: true })
      .click();
    await page
      .getByRole("region", { name: "Geschiedenis snelle opdrachten" })
      .locator("summary")
      .click();
    await waitWrite(
      `/settings/quick-actions/history/${revisionId}/rollback`,
      () =>
        page
          .getByRole("button", { name: "Herstel deze versie", exact: true })
          .click(),
    );
    await page.waitForFunction(
      () =>
        document.querySelector('[aria-label="Knoptekst"]').value === "Het weer",
    );
    await clickSection(page, "windows");
    await clickSection(page, "gesprek");
    await openSummary("Snelle opdrachten");
    assert.equal(
      await quick.getByLabel("Knoptekst", { exact: true }).first().inputValue(),
      "Het weer",
    );

    // Service credentials start blank and never appear in returned settings.
    await page.goto(`${base}/settings?section=huis#connection-home-assistant`);
    const connection = page.locator("#connection-home-assistant");
    await connection.locator('input[type="password"]').waitFor();
    assert.equal(
      await connection.locator('input[type="password"]').inputValue(),
      "",
    );
    await connection.locator('input[type="password"]').fill(privateSecret);
    await waitWrite("/settings/services/home-assistant", () =>
      connection.getByRole("button", { name: "Opslaan", exact: true }).click(),
    );
    assert.equal(JSON.stringify(services).includes(privateSecret), false);
    assert.equal(
      (await page.locator("body").innerText()).includes(privateSecret),
      false,
    );

    // Native gateway changes and rollbacks use current one-step endpoints.
    await page.goto(`${base}/settings?section=modellen#modellen-expert`);
    await openSummary("NOVA-gateway");
    await page
      .getByRole("button", { name: "OmniRoute-overzicht laden", exact: true })
      .click();
    await waitWrite("/settings/omniroute/native/memory", () =>
      page
        .getByRole("button", {
          name: "Gateway-geheugen inschakelen",
          exact: true,
        })
        .click(),
    );
    assert.equal(memoryEnabled, true);
    await waitWrite("/settings/omniroute/native/memory/rollback", () =>
      page.getByRole("button", { name: "Zet terug", exact: true }).click(),
    );
    assert.equal(memoryEnabled, false);
    await page
      .getByRole("button", { name: "Gateway-prompt vervangen", exact: true })
      .click();
    await page.getByLabel("Extra gateway-prompt inschakelen").check();
    await page
      .getByLabel("Nieuw gateway-voorvoegsel", { exact: true })
      .fill("Synthetic prefix");
    await page
      .getByLabel("Nieuw gateway-achtervoegsel", { exact: true })
      .fill("Synthetic suffix");
    await waitWrite("/settings/omniroute/native/prompt", () =>
      page
        .getByRole("button", { name: "Gateway-prompt opslaan", exact: true })
        .click(),
    );
    await page
      .getByText("Gateway-prompt opgeslagen en gecontroleerd.", { exact: true })
      .waitFor();

    // Pairing is sufficient: no additional desktop permission switches or dialogs.
    await page.goto(`${base}/settings?section=windows#pc-bedienen`);
    const desktop = page.getByRole("region", { name: "Meekijken op je pc" });
    await desktop.waitFor();
    assert.equal(
      await desktop.getByRole("checkbox").count(),
      1,
      "Only the cache preference remains",
    );
    const cache = desktop.getByRole("checkbox", {
      name: "Schermbeschrijving 10 seconden onthouden voor snellere reacties",
    });
    await waitWrite("/settings/desktop", () => cache.check());
    assert.deepEqual(writes.at(-1).body, { cacheEnabled: true });
    assert.equal(desktopSettings.viewEnabled, true);
    assert.equal(desktopSettings.controlEnabled, true);
    await noConfirmation();

    // Runtime settings retain secret values when their empty editor is saved.
    await clickSection(page, "runtime");
    await openSummary("Pushmeldingen (ntfy)");
    assert.equal(await page.locator("#runtime-ntfy-token").inputValue(), "");
    await page.locator("#runtime-ntfy-topic").fill("nova-browser-fixture");
    await waitWrite("/settings/runtime/ntfy", () =>
      page
        .locator("#voorkeuren")
        .getByRole("button", { name: "Opslaan", exact: true })
        .click(),
    );
    assert.equal(
      runtimeGroups[0].fields.find((field) => field.key === "token").configured,
      true,
    );
    assert.equal(await page.locator("#runtime-ntfy-token").inputValue(), "");

    // Long catalogues render a bounded page and support navigation/filtering.
    await clickSection(page, "tools");
    const toolRows = page.locator("#gereedschappen .set-list > li");
    assert.equal(await toolRows.count(), 10);
    await page
      .getByRole("navigation", { name: "Gereedschappen doorbladeren" })
      .getByRole("button", { name: "Volgende", exact: true })
      .click();
    await page.locator("#toolSearch").fill("fixture_tool_24");
    await page
      .getByText("Pagina 1 van 1 · 1 resultaten", { exact: true })
      .waitFor();
    assert.equal(await toolRows.count(), 1);
    await layout();
    await noConfirmation();
    assert.deepEqual(
      errors,
      [],
      "Settings must not produce uncaught browser errors",
    );
    console.log(
      `settings ${width}px @${scale}x: navigation, compact layout, save/retry/rollback, secret privacy, one-step gateway, tools passed`,
    );
    await context.close();
  }
} finally {
  await browser.close();
}
