import assert from "node:assert/strict";
import { chromium } from "playwright-core";

// Synthetic frames only: never connects to a PC or saves a real screen.
const browser = await chromium.launch({
  headless: true,
  args: ["--no-sandbox"],
});
let checkedPage;
try {
  const page = await browser.newPage({ ignoreHTTPSErrors: true });
  checkedPage = page;
  let frames = 0,
    stops = 0;
  let armed = false;
  let holdNextFrame = false,
    frameStarted,
    releaseFrame;
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("dialog", async (dialog) => {
    errors.push(`Unexpected dialog: ${dialog.type()}`);
    await dialog.dismiss();
  });
  await page.addInitScript(() => {
    globalThis.__desktopObjectUrls = [];
    globalThis.__desktopRevokedUrls = [];
    const create = URL.createObjectURL.bind(URL);
    const revoke = URL.revokeObjectURL.bind(URL);
    URL.createObjectURL = (value) => {
      const url = create(value);
      if (value instanceof Blob && value.type.startsWith("image/"))
        globalThis.__desktopObjectUrls.push(url);
      return url;
    };
    URL.revokeObjectURL = (url) => {
      globalThis.__desktopRevokedUrls.push(url);
      revoke(url);
    };
  });
  const displays = [
    { index: 1, width: 1920, height: 1080, primary: true },
    { index: 2, width: 1280, height: 720 },
  ];
  await page.route("**/api/**", async (route) => {
    const req = route.request(),
      url = new URL(req.url());
    const path = url.pathname;
    if (!path.startsWith("/api/")) return route.continue();
    if (path.startsWith("/api/settings/desktop")) {
      assert.equal(
        req.headers()["x-nova-pin"],
        undefined,
        "NOVA desktop requests do not need a PIN",
      );
      assert.equal(
        req.headers().authorization,
        undefined,
        "Browser must never receive the Windows agent bearer token",
      );
      if (path.endsWith("/frame")) {
        frames++;
        const held = holdNextFrame;
        if (held) {
          holdNextFrame = false;
          frameStarted();
          await new Promise((resolve) => {
            releaseFrame = resolve;
          });
        }
        return route
          .fulfill({
            json: {
              ok: true,
              capturedAt: new Date().toISOString(),
              screenshot: {
                mimeType: "image/png",
                base64:
                  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=",
                width: 960,
                height: 540,
                display: Number(url.searchParams.get("display")),
              },
            },
          })
          .catch((error) => {
            // Closing the viewer aborts an outstanding synthetic frame request.
            if (!held) throw error;
          });
      }
      if (path.endsWith("/stop")) {
        assert.equal(req.method(), "POST");
        assert.deepEqual(req.postDataJSON(), {});
        stops++;
        armed = false;
        return route.fulfill({
          json: { ok: true, wasRunning: true, agentDisarmed: true },
        });
      }
      return route.fulfill({
        json: {
          configured: true,
          settings: {
            viewEnabled: true,
            controlEnabled: true,
            cacheEnabled: false,
          },
          agent: {
            viewAvailable: true,
            controlAvailable: true,
            armed,
            displays,
          },
          session: armed
            ? {
                id: "fixture-session",
                goal: "Synthetische test",
                actions: 1,
                maxActions: 100,
                startedAt: Date.now(),
                expiresAt: Date.now() + 60000,
                lastActivityAt: Date.now(),
                observations: 1,
              }
            : null,
          disarmPending: false,
          audit: [],
        },
      });
    }
    if (path === "/api/access/status")
      return route.fulfill({ json: { required: false, unlocked: true } });
    if (path === "/api/alerts")
      return route.fulfill({ json: { latest: 0, events: [] } });
    if (path === "/api/overview")
      return route.fulfill({
        json: { timers: [], lists: {}, home: null, proxmox: null },
      });
    if (path.endsWith("/helper/preferences"))
      return route.fulfill({
        json: {
          shape: "orb",
          cues: {},
          wardrobe: { theme: "nova", seasonal: false, birthday: "" },
        },
      });
    return route.fulfill({ json: {} });
  });
  await page.goto(
    process.env.NOVA_LIVE_DESKTOP_TEST_URL || "http://127.0.0.1:5189",
  );
  const launcher = page.getByRole("button", {
    name: "Pc bekijken",
    exact: true,
  });
  await launcher.waitFor();
  assert.equal(frames, 0, "closed viewer must not capture");
  armed = true;
  await launcher.click();
  assert.equal(
    await page.getByLabel("Instellingen-PIN", { exact: true }).count(),
    0,
  );
  await page
    .getByAltText("Actueel beeld van het geselecteerde pc-scherm")
    .waitFor();
  await Promise.all([
    page.waitForResponse((r) =>
      r.url().includes("/settings/desktop/frame?display=2"),
    ),
    page.getByLabel("Beeldscherm", { exact: true }).selectOption("2"),
  ]);
  await page
    .getByRole("button", { name: "Schermbeeld minimaliseren", exact: true })
    .click();
  await page.waitForTimeout(100);
  const minimized = frames;
  await page.waitForTimeout(1300);
  assert.equal(frames, minimized, "minimized viewer must stop capture");
  assert.equal(
    await page
      .getByAltText("Actueel beeld van het geselecteerde pc-scherm")
      .count(),
    0,
  );
  await page
    .getByRole("button", { name: "Schermbeeld uitklappen", exact: true })
    .click();
  await page
    .getByAltText("Actueel beeld van het geselecteerde pc-scherm")
    .waitFor();
  await Promise.all([
    page.waitForResponse((r) => r.url().endsWith("/settings/desktop/stop")),
    page.getByRole("button", { name: "Stop overname", exact: true }).click(),
  ]);
  assert.equal(stops, 1);
  // Hold the next capture response, then close during that request. A late
  // frame must not recreate an image or restart polling after cancellation.
  const inFlight = new Promise((resolve) => {
    frameStarted = resolve;
  });
  holdNextFrame = true;
  let frameTimeout;
  try {
    await Promise.race([
      inFlight,
      new Promise((_, reject) => {
        frameTimeout = setTimeout(
          () =>
            reject(
              new Error("Viewer did not request a frame for cancellation test"),
            ),
          15000,
        );
      }),
    ]);
  } finally {
    clearTimeout(frameTimeout);
  }
  const createdBeforeClose = await page.evaluate(
    () => globalThis.__desktopObjectUrls.length,
  );
  await page
    .getByRole("button", { name: "Schermbeeld sluiten", exact: true })
    .click();
  const closed = frames;
  releaseFrame();
  await page.waitForTimeout(1300);
  assert.equal(
    await page.evaluate(() => globalThis.__desktopObjectUrls.length),
    createdBeforeClose,
    "Late cancelled frame must not create an object URL",
  );
  assert.equal(
    await page
      .getByAltText("Actueel beeld van het geselecteerde pc-scherm")
      .count(),
    0,
  );
  assert.equal(frames, closed, "closed viewer must stop capture");
  const privacy = await page.evaluate(() => ({
    created: globalThis.__desktopObjectUrls,
    revoked: globalThis.__desktopRevokedUrls,
    stored:
      Object.values(localStorage).join(" ") +
      Object.values(sessionStorage).join(" "),
  }));
  assert.ok(privacy.created.length > 0);
  assert.ok(
    privacy.created.every((url) => privacy.revoked.includes(url)),
    "Closing must revoke every screen object URL",
  );
  assert.equal(
    privacy.stored.includes("iVBORw0KGgo"),
    false,
    "Screen data must never enter browser storage",
  );
  assert.deepEqual(errors, []);
  console.log(
    "Live desktop: direct open without PIN, frame polling, monitor switch, minimize, stop, in-flight cancellation and frame privacy passed (synthetic data only).",
  );
} catch (error) {
  if (checkedPage)
    console.error((await checkedPage.locator("body").innerText()).slice(-2000));
  throw error;
} finally {
  await browser.close();
}
