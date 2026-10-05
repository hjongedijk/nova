import { afterAll, beforeAll, describe, expect, it } from "vitest";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { BrowserAgentService } from "../../src/integrations/browser-agent/browser-agent.service.js";
import { call, fakeConfig, listen } from "./helpers.js";

const TOKEN = "geheim-token-1234567";
let reply: () => { status: number; body: unknown } = () => ({
  status: 200,
  body: { ok: true },
});
let fake: Awaited<ReturnType<typeof listen>>;
let browser: BrowserAgentService;
const make = (url: string, token = TOKEN) =>
  new BrowserAgentService(fakeConfig({ windowsAgent: { url, token } }));

beforeAll(async () => {
  fake = await listen((_seen, send) => {
    const { status, body } = reply();
    send(status, body);
  });
  browser = make(fake.url);
});
afterAll(() => fake.close());

describe("BrowserAgentService", () => {
  it("the tools are listed, valid and risk-ranked: only the buying click needs confirmation", () => {
    const defs = browser.definitions();
    const names = defs.map((item) => item.name);
    expect(new Set(names).size).toBe(names.length);
    expect(names.every((name) => name.startsWith("browser_"))).toBe(true);
    const risk = Object.fromEntries(defs.map((item) => [item.name, item.risk]));
    expect(risk.browser_click_confirmed).toBe("CONFIRM");
    expect(risk.browser_click).toBe("SAFE");
    expect(risk.browser_read).toBe("READ_ONLY");
    expect(risk.browser_status).toBe("READ_ONLY");
    for (const item of defs)
      for (const key of item.parameters.required ?? [])
        expect(key in item.parameters.properties, `${item.name}.${key}`).toBe(
          true,
        );
  });

  it("without a configured agent the tools exist but are switched off", () => {
    const unset = make("", "");
    expect(unset.configured).toBe(false);
    const all = unset.definitions();
    expect(all.length).toBeGreaterThanOrEqual(10);
    for (const item of all) expect(item.enabled, item.name).toBe(false);
    expect(browser.definitions().every((item) => item.enabled)).toBe(true);
  });

  it("each tool reaches the right Windows agent browser endpoint with the token", async () => {
    const cases: [string, Record<string, unknown>, string, string, unknown][] =
      [
        ["browser_status", {}, "GET", "/v1/browser/status", null],
        [
          "browser_search",
          { query: "auto", engine: "youtube" },
          "POST",
          "/v1/browser/search",
          { query: "auto", engine: "youtube" },
        ],
        [
          "browser_open",
          { url: "https://nl.wikipedia.org" },
          "POST",
          "/v1/browser/open",
          { url: "https://nl.wikipedia.org" },
        ],
        ["browser_read", {}, "POST", "/v1/browser/read", {}],
        ["browser_click", { id: 4 }, "POST", "/v1/browser/click", { id: 4 }],
        [
          "browser_type",
          { id: 2, text: "hallo", submit: true },
          "POST",
          "/v1/browser/type",
          { id: 2, text: "hallo", submit: true },
        ],
        [
          "browser_press",
          { key: "Enter" },
          "POST",
          "/v1/browser/press",
          { key: "Enter" },
        ],
        [
          "browser_scroll",
          { direction: "down" },
          "POST",
          "/v1/browser/scroll",
          { direction: "down" },
        ],
        ["browser_back", {}, "POST", "/v1/browser/back", {}],
        [
          "browser_tab",
          { action: "list" },
          "POST",
          "/v1/browser/tab",
          { action: "list" },
        ],
      ];
    for (const [name, args, method, path, body] of cases) {
      fake.requests.length = 0;
      reply = () => ({ status: 200, body: { ok: true, title: "T" } });
      const out = await browser.execute(name, args, call());
      expect(out.ok, name).toBe(true);
      expect(out.result, name).toEqual({ title: "T" });
      const seen = fake.requests[0]!;
      expect(seen.method, name).toBe(method);
      expect(seen.url, name).toBe(path);
      expect(seen.headers.authorization, name).toBe(`Bearer ${TOKEN}`);
      expect(seen.body ? JSON.parse(seen.body) : null, name).toEqual(body);
    }
  });

  it("the confirmed click is the only way to set the confirmed flag", async () => {
    reply = () => ({ status: 200, body: { ok: true } });
    fake.requests.length = 0;
    await browser.execute("browser_click_confirmed", { id: 7 }, call());
    expect(JSON.parse(fake.requests[0]!.body)).toEqual({
      id: 7,
      confirmed: true,
    });
    const click = browser
      .definitions()
      .find((item) => item.name === "browser_click")!;
    expect("confirmed" in click.parameters.properties).toBe(false);
  });

  it("a refused risky click comes back flagged, with the agent's explanation", async () => {
    reply = () => ({
      status: 200,
      body: {
        ok: false,
        risky: true,
        label: "Koop nu",
        error: "“Koop nu” lijkt een aankoop.",
      },
    });
    const out = await browser.execute("browser_click", { id: 3 }, call());
    expect(out.ok).toBe(false);
    expect(out.risky).toBe(true);
    expect(out.error).toMatch(/aankoop/);
  });

  it("failures are said in plain Dutch: offline PC, wrong token, agent error", async () => {
    const gone = await make("http://127.0.0.1:1").execute(
      "browser_status",
      {},
      call(),
    );
    expect(gone.ok).toBe(false);
    expect(gone.error).toMatch(/niet bereikbaar.*pc/i);
    reply = () => ({
      status: 401,
      body: { ok: false, error: "Ongeldig token." },
    });
    expect((await browser.execute("browser_read", {}, call())).error).toMatch(
      /token/i,
    );
    reply = () => ({
      status: 400,
      body: { ok: false, error: "Dat element bestaat niet meer." },
    });
    expect(
      (await browser.execute("browser_click", { id: 1 }, call())).error,
    ).toBe("Dat element bestaat niet meer.");
    reply = () => ({ status: 502, body: null });
    expect((await browser.execute("browser_read", {}, call())).error).toMatch(
      /Browser-agent fout \(502\)/,
    );
    expect((await browser.execute("browser_nope", {}, call())).ok).toBe(false);
  });

  it("an old Windows agent without the browser is told to update", async () => {
    reply = () => ({
      status: 404,
      body: { ok: false, error: "Not found" },
    });
    const out = await browser.execute("browser_read", {}, call());
    expect(out.ok).toBe(false);
    expect(out.error).toMatch(/jarvis-agent\.ps1/);
  });

  it("a timeout is reported as the browser not answering", async () => {
    const slow = http.createServer(() => {});
    await new Promise<void>((resolve) => slow.listen(0, "127.0.0.1", resolve));
    const patient = make(
      `http://127.0.0.1:${(slow.address() as AddressInfo).port}`,
    );
    const out = await patient.execute(
      "browser_read",
      {},
      call(AbortSignal.timeout(150)),
    );
    slow.closeAllConnections();
    slow.close();
    expect(out.ok).toBe(false);
    expect(out.error).toMatch(/niet op tijd/);
  });
});
