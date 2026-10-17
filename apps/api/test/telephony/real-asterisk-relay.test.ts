import { execFileSync } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { renderAll, renderPjsip } from "../../src/telephony/asterisk-config.js";
import { SipRelay } from "../../src/telephony/sip-relay/relay.js";
import {
  type FrameItem,
  SipFramer,
  type SipMessage,
} from "../../src/telephony/sip-relay/sip-message.js";
import { defaultConfig } from "../../src/telephony/telephony.store.js";
import * as helpers from "./sip-relay-helpers.js";

const { crlf } = helpers;
const messageRequest = (type: string | null, body: string, id: string) =>
  helpers.messageRequest(type, body, id, [], HOST);
const cpim = (inner: string | null, body: string) =>
  helpers.cpim(inner, body, "\r\n", [], HOST);

/**
 * Real Asterisk 22 registers through NOVA's SIP relay at a fake Flexisip (a TCP SIP server) and the whole text and call
 * path is exercised: REGISTER, an INVITE from the registrar, MESSAGEs in message/cpim, typing and IMDN, and NOVA's reply
 * text going back out. The pjsip.conf and dialplan are the ones NOVA generates. Opt-in: NOVA_TEST_ASTERISK=1
 * (needs Docker and andrius/asterisk:22; uses the host network and ports 15061, 15070, 15071).
 */
const enabled = process.env.NOVA_TEST_ASTERISK === "1";
const NAME = `nova-test-relay-${process.pid}`;
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "nova-ast-relay-"));
const SIP = 15061;
const RELAY = 15070;
const FLEXISIP = 15071;
const HOST = "sip.lab.test";
const docker = (...args: string[]) =>
  execFileSync("docker", args, { encoding: "utf8", timeout: 60_000 });

interface Seen {
  conn: number;
  message: SipMessage;
}

/** Just enough of Flexisip: registrar with digest challenge, answers MESSAGE/BYE, and can push requests to Asterisk. */
class FakeFlexisip {
  readonly seen: Seen[] = [];
  readonly sockets: net.Socket[] = [];
  private readonly server: net.Server;
  constructor() {
    this.server = net.createServer((socket) => {
      const conn = this.sockets.push(socket) - 1;
      const framer = new SipFramer();
      socket.on("error", () => undefined);
      socket.on("data", (chunk) => {
        for (const item of framer.push(chunk) as FrameItem[]) {
          if (item.type !== "message") continue;
          this.seen.push({ conn, message: item.message });
          this.answer(socket, item.message);
        }
      });
    });
  }
  listen = () =>
    new Promise<void>((r) => this.server.listen(FLEXISIP, "127.0.0.1", r));
  close = () => {
    this.server.close();
    this.sockets.forEach((s) => s.destroy());
  };
  private answer(socket: net.Socket, m: SipMessage) {
    if (!m.isRequest) return;
    const get = (n: string) =>
      m.headers
        .filter((h) => h.name === n)
        .flatMap((h) => h.lines)
        .join("\r\n");
    const common = [get("via"), get("from"), get("call-id"), get("cseq")];
    const to = `${get("to")};tag=fx${Math.random().toString(36).slice(2, 8)}`;
    if (m.method === "REGISTER") {
      const authed = m.headers.some((h) => h.name === "authorization");
      socket.write(
        crlf([
          authed ? "SIP/2.0 200 OK" : "SIP/2.0 401 Unauthorized",
          common[0]!,
          common[1]!,
          to,
          common[2]!,
          common[3]!,
          ...(authed
            ? [get("contact"), "Expires: 3600"]
            : [
                'WWW-Authenticate: Digest realm="sip.lab.test", nonce="abc123", algorithm=MD5, qop="auth"',
              ]),
          "Content-Length: 0",
          "",
          "",
        ]),
      );
    } else if (m.method === "MESSAGE" || m.method === "BYE") {
      socket.write(
        crlf([
          "SIP/2.0 200 OK",
          common[0]!,
          common[1]!,
          to,
          common[2]!,
          common[3]!,
          "Content-Length: 0",
          "",
          "",
        ]),
      );
    }
  }
  /** The newest connection that carried an authorised REGISTER: Asterisk's registered connection. */
  registered(): net.Socket {
    const reg = [...this.seen]
      .reverse()
      .find(
        (s) =>
          s.message.method === "REGISTER" &&
          s.message.headers.some((h) => h.name === "authorization"),
      );
    if (!reg) throw new Error("not registered");
    return this.sockets[reg.conn]!;
  }
  requests = (method: string) =>
    this.seen.filter((s) => s.message.isRequest && s.message.method === method);
  responses = (callId: string) =>
    this.seen.filter(
      (s) => !s.message.isRequest && s.message.raw.includes(callId),
    );
}

describe.skipIf(!enabled)("real Asterisk behind the SIP relay", () => {
  const novaPosts: Record<string, string>[] = [];
  let reply = "";
  let novaServer: http.Server;
  const flexisip = new FakeFlexisip();
  let relay: SipRelay;
  const startRelay = async () => {
    relay = new SipRelay({
      listen: { host: "127.0.0.1", port: RELAY },
      target: { host: "127.0.0.1", port: FLEXISIP },
      proxy: { host: "127.0.0.1", port: RELAY },
      allow: async () => ["127.0.0.1"],
    });
    await relay.start();
  };
  const waitSeen = (fn: () => boolean, timeout = 20_000) =>
    vi.waitFor(() => expect(fn()).toBe(true), { timeout, interval: 100 });
  const send = (text: string) => flexisip.registered().write(text);

  beforeAll(async () => {
    novaServer = http.createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on("data", (c: Buffer) => chunks.push(c));
      req.on("end", () => {
        const post = Object.fromEntries(
          new URLSearchParams(Buffer.concat(chunks).toString("utf8")),
        );
        novaPosts.push(post);
        res.writeHead(200, { "content-type": "text/plain; charset=utf-8" });
        res.end(reply);
      });
    });
    await new Promise<void>((r) => novaServer.listen(0, "127.0.0.1", r));
    const novaPort = (novaServer.address() as net.AddressInfo).port;

    const config = {
      ...defaultConfig(),
      enabled: true,
      messageToken: "LabToken_abcdefghijkl",
      trunk: {
        host: HOST,
        username: "nova-techlepp",
        secret: "geheim-wachtwoord",
        number: "",
        allowExtensionsToDialOut: false,
      },
      contacts: [
        { name: "Tester", sip: `tester@${HOST}`, allowConversation: true },
      ],
    };
    const files = renderAll(
      config,
      undefined,
      null,
      `http://127.0.0.1:${novaPort}/api/integrations/asterisk/message`,
      { host: "127.0.0.1", port: RELAY },
    );
    // Only the lab's addresses differ from what production gets; the trunk sections are untouched.
    const pjsip = files["pjsip.conf"]!.replaceAll(
      "bind=0.0.0.0:5060",
      `bind=127.0.0.1:${SIP}`,
    );
    expect(pjsip).toBe(
      renderPjsip(config, { host: "127.0.0.1", port: RELAY }).replaceAll(
        "bind=0.0.0.0:5060",
        `bind=127.0.0.1:${SIP}`,
      ),
    );
    fs.writeFileSync(path.join(dir, "pjsip.conf"), pjsip);
    // No ARI in the lab: an inbound call is answered, held for a second and hung up.
    fs.writeFileSync(
      path.join(dir, "extensions.conf"),
      files["extensions.conf"]!.replace(
        " same => n,Stasis(nova,external)",
        " same => n,Answer()\n same => n,Wait(1)",
      ),
    );
    await flexisip.listen();
    await startRelay();
    docker(
      "run",
      "-d",
      "--rm",
      "--name",
      NAME,
      "--network",
      "host",
      "--add-host",
      `${HOST}:127.0.0.1`,
      "-v",
      `${path.join(dir, "extensions.conf")}:/etc/asterisk/extensions.conf:ro`,
      "-v",
      `${path.join(dir, "pjsip.conf")}:/etc/asterisk/pjsip.conf:ro`,
      "andrius/asterisk:22",
    );
    await vi.waitFor(
      () => docker("exec", NAME, "asterisk", "-rx", "core waitfullybooted"),
      { timeout: 40_000, interval: 1000 },
    );
  }, 90_000);

  afterAll(async () => {
    if (process.env.NOVA_LAB_LOG)
      console.log(
        flexisip.seen
          .slice(0, 6)
          .map((s) => `#${s.conn} ${s.message.raw.toString().slice(0, 900)}`)
          .join("\n-----\n"),
      );
    if (process.env.NOVA_LAB_LOG)
      console.log(
        docker("logs", "--tail", "80", NAME).slice(-6000),
        JSON.stringify(relay?.status()),
      );
    try {
      docker("rm", "-f", NAME);
    } catch {
      /* gone */
    }
    await relay?.stop();
    flexisip.close();
    await new Promise<void>((r) =>
      novaServer ? novaServer.close(() => r()) : r(),
    );
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("registers through the relay: the registrar sees a REGISTER without the relay's Route and answers 200", async () => {
    await waitSeen(() =>
      flexisip
        .requests("REGISTER")
        .some((s) => s.message.headers.some((h) => h.name === "authorization")),
    );
    const register = flexisip.requests("REGISTER")[0]!.message;
    expect(register.headers.some((h) => h.name === "route")).toBe(false);
    expect(register.startLine).toBe(`REGISTER sip:${HOST} SIP/2.0`);
    expect(register.raw.toString()).toMatch(/Via: SIP\/2\.0\/TCP .*;/);
    await vi.waitFor(
      () =>
        expect(
          docker("exec", NAME, "asterisk", "-rx", "pjsip show registrations"),
        ).toMatch(/Registered/),
      { timeout: 20_000, interval: 500 },
    );
    expect(relay.status()).toMatchObject({ listening: true });
  }, 60_000);

  const SDP = crlf([
    "v=0",
    "o=- 1 1 IN IP4 127.0.0.1",
    "s=-",
    "c=IN IP4 127.0.0.1",
    "t=0 0",
    "m=audio 20000 RTP/SAVP 0",
    "a=rtpmap:0 PCMU/8000",
    "a=crypto:1 AES_CM_128_HMAC_SHA1_80 inline:WVNfX19zZW1jdGwgKCkgewkyMjA7fQp9CnVubGVz",
    "",
  ]);
  /** An INVITE as a proxy would forward it; `via` is the sent-by of its Via, `routeHost` its Record-Route. */
  const invite = (id: string, via: string, routeHost: string) =>
    send(
      crlf([
        `INVITE sip:nova-techlepp@${HOST} SIP/2.0`,
        `Via: SIP/2.0/TCP ${via};branch=z9hG4bK${id};rport`,
        "Max-Forwards: 69",
        `From: "Tester" <sip:tester@${HOST}>;tag=${id}`,
        `To: <sip:nova-techlepp@${HOST}>`,
        `Call-ID: ${id}@flexisip`,
        "CSeq: 1 INVITE",
        `Contact: <sip:tester@127.0.0.1:${FLEXISIP};transport=tcp>`,
        `Record-Route: <sip:${routeHost};transport=tcp;lr>`,
        "Content-Type: application/sdp",
        `Content-Length: ${Buffer.byteLength(SDP)}`,
        "",
        SDP,
      ]),
    );
  const answered = async (id: string) => {
    await waitSeen(() =>
      flexisip
        .responses(`${id}@flexisip`)
        .some((r) => r.message.startLine.startsWith("SIP/2.0 200")),
    );
    const ok = flexisip
      .responses(`${id}@flexisip`)
      .find((r) => r.message.startLine.startsWith("SIP/2.0 200"))!;
    const h = (n: string) =>
      ok.message.headers.find((x) => x.name === n)!.value;
    send(
      crlf([
        `ACK sip:127.0.0.1:${SIP};transport=TCP SIP/2.0`,
        `Via: SIP/2.0/TCP 127.0.0.1:${FLEXISIP};branch=z9hG4bKack${id};rport`,
        "Max-Forwards: 69",
        `From: ${h("from")}`,
        `To: ${h("to")}`,
        `Call-ID: ${id}@flexisip`,
        "CSeq: 1 ACK",
        "Content-Length: 0",
        "",
        "",
      ]),
    );
    return ok;
  };
  const byes = () => flexisip.requests("BYE");

  it("delivers an INVITE from the registrar on the registered connection and Asterisk handles the call", async () => {
    const connectionsBefore = flexisip.sockets.length;
    invite("inv1", `127.0.0.1:${FLEXISIP}`, `127.0.0.1:${FLEXISIP}`);
    const ok = await answered("inv1");
    expect(ok.message.raw.toString()).toMatch(/RTP\/SAVP/); // SDES-SRTP answer: SDP untouched
    expect(ok.message.raw.toString()).toMatch(
      /a=crypto:1 AES_CM_128_HMAC_SHA1_80/,
    );
    // the call is answered, held for a second by the dialplan and hung up by Asterisk
    await waitSeen(() => byes().length === 1);
    const bye = byes()[0]!;
    console.log(
      `INVITE path: 200 OK on connection #${ok.conn}, BYE on connection #${bye.conn}; ${flexisip.sockets.length} connections at the registrar, relay carried ${relay.status().totalConnections}; BYE Route: ${bye.message.headers.find((h) => h.name === "route")?.value ?? "none"}`,
    );
    expect(ok.conn).toBe(
      flexisip.seen.find((s) => s.message.method === "REGISTER")!.conn,
    );
    expect(flexisip.sockets.length).toBe(connectionsBefore);
    expect(relay.status().totalConnections).toBe(flexisip.sockets.length);
    expect(bye.message.headers.some((h) => h.name === "route")).toBe(false);
  }, 60_000);

  it("keeps calls working when the registrar's Record-Route is not the previous hop (where does the BYE go?)", async () => {
    invite("inv2", "203.0.113.9:5060", `127.0.0.1:${FLEXISIP}`);
    const ok = await answered("inv2");
    expect(ok.message.raw.toString()).toMatch(/RTP\/SAVP/);
    await waitSeen(() => byes().length === 2, 30_000);
    console.log(
      `INVITE 2 (foreign Via, Record-Route kept): BYE on connection #${byes()[1]!.conn} of ${flexisip.sockets.length}; relay carried ${relay.status().totalConnections}`,
    );
  }, 60_000);

  it("turns a CPIM text into plain text for NOVA, and the reply text flows back out through the relay", async () => {
    reply = `sip:tester@${HOST}|Het is 14 graden, "bewolkt" en €5 kost {niets}; 100% zeker.`;
    send(
      messageRequest(
        "message/cpim",
        cpim(
          "text/plain;charset=UTF-8",
          "Wat is het weer, vandaag? €5 {x}\nTweede regel",
        ),
        "cp1",
      ),
    );
    await waitSeen(() => novaPosts.length === 1, 30_000);
    expect(novaPosts[0]).toMatchObject({
      token: "LabToken_abcdefghijkl",
      type: "text/plain;charset=UTF-8",
      body: "Wat is het weer, vandaag? €5 {x}\nTweede regel",
    });
    expect(novaPosts[0]!.from).toContain(`sip:tester@${HOST}`);
    // Asterisk accepted the (rewritten) message: 202 for the transaction, passed through the relay untouched
    await waitSeen(() => flexisip.responses("cp1@flexisip").length > 0);
    expect(flexisip.responses("cp1@flexisip")[0]!.message.startLine).toMatch(
      /^SIP\/2\.0 202/,
    );
    await waitSeen(() => flexisip.requests("MESSAGE").length === 1, 30_000);
    const out = flexisip.requests("MESSAGE")[0]!.message;
    expect(out.startLine).toBe(`MESSAGE sip:tester@${HOST} SIP/2.0`);
    expect(out.headers.some((h) => h.name === "route")).toBe(false);
    expect(out.body.toString("utf8")).toBe(
      `Het is 14 graden, "bewolkt" en €5 kost {niets}; 100% zeker.`,
    );
    expect(relay.status().rewritten).toBe(1);
  }, 90_000);

  it("answers typing and IMDN itself: 200 OK upstream, nothing reaches Asterisk or NOVA", async () => {
    const before = novaPosts.length;
    const asteriskLogBefore = docker("logs", NAME);
    for (const [id, type, body] of [
      [
        "ty1",
        "application/im-iscomposing+xml",
        "<isComposing xmlns='urn:ietf:params:xml:ns:im-iscomposing'><state>active</state></isComposing>",
      ],
      [
        "im1",
        "message/imdn+xml",
        "<imdn xmlns='urn:ietf:params:xml:ns:imdn'><message-id>x</message-id></imdn>",
      ],
    ] as const)
      send(messageRequest(type, body, id));
    send(
      messageRequest("message/cpim", cpim("image/jpeg", "JFIF-bytes"), "fl1"),
    );
    await waitSeen(() =>
      ["ty1", "im1", "fl1"].every(
        (id) => flexisip.responses(`${id}@flexisip`).length === 1,
      ),
    );
    for (const id of ["ty1", "im1", "fl1"]) {
      const response = flexisip.responses(`${id}@flexisip`)[0]!.message;
      expect(response.startLine).toBe("SIP/2.0 200 OK");
      expect(response.raw.toString()).toMatch(/To: .*;tag=[0-9a-f]+/);
    }
    await new Promise((r) => setTimeout(r, 1500));
    expect(novaPosts).toHaveLength(before);
    const added = docker("logs", NAME).slice(asteriskLogBefore.length);
    expect(added).not.toMatch(/ty1@flexisip|im1@flexisip|fl1@flexisip/);
    expect(relay.status()).toMatchObject({
      answered: 3,
      dropped: 3,
      unreadable: 1,
    });
    // plain text still goes through untouched
    reply = "";
    send(messageRequest("text/plain;charset=UTF-8", "gewone tekst", "pl1"));
    await waitSeen(() => novaPosts.length === before + 1);
    expect(novaPosts.at(-1)).toMatchObject({
      type: "text/plain;charset=UTF-8",
      body: "gewone tekst",
    });
  }, 60_000);

  it("re-registers by itself after the relay restarts (NOVA redeploy)", async () => {
    const registers = () =>
      flexisip
        .requests("REGISTER")
        .filter((s) =>
          s.message.headers.some((h) => h.name === "authorization"),
        ).length;
    const before = registers();
    await relay.stop();
    await new Promise((r) => setTimeout(r, 3000));
    const started = Date.now();
    await startRelay();
    await waitSeen(() => registers() > before, 90_000);
    console.log(
      `re-registered ${Math.round((Date.now() - started) / 1000)}s after the relay came back`,
    );
    expect(Date.now() - started).toBeLessThan(45_000);
    reply = "";
    send(
      messageRequest(
        "message/cpim",
        cpim("text/plain;charset=UTF-8", "na herstart"),
        "rs1",
      ),
    );
    await waitSeen(
      () => novaPosts.some((p) => p.body === "na herstart"),
      30_000,
    );
  }, 150_000);
});
