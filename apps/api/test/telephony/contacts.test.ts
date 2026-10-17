import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { encodeWav16k } from "../../src/telephony/announce.js";
import {
  assertValid,
  renderAll,
  renderExtensions,
  renderPjsip,
} from "../../src/telephony/asterisk-config.js";
import { TelephonyService } from "../../src/telephony/telephony.service.js";
import {
  defaultConfig,
  TelephonyStore,
} from "../../src/telephony/telephony.store.js";
import type { NovaConfig } from "../../src/core/config/nova-config.js";
import { FakeAri } from "./fake-ari.js";

delete process.env.COREPACK_ENABLE_AUTO_PIN;
const UUID = "11111111-2222-3333-4444-555555555555";
const plan = { host: "nova", port: 8093, uuid: UUID };
let dir: string;
let ari: FakeAri;
let service: TelephonyService;
let store: TelephonyStore;
const conversation = {
  dialplan: vi.fn(
    () => plan as { host: string; port: number; uuid: string } | null,
  ),
  onChange: vi.fn(),
  sttProblem: vi.fn(() => null as string | null),
  expectOutbound: vi.fn(),
  cancelOutbound: vi.fn(),
};

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "nova-contacts-"));
  Object.values(conversation).forEach((f) => f.mockClear());
  conversation.dialplan.mockReturnValue(plan);
  conversation.sttProblem.mockReturnValue(null);
  store = new TelephonyStore({
    dataFile: (n: string) => path.join(dir, n),
  } as unknown as NovaConfig);
  ari = new FakeAri();
  service = new TelephonyService(
    store,
    ari,
    { emit: () => undefined } as never,
    {
      speakProfile: async () => ({
        audio: Buffer.from("x"),
        contentType: "audio/mpeg",
      }),
    } as never,
    async () => encodeWav16k(new Int16Array([0, 1000, -1000, 0])),
    conversation as never,
  );
  service.setEnabled(true);
  service.setTrunk({
    host: "sip.linphone.org",
    username: "nova-bot",
    secret: "geheim-wachtwoord",
    number: "",
    allowExtensionsToDialOut: false,
  });
});
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

describe("contacts on the Linphone trunk", () => {
  it("accepts the user's Linphone address and resolves it by name, address and sip: form", () => {
    service.setContacts([
      {
        name: "Dylan",
        sip: "hjongedijk@sip.linphone.org",
        allowConversation: false,
      },
    ]);
    for (const asked of [
      "Dylan",
      "dylan",
      "hjongedijk@sip.linphone.org",
      "sip:hjongedijk@sip.linphone.org",
      " DYLAN ",
    ])
      expect(service.classify(asked), asked).toEqual({
        kind: "external",
        number: "Dylan",
        endpoint: "PJSIP/hjongedijk@trunk",
      });
    expect(service.classify("Onbekend")).toBeNull();
  });

  it("resolves 'me' to the only saved contact, never when there are several", () => {
    service.setContacts([
      { name: "Dylan", sip: "a@sip.linphone.org", allowConversation: false },
    ]);
    expect(service.classify("me")?.number).toBe("Dylan");
    service.setContacts([
      { name: "Dylan", sip: "a@sip.linphone.org", allowConversation: false },
      { name: "Anna", sip: "b@sip.linphone.org", allowConversation: false },
    ]);
    expect(service.classify("me")).toBeNull();
  });

  it("refuses contacts on another domain, bad names, duplicates and anything without a trunk", () => {
    expect(() =>
      service.setContacts([
        { name: "X", sip: "x@evil.example", allowConversation: false },
      ]),
    ).toThrow(/trunk/i);
    expect(() =>
      service.setContacts([
        {
          name: "Bad\nname",
          sip: "a@sip.linphone.org",
          allowConversation: false,
        },
      ]),
    ).toThrow();
    expect(() =>
      service.setContacts([
        { name: "A", sip: "a@sip.linphone.org;x", allowConversation: false },
      ]),
    ).toThrow();
    expect(() =>
      service.setContacts([
        { name: "A", sip: "a@sip.linphone.org", allowConversation: false },
        { name: "a", sip: "b@sip.linphone.org", allowConversation: false },
      ]),
    ).toThrow(/dubbel/);
    service.setTrunk(null);
    expect(() =>
      service.setContacts([
        { name: "A", sip: "a@sip.linphone.org", allowConversation: false },
      ]),
    ).toThrow();
  });

  it("drops contacts when the trunk host changes or the trunk is removed", () => {
    service.setContacts([
      {
        name: "Dylan",
        sip: "hjongedijk@sip.linphone.org",
        allowConversation: true,
      },
    ]);
    service.setTrunk({
      host: "sip.other.example",
      username: "nova",
      secret: "geheim-wachtwoord",
      number: "",
      allowExtensionsToDialOut: false,
    });
    expect(store.get().contacts).toEqual([]);
  });

  it("calls a contact through the trunk with the message", async () => {
    service.setContacts([
      {
        name: "Dylan",
        sip: "hjongedijk@sip.linphone.org",
        allowConversation: false,
      },
    ]);
    const result = await service.call("Dylan", "De wasmachine is klaar.");
    expect(result).toMatchObject({ kind: "external", to: "Dylan" });
    expect(ari.commands.find((c) => c.op === "originate")).toMatchObject({
      endpoint: "PJSIP/hjongedijk@trunk",
      app: "nova",
    });
  });

  it("calls a contact and talks: dialplan origination, opening line handed to the conversation", async () => {
    service.setContacts([
      {
        name: "Dylan",
        sip: "hjongedijk@sip.linphone.org",
        allowConversation: false,
      },
    ]);
    await service.call("Dylan", "Hoi, ik bel over je afspraak van vanmiddag.", {
      conversation: true,
    });
    const call = ari.commands.find((c) => c.op === "originate")!;
    expect(call).toMatchObject({
      endpoint: "PJSIP/hjongedijk@trunk",
      context: "nova-converse",
      extension: "s",
    });
    expect(call.app).toBeUndefined();
    expect(conversation.expectOutbound).toHaveBeenCalledWith(
      "Hoi, ik bel over je afspraak van vanmiddag.",
    );
  });

  it("will not start a conversation call while conversations or speech recognition are off, and cleans up on failure", async () => {
    service.setContacts([
      {
        name: "Dylan",
        sip: "hjongedijk@sip.linphone.org",
        allowConversation: false,
      },
    ]);
    conversation.dialplan.mockReturnValue(null);
    await expect(
      service.call("Dylan", "Hoi", { conversation: true }),
    ).rejects.toThrow(/Gesprekken staan uit/);
    conversation.dialplan.mockReturnValue(plan);
    conversation.sttProblem.mockReturnValue(
      "Spraakherkenning is niet ingesteld",
    );
    await expect(
      service.call("Dylan", "Hoi", { conversation: true }),
    ).rejects.toThrow(/Spraakherkenning/);
    conversation.sttProblem.mockReturnValue(null);
    ari.failOriginate = true;
    await expect(
      service.call("Dylan", "Hoi", { conversation: true }),
    ).rejects.toThrow();
    expect(conversation.cancelOutbound).toHaveBeenCalled();
  });
});

describe("dialplan for the trunk and contacts", () => {
  const base = () => {
    const config = {
      ...defaultConfig(),
      enabled: true,
      trunk: {
        host: "sip.linphone.org",
        username: "nova-bot",
        secret: "geheim-wachtwoord",
        number: "",
        allowExtensionsToDialOut: false,
      },
      contacts: [
        {
          name: "Dylan",
          sip: "hjongedijk@sip.linphone.org",
          allowConversation: true,
        },
        {
          name: "Buur",
          sip: "buur@sip.linphone.org",
          allowConversation: false,
        },
      ],
    };
    return config;
  };

  it("lets only an allowed contact into the conversation; everyone else keeps the alert-and-ring path", () => {
    const text = renderExtensions(base(), plan);
    expect(text).toContain("[nova-trunk-in]");
    expect(text).toContain(
      'GotoIf($["${CALLERID(num)}"="hjongedijk"]?converse)',
    );
    expect(text).not.toContain('"buur"');
    expect(text).toContain("Stasis(nova,external)");
    expect(text).toContain("same => n(converse),Answer()");
    expect(text).toContain(`AudioSocket(${UUID},nova:8093)`);
    expect(text).toContain("[nova-converse]");
    expect(text).toMatch(/exten => _\.,1/);
  });

  it("has no conversation entries while conversations are off", () => {
    const text = renderExtensions(base(), null);
    expect(text).not.toContain("AudioSocket");
    expect(text).not.toContain("converse");
    expect(text).toContain("Stasis(nova,external)");
  });

  it("validates contacts at render time so a bad entry never reaches Asterisk", () => {
    const bad = {
      ...base(),
      contacts: [
        {
          name: "X",
          sip: "x@sip.linphone.org\nexten => 1,1,System(x)",
          allowConversation: true,
        },
      ],
    };
    expect(() => assertValid(bad)).toThrow();
    expect(() => renderAll(bad, undefined, plan)).toThrow();
    expect(() => assertValid({ ...base(), trunk: null })).toThrow();
  });

  it("encrypts trunk audio with SDES-SRTP, as Linphone requires, and leaves LAN phones unchanged", () => {
    const config = {
      ...base(),
      extensions: [
        {
          id: "101",
          name: "Laptop",
          kind: "phone" as const,
          secret: "geheim-wachtwoord",
          createdAt: "2026-10-16T00:00:00.000Z",
        },
      ],
    };
    const pjsip = renderPjsip(config);
    const trunkBlock = pjsip.slice(
      pjsip.indexOf("[trunk]\ntype=endpoint"),
      pjsip.indexOf("[trunk]", pjsip.indexOf("[trunk]\ntype=endpoint") + 10),
    );
    expect(trunkBlock).toContain("media_encryption=sdes");
    expect(pjsip.match(/media_encryption=sdes/g)).toHaveLength(1);
  });

  it("registers the trunk with the Linphone account", () => {
    const pjsip = renderPjsip(base());
    expect(pjsip).toContain("server_uri=sip:sip.linphone.org");
    expect(pjsip).toContain("client_uri=sip:nova-bot@sip.linphone.org");
  });
});
