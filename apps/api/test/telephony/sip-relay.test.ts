import net from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import {
  MAX_TEXT_BYTES,
  parseCpim,
} from "../../src/telephony/sip-relay/cpim.js";
import { SipRelay } from "../../src/telephony/sip-relay/relay.js";
import { relaySettings } from "../../src/telephony/sip-relay/relay-config.js";
import { decideInbound } from "../../src/telephony/sip-relay/rewrite.js";
import {
  type FrameItem,
  SipFramer,
  SipFramingError,
  type SipMessage,
  stripOwnRoute,
} from "../../src/telephony/sip-relay/sip-message.js";
import { cpim, messageRequest, sipRequest } from "./sip-relay-helpers.js";

const messages = (items: FrameItem[]): SipMessage[] =>
  items.flatMap((i) => (i.type === "message" ? [i.message] : []));
const frame = (text: string | Buffer) =>
  messages(new SipFramer().push(Buffer.from(text)))[0]!;

describe("SIP framing", () => {
  const a = messageRequest("text/plain", "hoi", "a");
  const b = messageRequest("text/plain;charset=UTF-8", "tweede ä€", "b");

  it("handles a message split into single bytes", () => {
    const framer = new SipFramer();
    const out: SipMessage[] = [];
    for (const byte of Buffer.from(a))
      out.push(...messages(framer.push(Buffer.from([byte]))));
    expect(out).toHaveLength(1);
    expect(out[0]!.raw.toString()).toBe(a);
    expect(out[0]!.body.toString()).toBe("hoi");
    expect(framer.pending).toBe(0);
  });

  it("splits coalesced messages and keeps the keepalives between them", () => {
    const items = new SipFramer().push(
      Buffer.from(`\r\n\r\n${a}\r\n${b}\r\n\r\n`),
    );
    expect(items.map((i) => i.type)).toEqual([
      "raw",
      "message",
      "raw",
      "message",
      "raw",
    ]);
    expect(messages(items).map((m) => m.body.toString())).toEqual([
      "hoi",
      "tweede ä€",
    ]);
  });

  it("measures Content-Length in bytes, not characters, and accepts the compact form", () => {
    const text = sipRequest(
      "MESSAGE",
      ["Via: SIP/2.0/TCP x;branch=z9hG4bK1", "c: text/plain"],
      "€€€",
    ).replace("Content-Length: 9", "l: 9");
    const message = frame(text);
    expect(message.body.length).toBe(9);
    expect(message.headers.some((h) => h.name === "content-type")).toBe(true);
  });

  it("frames responses and a body that arrives later", () => {
    const framer = new SipFramer();
    const response = "SIP/2.0 202 Accepted\r\nContent-Length: 3\r\n\r\nabc";
    expect(framer.push(Buffer.from(response.slice(0, 30)))).toEqual([]);
    const [item] = framer.push(Buffer.from(response.slice(30)));
    expect(item).toMatchObject({
      type: "message",
      message: { isRequest: false },
    });
  });

  it.each([
    ["garbage start line", "HELLO WORLD\r\nContent-Length: 0\r\n\r\n"],
    [
      "negative length",
      "MESSAGE sip:a@b SIP/2.0\r\nContent-Length: -1\r\n\r\n",
    ],
    [
      "non numeric length",
      "MESSAGE sip:a@b SIP/2.0\r\nContent-Length: abc\r\n\r\n",
    ],
    [
      "conflicting lengths",
      "MESSAGE sip:a@b SIP/2.0\r\nContent-Length: 1\r\nl: 2\r\n\r\nx",
    ],
    ["header without colon", "MESSAGE sip:a@b SIP/2.0\r\nnonsense\r\n\r\n"],
    [
      "body over the cap",
      "MESSAGE sip:a@b SIP/2.0\r\nContent-Length: 99999999\r\n\r\n",
    ],
  ])("rejects %s", (_name, text) => {
    expect(() => new SipFramer().push(Buffer.from(text))).toThrow(
      SipFramingError,
    );
  });

  it("rejects an endless header section", () => {
    const framer = new SipFramer({ maxHead: 1024, maxBody: 1024 });
    expect(() =>
      framer.push(
        Buffer.from(`MESSAGE sip:a@b SIP/2.0\r\n${"X: y\r\n".repeat(400)}`),
      ),
    ).toThrow(SipFramingError);
  });
});

describe("CPIM", () => {
  const text = (r: ReturnType<typeof parseCpim>) =>
    r.kind === "text" ? r.body.toString("utf8") : r;

  it("unwraps text with CRLF and with bare LF", () => {
    expect(
      text(
        parseCpim(
          Buffer.from(cpim("text/plain;charset=UTF-8", "Hallo wereld")),
        ),
      ),
    ).toBe("Hallo wereld");
    expect(
      text(parseCpim(Buffer.from(cpim("text/plain", "Hallo", "\n")))),
    ).toBe("Hallo");
  });

  it("keeps multi-line bodies, blank lines and non-ASCII bytes intact", () => {
    const body = "regel 1\r\n\r\nregel 3 € ä\nlaatste";
    expect(
      text(parseCpim(Buffer.from(cpim("text/plain;charset=UTF-8", body)))),
    ).toBe(body);
  });

  it("honours an inner Content-Length and an empty body", () => {
    const wrapped = cpim("text/plain", "abcdef", "\r\n", ["Content-Length: 3"]);
    expect(text(parseCpim(Buffer.from(wrapped)))).toBe("abc");
    expect(text(parseCpim(Buffer.from(cpim("text/plain", ""))))).toBe("");
  });

  it("transcodes other charsets to UTF-8 and refuses unknown ones", () => {
    const latin1 = Buffer.concat([
      Buffer.from(
        "From: <sip:a@b>\r\n\r\nContent-Type: text/plain;charset=iso-8859-1\r\n\r\n",
      ),
      Buffer.from([0x63, 0x61, 0x66, 0xe9]),
    ]);
    expect(text(parseCpim(latin1))).toBe("café");
    expect(
      parseCpim(Buffer.from(cpim("text/plain;charset=nonsense-9", "x"))),
    ).toMatchObject({
      kind: "unreadable",
    });
  });

  it("treats typing and delivery reports as notifications, files and the rest as unreadable", () => {
    expect(
      parseCpim(Buffer.from(cpim("application/im-iscomposing+xml", "<x/>"))),
    ).toEqual({ kind: "notification" });
    expect(parseCpim(Buffer.from(cpim("message/imdn+xml", "<x/>")))).toEqual({
      kind: "notification",
    });
    expect(
      parseCpim(
        Buffer.from(cpim("application/vnd.gsma.rcs-ft-http+xml", "<x/>")),
      ),
    ).toMatchObject({
      kind: "unreadable",
    });
    expect(parseCpim(Buffer.from(cpim("image/png", "\x89PNG")))).toMatchObject({
      kind: "unreadable",
    });
  });

  it("copes with missing inner headers, no blank line and oversized text", () => {
    expect(parseCpim(Buffer.from(cpim(null, "zonder kop")))).toMatchObject({
      kind: "unreadable",
    });
    expect(parseCpim(Buffer.from("From: <sip:a@b>"))).toMatchObject({
      kind: "unreadable",
    });
    expect(parseCpim(Buffer.from(""))).toMatchObject({ kind: "unreadable" });
    expect(
      parseCpim(
        Buffer.from(cpim("text/plain", "x".repeat(MAX_TEXT_BYTES + 1))),
      ),
    ).toMatchObject({
      kind: "unreadable",
    });
    expect(
      text(
        parseCpim(Buffer.from(cpim("text/plain", "x".repeat(MAX_TEXT_BYTES)))),
      ),
    ).toHaveLength(MAX_TEXT_BYTES);
  });
});

describe("inbound decisions", () => {
  it("rewrites a CPIM text message and fixes only Content-Type and Content-Length", () => {
    const inner = "Wat is het weer? €";
    const original = messageRequest(
      "message/cpim",
      cpim("text/plain;charset=UTF-8", inner),
      "c1",
      ["User-Agent: Flexisip"],
    );
    const decision = decideInbound(frame(original));
    expect(decision).toMatchObject({ action: "forward", rewritten: true });
    const out = frame((decision as { bytes: Buffer }).bytes);
    expect(out.body.toString("utf8")).toBe(inner);
    const lines = out.raw.toString("latin1").split("\r\n");
    expect(lines).toContain("Content-Type: text/plain;charset=UTF-8");
    expect(lines).toContain(`Content-Length: ${Buffer.byteLength(inner)}`);
    for (const keep of [
      "MESSAGE sip:nova-techlepp@sip.linphone.org SIP/2.0",
      "Via: SIP/2.0/TCP 203.0.113.9:5060;branch=z9hG4bKc1;rport",
      "User-Agent: Flexisip",
      "Call-ID: c1@flexisip",
    ])
      expect(lines).toContain(keep);
    expect(lines.filter((l) => /^content-/i.test(l))).toHaveLength(2);
  });

  it("answers typing indicators and delivery reports with 200 OK, copying the transaction", () => {
    for (const type of ["application/im-iscomposing+xml", "message/imdn+xml"]) {
      const decision = decideInbound(frame(messageRequest(type, "<x/>", "t1")));
      expect(decision).toMatchObject({
        action: "answer",
        category: "notification",
      });
      const response = (decision as { response: Buffer }).response.toString();
      expect(response).toMatch(/^SIP\/2\.0 200 OK\r\n/);
      expect(response).toContain(
        "Via: SIP/2.0/TCP 203.0.113.9:5060;branch=z9hG4bKt1;rport",
      );
      expect(response).toContain(
        'From: "Tester" <sip:tester@sip.linphone.org>;tag=ft1',
      );
      expect(response).toMatch(
        /\r\nTo: <sip:nova-techlepp@sip\.linphone\.org>;tag=[0-9a-f]{10}\r\n/,
      );
      expect(response).toContain("Call-ID: t1@flexisip");
      expect(response).toContain("CSeq: 1 MESSAGE");
      expect(response).toMatch(/Content-Length: 0\r\n\r\n$/);
    }
  });

  it("answers and counts CPIM files and unknown types as unreadable", () => {
    expect(
      decideInbound(
        frame(messageRequest("message/cpim", cpim("image/png", "x"))),
      ),
    ).toMatchObject({
      action: "answer",
      category: "unreadable",
    });
    expect(
      decideInbound(frame(messageRequest("application/lime", "x"))),
    ).toMatchObject({
      action: "answer",
      category: "unreadable",
    });
    expect(
      decideInbound(
        frame(
          messageRequest(
            "message/cpim",
            cpim("application/im-iscomposing+xml", "<x/>"),
          ),
        ),
      ),
    ).toMatchObject({ action: "answer", category: "notification" });
  });

  it("leaves text/plain, MESSAGE without a type, other methods and responses byte-identical", () => {
    const same = (text: string) => {
      const d = decideInbound(frame(text));
      expect(d).toMatchObject({ action: "forward", rewritten: false });
      expect((d as { bytes: Buffer }).bytes.toString()).toBe(text);
    };
    same(messageRequest("text/plain;charset=UTF-8", "hoi"));
    same(messageRequest(null, ""));
    same(
      sipRequest(
        "INVITE",
        ["Via: SIP/2.0/TCP x;branch=z9hG4bK1", "Content-Type: application/sdp"],
        "v=0\r\n",
      ),
    );
    same(
      "SIP/2.0 200 OK\r\nContent-Type: message/cpim\r\nContent-Length: 2\r\n\r\nhi",
    );
    same(
      sipRequest(
        "OPTIONS",
        ["Via: SIP/2.0/TCP x;branch=z9hG4bK1", "Content-Type: message/cpim"],
        "x",
      ),
    );
  });
});

describe("Route handling", () => {
  const own = [
    { host: "nova", port: 5070 },
    { host: "172.20.0.5", port: 5070 },
  ];
  const request = (route: string) =>
    frame(
      sipRequest("REGISTER", [
        "Via: SIP/2.0/TCP x;branch=z9hG4bK1",
        route,
        "Call-ID: 1",
      ]),
    );

  it("removes only its own topmost Route", () => {
    const out = stripOwnRoute(
      request("Route: <sip:nova:5070;transport=tcp;lr>"),
      own,
    ).toString();
    expect(out).not.toMatch(/Route/i);
    expect(out).toContain("Call-ID: 1");
    expect(
      stripOwnRoute(
        request("Route: <sip:nova:5070;lr>, <sip:other.example;lr>"),
        own,
      ).toString(),
    ).toContain("Route: <sip:other.example;lr>");
    expect(
      stripOwnRoute(
        request("Route: <sip:172.20.0.5:5070;transport=TCP;lr>"),
        own,
      ).toString(),
    ).not.toMatch(/Route/);
    const foreign = request("Route: <sip:elsewhere:5070;lr>");
    expect(stripOwnRoute(foreign, own)).toBe(foreign.raw);
  });
});

describe("relay settings", () => {
  it("is automatic for the compose stack and off for a dev setup", () => {
    expect(relaySettings({})).toBeNull();
    expect(
      relaySettings({ NOVA_ASTERISK_ARI_URL: "http://asterisk:8088" }),
    ).toMatchObject({
      listenPort: 5070,
      proxyHost: "nova",
      upstreamPort: 5060,
      allow: ["asterisk"],
    });
    expect(
      relaySettings({
        NOVA_ASTERISK_ARI_URL: "http://asterisk:8088",
        NOVA_SIP_RELAY: "off",
      }),
    ).toBeNull();
    expect(relaySettings({ NOVA_SIP_RELAY: "on" })).not.toBeNull();
  });
});

// ---- the relay over real sockets ------------------------------------------------------------------------------

const open: Array<{ close: () => void }> = [];
afterEach(() => {
  for (const c of open.splice(0)) c.close();
});

async function upstream() {
  const sockets: net.Socket[] = [];
  const received: Buffer[] = [];
  const server = net.createServer((s) => {
    sockets.push(s);
    s.on("data", (d) => received.push(d));
    s.on("error", () => undefined);
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  open.push({
    close: () => {
      server.close();
      sockets.forEach((s) => s.destroy());
    },
  });
  return {
    port: (server.address() as net.AddressInfo).port,
    sockets,
    received,
    text: () => Buffer.concat(received).toString("utf8"),
  };
}

async function relay(
  target: number,
  allow = ["127.0.0.1"],
  extra: Partial<ConstructorParameters<typeof SipRelay>[0]> = {},
) {
  const r = new SipRelay({
    listen: { host: "127.0.0.1", port: 0 },
    target: { host: "127.0.0.1", port: target },
    proxy: { host: "nova", port: 5070 },
    allow: async () => allow,
    ...extra,
  });
  await r.start();
  open.push({ close: () => void r.stop() });
  return r;
}

async function client(port: number) {
  const socket = net.connect(port, "127.0.0.1");
  const received: Buffer[] = [];
  let closed = false;
  socket.on("data", (d) => received.push(d));
  socket.on("error", () => undefined);
  socket.on("close", () => (closed = true));
  await new Promise<void>((r) => socket.once("connect", r));
  open.push({ close: () => socket.destroy() });
  return {
    socket,
    text: () => Buffer.concat(received).toString("utf8"),
    closed: () => closed,
  };
}

const until = async (fn: () => boolean, ms = 3000) => {
  const end = Date.now() + ms;
  while (!fn()) {
    if (Date.now() > end) throw new Error("timeout");
    await new Promise((r) => setTimeout(r, 10));
  }
};

describe("SipRelay over TCP", () => {
  it("relays both ways byte for byte, including keepalives, and closes both sides together", async () => {
    const up = await upstream();
    const r = await relay(up.port);
    const down = await client(r.port);
    await until(() => up.sockets.length === 1);
    const invite = sipRequest(
      "INVITE",
      ["Via: SIP/2.0/TCP a;branch=z9hG4bK1", "Content-Type: application/sdp"],
      "v=0\r\n",
    );
    down.socket.write(`\r\n\r\n${invite}`);
    await until(() => up.text().length >= invite.length + 4);
    expect(up.text()).toBe(`\r\n\r\n${invite}`);
    up.sockets[0]!.write("\r\n");
    up.sockets[0]!.write("SIP/2.0 200 OK\r\nContent-Length: 0\r\n\r\n");
    await until(() => down.text().length === 2 + 37);
    expect(down.text()).toBe("\r\nSIP/2.0 200 OK\r\nContent-Length: 0\r\n\r\n");
    expect(r.status()).toMatchObject({ listening: true, activeConnections: 1 });
    up.sockets[0]!.destroy();
    await until(() => down.closed());
    await until(() => r.status().activeConnections === 0);
  });

  it("unwraps CPIM, answers typing upstream without bothering Asterisk, and counts files", async () => {
    const up = await upstream();
    const r = await relay(up.port);
    const down = await client(r.port);
    await until(() => up.sockets.length === 1);
    const flexisip = up.sockets[0]!;
    // one TCP write carrying four messages, cut in the middle of a body
    const wire = [
      messageRequest("application/im-iscomposing+xml", "<isComposing/>", "i1"),
      messageRequest(
        "message/cpim",
        cpim("text/plain;charset=UTF-8", "Hoi NOVA"),
        "i2",
      ),
      messageRequest("message/imdn+xml", "<imdn/>", "i3"),
      messageRequest("message/cpim", cpim("image/jpeg", "JFIF"), "i4"),
    ].join("");
    flexisip.write(wire.slice(0, 300));
    flexisip.write(wire.slice(300));
    await until(() => down.text().includes("Hoi NOVA"));
    await until(() => up.text().split("SIP/2.0 200 OK").length === 4);
    expect(down.text()).not.toMatch(/iscomposing|imdn|image\/jpeg/i);
    expect(down.text()).toMatch(/Content-Type: text\/plain;charset=UTF-8/);
    expect(up.text()).toContain("Call-ID: i1@flexisip");
    expect(up.text()).toContain("Call-ID: i3@flexisip");
    expect(up.text()).toContain("Call-ID: i4@flexisip");
    expect(r.status()).toMatchObject({
      rewritten: 1,
      answered: 3,
      dropped: 3,
      unreadable: 1,
    });
    expect(r.status().lastUnreadableAt).toMatch(/^\d{4}-/);
    expect(JSON.stringify(r.status())).not.toContain("Hoi NOVA");
  });

  it("removes its own Route when Asterisk sends a request upstream", async () => {
    const up = await upstream();
    const r = await relay(up.port);
    const down = await client(r.port);
    down.socket.write(
      sipRequest(
        "REGISTER",
        [
          "Via: SIP/2.0/TCP a;branch=z9hG4bK1",
          "Route: <sip:nova:5070;transport=tcp;lr>",
          "Call-ID: r1",
        ],
        "",
        "sip:sip.linphone.org",
      ),
    );
    await until(() => up.text().includes("Call-ID: r1"));
    expect(up.text()).not.toMatch(/Route/);
  });

  it("closes only that connection on malformed input and keeps serving others", async () => {
    const up = await upstream();
    const r = await relay(up.port);
    const bad = await client(r.port);
    const good = await client(r.port);
    await until(() => up.sockets.length === 2);
    bad.socket.write("THIS IS NOT SIP\r\n\r\n");
    await until(() => bad.closed());
    expect(r.status().lastError).toMatch(/malformed SIP/);
    good.socket.write(messageRequest("text/plain", "nog steeds", "g1"));
    await until(() => up.text().includes("nog steeds"));
    const bad2 = await client(r.port);
    bad2.socket.write(
      "MESSAGE sip:a@b SIP/2.0\r\nContent-Length: 99999999\r\n\r\n",
    );
    await until(() => bad2.closed());
  });

  it("respects backpressure: a slow reader pauses the sender instead of growing memory", async () => {
    const up = await upstream();
    const r = await relay(up.port);
    const down = await client(r.port);
    await until(() => up.sockets.length === 1);
    down.socket.pause(); // never reads
    const flexisip = up.sockets[0]!;
    const chunk = messageRequest("text/plain", "x".repeat(60_000), "bp");
    // keep writing until the kernel buffers along the path are full and our own socket cannot flush any more
    let stalled = false;
    for (let i = 0; i < 1500 && !stalled; i++) {
      flexisip.write(chunk);
      if (i % 25 === 0) {
        await new Promise((x) => setTimeout(x, 30));
        stalled = flexisip.writableLength > 1_000_000;
      }
    }
    expect(stalled).toBe(true);
    const held = flexisip.writableLength;
    await new Promise((x) => setTimeout(x, 300));
    expect(flexisip.writableLength).toBeGreaterThanOrEqual(held); // nothing drains while Asterisk is not reading
    expect(r.status().activeConnections).toBe(1);
  });

  it("rejects peers that are not on the allowlist and never connects upstream for them", async () => {
    const up = await upstream();
    const r = await relay(up.port, ["10.9.9.9"]);
    const down = await client(r.port);
    await until(() => down.closed());
    expect(up.sockets).toHaveLength(0);
    expect(r.status()).toMatchObject({ rejected: 1, activeConnections: 0 });
    expect(r.status().lastError).toMatch(/non-allowed/);
  });

  it("enforces the connection cap, closes idle connections and survives an unreachable upstream", async () => {
    const up = await upstream();
    const r = await relay(up.port, ["127.0.0.1"], {
      maxConnections: 2,
      idleMs: 1200,
    });
    const [a, , c] = [
      await client(r.port),
      await client(r.port),
      await client(r.port),
    ];
    await until(() => c.closed());
    expect(r.status().rejected).toBe(1);
    await until(() => a.closed(), 5000);
    await until(() => r.status().activeConnections === 0, 5000);
    // upstream gone: the downstream is closed, the relay keeps listening
    const dead = await upstream();
    const port = dead.port;
    dead.sockets.length = 0;
    open.pop()!.close();
    const r2 = await relay(port);
    const d = await client(r2.port);
    await until(() => d.closed());
    expect(r2.status()).toMatchObject({ listening: true });
    expect(r2.status().lastError).toMatch(/upstream/);
  });

  it("always connects to the fixed target, whatever the traffic says", async () => {
    const up = await upstream();
    const other = await upstream();
    const r = await relay(up.port);
    const down = await client(r.port);
    down.socket.write(
      sipRequest(
        "INVITE",
        [
          "Via: SIP/2.0/TCP a;branch=z9hG4bK1",
          "Route: <sip:127.0.0.1:" + other.port + ";lr>",
        ],
        "",
        `sip:x@127.0.0.1:${other.port}`,
      ),
    );
    await until(() => up.text().includes("INVITE"));
    expect(other.sockets).toHaveLength(0);
  });

  it("stops cleanly and frees the port", async () => {
    const up = await upstream();
    const r = await relay(up.port);
    const down = await client(r.port);
    await r.stop();
    await until(() => down.closed());
    expect(r.status().listening).toBe(false);
  });
});
