import { execFileSync } from "node:child_process";
import dgram from "node:dgram";
import fs from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { renderExtensions } from "../../src/telephony/asterisk-config.js";
import { defaultConfig } from "../../src/telephony/telephony.store.js";

/**
 * A real Asterisk 22 container receives raw SIP MESSAGEs, the generated [nova-message] dialplan posts them to a fake NOVA
 * endpoint and sends the answer back as a SIP MESSAGE. Opt-in: NOVA_TEST_ASTERISK=1 (needs Docker and andrius/asterisk:22).
 */
const enabled = process.env.NOVA_TEST_ASTERISK === "1";
const NAME = `nova-test-msg-${process.pid}`;
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "nova-ast-msg-"));
const SIP_PORT = 15060;
const TEST_PORT = 15099;
const docker = (...args: string[]) =>
  execFileSync("docker", args, { encoding: "utf8", timeout: 60_000 });

describe.skipIf(!enabled)("real Asterisk text messages", () => {
  const seen: Record<string, string>[] = [];
  let replyFor: (post: Record<string, string>) => string = () => "";
  let server: http.Server;
  let socket: dgram.Socket;
  const received: string[] = [];

  beforeAll(async () => {
    server = http.createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on("data", (c: Buffer) => chunks.push(c));
      req.on("end", () => {
        const post = Object.fromEntries(
          new URLSearchParams(Buffer.concat(chunks).toString("utf8")),
        );
        seen.push(post);
        res.writeHead(200, { "content-type": "text/plain; charset=utf-8" });
        res.end(replyFor(post));
      });
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const novaPort = (server.address() as AddressInfo).port;

    socket = dgram.createSocket("udp4");
    await new Promise<void>((r) => socket.bind(TEST_PORT, "127.0.0.1", r));
    socket.on("message", (data, rinfo) => {
      const text = data.toString("utf8");
      if (text.startsWith("MESSAGE ")) {
        received.push(text);
        const via = /^Via:.*$/im.exec(text)![0];
        const from = /^From:.*$/im.exec(text)![0];
        const to = /^To:.*$/im.exec(text)![0];
        const callId = /^Call-ID:.*$/im.exec(text)![0];
        const cseq = /^CSeq:.*$/im.exec(text)![0];
        socket.send(
          `SIP/2.0 200 OK\r\n${via}\r\n${from}\r\n${to};tag=t1\r\n${callId}\r\n${cseq}\r\nContent-Length: 0\r\n\r\n`,
          rinfo.port,
          rinfo.address,
        );
      }
    });

    const config = {
      ...defaultConfig(),
      enabled: true,
      messageToken: "LabToken_abcdefghijkl",
      trunk: {
        host: "sip.linphone.org",
        username: "nova-techlepp",
        secret: "geheim-wachtwoord",
        number: "",
        allowExtensionsToDialOut: false,
      },
      contacts: [
        {
          name: "Tester",
          sip: "tester@sip.linphone.org",
          allowConversation: true,
        },
      ],
    };
    fs.writeFileSync(
      path.join(dir, "extensions.conf"),
      renderExtensions(
        config,
        null,
        `http://127.0.0.1:${novaPort}/api/integrations/asterisk/message`,
      ),
    );
    fs.writeFileSync(
      path.join(dir, "pjsip.conf"),
      [
        "[transport-udp]",
        "type=transport",
        "protocol=udp",
        `bind=127.0.0.1:${SIP_PORT}`,
        "[trunk]",
        "type=aor",
        `contact=sip:127.0.0.1:${TEST_PORT}`,
        "[trunk]",
        "type=endpoint",
        "context=nova-trunk-in",
        "message_context=nova-message",
        "disallow=all",
        "allow=ulaw",
        "aors=trunk",
        "[trunk]",
        "type=identify",
        "endpoint=trunk",
        "match=127.0.0.1",
        "",
      ].join("\n"),
    );
    docker(
      "run",
      "-d",
      "--rm",
      "--name",
      NAME,
      "--network",
      "host",
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
    try {
      docker("rm", "-f", NAME);
    } catch {
      /* gone */
    }
    socket?.close();
    await new Promise<void>((r) => (server ? server.close(() => r()) : r()));
    fs.rmSync(dir, { recursive: true, force: true });
  });

  const send = (
    type: string,
    body: string,
    from = `"Tester" <sip:tester@sip.linphone.org;gr=urn:uuid:abc>`,
  ) =>
    new Promise<string>((resolve) => {
      const n = Math.random().toString(36).slice(2, 10);
      const length = Buffer.byteLength(body);
      const text = [
        `MESSAGE sip:nova-techlepp@sip.linphone.org SIP/2.0`,
        `Via: SIP/2.0/UDP 127.0.0.1:${TEST_PORT};branch=z9hG4bK${n};rport`,
        "Max-Forwards: 70",
        `From: ${from};tag=${n}`,
        "To: <sip:nova-techlepp@sip.linphone.org>",
        `Call-ID: ${n}@127.0.0.1`,
        "CSeq: 1 MESSAGE",
        `Content-Type: ${type}`,
        `Content-Length: ${length}`,
        "",
        body,
      ].join("\r\n");
      const once = (data: Buffer) => {
        const t = data.toString("utf8");
        if (t.startsWith("SIP/2.0") && t.includes(`${n}@127.0.0.1`)) {
          socket.off("message", once);
          resolve(t.split("\r\n")[0]!);
        }
      };
      socket.on("message", once);
      socket.send(text, SIP_PORT, "127.0.0.1");
    });

  it("accepts the message, posts it to NOVA with the token, and sends NOVA's answer back as a SIP MESSAGE", async () => {
    replyFor = () =>
      `sip:tester@127.0.0.1:${TEST_PORT}|Het is 14 graden, "bewolkt" en €5 kost {niets}; 100% zeker.`;
    expect(
      await send(
        "text/plain;charset=UTF-8",
        "Wat is het weer, vandaag? Kost $5 {x}",
      ),
    ).toContain("202");
    await vi.waitFor(() => expect(seen).toHaveLength(1), { timeout: 15_000 });
    expect(seen[0]).toMatchObject({
      token: "LabToken_abcdefghijkl",
      type: "text/plain;charset=UTF-8",
      body: "Wat is het weer, vandaag? Kost $5 {x}",
    });
    expect(seen[0]!.from).toContain("sip:tester@sip.linphone.org");
    await vi.waitFor(() => expect(received).toHaveLength(1), {
      timeout: 15_000,
    });
    const message = received[0]!;
    expect(message).toMatch(/^MESSAGE sip:tester@127\.0\.0\.1:15099/);
    expect(message).toMatch(/Content-Type: text\/plain/i);
    expect(message).toContain(
      `Het is 14 graden, "bewolkt" en €5 kost {niets}; 100% zeker.`,
    );
    expect(message).toMatch(/^From: .*sip:nova-techlepp@sip\.linphone\.org/im);
  }, 60_000);

  it("reports how Asterisk treats other content types (diagnostic)", async () => {
    replyFor = () => "";
    const out: Record<string, string> = {};
    for (const [type, body] of [
      ["application/im-iscomposing+xml", "<isComposing/>"],
      [
        "message/cpim",
        "From: <sip:tester@sip.linphone.org>\r\n\r\nContent-Type: text/plain;charset=UTF-8\r\n\r\nHoi!",
      ],
      ["message/imdn+xml", "<imdn/>"],
      ["text/html", "<b>x</b>"],
    ] as const) {
      out[type] = await send(type, body);
      await new Promise((r) => setTimeout(r, 800));
    }
    console.log(
      "CONTENT-TYPE RESPONSES",
      JSON.stringify(out),
      "reached NOVA:",
      JSON.stringify(seen.map((s) => s.type)),
    );
    expect(out["application/im-iscomposing+xml"]).toBeDefined();
  }, 60_000);
});
