import type { NovaTerminalEvent } from "@nova/contracts";
import { afterEach, describe, expect, it, vi } from "vitest";
import { toolResultPreview } from "../../src/chat/tool-preview.js";
import { frameableFrom } from "../../src/live/live.controller.js";
import {
  BandwidthBudget,
  encodeFrame,
  FrameGate,
  LIVE_LIMITS,
} from "../../src/live/frame-gate.js";
import {
  LiveStreamsService,
  type LiveFrame,
} from "../../src/live/live-streams.service.js";
import {
  liveUpgradeAllowed,
  parseClientMessage,
} from "../../src/live/live.socket.js";
import { frameMeta, MjpegParser } from "../../src/live/mjpeg.js";
import {
  cleanTerminal,
  TerminalRelay,
  TERMINAL_LIMITS,
} from "../../src/live/terminal-relay.js";
import {
  resultWindowFor,
  safeHttpUrl,
  videoSource,
} from "../../src/live/window-media.js";
import { WindowSource } from "../../src/live/window.source.js";
import { rankToolsForRequest } from "../../src/tools/tool-selection.js";

const part = (body: Buffer, meta = "{}", size = "4x3") =>
  Buffer.concat([
    Buffer.from(
      `--novaframe\r\nContent-Type: image/jpeg\r\nContent-Length: ${body.length}\r\nX-Nova-Size: ${size}\r\nX-Nova-Meta: ${meta}\r\n\r\n`,
    ),
    body,
    Buffer.from("\r\n"),
  ]);

describe("MJPEG from the Windows agent", () => {
  it("cuts frames by Content-Length, also when they arrive in pieces", () => {
    const jpeg = Buffer.from([0xff, 0xd8, 0x0d, 0x0a, 0x2d, 0x2d, 0xff, 0xd9]);
    const stream = Buffer.concat([
      part(jpeg, '{"kind":"browser","url":"https://example.org/a","vw":1280}'),
      part(Buffer.from([1, 2, 3])),
      Buffer.from("--novaframe--\r\n"),
    ]);
    const parser = new MjpegParser();
    const frames = [];
    for (let i = 0; i < stream.length; i += 7)
      frames.push(...parser.push(stream.subarray(i, i + 7)));
    expect(frames.map((f) => [...f.body])).toEqual([[...jpeg], [1, 2, 3]]);
    expect(frames[0]!.headers["x-nova-size"]).toBe("4x3");
    expect(frameMeta(frames[0]!.headers["x-nova-meta"])).toEqual({
      url: "https://example.org/a",
      vw: 1280,
    });
    expect(parser.finished).toBe(true);
  });

  it("refuses oversized or malformed parts instead of buffering them", () => {
    expect(() =>
      new MjpegParser().push(
        Buffer.from("--novaframe\r\nContent-Length: 99999999\r\n\r\n"),
      ),
    ).toThrow(/length/);
    expect(() =>
      new MjpegParser().push(
        Buffer.from("--other\r\nContent-Length: 1\r\n\r\n"),
      ),
    ).toThrow(/boundary/);
    expect(() => new MjpegParser().push(Buffer.alloc(5000, 65))).toThrow(
      /header/,
    );
  });

  it("keeps only display fields from the frame metadata", () => {
    expect(
      frameMeta(
        '{"url":"javascript:alert(1)","title":"x","tab":"../x","vw":-1,"extra":1}',
      ),
    ).toEqual({ title: "x" });
    expect(frameMeta("not json")).toEqual({});
  });
});

describe("frame budget per viewer and in total", () => {
  it("limits the rate to the viewer's fps budget", () => {
    const gate = new FrameGate(10);
    const verdicts = Array.from({ length: 20 }, (_, i) =>
      gate.offer(1000, 0, i * 50),
    );
    // 20 frames over one second at 20 fps upstream, 10 fps budget: every other frame.
    expect(verdicts.filter((v) => v === "send")).toHaveLength(10);
    expect(verdicts.filter((v) => v === "rate")).toHaveLength(10);
    gate.setFps(1000);
    expect(gate.budgetFps).toBe(LIVE_LIMITS.maxFps);
  });

  it("drops frames for a busy socket and caps one frame's size", () => {
    const gate = new FrameGate(30);
    expect(gate.offer(LIVE_LIMITS.maxFrameBytes + 1, 0, 0)).toBe("size");
    expect(gate.offer(1000, LIVE_LIMITS.maxBufferedBytes + 1, 100)).toBe(
      "busy",
    );
    expect(gate.offer(1000, 0, 200)).toBe("send");
    expect(gate.dropped).toBe(2);
    expect(gate.sent).toBe(1);
  });

  it("shares one bandwidth cap between all live windows", () => {
    // Eight windows each wanting 24 fps of 100 kB frames for one second: far above 1 MB/s.
    const budget = new BandwidthBudget(1_000_000, 0);
    const gates = Array.from({ length: 8 }, () => new FrameGate(24));
    let sent = 0;
    for (let t = 0; t <= 1000; t += 1000 / 24)
      for (const gate of gates)
        if (gate.offer(100_000, 0, t, budget) === "send") sent++;
    const bytes = sent * 100_000;
    // Initial bucket (1 MB) plus one second of refill: never more than ~2 MB, against 19 MB wanted.
    expect(bytes).toBeLessThanOrEqual(2_000_000);
    expect(gates.reduce((n, g) => n + g.dropped, 0)).toBeGreaterThan(100);
  });

  it("frames are a length-prefixed JSON header plus the JPEG", () => {
    const frame = encodeFrame({ key: "w1", seq: 3 }, Buffer.from([9, 9]));
    const length = frame.readUInt32BE(0);
    expect(JSON.parse(frame.subarray(4, 4 + length).toString())).toEqual({
      key: "w1",
      seq: 3,
    });
    expect([...frame.subarray(4 + length)]).toEqual([9, 9]);
  });
});

describe("/api/live upgrade and messages", () => {
  const guard = { publicUrl: "https://nova.example.org", allowedHosts: [] };
  const request = (headers: Record<string, string>, url = "/api/live") => ({
    method: "GET",
    url,
    headers,
  });
  it("needs NOVA's own Origin; a websocket is not protected by CORS", () => {
    expect(
      liveUpgradeAllowed(
        request({ host: "nova:8080", origin: "http://nova:8080" }),
        guard,
      ),
    ).toBe(true);
    expect(
      liveUpgradeAllowed(
        request({ host: "192.168.10.9", origin: "https://nova.example.org" }),
        guard,
      ),
    ).toBe(true);
    expect(liveUpgradeAllowed(request({ host: "nova:8080" }), guard)).toBe(
      false,
    );
    expect(
      liveUpgradeAllowed(
        request({ host: "nova:8080", origin: "https://evil.example" }),
        guard,
      ),
    ).toBe(false);
    expect(
      liveUpgradeAllowed(
        request({
          host: "evil.example.com",
          origin: "http://evil.example.com",
        }),
        guard,
      ),
    ).toBe(false);
    expect(
      liveUpgradeAllowed(
        request({ host: "nova", origin: "http://nova" }, "/api/live?x=1"),
        guard,
      ),
    ).toBe(false);
  });

  it("parses and clamps client messages", () => {
    expect(
      parseClientMessage(
        JSON.stringify({
          type: "subscribe",
          key: "w-1",
          stream: "desktop",
          display: 2,
          fps: 500,
          maxWidth: 99999,
        }),
      ),
    ).toEqual({
      type: "subscribe",
      key: "w-1",
      stream: "desktop",
      display: 2,
      fps: LIVE_LIMITS.maxFps,
      maxWidth: LIVE_LIMITS.maxWidth,
    });
    expect(
      parseClientMessage(
        JSON.stringify({ type: "subscribe", key: "w", stream: "files" }),
      ),
    ).toBeNull();
    expect(
      parseClientMessage(JSON.stringify({ type: "unsubscribe", key: "../x" })),
    ).toBeNull();
    expect(parseClientMessage("x".repeat(5000))).toBeNull();
  });
});

describe("shared live upstreams", () => {
  afterEach(() => vi.useRealTimers());
  const config = {
    windowsAgent: { url: "http://pc:8765", token: "pairing-token-123" },
  };
  const settings = (viewEnabled = true) => ({ get: () => ({ viewEnabled }) });

  it("one agent stream feeds every window that watches it", async () => {
    const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xd9]);
    const calls: string[] = [];
    const service = new LiveStreamsService(
      config as never,
      settings() as never,
    );
    service.fetcher = (async (url: string, init: RequestInit) => {
      calls.push(url);
      expect((init.headers as Record<string, string>).authorization).toBe(
        "Bearer pairing-token-123",
      );
      const body = new ReadableStream({
        start(controller) {
          controller.enqueue(part(jpeg, '{"url":"https://a.example/"}'));
        },
      });
      return new Response(body, { status: 200 });
    }) as never;
    const a: LiveFrame[] = [];
    const b: LiveFrame[] = [];
    const states: string[] = [];
    const stopA = service.subscribe(
      { stream: "browser", fps: 10, maxWidth: 960 },
      { frame: (f) => a.push(f), status: (s) => states.push(s) },
    );
    const stopB = service.subscribe(
      { stream: "browser", fps: 4, maxWidth: 480 },
      { frame: (f) => b.push(f), status: () => {} },
    );
    await vi.waitFor(() =>
      expect(a.length + b.length).toBeGreaterThanOrEqual(2),
    );
    expect(calls).toHaveLength(1);
    expect(calls[0]).toContain("/v1/stream/browser?fps=24");
    expect(a[0]!.url).toBe("https://a.example/");
    expect(states).toContain("live");
    stopA();
    stopB();
    service.onModuleDestroy();
  });

  it("falls back to labelled screenshot refresh when the agent has no live stream", async () => {
    const urls: string[] = [];
    const service = new LiveStreamsService(
      config as never,
      settings() as never,
    );
    service.fetcher = (async (url: string) => {
      urls.push(url);
      if (url.includes("/v1/stream/"))
        return new Response('{"ok":false,"error":"Onbekende route"}', {
          status: 404,
        });
      return Response.json({
        ok: true,
        image: Buffer.from([1, 2, 3]).toString("base64"),
        width: 1280,
        height: 720,
      });
    }) as never;
    const frames: LiveFrame[] = [];
    const states: [string, string | undefined][] = [];
    const stop = service.subscribe(
      { stream: "desktop", display: 1, fps: 8, maxWidth: 960 },
      {
        frame: (f) => frames.push(f),
        status: (s, reason) => states.push([s, reason]),
      },
    );
    await vi.waitFor(() => expect(frames.length).toBeGreaterThan(0));
    expect(states.at(-1)?.[0]).toBe("snapshot");
    expect(states.at(-1)?.[1]).toMatch(/Momentopnamen/);
    expect(
      urls.some((u) => u.includes("/v1/desktop/screenshot?display=1")),
    ).toBe(true);
    stop();
    service.onModuleDestroy();
  });

  it("shows nothing of the desktop when viewing is switched off", async () => {
    const service = new LiveStreamsService(
      config as never,
      settings(false) as never,
    );
    const fetcher = vi.fn();
    service.fetcher = fetcher as never;
    const states: string[] = [];
    const stop = service.subscribe(
      { stream: "desktop", fps: 8, maxWidth: 960 },
      { frame: () => {}, status: (s) => states.push(s) },
    );
    await vi.waitFor(() => expect(states).toContain("offline"));
    expect(fetcher).not.toHaveBeenCalled();
    stop();
    service.onModuleDestroy();
  });

  it("closes the upstream after the last window leaves", async () => {
    vi.useFakeTimers();
    const service = new LiveStreamsService(
      config as never,
      settings() as never,
    );
    let aborted = false;
    service.fetcher = (async (_url: string, init: RequestInit) => {
      init.signal?.addEventListener("abort", () => (aborted = true));
      return new Response(new ReadableStream(), { status: 200 });
    }) as never;
    const stop = service.subscribe(
      { stream: "browser", fps: 8, maxWidth: 960 },
      { frame: () => {}, status: () => {} },
    );
    await vi.advanceTimersByTimeAsync(10);
    expect(service.active).toBe(1);
    stop();
    await vi.advanceTimersByTimeAsync(5000);
    expect(aborted).toBe(true);
    expect(service.active).toBe(0);
  });
});

describe("result window framing check", () => {
  it("frames a page only when its own headers allow it", () => {
    expect(frameableFrom({})).toBe(true);
    expect(frameableFrom({ "x-frame-options": "SAMEORIGIN" })).toBe(false);
    expect(
      frameableFrom({
        "content-security-policy": "default-src 'self'; frame-ancestors 'self'",
      }),
    ).toBe(false);
    expect(
      frameableFrom({ "content-security-policy": "frame-ancestors *" }),
    ).toBe(true);
    expect(
      frameableFrom({ "content-security-policy": "default-src 'self'" }),
    ).toBe(true);
  });
});

describe("live terminal output", () => {
  const collect = () => {
    const events: NovaTerminalEvent[] = [];
    let now = 0;
    const relay = new TerminalRelay(
      "term-1",
      (_event, data) => events.push(data),
      () => now,
    );
    return { relay, events, advance: (ms: number) => (now += ms) };
  };
  const text = (events: NovaTerminalEvent[]) =>
    events.map((e) => (e.phase === "data" ? e.data : "")).join("");

  it("streams whole lines and redacts a secret split over two chunks", () => {
    process.env.TEST_LIVE_PASSWORD = "hunter2-very-secret";
    const { relay, events } = collect();
    relay.start({ tool: "termix_run_command", host: "vm100", command: "env" });
    relay.write("stdout", "DB=hunter2-very");
    relay.write("stdout", "-secret\nnext line\n");
    relay.flush(false);
    relay.end({ ok: true, exitCode: 0 });
    delete process.env.TEST_LIVE_PASSWORD;
    expect(events[0]).toMatchObject({ phase: "start", host: "vm100" });
    expect(text(events)).toContain("DB=[redacted]\nnext line\n");
    expect(text(events)).not.toContain("hunter2");
    expect(events.at(-1)).toMatchObject({
      phase: "end",
      exitCode: 0,
      ok: true,
    });
  });

  it("keeps colours but drops clipboard, title and cursor escapes", () => {
    expect(
      cleanTerminal(
        "\u001b[32mok\u001b[0m\u001b]52;c;ZXZpbA==\u0007\u001b]0;title\u0007\u001b[2J\u001b[H done",
      ),
    ).toBe("\u001b[32mok\u001b[0m done");
  });

  it("buffered tools show their output at the end; the total is capped", () => {
    const { relay, events } = collect();
    relay.start({ tool: "code_run_tests", command: "tests demo" });
    relay.end({
      ok: false,
      exitCode: 1,
      output: "x".repeat(TERMINAL_LIMITS.maxTotalChars + 5000),
    });
    const out = text(events);
    expect(out.length).toBeLessThan(TERMINAL_LIMITS.maxTotalChars + 100);
    expect(out).toContain("uitvoer ingekort");
    expect(
      events.every(
        (e) =>
          e.phase !== "data" || e.data.length <= TERMINAL_LIMITS.maxEventChars,
      ),
    ).toBe(true);
  });
});

describe("window_open and result windows", () => {
  it("is registered as a model tool without a confirmation gate", () => {
    const [definition] = new WindowSource({} as never).definitions();
    expect(definition).toMatchObject({
      name: "window_open",
      risk: "SAFE",
      enabled: true,
    });
    expect(
      (
        definition!.parameters as unknown as {
          properties: { kind: { enum: string[] } };
        }
      ).properties.kind.enum,
    ).toEqual(["video", "page", "image", "document"]);
  });

  it("is offered for 'speel ... af'", () => {
    const tool = (name: string, description: string) => ({
      type: "function" as const,
      function: { name, description, parameters: {} },
    });
    const ranked = rankToolsForRequest(
      [
        tool("calendar_list", "List calendar events."),
        tool(
          "window_open",
          new WindowSource({} as never).definitions()[0]!.description,
        ),
      ],
      "speel de trailer van dune af",
      "conversation",
    );
    expect(ranked[0]?.function.name).toBe("window_open");
  });

  it("knows which player an address needs", () => {
    expect(
      videoSource("https://www.youtube.com/watch?v=dQw4w9WgXcQ&t=1m30s"),
    ).toEqual({ provider: "youtube", id: "dQw4w9WgXcQ", start: 90 });
    expect(videoSource("https://youtu.be/dQw4w9WgXcQ")).toEqual({
      provider: "youtube",
      id: "dQw4w9WgXcQ",
    });
    expect(videoSource("https://vimeo.com/76979871")).toEqual({
      provider: "vimeo",
      id: "76979871",
    });
    expect(videoSource("https://cdn.example.org/a/clip.mp4")).toEqual({
      provider: "file",
      url: "https://cdn.example.org/a/clip.mp4",
    });
    expect(
      videoSource("https://cdn.example.org/live/index.m3u8")?.provider,
    ).toBe("hls");
    expect(videoSource("https://example.org/page")).toBeNull();
    expect(safeHttpUrl("https://user:pw@example.org/")).toBeNull();
    expect(safeHttpUrl("javascript:alert(1)")).toBeNull();
  });

  it("finds a video by query, YouTube first", async () => {
    const world = {
      searchVideos: vi.fn(async () => [
        { title: "Op Vimeo", url: "https://vimeo.com/76979871" },
        {
          title: "Dune trailer",
          url: "https://www.youtube.com/watch?v=n9xhJrPXop4",
        },
      ]),
    };
    const result = await new WindowSource(world as never).execute(
      "window_open",
      { kind: "video", query: "dune trailer" },
      { sessionId: "s", signal: new AbortController().signal },
    );
    expect(result.ok).toBe(true);
    expect(result.window).toMatchObject({
      kind: "video",
      title: "Dune trailer",
      video: { provider: "youtube", id: "n9xhJrPXop4" },
    });
  });

  it("builds a reader window from web_read, secrets masked", () => {
    const window = resultWindowFor(
      "web_read",
      { url: "https://example.org/x" },
      {
        ok: true,
        result: {
          title: "Artikel",
          url: "https://example.org/x",
          text: "Eerste alinea.\n\n\n\nTweede met password=geheim123",
        },
      },
      3,
    );
    expect(window).toMatchObject({
      id: "reader-3",
      kind: "reader",
      title: "Artikel",
      domain: "example.org",
      result: true,
    });
    expect(window!.text).toBe(
      "Eerste alinea.\n\nTweede met password=[redacted]",
    );
    expect(resultWindowFor("web_read", {}, { ok: false }, 1)).toBeUndefined();
  });

  it("previews where a browser click and a desktop action landed", () => {
    expect(
      toolResultPreview(
        "browser_click",
        { id: 4 },
        {
          ok: true,
          result: {
            url: "https://shop.example/cart?session=abcdefghij1234567890abcdefghij12",
            title: "Winkelwagen",
            point: { x: 640, y: 180, vw: 1280, vh: 720 },
          },
        },
      ),
    ).toMatchObject({
      kind: "page",
      url: "https://shop.example/cart?[redacted]",
      action: { kind: "click", x: 0.5, y: 0.25 },
    });
    expect(
      toolResultPreview(
        "browser_type",
        { id: 2, text: "Sup3rGeheim!" },
        {
          ok: true,
          result: { url: "https://a.example/", point: {}, secret: false },
        },
      ),
    ).toMatchObject({ action: { kind: "type", text: "••••••••••••" } });
    expect(
      toolResultPreview(
        "desktop_act",
        { action: "click", x: 10, y: 10 },
        { ok: true, pointer: { x: 0.25, y: 0.75 } },
      ),
    ).toEqual({ kind: "screen", action: { kind: "click", x: 0.25, y: 0.75 } });
  });
});
