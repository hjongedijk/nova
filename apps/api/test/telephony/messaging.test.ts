import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  chatText,
  MessageAuthError,
  messageText,
  sipAddress,
  TelephonyMessaging,
} from "../../src/telephony/messaging.js";
import {
  renderExtensions,
  renderPjsip,
  assertValid,
  messagingEnabled,
} from "../../src/telephony/asterisk-config.js";
import {
  defaultConfig,
  TelephonyStore,
} from "../../src/telephony/telephony.store.js";
import type { NovaConfig } from "../../src/core/config/nova-config.js";
import type { TelephonyConfig } from "../../src/telephony/telephony.types.js";

delete process.env.COREPACK_ENABLE_AUTO_PIN;
let dir: string;
const audits: Record<string, unknown>[] = [];
const runs: Record<string, unknown>[] = [];
const remembered: [string, string, string][] = [];
let reply: () => Promise<Record<string, unknown>>;

function boot(contacts?: TelephonyConfig["contacts"]) {
  const cfg = {
    dataFile: (n: string) => path.join(dir, n),
    defaultLanguage: "nl-NL",
  } as unknown as NovaConfig;
  const store = new TelephonyStore(cfg);
  store.update((d) => {
    d.trunk = {
      host: "sip.linphone.org",
      username: "nova-techlepp",
      secret: "geheim-wachtwoord",
      number: "",
      allowExtensionsToDialOut: false,
    };
    d.contacts = contacts ?? [
      {
        name: "Harm",
        sip: "hjongedijk@sip.linphone.org",
        allowConversation: true,
      },
    ];
  });
  const orchestrator = {
    run: vi.fn(async (input: Record<string, unknown>) => {
      runs.push(input);
      return reply();
    }),
  };
  const service = new TelephonyMessaging(
    store,
    orchestrator as never,
    { record: (r: Record<string, unknown>) => audits.push(r) } as never,
    cfg,
    {
      add: (s: string, r: string, c: string) => remembered.push([s, r, c]),
    } as never,
  );
  return { service, store, orchestrator };
}
const ok = (text: string) => async () => ({ reply: text });

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "nova-msg-"));
  audits.length = 0;
  runs.length = 0;
  remembered.length = 0;
  reply = ok("Het is 14 graden en bewolkt.");
});
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

const msg = (b: ReturnType<typeof boot>, over: Record<string, unknown> = {}) =>
  b.service.handle({
    token: b.store.get().messageToken,
    from: '"Harm" <sip:hjongedijk@sip.linphone.org;gr=urn:uuid:1>',
    type: "text/plain;charset=UTF-8",
    body: "Wat is het weer?",
    ...over,
  });

describe("message parsing", () => {
  it("reads plain text, unwraps CPIM and ignores everything else", () => {
    expect(messageText("text/plain; charset=UTF-8", " Hallo ")).toBe("Hallo");
    const cpim =
      "From: <sip:a@b>\r\nTo: <sip:c@d>\r\nNS: imdn <urn:ietf:params:imdn>\r\n\r\nContent-Type: text/plain;charset=UTF-8\r\nContent-Length: 5\r\n\r\nHoi!";
    expect(messageText("message/cpim", cpim)).toBe("Hoi!");
    expect(messageText("application/im-iscomposing+xml", "<x/>")).toBeNull();
    expect(messageText("message/imdn+xml", "<imdn/>")).toBeNull();
    expect(messageText("text/plain", "   ")).toBeNull();
    expect(
      messageText(
        "message/cpim",
        "From: x\r\n\r\nContent-Type: application/octet-stream\r\n\r\nzz",
      ),
    ).toBeNull();
    expect(messageText("", "x")).toBeNull();
  });
  it("normalises sender addresses", () => {
    expect(
      sipAddress('"Harm" <sip:HJongedijk@sip.linphone.org;gr=urn:uuid:1>'),
    ).toBe("hjongedijk@sip.linphone.org");
    expect(sipAddress("sip:hjongedijk@sip.linphone.org")).toBe(
      "hjongedijk@sip.linphone.org",
    );
    expect(sipAddress("garbage")).toBeNull();
  });
  it("cleans markdown and keeps replies short", () => {
    const sample = ["**Hoi** `x`", "```js", "let a", "```", "# Kop | a"].join(
      "\n",
    );
    expect(chatText(sample)).toBe("Hoi `x`\nKop / a");
    expect(chatText("woord. ".repeat(300)).length).toBeLessThanOrEqual(905);
  });
});

describe("answering text messages", () => {
  it("rejects a wrong or missing token", async () => {
    const b = boot();
    await expect(msg(b, { token: "nope" })).rejects.toBeInstanceOf(
      MessageAuthError,
    );
    await expect(msg(b, { token: undefined })).rejects.toBeInstanceOf(
      MessageAuthError,
    );
    expect(runs).toHaveLength(0);
  });

  it("stays silent for unknown senders, contacts without permission, and non-text messages", async () => {
    const b = boot();
    expect(await msg(b, { from: "sip:stranger@sip.linphone.org" })).toBe("");
    expect(await msg(b, { from: "sip:hjongedijk@evil.example" })).toBe("");
    expect(await msg(b, { type: "application/im-iscomposing+xml" })).toBe("");
    const off = boot([
      {
        name: "Harm",
        sip: "hjongedijk@sip.linphone.org",
        allowConversation: false,
      },
    ]);
    expect(await msg(off)).toBe("");
    expect(runs).toHaveLength(0);
    expect(audits.filter((a) => a.phase === "rejected")).toHaveLength(3);
  });

  it("never carries out something that needs a confirmation, and survives failures", async () => {
    const b = boot();
    reply = async () => ({
      reply: "Zal ik de deur openen?",
      confirmation: { id: "c" },
    });
    expect(await msg(b)).toContain("op het scherm bevestigen");
    reply = async () => {
      throw new Error("model down");
    };
    expect(await msg(b)).toContain("ging iets mis");
  });

  it("answers one message per contact at a time and limits the rate", async () => {
    const b = boot();
    let release!: () => void;
    reply = () =>
      new Promise((resolve) => (release = () => resolve({ reply: "klaar" })));
    const first = msg(b);
    await vi.waitFor(() => expect(runs).toHaveLength(1));
    expect(await msg(b)).toContain("nog bezig");
    release();
    expect(await first).toContain("klaar");
    reply = ok("ja");
    for (let i = 0; i < 12; i++) await msg(b);
    expect(await msg(b)).toContain("erg snel");
  });

  it("remembers the exchange so the next message has context, but not a failed turn", async () => {
    const b = boot();
    await msg(b, { body: "Wat is het weer?" });
    expect(remembered).toEqual([
      ["sipchat_harm", "user", "Wat is het weer?"],
      ["sipchat_harm", "assistant", "Het is 14 graden en bewolkt."],
    ]);
    remembered.length = 0;
    reply = async () => ({ reply: "x", unavailable: true });
    await msg(b, { body: "nog een vraag" });
    expect(remembered).toEqual([]);
  });

  it("audits metadata only, never the text", async () => {
    const b = boot();
    await msg(b, { body: "geheime vraag over mijn pincode 1234" });
    expect(JSON.stringify(audits)).not.toContain("pincode");
    expect(audits.some((a) => a.phase === "answered")).toBe(true);
  });
});

describe("dialplan for text messages", () => {
  const config = (): TelephonyConfig => ({
    ...defaultConfig(),
    enabled: true,
    messageToken: "T0ken_abcdefghijklmnop",
    trunk: {
      host: "sip.linphone.org",
      username: "nova-techlepp",
      secret: "geheim-wachtwoord",
      number: "",
      allowExtensionsToDialOut: false,
    },
    contacts: [
      {
        name: "Harm",
        sip: "hjongedijk@sip.linphone.org",
        allowConversation: true,
      },
    ],
  });

  it("routes messages to NOVA only when a contact may talk to NOVA", () => {
    const on = renderExtensions(config());
    expect(on).toContain("[nova-message]");
    expect(on).toContain(
      "CURL(http://nova:8080/api/integrations/asterisk/message,token=T0ken_abcdefghijklmnop&",
    );
    expect(on).toContain(
      "MessageSend(pjsip:trunk/${CUT(REPLY,|,1)},sip:nova-techlepp@sip.linphone.org)",
    );
    expect(renderPjsip(config())).toContain("message_context=nova-message");
    const off = {
      ...config(),
      contacts: [
        {
          name: "Harm",
          sip: "hjongedijk@sip.linphone.org",
          allowConversation: false,
        },
      ],
    };
    expect(messagingEnabled(off)).toBe(false);
    expect(renderExtensions(off)).not.toContain("nova-message");
    expect(renderPjsip(off)).not.toContain("message_context");
  });

  it("refuses an injectable token or address", () => {
    expect(() =>
      assertValid({ ...config(), messageToken: "x\nexten => 1,1,System(x)" }),
    ).toThrow(/geheim/);
    expect(() => assertValid({ ...config(), messageToken: undefined })).toThrow(
      /geheim/,
    );
    expect(() => assertValid(config(), "http://evil.example/steal?x")).toThrow(
      /tekstberichten/,
    );
    expect(() =>
      assertValid(
        config(),
        "http://nova:8080/api/integrations/asterisk/message",
      ),
    ).not.toThrow();
  });

  it("generates and keeps a token for an older telephony.json", () => {
    const cfg = {
      dataFile: (n: string) => path.join(dir, n),
    } as unknown as NovaConfig;
    fs.writeFileSync(
      path.join(dir, "telephony.json"),
      JSON.stringify({
        version: 1,
        enabled: true,
        ariSecret: "x".repeat(20),
        extensions: [],
        trunk: null,
        ringExtensions: [],
      }),
      { mode: 0o600 },
    );
    const first = new TelephonyStore(cfg).get().messageToken;
    expect(first).toMatch(/^[A-Za-z0-9_-]{16,}$/);
    expect(new TelephonyStore(cfg).get().messageToken).toBe(first);
  });
});

describe("private mood tags never reach the phone", () => {
  it("strips NOVA_MOOD tags, including a misspelled one, from text replies", () => {
    expect(
      chatText("<!--NOVA_MOOD:NEUTRAL-->Hallo, hoe kan ik je helpen?"),
    ).toBe("Hallo, hoe kan ik je helpen?");
    expect(chatText("<!--NOVA_MOED:NEUTRAL-->Hallo!")).toBe("Hallo!");
    expect(chatText("Hoi <!-- NOVA_MOOD:happy --> daar")).toBe("Hoi daar");
  });
});
