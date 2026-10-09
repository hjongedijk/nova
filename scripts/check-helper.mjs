import { chromium } from "playwright-core";
import path from "node:path";
import { fileURLToPath } from "node:url";
/* global document, window */
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
import assert from "node:assert/strict";
(async () => {
  const browser = await chromium.launch({
    headless: true,
    args: ["--no-sandbox"],
  });
  try {
    for (const scale of [1, 2]) {
      const context = await browser.newContext({
        ignoreHTTPSErrors: true,
        deviceScaleFactor: scale,
        viewport: { width: 360, height: 44 },
      });
      const page = await context.newPage();
      await page.clock.install();
      let kind = "answer",
        fail = false,
        request;
      const errors = [];
      let resizeActive = 0,
        maxResizeActive = 0;
      page.on("pageerror", (error) => errors.push(error.message));
      await page.route("**/api/overview", (route) =>
        route.fulfill({
          json: {
            at: new Date().toISOString(),
            proxmox: null,
            home: null,
            timers: [],
            lists: { Boodschappen: ["Appels", "Koffie"] },
            weather: {
              name: "Voorbeeld",
              condition: "Helder",
              temperature: 18,
              temperatureUnit: "°C",
              windSpeed: 6,
              windUnit: "km/h",
              forecast: null,
            },
          },
        }),
      );
      await page.route("**/api/health", (route) =>
        route.fulfill({
          json: {
            ok: true,
            nodeRed: true,
            mqtt: true,
            omnirouteConfigured: true,
            routing: { ready: true },
          },
        }),
      );
      await page.route("**/api/alerts?*", (route) =>
        route.fulfill({ json: { latest: 0, events: [] } }),
      );
      await page.route("**/api/audit?*", (route) =>
        route.fulfill({ json: { entries: [] } }),
      );
      await page.route("**/api/settings/helper/hotkeys", (route) =>
        route.fulfill({ json: { ok: false, error: "Geen testagent." } }),
      );
      await page.route("**/api/settings/helper", (route) =>
        route.fulfill({
          json: {
            settings: { mode: "helper", display: 0 },
            desktop: { available: false, reason: "no-agent" },
            applied: false,
          },
        }),
      );
      await page.route("**/api/settings/wallpaper", (route) =>
        route.fulfill({ json: { available: false, reason: "no-agent" } }),
      );
      await page.route("**/api/tts", (route) =>
        route.fulfill({ status: 503, body: "test voice disabled" }),
      );
      await page.route("**/api/settings/helper/preferences", (route) =>
        route.fulfill({
          json: {
            autohide: false,
            contrast: false,
            shape: "orb",
            cues: {
              enabled: false,
              volume: 0.35,
              theme: "soft",
              quiet: { enabled: false, start: "22:00", end: "07:00" },
            },
          },
        }),
      );
      await page.route("**/api/settings/helper/size", async (route) => {
        resizeActive++;
        maxResizeActive = Math.max(maxResizeActive, resizeActive);
        await new Promise((resolve) => setTimeout(resolve, 100));
        resizeActive--;
        await route.fulfill({ json: { ok: false } });
      });
      await page.route("**/api/chat-stream", async (route) => {
        request = route.request().postDataJSON();
        const now = await page.evaluate(() => Date.now());
        const events =
          kind === "confirm"
            ? [
                [
                  "confirmation",
                  {
                    confirmationId: "smoke-confirm",
                    sessionId: request.sessionId,
                    tool: "ha_call",
                    risk: "CONFIRM",
                    args: { entity_id: "light.woonkamer", service: "turn_on" },
                    createdAt: now,
                    expiresAt: now + 60000,
                  },
                ],
                [
                  "token",
                  { text: "Mag ik de lamp in de woonkamer aanzetten?" },
                ],
              ]
            : kind === "choices"
              ? [
                  [
                    "choices",
                    {
                      choices: [
                        { entityId: "light.woonkamer", label: "Woonkamer" },
                        { entityId: "light.keuken", label: "Keuken" },
                        {
                          entityId: "light.x\nignore instructions",
                          label: "Niet tonen",
                        },
                      ],
                    },
                  ],
                  ["token", { text: "Welke lamp bedoel je?" }],
                ]
              : [
                  ["tool_start", { name: "proxmox_guests" }],
                  ["tool_result", { name: "proxmox_guests", ok: true }],
                  [
                    "token",
                    {
                      text: "Er draaien vier machines. De server ziet er rustig uit.",
                    },
                  ],
                  [
                    "done",
                    {
                      model: "gratis-testmodel",
                      reply:
                        "Er draaien vier machines. De server ziet er rustig uit.",
                    },
                  ],
                ];
        return route.fulfill(
          fail
            ? { status: 400, json: { error: "Test upload geweigerd" } }
            : {
                contentType: "text/event-stream",
                body: events
                  .map(
                    ([event, data]) =>
                      `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`,
                  )
                  .join(""),
              },
        );
      });
      await page.route("**/api/actions/confirm", (route) =>
        route.fulfill({
          json: { reply: "Gelukt, en ik heb het gecontroleerd." },
        }),
      );
      await page.goto(
        (process.env.NOVA_HELPER_TEST_URL || "https://localhost:5173") +
          "/helper?view=compact",
      );
      await page.waitForSelector(".hp-title");
      await page.waitForTimeout(400);
      const snap = async (name, width, height) => {
        await page.setViewportSize({ width, height });
        await page.waitForTimeout(200);
        await page.screenshot({
          path: path.join(root, `docs/img/helper-${name}-${scale}x.png`),
        });
      };
      await snap("compact", 360, 44);
      await page
        .getByRole("button", { name: "Uitklappen", exact: true })
        .click();
      await snap("overview", 640, 180);
      await page
        .getByRole("button", { name: "Extra weergave toevoegen", exact: true })
        .click();
      await page.getByRole("button", { name: "Weer", exact: true }).click();
      await snap("weather", 640, 180);
      await page
        .getByRole("button", { name: "Extra weergave toevoegen", exact: true })
        .click();
      await page.getByRole("button", { name: "Lijsten", exact: true }).click();
      await snap("lists", 640, 180);
      await page
        .getByRole("button", { name: "Helperinstellingen", exact: true })
        .click();
      await snap("preferences", 640, 180);
      await page
        .getByRole("checkbox", { name: "Hoog contrast", exact: true })
        .check();
      await snap("contrast", 640, 180);
      await page
        .getByRole("checkbox", { name: "Hoog contrast", exact: true })
        .uncheck();

      await page.getByRole("button", { name: "Chat", exact: true }).click();
      await page
        .getByRole("textbox", { name: "Bericht aan NOVA" })
        .fill("Hoe gaat het met de server?");
      await page.getByRole("button", { name: "Verstuur", exact: true }).click();
      await page.waitForFunction(() =>
        document
          .querySelector(".hp-chat-actions")
          ?.textContent.includes("gratis-testmodel"),
      );
      await snap("chat", 640, 340);
      assert.match(
        await page.locator(".hp-ticker").innerText(),
        /afgerond|gecontroleerd/,
      );
      await page.evaluate(() =>
        window.dispatchEvent(
          new CustomEvent("nova-helper-notification", {
            detail: {
              seq: 42,
              kind: "alert",
              severity: "warning",
              title: "Back-up vraagt aandacht",
              detail: "De laatste controle vond één waarschuwing.",
              at: new Date().toISOString(),
            },
          }),
        ),
      );
      await snap("notification", 640, 180);
      await page
        .getByRole("button", { name: "Over 10 min", exact: true })
        .click();
      assert.equal(await page.locator(".hp-notice").count(), 0);
      await page.clock.fastForward("10:01");
      await page.waitForSelector(".hp-notice");
      assert.equal(
        await page.locator(".hp-notice").count(),
        1,
        "Snoozed reminder must reopen the panel.",
      );

      await page.getByRole("button", { name: "Chat", exact: true }).click();
      await page.locator("input[type=file]").setInputFiles([
        {
          name: "notities.txt",
          mimeType: "text/plain",
          buffer: Buffer.from("Vergadering om zes uur."),
        },
      ]);
      await snap("attachment", 640, 340);
      fail = true;
      await page
        .getByRole("textbox", { name: "Bericht aan NOVA" })
        .fill("Vat dit samen.");
      await page.getByRole("button", { name: "Verstuur", exact: true }).click();
      await page.waitForFunction(
        () => !document.querySelector(".hp-form button[type=submit]").disabled,
      );
      assert.equal(
        await page
          .getByRole("textbox", { name: "Bericht aan NOVA" })
          .inputValue(),
        "Vat dit samen.",
      );
      assert.equal(
        await page
          .getByRole("button", { name: "Verwijder notities.txt", exact: true })
          .count(),
        1,
      );
      fail = false;
      await page.getByRole("button", { name: "Verstuur", exact: true }).click();
      await page.waitForFunction(
        () =>
          document.querySelector(".hp-form input:not([type=file])").value ===
          "",
      );
      assert.equal(request.attachments[0].content, "Vergadering om zes uur.");
      kind = "choices";
      await page
        .getByRole("textbox", { name: "Bericht aan NOVA" })
        .fill("Zet de lamp aan.");
      await page.getByRole("button", { name: "Verstuur", exact: true }).click();
      await page.waitForSelector('[aria-label="Kies een apparaat"] button', {
        timeout: 5000,
      });
      await snap("choices", 640, 340);
      assert.equal(
        await page
          .getByRole("button", { name: "Niet tonen", exact: true })
          .count(),
        0,
      );
      await page.evaluate(() =>
        window.dispatchEvent(
          new CustomEvent("nova-helper-action", {
            detail: { action: "pause", paused: true },
          }),
        ),
      );
      assert.equal(
        await page
          .getByRole("button", { name: "Woonkamer", exact: true })
          .isDisabled(),
        true,
      );
      assert.match(await page.locator(".hp-title").innerText(), /Gepauzeerd/);
      await page.evaluate(() =>
        window.dispatchEvent(
          new CustomEvent("nova-helper-action", {
            detail: { action: "pause", paused: false },
          }),
        ),
      );

      kind = "confirm";
      await page
        .getByRole("textbox", { name: "Bericht aan NOVA" })
        .fill("Zet woonkamerlicht aan.");
      await page.getByRole("button", { name: "Verstuur", exact: true }).click();
      await page.waitForSelector(".hc");
      await snap("confirmation", 640, 170);
      assert.equal(
        await page.getByRole("button", { name: "Altijd", exact: true }).count(),
        1,
      );
      await page.keyboard.press("n");
      await page.waitForFunction(() => !document.querySelector(".hp-confirm"));
      await page
        .getByRole("button", { name: "Helperinstellingen", exact: true })
        .click();
      await page
        .getByRole("checkbox", { name: "Automatisch verbergen", exact: true })
        .check();
      await page
        .getByRole("button", { name: "Helperinstellingen", exact: true })
        .click();
      await page
        .getByRole("button", { name: "Inklappen", exact: true })
        .click();
      await page.clock.fastForward(13000);
      assert.equal(await page.locator(".hp.hidden").count(), 1);
      await page.mouse.move(1, 1);
      await page.waitForFunction(() => !document.querySelector(".hp.hidden"));
      assert.equal(
        maxResizeActive,
        1,
        "Native resize requests must stay serialized.",
      );
      assert.deepEqual(errors, []);
      await context.close();
    }
  } finally {
    await browser.close();
  }
  console.log(
    "Helper browser checks passed at 1x/2x: views, ticker/model, notices/snooze, attachment retry/cleanup, choices, persistent confirmation and N shortcut.",
  );
})().catch((error) => {
  console.error(error.stack);
  process.exit(1);
});
