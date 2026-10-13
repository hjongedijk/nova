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
      await page.addInitScript(() => {
        if (!localStorage.getItem("jarvisWake"))
          localStorage.setItem("jarvisWake", "off");
        window.__testMicRequests = [];
        window.__testMicStopped = 0;
        window.__testRecognitionTrack = null;
        window.SpeechRecognition = class {
          onstart = null;
          onend = null;
          onerror = null;
          onresult = null;
          constructor() {
            window.__testRecognition = this;
          }
          start(track) {
            window.__testRecognitionTrack = track?.id ?? "default";
            this.onstart?.();
          }
          abort() {
            this.onend?.();
          }
          stop() {
            this.onend?.();
          }
        };
        Object.defineProperty(navigator, "mediaDevices", {
          configurable: true,
          value: Object.assign(new EventTarget(), {
            enumerateDevices: async () =>
              [
                {
                  kind: "audioinput",
                  deviceId: "microphone-one",
                  label: "Test microphone",
                },
                {
                  kind: "audiooutput",
                  deviceId: "speaker-one",
                  label: "Test speaker",
                },
              ].filter(
                (device) =>
                  device.kind !== "audioinput" ||
                  window.__testInputAvailable !== false,
              ),
            getUserMedia: async (constraints) => {
              window.__testMicRequests.push(constraints);
              const track = {
                id: "selected-mic-track",
                kind: "audio",
                readyState: "live",
                stop() {
                  this.readyState = "ended";
                  window.__testMicStopped++;
                },
              };
              window.__testInputTrack = track;
              return {
                getTracks: () => [track],
                getAudioTracks: () => [track],
              };
            },
          }),
        });
        Object.defineProperty(globalThis.AudioContext.prototype, "setSinkId", {
          configurable: true,
          value: async function (id) {
            window.__testSinkId = id;
          },
        });
      });
      let kind = "answer",
        fail = false,
        request,
        savedNotificationModes;
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
            calendarStatus: "ready",
            nextAppointment: {
              summary: "Tandarts",
              start: "2026-10-13T09:00:00+02:00",
              end: "2026-10-13T09:30:00+02:00",
              allDay: false,
              timeZone: "Europe/Amsterdam",
            },
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
      await page.route("**/api/settings/helper/preferences", (route) => {
        if (route.request().method() === "PUT") {
          savedNotificationModes = route.request().postDataJSON().notifications;
          return route.fulfill({ json: { ok: true } });
        }
        return route.fulfill({
          json: {
            autohide: false,
            contrast: false,
            shape: "orb",
            notifications: {
              info: "helper",
              warning: "speak",
              critical: "speak",
              timer: "speak",
            },
            cues: {
              enabled: false,
              volume: 0.35,
              theme: "soft",
              quiet: { enabled: false, start: "22:00", end: "07:00" },
            },
          },
        });
      });
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
          kind === "confirm" || kind === "settings-confirm"
            ? [
                [
                  "confirmation",
                  {
                    confirmationId: `smoke-${kind}`,
                    sessionId: request.sessionId,
                    tool:
                      kind === "settings-confirm"
                        ? "settings_persona_set"
                        : "ha_call",
                    ...(kind === "settings-confirm"
                      ? { allowAlways: false }
                      : {}),
                    risk: "CONFIRM",
                    args:
                      kind === "settings-confirm"
                        ? { text: "Spreek rustig en bondig." }
                        : { entity_id: "light.woonkamer", service: "turn_on" },
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
                  ["mood", { mood: "thoughtful" }],
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
                      mood: "thoughtful",
                    },
                  ],
                ];
        // All successfully completed production streams end with done, including
        // choices and confirmation requests. EOF alone is now an interruption.
        if (!events.some(([event]) => event === "done")) {
          const token = events.findLast(([event]) => event === "token");
          events.push([
            "done",
            { reply: token?.[1].text ?? "", model: "gratis-testmodel" },
          ]);
        }
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
      const speakingMeter = page.getByLabel("Stemvolume tijdens spreken");
      assert.equal(await speakingMeter.count(), 1);
      assert.equal(await speakingMeter.getAttribute("min"), "0");
      assert.equal(await speakingMeter.getAttribute("max"), "1");
      const helperBackgrounds = () =>
        page.evaluate(() => {
          const colors = [
            window.getComputedStyle(document.documentElement).backgroundColor,
            window.getComputedStyle(document.body).backgroundColor,
            window.getComputedStyle(document.querySelector(".hp"))
              .backgroundColor,
          ];
          return colors;
        });
      const normalBackgrounds = await helperBackgrounds();
      assert.equal(new Set(normalBackgrounds).size, 1);
      assert.notEqual(normalBackgrounds[0], "rgba(0, 0, 0, 0)");
      await page.waitForTimeout(400);
      const snap = async (name, width, height) => {
        await page.setViewportSize({ width, height });
        await page.waitForTimeout(200);
        const bounds = await page.locator(".hp").evaluate((panel) => {
          return {
            panelWidth: panel.offsetWidth,
            panelHeight: panel.offsetHeight,
            width: window.innerWidth,
            height: window.innerHeight,
          };
        });
        assert.ok(
          Math.abs(bounds.panelWidth - bounds.width) <= 1 &&
            Math.abs(bounds.panelHeight - bounds.height) <= 1,
          `helper size differs from viewport: ${JSON.stringify(bounds)}`,
        );
        await page.screenshot({
          path: path.join(
            process.env.NOVA_HELPER_SCREENSHOT_DIR ||
              path.join(root, "docs/img"),
            `helper-${name}-${scale}x.png`,
          ),
        });
      };
      await page.setViewportSize({ width: 1280, height: 900 });
      const dimensions = () =>
        page.locator(".hp").evaluate((panel) => ({
          width: panel.offsetWidth,
          height: panel.offsetHeight,
        }));
      const assertFullscreen = async () => {
        await page
          .getByRole("button", { name: "Volledig scherm", exact: true })
          .click();
        await page.waitForFunction(() => !!document.fullscreenElement);
        assert.deepEqual(
          await dimensions(),
          await page.evaluate(() => ({
            width: window.innerWidth,
            height: window.innerHeight,
          })),
        );
        await page.clock.fastForward(13000);
        assert.equal(
          await page.locator(".hp.expanded").count(),
          1,
          "Fullscreen must survive the idle-collapse timer",
        );
        await page
          .getByRole("button", {
            name: "Volledig scherm verlaten",
            exact: true,
          })
          .click();
        await page.waitForFunction(() => !document.fullscreenElement);
      };
      assert.deepEqual(await dimensions(), { width: 360, height: 44 });
      await page
        .getByRole("button", { name: "Uitklappen", exact: true })
        .click();
      assert.deepEqual(await dimensions(), { width: 640, height: 180 });
      assert.equal(await page.evaluate(() => document.fullscreenElement), null);
      await page
        .getByRole("button", { name: "Volledig scherm", exact: true })
        .click();
      await page.waitForFunction(() => !!document.fullscreenElement);
      assert.deepEqual(
        await dimensions(),
        await page.evaluate(() => ({
          width: window.innerWidth,
          height: window.innerHeight,
        })),
      );
      await page
        .getByRole("button", { name: "Volledig scherm verlaten", exact: true })
        .click();
      await page.waitForFunction(() => !document.fullscreenElement);
      assert.deepEqual(await dimensions(), { width: 640, height: 180 });
      await page
        .getByRole("button", { name: "Helper verbergen", exact: true })
        .click();
      assert.deepEqual(await dimensions(), { width: 360, height: 3 });
      await page.locator(".hp").dispatchEvent("pointermove");
      assert.deepEqual(await dimensions(), { width: 360, height: 44 });
      await page.setViewportSize({ width: 280, height: 44 });
      assert.deepEqual(await dimensions(), { width: 280, height: 44 });
      await snap("compact", 360, 44);
      await page
        .getByRole("button", { name: "Uitklappen", exact: true })
        .click();
      await page.setViewportSize({ width: 640, height: 180 });
      await page.getByRole("button", { name: /Timers 0 actief/ }).click();
      await page.getByText("Geen actieve timers.").waitFor();
      await page.getByRole("button", { name: /Timers 0 actief/ }).click();
      await page.getByRole("button", { name: /^Agenda / }).click();
      await page.getByText(/Tandarts/).waitFor();
      await page.getByRole("button", { name: /^Agenda / }).click();
      assert.equal(
        await page.locator(".hp-overview-orb canvas").count(),
        1,
        "overview must show the orb beside its status cards",
      );
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
      await page.getByLabel("Waarschuwing").selectOption("helper");
      await page.getByLabel("Kritiek").selectOption("screen");
      const preferencesSaved = page.waitForResponse(
        (response) =>
          response.request().method() === "PUT" &&
          response.url().includes("/api/settings/helper/preferences"),
      );
      await page
        .getByRole("button", { name: "Instellingen opslaan", exact: true })
        .click();
      await preferencesSaved;
      assert.deepEqual(savedNotificationModes, {
        info: "helper",
        briefing: "speak",
        warning: "helper",
        critical: "screen",
        timer: "speak",
      });
      await page
        .getByRole("checkbox", { name: "Hoog contrast", exact: true })
        .check();
      await page.waitForFunction(() => {
        const html = window.getComputedStyle(
          document.documentElement,
        ).backgroundColor;
        const body = window.getComputedStyle(document.body).backgroundColor;
        const panel = window.getComputedStyle(
          document.querySelector(".hp"),
        ).backgroundColor;
        return html === body && body === panel;
      });
      assert.equal(new Set(await helperBackgrounds()).size, 1);
      await snap("contrast", 640, 180);
      await page
        .getByRole("checkbox", { name: "Hoog contrast", exact: true })
        .uncheck();
      await page.getByText("Microfoon en stem", { exact: true }).click();
      await page.getByLabel("Uitvoerapparaat").selectOption("speaker-one");
      await page.waitForFunction(
        () => localStorage.getItem("novaAudioOutput") === "speaker-one",
      );
      assert.equal(
        await page.evaluate(() => window.__testSinkId),
        "speaker-one",
      );
      await page
        .getByRole("button", { name: "Microfoons zoeken", exact: true })
        .click();
      await page.waitForFunction(() => window.__testMicStopped === 1);
      await page.getByLabel("Invoerapparaat").selectOption("microphone-one");
      await page.waitForFunction(
        () => localStorage.getItem("novaAudioInput") === "microphone-one",
      );
      assert.deepEqual(await page.evaluate(() => window.__testMicRequests[0]), {
        audio: true,
      });
      await page.evaluate(() => {
        window.__testInputAvailable = false;
      });
      await page
        .getByRole("button", { name: "Microfoons zoeken", exact: true })
        .click();
      await page.waitForFunction(() => window.__testMicRequests.length === 2);
      assert.equal(
        await page.evaluate(() => localStorage.getItem("novaAudioInput")),
        "microphone-one",
      );
      assert.equal(
        await page.getByLabel("Invoerapparaat").inputValue(),
        "microphone-one",
      );
      await page.evaluate(() => {
        window.__testInputAvailable = true;
        navigator.mediaDevices.dispatchEvent(new Event("devicechange"));
      });
      await page.waitForFunction(
        () =>
          document.querySelector('select option[value="microphone-one"]')
            .textContent === "Test microphone",
      );
      assert.equal(
        await page.evaluate(() => window.__testMicRequests.length),
        2,
      );
      await page.getByRole("button", { name: "Spreek met NOVA" }).click();
      await page.waitForFunction(
        () => window.__testRecognitionTrack === "selected-mic-track",
      );
      assert.deepEqual(
        await page.evaluate(() => window.__testMicRequests.at(-1)),
        { audio: { deviceId: { exact: "microphone-one" } } },
      );
      await page.evaluate(() => window.__testRecognition.abort());
      await page.waitForFunction(() => window.__testMicStopped === 3);
      await page.evaluate(() => localStorage.setItem("jarvisWake", "on"));
      await page.reload();
      await page.waitForFunction(
        () => window.__testRecognitionTrack === "selected-mic-track",
      );
      assert.deepEqual(await page.evaluate(() => window.__testMicRequests[0]), {
        audio: { deviceId: { exact: "microphone-one" } },
      });
      await page.evaluate(() =>
        window.dispatchEvent(
          new CustomEvent("nova-helper-action", {
            detail: { action: "pause", paused: true },
          }),
        ),
      );
      await page.reload();
      await page.waitForSelector(".hp-title");
      await page
        .getByRole("button", { name: "Helperinstellingen", exact: true })
        .click();
      await page.getByText("Microfoon en stem", { exact: true }).click();
      await page.waitForFunction(() => window.__testSinkId === "speaker-one");
      assert.equal(
        await page.getByLabel("Uitvoerapparaat").inputValue(),
        "speaker-one",
      );
      await page.evaluate(() =>
        localStorage.setItem("novaAudioOutput", "missing-device"),
      );
      await page.reload();
      await page.waitForSelector(".hp-title");
      await page
        .getByRole("button", { name: "Helperinstellingen", exact: true })
        .click();
      await page.getByText("Microfoon en stem", { exact: true }).click();
      await page.waitForFunction(
        () => localStorage.getItem("novaAudioOutput") === "",
      );
      assert.equal(await page.getByLabel("Uitvoerapparaat").inputValue(), "");

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
      await page.getByText("Nadenkend", { exact: true }).waitFor();
      assert.equal(
        (await page.locator("body").innerText()).includes("NOVA_MOOD"),
        false,
      );
      await snap("chat", 640, 340);
      await assertFullscreen();
      assert.match(
        await page.locator(".hp-ticker").innerText(),
        /afgerond|gecontroleerd/,
      );
      await page.evaluate(() =>
        window.dispatchEvent(
          new CustomEvent("nova-helper-notification", {
            detail: {
              seq: 41,
              kind: "alert",
              severity: "warning",
              title: "Alleen op scherm",
              detail: "Geen helperpop-up.",
              deliveryMode: "screen",
              speakAllowed: false,
              at: new Date().toISOString(),
            },
          }),
        ),
      );
      assert.equal(
        await page
          .getByRole("button", { name: "Chat", exact: true })
          .getAttribute("aria-current"),
        "page",
        "Screen-only alerts must not open the helper notification view.",
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
        .first()
        .click();
      assert.equal(await page.locator(".hp-notice").count(), 1);
      await page.reload();
      await page.waitForSelector(".hp-title");
      assert.equal(await page.locator(".hp-notice").count(), 0);
      await page.clock.fastForward("10:01");
      await page.waitForSelector(".hp-notice");
      assert.equal(
        await page.locator(".hp-notice").count(),
        1,
        "Snoozed reminder must reopen after helper reload.",
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
      await assertFullscreen();
      assert.equal(
        await page.getByRole("button", { name: "Altijd", exact: true }).count(),
        1,
      );
      await page.keyboard.press("n");
      await page.waitForFunction(() => !document.querySelector(".hp-confirm"));
      kind = "settings-confirm";
      await page
        .getByRole("textbox", { name: "Bericht aan NOVA" })
        .fill("Pas mijn persoonlijke regels aan.");
      await page.getByRole("button", { name: "Verstuur", exact: true }).click();
      await page.waitForSelector(".hc:not(.done)");
      assert.match(
        await page.locator(".hc:not(.done)").innerText(),
        /Spreek rustig en bondig/,
      );
      assert.equal(
        await page.getByRole("button", { name: "Altijd", exact: true }).count(),
        0,
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
      assert.equal(
        await page.locator(".hp.hidden").count(),
        1,
        JSON.stringify(
          await page.evaluate(() => ({
            className: document.querySelector(".hp").className,
            active: document.activeElement?.outerHTML,
            draft: document.querySelector(".hp-form input:not([type=file])")
              ?.value,
            footer: document.querySelector(".hp-ticker")?.textContent,
          })),
        ),
      );
      await page.locator(".hp").hover();
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
    "Helper browser checks passed at 1x/2x: compact/fullscreen/hide/responsive sizing, views, speech meter, persisted input/output selection, temporary missing microphone/reconnect, chosen track for tap-to-talk and wake, stream cleanup, ticker/model, notices/snooze, attachment retry/cleanup, choices, confirmations and N shortcut.",
  );
})().catch((error) => {
  console.error(error.stack);
  process.exit(1);
});
