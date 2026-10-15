import assert from "node:assert/strict";
import { chromium } from "playwright-core";

const base = process.env.NOVA_SETTINGS_TEST_URL ?? "https://localhost:5173";
const privateAbility = "Private fixture ability";
const privateToken = "private-receipt-token-example-123456";
const moduleName = "node-red-contrib-private-fixture";
const privateTool = "private-fixture-tool";
const defaultToolDescription = "Private fixture default tool description.";
const changedToolDescription =
  "Private fixture description that must never enter cards.";
const browser = await chromium.launch({
  headless: true,
  args: ["--no-sandbox"],
});

try {
  for (const width of [1280, 390]) {
    const context = await browser.newContext({
      ignoreHTTPSErrors: true,
      serviceWorkers: "block",
      viewport: { width, height: 960 },
    });
    try {
      await context.addInitScript(() => {
        localStorage.setItem("novaWake", "off");
        localStorage.setItem("novaVoiceAlerts", "off");
        localStorage.setItem("novaPanels", "off");
      });
      const page = await context.newPage();
      page.setDefaultTimeout(15_000);
      const errors = [];
      const unexpectedWrites = [];
      let abilityWrites = 0;
      let serviceWrites = 0;
      let preparations = 0;
      let cancellations = 0;
      let confirmations = 0;
      let toolWrites = 0;
      let toolReadbacks = 0;
      let pendingToolReadback = false;
      let failAbility = false;
      let servicePending = false;
      let quickWrites = 0;
      let quickHistoryReads = 0;
      let quickRollbackAttempts = 0;
      let quickRollbackEffects = 0;
      let failQuickHistory = false;
      let expectedRollbackId = null;
      let quickHistory = [];
      const quickSaveId = "11111111-1111-4111-8111-111111111111";
      const olderQuickId = "33333333-3333-4333-8333-333333333333";
      const driftQuickId = "44444444-4444-4444-8444-444444444444";
      const savedQuickItems = [
        { label: "Nieuwe keuze", prompt: "Noem een natuurfeit." },
      ];
      const olderQuickItems = [
        { label: "Eerdere keuze", prompt: "Vertel een rustig feit." },
      ];
      const snapshot = (items) => ({
        isDefault: false,
        items: structuredClone(items),
      });

      const overview = {
        persona: "Spreek duidelijk.",
        personaStyle: "friendly",
        personaProfile: {
          name: "NOVA",
          character: "warm",
          address: "je",
          avoid: "verzinsels",
        },
        householdProfiles: [],
        activeHouseholdProfileId: null,
        quickActions: [],
        quickActionsAreDefault: false,
        skills: [],
        widgets: [],
        sidebar: [],
        builtinPanels: [],
        maxPages: { left: 3, right: 3 },
        abilities: [
          {
            id: "private-fixture-ability",
            name: privateAbility,
            description: "Synthetic browser fixture.",
            example: null,
            tools: [],
            total: 1,
            enabledCount: 1,
            state: "on",
          },
        ],
        tools: [
          {
            name: privateTool,
            description: defaultToolDescription,
            defaultDescription: defaultToolDescription,
            source: "fixture",
            risk: "READ_ONLY",
            enabled: true,
            switchedOff: false,
            edited: false,
          },
        ],
        pinRequired: false,
        standingApprovals: [],
      };
      const services = [
        {
          id: "node-red",
          label: "Node-RED",
          fields: [
            {
              key: "adminToken",
              label: "Beheertoken",
              kind: "secret",
              source: "environment",
              set: true,
            },
          ],
          restartRequired: false,
        },
      ];
      let palette = {
        revision: "a".repeat(64),
        modules: [
          {
            name: moduleName,
            installed: true,
            version: "1.0.0",
            targetVersion: "2.0.0",
            pendingVersion: null,
            restartRequired: false,
          },
        ],
      };
      page.on("pageerror", (error) => {
        errors.push(error.message);
        console.error("Receipt browser page error:", error.message);
      });
      // Every API request is fulfilled here. No request can reach the running API.
      await context.route(/^https?:\/\/[^/]+\/api\//, async (route) => {
        const request = route.request();
        const pathname = new URL(request.url()).pathname;
        const method = request.method();
        const json = (body, status = 200) =>
          route.fulfill({ status, json: body });
        if (method !== "GET") {
          if (
            pathname === "/api/settings/abilities/private-fixture-ability" &&
            method === "PUT"
          ) {
            abilityWrites++;
            if (failAbility) return json({ error: "Synthetic failure." }, 500);
            const enabled = request.postDataJSON().enabled;
            overview.abilities[0].state = enabled ? "on" : "off";
            overview.abilities[0].enabledCount = enabled ? 1 : 0;
            return json({ ok: true });
          }
          if (
            pathname === `/api/settings/tools/${privateTool}` &&
            method === "PUT"
          ) {
            toolWrites++;
            const override = request.postDataJSON();
            assert(
              Object.keys(override).every((key) =>
                ["enabled", "description"].includes(key),
              ),
            );
            const tool = overview.tools[0];
            tool.description =
              typeof override.description === "string"
                ? override.description
                : defaultToolDescription;
            tool.edited = typeof override.description === "string";
            tool.enabled = override.enabled !== false;
            tool.switchedOff = override.enabled === false;
            pendingToolReadback = true;
            return json({ ok: true, override });
          }
          if (pathname === "/api/settings/quick-actions" && method === "PUT") {
            quickWrites++;
            assert.deepEqual(request.postDataJSON(), {
              items: savedQuickItems,
            });
            const revision = {
              id: quickSaveId,
              at: "2026-10-15T12:00:00.000Z",
              before: snapshot(overview.quickActions),
              after: snapshot(savedQuickItems),
            };
            quickHistory = [revision, ...quickHistory];
            overview.quickActions = structuredClone(savedQuickItems);
            return json({ ok: true, quickActions: overview.quickActions });
          }
          const quickRollback =
            /^\/api\/settings\/quick-actions\/history\/([0-9a-f-]{36})\/rollback$/.exec(
              pathname,
            );
          if (quickRollback && method === "POST") {
            quickRollbackAttempts++;
            const id = quickRollback[1];
            assert.equal(
              id,
              expectedRollbackId,
              "Only the explicitly selected history row may be restored",
            );
            assert.deepEqual(request.postDataJSON(), {});
            const revision = quickHistory.find((row) => row.id === id);
            assert(
              revision,
              "Selected revision must exist in the returned fixture history",
            );
            if (
              JSON.stringify(revision.after) !==
              JSON.stringify(snapshot(overview.quickActions))
            ) {
              return json({ error: "Synthetic private drift diagnostic" }, 409);
            }
            quickRollbackEffects++;
            const before = snapshot(overview.quickActions);
            overview.quickActions = structuredClone(revision.before.items);
            quickHistory = [
              {
                id: `55555555-5555-4555-8555-${String(quickRollbackEffects).padStart(12, "0")}`,
                at: `2026-10-15T12:0${quickRollbackEffects}:00.000Z`,
                before,
                after: snapshot(overview.quickActions),
              },
              ...quickHistory,
            ];
            return json({ ok: true, quickActions: overview.quickActions });
          }
          if (
            pathname === "/api/settings/services/node-red" &&
            method === "PUT"
          ) {
            serviceWrites++;
            assert.equal(
              request.postDataJSON().values.adminToken,
              privateToken,
            );
            services[0].restartRequired = true;
            services[0].fields[0].source = "settings";
            servicePending = true;
            return json({ ok: true, services });
          }
          if (
            pathname === "/api/settings/node-red/palette/prepare" &&
            method === "POST"
          ) {
            preparations++;
            return json({
              warning: "Synthetic upgrade requires a separate confirmation.",
              action: {
                sessionId:
                  "settings-node-red-palette:aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
                confirmationId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
                tool: "settings_node_red_palette",
                args: {},
                risk: "DANGEROUS",
                expiresAt: Date.now() + 120_000,
              },
            });
          }
          if (
            pathname === "/api/settings/node-red/palette/confirm" &&
            method === "POST"
          ) {
            if (!request.postDataJSON().approve) {
              cancellations++;
              return json({ ok: true, cancelled: true });
            }
            confirmations++;
            palette = {
              ...palette,
              revision: "b".repeat(64),
              modules: [
                {
                  ...palette.modules[0],
                  pendingVersion: "2.0.0",
                  restartRequired: true,
                },
              ],
            };
            return json({
              ok: true,
              verified: false,
              pendingRestart: true,
              state: palette,
            });
          }
          unexpectedWrites.push({ pathname, method });
          return json({ error: "Unmocked mutation blocked." }, 501);
        }
        if (pathname === "/api/access/status")
          return json({ required: false, unlocked: true });
        if (pathname === "/api/settings") {
          if (pendingToolReadback) {
            toolReadbacks++;
            pendingToolReadback = false;
          }
          return json(overview);
        }
        if (pathname === "/api/settings/quick-actions/history") {
          quickHistoryReads++;
          assert.equal(request.headers()["x-nova-admin"], "1");
          if (failQuickHistory)
            return json({ error: "Synthetic private history diagnostic" }, 503);
          return json({ revisions: quickHistory, truncated: false });
        }
        if (pathname === "/api/tts/health")
          return json({ piperAvailable: false, voice: "nl-NL-FennaNeural" });
        if (pathname === "/api/settings/services") return json({ services });
        if (pathname === "/api/settings/services/restart") {
          return json({
            available: false,
            pendingChanges: servicePending,
            restartPending: false,
          });
        }
        if (pathname === "/api/settings/services/history")
          return json({ revisions: [] });
        if (pathname === "/api/settings/node-red/palette") return json(palette);
        if (pathname === "/api/settings/helper/preferences") {
          return json({
            autohide: true,
            contrast: false,
            shape: "orb",
            cues: {
              enabled: false,
              volume: 0,
              theme: "soft",
              quiet: { enabled: false, start: "22:00", end: "07:00" },
            },
          });
        }
        if (pathname === "/api/settings/public")
          return json({
            sidebar: [],
            widgets: [],
            maxPages: { left: 3, right: 3 },
            quickActions: [],
          });
        if (pathname === "/api/health")
          return json({
            ok: true,
            omnirouteConfigured: true,
            routing: { ready: true },
            services: {},
            state: {},
          });
        if (pathname === "/api/alerts") return json({ latest: 0, events: [] });
        if (pathname === "/api/focus")
          return json({
            active: false,
            until: null,
            pending: 0,
            workBlock: false,
          });
        if (pathname === "/api/activity") return json({ entries: [] });
        if (pathname === "/api/overview")
          return json({
            proxmox: { guests: [], storage: [] },
            timers: [],
            lists: {},
          });
        // Unknown reads fail locally rather than being forwarded to production.
        return json({ error: "Synthetic read unavailable." }, 404);
      });

      let documentMarker;
      async function inspectReceipts(expectedCount) {
        await page
          .getByRole("link", { name: "Terug naar gesprek", exact: true })
          .click();
        await page.locator("#menuButton").click();
        await page.locator("#historyOpen").click();
        assert.equal(
          await page.evaluate(() => globalThis.__novaReceiptTestDocument),
          documentMarker,
          "Settings return must preserve the document and in-memory receipts",
        );
        const drawer = page.locator('#history[aria-hidden="false"]');
        await drawer.waitFor();
        const cards = drawer.getByRole("region", {
          name: "Actiekaart",
          exact: true,
        });
        assert.equal(
          await cards.count(),
          expectedCount,
          `${width}: completed receipt count`,
        );
        for (const card of await cards.all()) {
          const text = await card.innerText();
          assert.match(text, /Gevraagd:/);
          assert.match(text, /Uitgevoerd:/);
          assert.match(text, /Gecontroleerd:/);
          assert.doesNotMatch(
            text,
            /Private fixture|private-fixture|private-receipt|node-red-contrib-private/,
          );
          assert.equal(
            await card
              .getByRole("link", { name: "Bekijk het actielog", exact: true })
              .getAttribute("href"),
            "/settings?section=system#actielog",
          );
        }
        return cards;
      }
      async function settingsSection(section) {
        await page.locator("#historyClose").click();
        await page.locator("#menuButton").click();
        await page.locator("#settingsOpen").click();
        await page
          .locator(`.settings-sidebar a[href="/settings?section=${section}"]`)
          .click();
        await page.locator(".settings-content").waitFor();
      }

      await page.goto(`${base}/settings?section=abilities`);
      await page.locator("#settingsBody").waitFor();
      documentMarker = await page.evaluate(
        () => (globalThis.__novaReceiptTestDocument = Math.random()),
      );
      const toggle = () =>
        page.getByRole("checkbox", {
          name: `${privateAbility} aan of uit`,
          exact: true,
        });
      await toggle().uncheck();
      await page
        .getByText(`${privateAbility} staat uit. NOVA doet dit nu niet meer.`, {
          exact: true,
        })
        .waitFor();
      let cards = await inspectReceipts(1);
      assert.match(
        await cards.first().locator("p").nth(2).innerText(),
        /niet|ontbreekt|geen/i,
      );

      await settingsSection("abilities");
      failAbility = true;
      await toggle().check();
      await page.locator("#settingsMessage.bad").waitFor();
      await inspectReceipts(1);
      assert.equal(abilityWrites, 2);

      await settingsSection("connections");
      const service = () =>
        page.locator("details.connection-editor").filter({
          has: page.locator("summary strong", { hasText: "Node-RED" }),
        });
      await service().locator("summary").click();
      await page.locator("#node-red-adminToken").fill(privateToken);
      await service()
        .getByRole("button", { name: "Opslaan", exact: true })
        .click();
      await page
        .getByText(
          "Opgeslagen. Herstart NOVA om deze koppeling toe te passen.",
          { exact: true },
        )
        .waitFor();
      await inspectReceipts(2);

      await settingsSection("connections");
      await service().locator("summary").click();
      const paletteRegion = page.getByRole("region", {
        name: "Node-RED-palette",
        exact: true,
      });
      await paletteRegion
        .getByRole("button", { name: "Palette laden", exact: true })
        .click();
      await paletteRegion
        .getByRole("button", { name: "Versie 2.0.0 installeren", exact: true })
        .click();
      await page
        .getByRole("group", {
          name: "Palettewijziging bevestigen",
          exact: true,
        })
        .waitFor();
      // Preparing an operation must not create a success card.
      await inspectReceipts(2);

      await settingsSection("connections");
      await service().locator("summary").click();
      await paletteRegion
        .getByRole("button", { name: "Palette laden", exact: true })
        .click();
      await paletteRegion
        .getByRole("button", { name: "Versie 2.0.0 installeren", exact: true })
        .click();
      await paletteRegion
        .getByRole("button", { name: "Annuleren", exact: true })
        .click();
      await paletteRegion
        .getByText("Palettewijziging geannuleerd.", { exact: true })
        .waitFor();
      await inspectReceipts(2);

      await settingsSection("connections");
      await service().locator("summary").click();
      await paletteRegion
        .getByRole("button", { name: "Palette laden", exact: true })
        .click();
      await paletteRegion
        .getByRole("button", { name: "Versie 2.0.0 installeren", exact: true })
        .click();
      await paletteRegion
        .getByRole("button", { name: "Ja, doorgaan", exact: true })
        .click();
      await paletteRegion
        .getByText(/versie klaargezet\. Herstart Node-RED via Services/)
        .waitFor();
      cards = await inspectReceipts(3);
      assert.match(
        await cards.first().locator("p").nth(1).innerText(),
        /herstart|klaargezet|aangevraagd/i,
      );
      assert.match(
        await cards.first().locator("p").nth(2).innerText(),
        /niet|ontbreekt|geen/i,
      );
      async function openFixtureTool() {
        await settingsSection("abilities");
        await page
          .getByText("Alle gereedschappen en hun risico", { exact: true })
          .click();
        return page
          .locator("li.set-row")
          .filter({ has: page.getByText(privateTool, { exact: true }) });
      }
      const overviewRead = () =>
        page.waitForResponse(
          (response) =>
            new URL(response.url()).pathname === "/api/settings" &&
            response.request().method() === "GET",
        );
      let tool = await openFixtureTool();
      await tool
        .getByRole("button", { name: "Beschrijving", exact: true })
        .click();
      await tool
        .getByRole("textbox", {
          name: `Beschrijving van ${privateTool}`,
          exact: true,
        })
        .fill(changedToolDescription);
      let refreshed = overviewRead();
      await tool.getByRole("button", { name: "Opslaan", exact: true }).click();
      await refreshed;
      await tool.getByText(changedToolDescription, { exact: true }).waitFor();
      cards = await inspectReceipts(4);
      assert.match(
        await cards.first().innerText(),
        /Gereedschapsbeschrijving aanpassen/,
      );
      assert.match(
        await cards.first().locator("p").nth(2).innerText(),
        /opnieuw gelezen en gecontroleerd/,
      );
      assert.equal(toolReadbacks, 1);

      tool = await openFixtureTool();
      await tool
        .getByRole("button", { name: "Beschrijving", exact: true })
        .click();
      refreshed = overviewRead();
      await tool
        .getByRole("button", { name: "Standaard herstellen", exact: true })
        .click();
      await refreshed;
      await tool.getByText(defaultToolDescription, { exact: true }).waitFor();
      assert.equal(
        await tool.getByText("aangepast", { exact: true }).count(),
        0,
      );
      cards = await inspectReceipts(5);
      assert.match(
        await cards.first().innerText(),
        /Standaardbeschrijving van gereedschap herstellen/,
      );
      assert.match(
        await cards.first().locator("p").nth(2).innerText(),
        /opnieuw gelezen en gecontroleerd/,
      );
      assert.equal(toolReadbacks, 2);

      tool = await openFixtureTool();
      refreshed = overviewRead();
      await tool
        .getByRole("checkbox", {
          name: `${privateTool} aan of uit`,
          exact: true,
        })
        .uncheck();
      await refreshed;
      cards = await inspectReceipts(6);
      assert.match(await cards.first().innerText(), /Gereedschap uitschakelen/);
      assert.match(
        await cards.first().locator("p").nth(2).innerText(),
        /opnieuw gelezen en gecontroleerd/,
      );
      assert.equal(toolWrites, 3);
      assert.equal(toolReadbacks, 3);

      await settingsSection("voice");
      await page.locator("#ttsVoice").selectOption("en-US-GuyNeural");
      assert.equal(
        await page.evaluate(() => localStorage.getItem("novaTtsVoice")),
        "en-US-GuyNeural",
      );
      cards = await inspectReceipts(7);
      assert.match(await cards.first().innerText(), /Spreekstem aanpassen/);
      assert.match(
        await cards.first().locator("p").nth(1).innerText(),
        /op dit apparaat opgeslagen/,
      );
      assert.match(
        await cards.first().locator("p").nth(2).innerText(),
        /Browseropslag opnieuw gelezen en gecontroleerd/,
      );
      assert.match(
        await cards.first().locator("p").nth(2).innerText(),
        /Hardware, spraak en server niet gecontroleerd/,
      );
      assert.doesNotMatch(
        await cards.first().innerText(),
        /GuyNeural|JennyNeural/,
      );

      await settingsSection("voice");
      await page.evaluate(() => {
        globalThis.__novaReceiptStorageSetter = Storage.prototype.setItem;
        Storage.prototype.setItem = function () {
          throw new DOMException(
            "Synthetic storage denied",
            "QuotaExceededError",
          );
        };
      });
      try {
        await page.locator("#ttsVoice").selectOption("en-US-JennyNeural");
        assert.equal(
          await page.evaluate(() => localStorage.getItem("novaTtsVoice")),
          "en-US-GuyNeural",
        );
      } finally {
        await page.evaluate(() => {
          Storage.prototype.setItem = globalThis.__novaReceiptStorageSetter;
          delete globalThis.__novaReceiptStorageSetter;
        });
      }
      cards = await inspectReceipts(8);
      assert.match(
        await cards.first().locator("p").nth(1).innerText(),
        /opslag niet bevestigd/,
      );
      assert.doesNotMatch(
        await cards.first().locator("p").nth(1).innerText(),
        /opgeslagen/,
      );
      assert.match(
        await cards.first().locator("p").nth(2).innerText(),
        /Hardware, spraak en server niet gecontroleerd/,
      );
      assert.doesNotMatch(
        await cards.first().innerText(),
        /GuyNeural|JennyNeural/,
      );
      // A real quick-action edit creates a receipt but never reads recovery history eagerly.
      await settingsSection("general");
      const quickEditor = page.locator("#quick-actions-history");
      await quickEditor
        .getByRole("button", { name: "Knop toevoegen", exact: true })
        .click();
      await quickEditor
        .getByRole("textbox", { name: "Knoptekst", exact: true })
        .fill(savedQuickItems[0].label);
      await quickEditor
        .getByRole("textbox", { name: "Opdracht", exact: true })
        .fill(savedQuickItems[0].prompt);
      assert.equal(quickHistoryReads, 0);
      const quickSaveReadback = overviewRead();
      await quickEditor
        .getByRole("button", { name: "Opslaan", exact: true })
        .click();
      await quickSaveReadback;
      await page
        .getByText("De snelle opdrachten zijn opgeslagen.", { exact: true })
        .waitFor();
      assert.equal(quickWrites, 1);
      assert.equal(
        quickHistoryReads,
        0,
        "Saving must not eagerly fetch recovery history",
      );
      cards = await inspectReceipts(9);
      assert.match(
        await cards.first().innerText(),
        /Snelle opdrachten aanpassen/,
      );
      assert.match(
        await cards.first().locator("p").nth(2).innerText(),
        /opnieuw gelezen en gecontroleerd/,
      );
      const drawer = page.locator('#history[aria-hidden="false"]');
      const historyRegion = () =>
        drawer.getByRole("region", {
          name: "Geschiedenis snelle opdrachten",
          exact: true,
        });
      const selectedRow = (at) =>
        historyRegion()
          .locator("details")
          .filter({ has: page.locator(`time[datetime="${at}"]`) });
      const rollbackCards = async () => {
        const requested = await cards
          .locator(":scope > p:first-of-type")
          .allTextContents();
        return requested.filter((line) =>
          line.includes("Eerdere snelle opdrachten herstellen"),
        ).length;
      };
      async function closeQuickRecovery() {
        await drawer
          .getByRole("button", { name: "Herstelopties sluiten", exact: true })
          .click();
        assert.equal(await historyRegion().count(), 0);
      }
      // Register the response wait before clicking; the fixture responds immediately.
      let historyResponse = page.waitForResponse(
        (response) =>
          new URL(response.url()).pathname ===
          "/api/settings/quick-actions/history",
      );
      await cards
        .first()
        .getByRole("button", { name: "Herstelopties openen", exact: true })
        .click();
      await historyResponse;
      assert.equal(quickHistoryReads, 1);
      await historyRegion().waitFor();
      let row = selectedRow("2026-10-15T12:00:00.000Z");
      await row.locator("summary").click();
      assert.match(await row.innerText(), /Voor/);
      assert.match(await row.innerText(), /Na/);
      assert.match(await row.innerText(), /Nieuwe keuze: Noem een natuurfeit/);
      assert.equal(quickRollbackAttempts, 0);
      const cancelledCards = await cards.allTextContents();
      page.once("dialog", async (dialog) => {
        assert.match(dialog.message(), /Dit voert ze niet uit/);
        await dialog.dismiss();
      });
      await row
        .getByRole("button", { name: "Herstel deze versie", exact: true })
        .click();
      assert.equal(quickRollbackAttempts, 0);
      assert.deepEqual(await cards.allTextContents(), cancelledCards);
      assert.deepEqual(overview.quickActions, savedQuickItems);

      expectedRollbackId = quickSaveId;
      page.once("dialog", async (dialog) => {
        assert.match(dialog.message(), /Dit voert ze niet uit/);
        await dialog.accept();
      });
      let readback = overviewRead();
      historyResponse = page.waitForResponse(
        (response) =>
          new URL(response.url()).pathname ===
          "/api/settings/quick-actions/history",
      );
      await row
        .getByRole("button", { name: "Herstel deze versie", exact: true })
        .click();
      await readback;
      await historyResponse;
      await historyRegion()
        .getByText("Snelle opdrachten hersteld.", { exact: true })
        .waitFor();
      assert.equal(quickRollbackAttempts, 1);
      assert.equal(quickRollbackEffects, 1);
      assert.deepEqual(overview.quickActions, []);
      assert.equal(await cards.count(), 10);
      assert.equal(await rollbackCards(), 1);
      assert.match(
        await cards.first().locator("p").nth(2).innerText(),
        /opnieuw gelezen en gecontroleerd/,
      );
      await closeQuickRecovery();

      // The current value can match an older row: select it explicitly, never pick the first.
      quickHistory = [
        {
          id: driftQuickId,
          at: "2026-10-15T11:00:00.000Z",
          before: snapshot([]),
          after: snapshot(savedQuickItems),
        },
        {
          id: olderQuickId,
          at: "2026-10-14T09:00:00.000Z",
          before: snapshot(olderQuickItems),
          after: snapshot([]),
        },
      ];
      historyResponse = page.waitForResponse(
        (response) =>
          new URL(response.url()).pathname ===
          "/api/settings/quick-actions/history",
      );
      await cards
        .first()
        .getByRole("button", { name: "Herstelopties openen", exact: true })
        .click();
      await historyResponse;
      assert.equal(quickHistoryReads, 3);
      assert.equal(await historyRegion().locator("details").count(), 2);
      row = selectedRow("2026-10-14T09:00:00.000Z");
      await row.locator("summary").click();
      assert.match(
        await row.innerText(),
        /Eerdere keuze: Vertel een rustig feit/,
      );
      expectedRollbackId = olderQuickId;
      page.once("dialog", (dialog) => dialog.accept());
      readback = overviewRead();
      historyResponse = page.waitForResponse(
        (response) =>
          new URL(response.url()).pathname ===
          "/api/settings/quick-actions/history",
      );
      await row
        .getByRole("button", { name: "Herstel deze versie", exact: true })
        .click();
      await readback;
      await historyResponse;
      assert.equal(quickRollbackAttempts, 2);
      assert.equal(quickRollbackEffects, 2);
      assert.deepEqual(overview.quickActions, olderQuickItems);
      await page
        .locator("#chips")
        .getByRole("button", { name: olderQuickItems[0].label, exact: true })
        .waitFor({ state: "attached" });
      assert.deepEqual(
        await page.locator("#chips button").allTextContents(),
        olderQuickItems.map((item) => item.label),
        "Direct restore refreshes the actual home chips without navigating or executing a prompt",
      );
      assert.equal(
        await rollbackCards(),
        2,
        "One checked receipt per explicit restore",
      );
      assert.match(
        await cards.first().locator("p").nth(2).innerText(),
        /opnieuw gelezen en gecontroleerd/,
      );
      await closeQuickRecovery();

      // A stale selected row gets a friendly conflict, without an effect or another receipt.
      quickHistory = [
        {
          id: driftQuickId,
          at: "2026-10-15T11:00:00.000Z",
          before: snapshot([]),
          after: snapshot(savedQuickItems),
        },
      ];
      historyResponse = page.waitForResponse(
        (response) =>
          new URL(response.url()).pathname ===
          "/api/settings/quick-actions/history",
      );
      await cards
        .first()
        .getByRole("button", { name: "Herstelopties openen", exact: true })
        .click();
      await historyResponse;
      assert.equal(quickHistoryReads, 5);
      row = selectedRow("2026-10-15T11:00:00.000Z");
      await row.locator("summary").click();
      expectedRollbackId = driftQuickId;
      const beforeConflict = structuredClone(overview.quickActions);
      const beforeConflictCards = await cards
        .locator(":scope > p:first-of-type")
        .allTextContents();
      page.once("dialog", (dialog) => dialog.accept());
      await row
        .getByRole("button", { name: "Herstel deze versie", exact: true })
        .click();
      await historyRegion()
        .getByRole("status")
        .filter({
          hasText:
            /^(?:De instellingen zijn gewijzigd\. Laad ze opnieuw en probeer het nog eens\.|The settings changed\. Reload before trying again\.)$/,
        })
        .waitFor();
      assert.equal(quickRollbackAttempts, 3);
      assert.equal(quickRollbackEffects, 2);
      assert.deepEqual(overview.quickActions, beforeConflict);
      assert.deepEqual(
        await cards.locator(":scope > p:first-of-type").allTextContents(),
        beforeConflictCards,
      );
      await closeQuickRecovery();

      // Failed history reads cannot keep stale rows; reopening retries with a fresh snapshot.
      failQuickHistory = true;
      historyResponse = page.waitForResponse(
        (response) =>
          new URL(response.url()).pathname ===
          "/api/settings/quick-actions/history",
      );
      await cards
        .first()
        .getByRole("button", { name: "Herstelopties openen", exact: true })
        .click();
      await historyResponse;
      await historyRegion().getByRole("status").waitFor();
      assert.equal(quickHistoryReads, 6);
      assert.equal(await historyRegion().locator("details").count(), 0);
      assert.doesNotMatch(
        await historyRegion().innerText(),
        /Synthetic private|Nieuwe keuze|Eerdere keuze/,
      );
      await closeQuickRecovery();
      failQuickHistory = false;
      quickHistory = [
        {
          id: olderQuickId,
          at: "2026-10-14T10:00:00.000Z",
          before: snapshot([]),
          after: snapshot(olderQuickItems),
        },
      ];
      historyResponse = page.waitForResponse(
        (response) =>
          new URL(response.url()).pathname ===
          "/api/settings/quick-actions/history",
      );
      await cards
        .first()
        .getByRole("button", { name: "Herstelopties openen", exact: true })
        .click();
      await historyResponse;
      assert.equal(quickHistoryReads, 7);
      await historyRegion()
        .locator('time[datetime="2026-10-14T10:00:00.000Z"]')
        .waitFor();
      assert.equal(
        await historyRegion()
          .locator('time[datetime="2026-10-15T11:00:00.000Z"]')
          .count(),
        0,
      );
      assert.equal(await historyRegion().getByRole("status").count(), 0);
      await closeQuickRecovery();

      // A real pointer drag writes live preferences, but emits just one card on release.
      await settingsSection("voice");
      const rate = page.locator("#ttsRate");
      const rateBox = await rate.boundingBox();
      assert(rateBox);
      const allStoredCards = page.locator('#history [aria-label="Actiekaart"]');
      const prosodyCards = async () =>
        (
          await allStoredCards
            .locator(":scope > p:first-of-type")
            .allTextContents()
        ).filter((line) => line.includes("Spreektempo en toonhoogte aanpassen"))
          .length;
      assert.equal(await prosodyCards(), 0);
      await page.mouse.move(
        rateBox.x + rateBox.width * 0.4,
        rateBox.y + rateBox.height / 2,
      );
      await page.mouse.down();
      await page.mouse.move(
        rateBox.x + rateBox.width * 0.85,
        rateBox.y + rateBox.height / 2,
        { steps: 8 },
      );
      assert.equal(
        await prosodyCards(),
        0,
        "Live range input must not flood receipts",
      );
      assert.notEqual(
        await page.evaluate(() => localStorage.getItem("novaTtsRate")),
        null,
      );
      await page.mouse.up();
      cards = await inspectReceipts(10);
      assert.equal(
        await prosodyCards(),
        1,
        "Range release produces one receipt",
      );
      assert.match(
        await cards.first().innerText(),
        /Spreektempo en toonhoogte aanpassen/,
      );
      assert.match(
        await cards.first().locator("p").nth(2).innerText(),
        /Browseropslag opnieuw gelezen en gecontroleerd/,
      );
      assert.equal(quickWrites, 1);
      assert.equal(quickRollbackAttempts, 3);
      assert.equal(quickRollbackEffects, 2);
      assert.equal(quickHistoryReads, 7);
      assert.equal(serviceWrites, 1);
      assert.equal(preparations, 3);
      assert.equal(cancellations, 1);
      assert.equal(confirmations, 1);
      assert.deepEqual(unexpectedWrites, []);
      assert.deepEqual(errors, []);
      console.log(
        `${width}px: settings receipts pass; failure/preparation/cancellation excluded, credentials hidden, staged restart honest, tool descriptions read back, toggle single-card, local voice storage success/failure honest; direct quick-action recovery is fresh, explicit, cancellable and conflict-safe; range drag emits one card; all API calls mocked.`,
      );
    } finally {
      await context.close();
    }
  }
} finally {
  await browser.close();
}
