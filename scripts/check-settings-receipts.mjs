import assert from "node:assert/strict";
import { chromium } from "playwright-core";

const base = process.env.NOVA_SETTINGS_TEST_URL ?? "https://localhost:5173";
const privateAbility = "Private fixture ability";
const privateToken = "private-receipt-token-example-123456";
const moduleName = "node-red-contrib-private-fixture";
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
      let failAbility = false;
      let servicePending = false;
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
        tools: [],
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
        if (pathname === "/api/settings") return json(overview);
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
      assert.equal(serviceWrites, 1);
      assert.equal(preparations, 3);
      assert.equal(cancellations, 1);
      assert.equal(confirmations, 1);
      assert.deepEqual(unexpectedWrites, []);
      assert.deepEqual(errors, []);
      console.log(
        `${width}px: settings receipts pass; failure/preparation/cancellation excluded, credentials hidden, staged restart honest; all API calls mocked.`,
      );
    } finally {
      await context.close();
    }
  }
} finally {
  await browser.close();
}
