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
      version: 1,
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
    await page.clock.install();
    const errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    let pinned = false;
    const services = structuredClone(initialServices);
    let tested = false;
    let persona = overview.persona;
    let updateChecks = 0;
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
      else if (endpoint === "/settings/helper/hotkeys") {
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
      } else if (endpoint === "/settings/omniroute/native")
        data = {
          available: true,
          truncated: false,
          skills: [
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
          prompt: { enabled: false, prefixCharacters: 0, suffixCharacters: 0 },
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
      else if (endpoint === "/settings/models/metrics")
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
      else if (endpoint === "/settings/services") data = { services };
      else if (endpoint === "/settings/services/history")
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
      else if (endpoint === "/settings/export")
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
    await page
      .getByRole("button", { name: "OmniRoute-overzicht laden", exact: true })
      .click();
    await page.getByText("Gedeelde voorbeeldskill", { exact: true }).waitFor();
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
    "Settings browser checks passed: all sections, search/keyboard/deep links, mobile, save, memory-only PIN expiry/lock, model metrics and explicit release checks, Windows shortcuts and native gateway documentation.",
  );
} finally {
  await browser.close();
}
