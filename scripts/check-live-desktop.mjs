import assert from "node:assert/strict";
import { chromium } from "playwright-core";

// Synthetic frames only: never connects to a PC or saves a real screen.
const browser = await chromium.launch({
  headless: true,
  args: ["--no-sandbox"],
});
let checkedPage;
try {
  const page = await browser.newPage();
  checkedPage = page;
  let frames = 0,
    stops = 0,
    wrongPins = 0;
  let armed = true;
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
      if (req.headers()["x-nova-pin"] !== "1234") {
        if (req.headers()["x-nova-pin"]) wrongPins++;
        return route.fulfill({
          status: 401,
          json: { error: "PIN vereist", pinRequired: true },
        });
      }
      if (path.endsWith("/frame")) {
        frames++;
        return route.fulfill({
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
        });
      }
      if (path.endsWith("/stop")) {
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
    name: "Pc bekijken · ontgrendelen",
    exact: true,
  });
  await launcher.waitFor();
  assert.equal(frames, 0, "closed viewer must not capture");
  await launcher.click();
  await page.getByLabel("Instellingen-PIN", { exact: true }).fill("wrong");
  await page.getByRole("button", { name: "Ontgrendelen", exact: true }).click();
  await page.waitForTimeout(1200);
  assert.equal(wrongPins, 1, "incorrect PIN must not be retried automatically");
  assert.equal(frames, 0);
  await page.getByLabel("Instellingen-PIN", { exact: true }).fill("1234");
  await page.getByRole("button", { name: "Ontgrendelen", exact: true }).click();
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
  await page
    .getByRole("button", { name: "Schermbeeld sluiten", exact: true })
    .click();
  const closed = frames;
  await page.waitForTimeout(1300);
  assert.equal(frames, closed, "closed viewer must stop capture");
  console.log(
    "Live desktop: PIN unlock, frame polling, monitor switch, minimize, stop and close passed (synthetic data only).",
  );
} catch (error) {
  if (checkedPage)
    console.error((await checkedPage.locator("body").innerText()).slice(-2000));
  throw error;
} finally {
  await browser.close();
}
