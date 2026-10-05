import fs from "node:fs";
import http from "node:http";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  createWidgetData,
  normalizeWidget,
  publicWidget,
  shapeData,
} from "../../src/settings/widgets/widgets.js";
import {
  ADMIN,
  createApp,
  lan,
  problem,
  type Reply,
  type TestApp,
} from "./helpers.js";

const value = (extra: Record<string, unknown> = {}) => ({
  type: "value",
  title: "Mensen in de ruimte",
  unit: "mensen",
  source: { url: "https://example.org/astros.json", extract: "number" },
  ...extra,
});

describe("panels", () => {
  it("are validated in plain Dutch", () => {
    expect(problem(() => normalizeWidget({ type: "x", title: "a" }))).toMatch(
      /soort/,
    );
    expect(problem(() => normalizeWidget({ type: "note", title: "" }))).toMatch(
      /titel/,
    );
    expect(
      problem(() => normalizeWidget({ type: "note", title: "A" })),
    ).toMatch(/tekst/);
    expect(
      problem(() => normalizeWidget(value({ source: { url: "ftp://x.nl" } }))),
    ).toMatch(/http/);
    expect(
      problem(() =>
        normalizeWidget(
          value({ source: { url: "https://a.nl", extract: "a b" } }),
        ),
      ),
    ).toMatch(/pad/);
    expect(
      problem(() =>
        normalizeWidget(value(), { takenIds: ["mensen_in_de_ruimte"] }),
      ),
    ).toMatch(/bestaat al/);
    expect(
      problem(() =>
        normalizeWidget(
          {
            type: "buttons",
            title: "B",
            buttons: [{ label: "x", action: "skill", skillId: "nee" }],
          },
          { skillIds: [] },
        ),
      ),
    ).toMatch(/vaardigheid/);
  });

  it("keep the address of a data source away from the screen", () => {
    const widget = normalizeWidget(value());
    expect("refreshMinutes" in widget && widget.refreshMinutes).toBe(15);
    expect("source" in publicWidget(widget)).toBe(false);
  });

  it("turn a response into a value or a short list, or say what is wrong", () => {
    const v = normalizeWidget(value()) as Parameters<typeof shapeData>[0];
    expect(shapeData(v, 12)).toEqual({ value: 12 });
    expect(shapeData(v, undefined).error).toMatch(/waarde/);
    const l = normalizeWidget({
      type: "list",
      title: "Koppen",
      max: 2,
      itemPath: "t",
      source: { url: "https://a.nl" },
    }) as Parameters<typeof shapeData>[0];
    expect(shapeData(l, [{ t: "een" }, { t: "twee" }, { t: "drie" }])).toEqual({
      items: ["een", "twee"],
    });
    expect(shapeData(l, { a: 1 }).error).toMatch(/lijst/);
  });

  it("are cached per panel, refreshed on time and fetched once at a time", async () => {
    let calls = 0;
    let clock = 0;
    const data = createWidgetData({
      now: () => clock,
      fetcher: async () => {
        calls++;
        await new Promise((resolve) => setTimeout(resolve, 10));
        return { value: calls };
      },
    });
    const w = normalizeWidget(value()) as Parameters<typeof shapeData>[0];
    const [a, b] = await Promise.all([data.get(w), data.get(w)]);
    expect(a.value).toBe(1);
    expect(b.value).toBe(1);
    expect(calls).toBe(1);
    clock = 14 * 60000;
    expect((await data.get(w)).value).toBe(1);
    clock = 16 * 60000;
    expect((await data.get(w)).value).toBe(2);
    const failing = createWidgetData({
      fetcher: async () => {
        throw new Error("kapot");
      },
    });
    expect((await failing.get(w)).error).toMatch(/niet worden opgehaald/);
  });
});

describe("the panels API", () => {
  let nova: TestApp;
  let source: http.Server;
  let sourcePort: number;

  beforeAll(async () => {
    source = http.createServer((_req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ number: 12, items: [{ t: "a" }, { t: "b" }] }));
    });
    await new Promise<void>((resolve) => source.listen(0, "0.0.0.0", resolve));
    sourcePort = (source.address() as { port: number }).port;
    nova = await createApp();
  });
  afterAll(async () => {
    source.closeAllConnections();
    source.close();
    await nova.app.close();
  });
  beforeEach(() => {
    fs.rmSync(nova.store["file" as never] as string, { force: true });
    nova.store.reset();
    nova.audits.length = 0;
  });

  const call = async (
    method: "get" | "post" | "put" | "delete",
    route: string,
    body?: unknown,
    headers: Record<string, string> = ADMIN,
  ): Promise<Reply> => {
    const response = await nova.api[method](`/api${route}`)
      .set(headers)
      .send(body as object | undefined);
    return {
      status: response.status,
      ...(response.body as object),
    };
  };

  it.skipIf(!lan)(
    "can be created, previewed, shown on the home screen with live data, and deleted",
    async () => {
      const src = {
        url: `http://${lan}:${sourcePort}/`,
        extract: "number",
        allowPrivate: true,
      };
      const preview = await call("post", "/settings/widgets/preview", {
        type: "value",
        source: src,
      });
      expect(preview.data.value).toBe(12);
      const created = await call("post", "/settings/widgets", {
        type: "value",
        title: "Aantal",
        unit: "x",
        source: src,
      });
      expect(created.status).toBe(201);
      expect(
        (
          await call("post", "/settings/widgets", {
            type: "value",
            title: "Aantal",
            source: src,
          })
        ).status,
      ).toBe(400);
      const pub = await call("get", "/settings/public", undefined, {});
      expect(pub.widgets[0].id).toBe("aantal");
      expect(JSON.stringify(pub)).not.toContain(String(sourcePort));
      expect(
        pub.sidebar.some((item: { id: string }) => item.id === "w:aantal"),
      ).toBe(true);
      const data = await call("get", "/widgets/data", undefined, {});
      expect(data.aantal.value).toBe(12);
      expect(data.aantal.kind).toBe("value");
      await call("put", "/settings/sidebar", {
        items: [{ id: "w:aantal", column: "left", page: 1 }],
      });
      expect(
        (await call("get", "/settings/public", undefined, {})).sidebar[0].id,
      ).toBe("w:aantal");
      expect((await call("delete", "/settings/widgets/aantal")).status).toBe(
        200,
      );
      const after = await call("get", "/settings/public", undefined, {});
      expect(
        after.sidebar.some((item: { id: string }) => item.id === "w:aantal"),
      ).toBe(false);
      const again = await call("delete", "/settings/widgets/aantal");
      expect(again.status).toBe(400);
      expect(again.error).toBe("Dit paneel bestaat niet.");
      await call("put", "/settings/sidebar", { reset: true });
      expect(
        nova.audits.some(
          (row) =>
            (row.arguments as { what?: string }).what === "widget_created",
        ),
      ).toBe(true);
    },
  );

  it("refuses a source on this machine unless it was allowed", async () => {
    const result = await call("post", "/settings/widgets/preview", {
      type: "value",
      source: { url: `http://127.0.0.1:${sourcePort}/` },
    });
    expect(result.data.error).toBeTruthy();
  });

  it("answers a button press: ask and link go back, safe skills run, risky ones are asked about", async () => {
    const url = `http://${lan}:${sourcePort}/`;
    const stored = (id: string, risk: string, method: string, extra = {}) => ({
      id,
      name: id === "ping" ? "Ping" : "Riskant",
      description: "Een dienst voor de test",
      enabled: true,
      type: "webhook",
      risk,
      parameters: [],
      examples: [],
      http: {
        method,
        url,
        headers: [],
        secretHeaders: [],
        allowPrivate: true,
        timeoutMs: 3000,
        extract: "",
        ...extra,
      },
    });
    nova.store.update((s) => {
      s.skills.push(
        stored("ping", "SAFE", "GET"),
        stored("risky", "CONFIRM", "POST", { body: "{}" }),
      );
    });
    const made = await call("post", "/settings/widgets", {
      type: "buttons",
      title: "Knoppen",
      buttons: [
        { label: "Vraag", action: "ask", prompt: "Hoe laat is het?" },
        { label: "Link", action: "link", url: "https://example.org" },
        { label: "Ping", action: "skill", skillId: "ping" },
        { label: "Risico", action: "skill", skillId: "risky" },
      ],
    });
    expect(made.status).toBe(201);
    const press = (index: number, headers?: Record<string, string>) =>
      call("post", "/widgets/knoppen/press", { index }, headers);
    expect((await press(0)).prompt).toBe("Hoe laat is het?");
    expect((await press(1)).url).toBe("https://example.org");
    expect((await press(0, {})).status).toBe(403);
    const missing = await press(9);
    expect(missing.status).toBe(404);
    expect(missing.error).toBe("Knop niet gevonden.");
    const ran = await press(2);
    expect(ran.action).toBe("ran");
    expect(ran.ok).toBe(true);
    expect(nova.audits.at(-1)?.confirmation).toBe("sidebar_button");
    const before = nova.audits.length;
    const risky = await press(3);
    expect(risky.action).toBe("ask");
    expect(risky.prompt).toMatch(/“Riskant”/);
    expect(nova.audits).toHaveLength(before);
  });
});
