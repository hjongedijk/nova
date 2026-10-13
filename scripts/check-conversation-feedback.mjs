import assert from "node:assert/strict";
import { chromium } from "playwright-core";

const base = process.env.NOVA_SETTINGS_TEST_URL ?? "https://localhost:5173";
const browser = await chromium.launch({
  headless: true,
  args: ["--no-sandbox"],
});
try {
  const page = await browser.newPage({
    ignoreHTTPSErrors: true,
    viewport: { width: 1440, height: 900 },
  });
  page.on("pageerror", (error) =>
    console.error("Dashboard page error:", error),
  );
  page.on("console", (message) => {
    if (message.type() === "error")
      console.error("Dashboard console error:", message.text());
  });
  await page.addInitScript(() => localStorage.setItem("novaWake", "off"));
  const requests = [];
  await page.route("**/api/**", async (route) => {
    const pathname = new URL(route.request().url()).pathname;
    if (!pathname.startsWith("/api/")) return route.continue();
    const json = (body) => route.fulfill({ json: body });
    if (pathname === "/api/health")
      return json({
        ok: true,
        nodeRed: true,
        mqtt: true,
        tts: true,
        memory: { persistent: true, sessions: 4 },
        omnirouteConfigured: true,
        routing: { ready: true },
        tools: { available: 98 },
        services: {
          api: { online: true },
          mqtt: { online: true },
          tts: { online: true },
          omniroute: { online: true },
          proxmox: { online: true },
          nodeRed: { online: true, flowCount: 4 },
        },
        state: { proxmox: { online: true } },
      });
    if (pathname === "/api/system")
      return json({
        at: "2026-10-11T08:00:00.000Z",
        cpu: 26,
        cores: 8,
        load: [1.2, 1.1, 0.9],
        memory: { total: 16_000_000_000, used: 6_700_000_000 },
        disk: { total: 900_000_000_000, used: 410_000_000_000 },
        uptime: 86400,
        network: { rxPerSec: 1024, txPerSec: 2048 },
        history: {
          cpu: Array(40).fill(26),
          memory: Array(40).fill(42),
          rx: Array(40).fill(1024),
          tx: Array(40).fill(2048),
        },
      });
    if (pathname === "/api/overview")
      return json({
        at: "2026-10-11T08:00:00.000Z",
        proxmox: {
          guests: [
            {
              vmid: 101,
              name: "media-server",
              type: "qemu",
              status: "running",
              cpu: 18,
              memoryUsed: 5_200_000_000,
              memoryTotal: 8_000_000_000,
              uptime: 86400,
            },
            {
              vmid: 102,
              name: "backup",
              type: "qemu",
              status: "running",
              cpu: 5,
              memoryUsed: 2_000_000_000,
              memoryTotal: 4_000_000_000,
              uptime: 86400,
            },
            {
              vmid: 103,
              name: "web-proxy",
              type: "lxc",
              status: "running",
              cpu: 1,
              memoryUsed: 900_000_000,
              memoryTotal: 2_000_000_000,
              uptime: 86400,
            },
            {
              vmid: 104,
              name: "test-vm",
              type: "qemu",
              status: "stopped",
              cpu: 0,
              memoryUsed: 0,
              memoryTotal: 2_000_000_000,
              uptime: 0,
            },
          ],
          storage: [
            {
              name: "local-zfs",
              type: "zfs",
              used: 410_000_000_000,
              total: 900_000_000_000,
            },
          ],
        },
        weather: null,
        sun: null,
        news: null,
        timers: [
          {
            id: "watering-plants",
            label: "Boodschappen",
            fireAt: "2026-10-11T08:06:00.000Z",
            remainingSeconds: 360,
          },
        ],
        lists: { Pasta: ["Boodschappen"] },
        alerts: [],
        home: null,
        air: null,
        markets: null,
        iss: null,
        moon: { phase: "waxing", illumination: 42 },
      });
    if (pathname === "/api/settings/public")
      return json({
        publicUrl: "",
        sidebar: [
          { id: "systeem", column: "left", page: 1, shown: true },
          { id: "vms", column: "left", page: 1, shown: true },
          { id: "opslag", column: "left", page: 1, shown: true },
          { id: "nu", column: "right", page: 1, shown: true },
          { id: "server", column: "right", page: 1, shown: true },
          { id: "planning", column: "right", page: 1, shown: true },
        ],
        widgets: [],
        maxPages: { left: 3, right: 3 },
        quickActions: [],
        skillExamples: [],
      });
    if (pathname === "/api/alerts") return json({ latest: 0, events: [] });
    if (pathname === "/api/audit") return json({ entries: [] });
    return json({});
  });
  await page.route("**/api/chat-stream", async (route) => {
    requests.push(route.request().postDataJSON());
    await route.fulfill({
      contentType: "text/event-stream",
      body: [
        ["connected", { ok: true }],
        ["mood", { mood: "happy" }],
        ["token", { text: "Dank je, ik houd daar rekening mee." }],
        [
          "done",
          {
            model: "browser-fixture",
            role: "conversation",
            reply: "Dank je, ik houd daar rekening mee.",
            mood: "happy",
          },
        ],
      ]
        .map(
          ([event, data]) =>
            `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`,
        )
        .join(""),
    });
  });
  await page.goto(base, { waitUntil: "domcontentloaded" });
  await page
    .locator("#input")
    .waitFor()
    .catch(async (error) => {
      console.error(
        "Dashboard did not render:",
        await page.locator("body").innerText(),
      );
      throw error;
    });
  if (!(await page.locator("#input").isVisible()))
    await page.locator("#reveal").click();
  await page.locator("#input").fill("Hallo");
  await page.locator("#sendButton").click();
  await page.getByText("Dank je, ik houd daar rekening mee.").first().waitFor();
  await page.getByText("Blij", { exact: true }).waitFor();
  await page.waitForTimeout(700);
  await page.screenshot({ path: "docs/img/main.png" });

  await page.locator("#menuButton").click();
  await page.locator("#historyOpen").click();
  await page
    .getByRole("button", { name: "Dit antwoord was niet goed" })
    .last()
    .click();
  await page.getByRole("button", { name: "Kortere antwoorden" }).last().click();
  assert.deepEqual(
    await page.evaluate(() =>
      JSON.parse(
        localStorage.getItem("nova-communication-preferences-v1") ?? "[]",
      ),
    ),
    ["concise"],
  );
  await page.getByRole("button", { name: "Overdracht", exact: true }).click();
  await page.locator("#handoffQuestion").fill("Een vervolgvraag");
  await page.locator("#handoffFiles").fill("apps/web/src/routes/+page.svelte");
  await page.locator("#handoffNextStep").fill("Controleer de chatweergave");
  await page.getByRole("button", { name: "Lokaal bewaren" }).click();
  assert.equal(
    await page.evaluate(
      () =>
        JSON.parse(localStorage.getItem("nova-handoff-v1") ?? "null")?.nextStep,
    ),
    "Controleer de chatweergave",
  );
  await page.locator("#historyClose").click();
  await page.reload();
  await page.locator("#menuButton").click();
  await page.locator("#historyOpen").click();
  await page.getByRole("button", { name: "Verder hiermee" }).waitFor();
  await page.getByRole("button", { name: "Wissen" }).click();
  assert.equal(
    await page.evaluate(() => localStorage.getItem("nova-handoff-v1")),
    null,
  );
  await page.locator("#historyClose").click();

  if (!(await page.locator("#input").isVisible()))
    await page.locator("#reveal").click();
  await page.locator("#input").fill("Nog een vraag");
  await page.locator("#sendButton").click();
  await page.waitForFunction(
    () => globalThis.document.querySelector("#input")?.value === "",
  );
  assert.deepEqual(requests[1]?.communicationPreferences, ["concise"]);
  await page.locator("#menuButton").click();
  await page.locator("#historyOpen").click();
  await page.getByRole("button", { name: "Overdracht", exact: true }).click();
  await page.locator("#handoffQuestion").fill("Nog een vraag");
  await page.locator("#handoffNextStep").fill("Ga verder met de tests");
  await page.getByRole("button", { name: "Lokaal bewaren" }).click();
  const handoffRequest = page.waitForRequest(
    (request) =>
      request.url().endsWith("/api/chat-stream") &&
      request.postDataJSON()?.message?.includes("Ga verder met de tests"),
  );
  await page.getByRole("button", { name: "Verder hiermee" }).click();
  await handoffRequest;
  assert.match(requests[2]?.message ?? "", /Ga verder met de tests/);
  console.log("Conversation feedback and local handoff browser checks passed.");
} finally {
  await browser.close();
}
