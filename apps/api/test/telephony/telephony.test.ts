import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Module } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { ConfirmationsService } from "../../src/confirmations/confirmations.service.js";
import { CoreModule } from "../../src/core/core.module.js";
import { NovaConfig } from "../../src/core/config/nova-config.js";
import { JarvisStateStore } from "../../src/planning/jarvis-state.store.js";
import {
  assertValid,
  renderAll,
  renderExtensions,
  renderPjsip,
  validExtensionId,
} from "../../src/telephony/asterisk-config.js";
import {
  encodeWav16k,
  parseWav,
  resampleTo16k,
} from "../../src/telephony/announce.js";
import { validateAriUrl } from "../../src/telephony/ari.client.js";
import { linphoneProvisioning } from "../../src/telephony/linphone.js";
import { TelephonyService } from "../../src/telephony/telephony.service.js";
import { TelephonySource } from "../../src/telephony/telephony.source.js";
import {
  defaultConfig,
  TelephonyStore,
} from "../../src/telephony/telephony.store.js";
import {
  ARI_PORT,
  type TelephonyConfig,
} from "../../src/telephony/telephony.types.js";
import { ToolsModule } from "../../src/tools/tools.module.js";
import { AutonomyLevelStore } from "../../src/tools/autonomy-level.store.js";
import { ToolsService } from "../../src/tools/tools.service.js";
import { FakeAri } from "./fake-ari.js";

// Short env values such as COREPACK_ENABLE_AUTO_PIN=0 would make the secret redactor mangle digits.
delete process.env.COREPACK_ENABLE_AUTO_PIN;
const emitted: Array<{ topic: string; payload: Record<string, unknown> }> = [];
const state = { emit: (e: (typeof emitted)[number]) => emitted.push(e) };
const speak = vi.fn(async () => ({
  audio: Buffer.from("mp3"),
  contentType: "audio/mpeg",
}));
const tts = { speakProfile: speak };
const decoder = vi.fn(async () =>
  encodeWav16k(new Int16Array([0, 1000, -1000, 0])),
);

let dir: string;
let ari: FakeAri;
let store: TelephonyStore;
let service: TelephonyService;

function boot() {
  const config = {
    dataFile: (name: string) => path.join(dir, name),
  } as unknown as NovaConfig;
  store = new TelephonyStore(config);
  ari = new FakeAri();
  service = new TelephonyService(
    store,
    ari,
    state as unknown as JarvisStateStore,
    tts as never,
    decoder,
  );
}

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "nova-tel-"));
  emitted.length = 0;
  speak.mockClear();
  decoder.mockClear();
  boot();
});

const sample = (): TelephonyConfig => ({
  ...defaultConfig(),
  enabled: true,
  extensions: [
    {
      id: "101",
      name: "Laptop",
      kind: "phone",
      secret: "s3cretS3cretS3cret",
      createdAt: "",
    },
    {
      id: "801",
      name: "Voordeur",
      kind: "doorbell",
      secret: "d00rb3llSecretXyz",
      createdAt: "",
    },
  ],
});

describe("Asterisk configuration", () => {
  it("renders private-only endpoints with generated secrets and no default password", () => {
    const a = defaultConfig();
    const b = defaultConfig();
    expect(a.ariSecret).not.toBe(b.ariSecret);
    expect(a.ariSecret.length).toBeGreaterThanOrEqual(20);
    const pjsip = renderPjsip(sample());
    expect(pjsip).toContain("[101]\ntype=endpoint");
    expect(pjsip).toContain("deny=0.0.0.0/0\npermit=10.0.0.0/8");
    expect(pjsip).not.toContain("type=acl");
    expect(pjsip).toContain("context=nova-doorbell");
    expect(pjsip).not.toMatch(/password=(password|secret|1234|admin)\b/i);
  });

  it("routes only known extensions, NOVA and the doorbell; trunk dial-out is opt-in", () => {
    const plan = renderExtensions(sample());
    expect(plan).toContain("exten => 700,1,Stasis(nova,inbound)");
    expect(plan).toContain("exten => 710,1,Stasis(nova,doorbell)");
    expect(plan).toContain("exten => 101,1,Dial(PJSIP/101,30)");
    expect(plan).not.toContain("PJSIP/801,30");
    expect(plan).not.toContain("@trunk");
    const withTrunk = {
      ...sample(),
      trunk: {
        host: "sip.example.net",
        username: "u1",
        secret: "trunkSecret123",
        number: "",
        allowExtensionsToDialOut: true,
      },
    };
    expect(renderExtensions(withTrunk)).toContain(
      "Dial(PJSIP/${EXTEN}@trunk,60)",
    );
    expect(renderPjsip(withTrunk)).toContain("type=registration");
  });

  it("writes the file set, ARI user, RTP range and keeps AMI off", () => {
    const files = renderAll(sample(), { start: 10000, end: 10100 });
    expect(Object.keys(files).sort()).toEqual([
      "ari.conf",
      "extensions.conf",
      "http.conf",
      "manager.conf",
      "modules.conf",
      "pjsip.conf",
      "rtp.conf",
    ]);
    expect(files["rtp.conf"]).toContain("rtpstart=10000");
    expect(files["manager.conf"]).toContain("enabled=no");
    expect(files["ari.conf"]).toContain("password=");
  });

  it("refuses values that could inject config lines", () => {
    const bad = sample();
    bad.extensions[0]!.secret = "abc\n[evil]\ntype=endpoint";
    expect(() => assertValid(bad)).toThrow();
    const trunk = sample();
    trunk.trunk = {
      host: "x.example.net\n[x]",
      username: "u",
      secret: "longenough1",
      number: "",
      allowExtensionsToDialOut: false,
    };
    expect(() => assertValid(trunk)).toThrow();
    expect(validExtensionId("700")).toBe(false);
    expect(validExtensionId("12")).toBe(false);
    expect(validExtensionId("101")).toBe(true);
    const named = sample();
    named.extensions[0]!.name = 'x" <999>\nallow=all';
    expect(renderPjsip(named)).not.toContain("<999>\n");
    expect(
      renderPjsip(named)
        .split("\n")
        .filter((l) => l.startsWith("allow=")),
    ).toHaveLength(2);
  });

  it("only accepts a private ARI URL", () => {
    expect(validateAriUrl("http://127.0.0.1:8088").hostname).toBe("127.0.0.1");
    expect(validateAriUrl("http://asterisk:8088").hostname).toBe("asterisk");
    expect(() => validateAriUrl("http://evil.example.com:8088")).toThrow();
    expect(() => validateAriUrl("https://127.0.0.1:8088")).toThrow();
    expect(() => validateAriUrl("http://u:p@127.0.0.1:8088")).toThrow();
  });
});

describe("Linphone provisioning", () => {
  it("generates an XML for one extension and escapes values", () => {
    const xml = linphoneProvisioning(
      { id: "101", name: 'A&B "x"', secret: "pa<ss>" },
      "192.168.1.5",
    );
    expect(xml).toContain("sip:192.168.1.5:5060;transport=udp");
    expect(xml).toContain("sip:101@192.168.1.5");
    expect(xml).toContain("pa&lt;ss&gt;");
    expect(xml).toContain("A&amp;B &quot;x&quot;");
  });

  it("hands out the file only through a short-lived one-time link", () => {
    service.setEnabled(false);
    const ext = service.addExtension("Telefoon");
    expect(() => service.createProvisioningLink(ext.id)).toThrow(/adres/);
    service.setPublicHost("nova.lan");
    const { token } = service.createProvisioningLink(ext.id);
    const xml = service.redeemProvisioningLink(token)!;
    expect(xml).toContain(`sip:${ext.id}@nova.lan`);
    expect(service.redeemProvisioningLink(token)).toBeNull();
    const second = service.createProvisioningLink(ext.id);
    service.now = () => Date.now() + 11 * 60_000;
    expect(service.redeemProvisioningLink(second.token)).toBeNull();
    service.now = () => Date.now();
  });

  it("never lists secrets in the public extension view", () => {
    service.addExtension("Telefoon");
    expect(JSON.stringify(service.listExtensions())).not.toMatch(/secret/i);
  });
});

describe("TelephonyService", () => {
  it("is off by default and does not touch Asterisk", async () => {
    expect(service.enabled).toBe(false);
    service.onModuleInit();
    expect(ari.ops("start")).toHaveLength(0);
    const status = await service.status();
    expect(status.enabled).toBe(false);
    await expect(service.call("101", "hoi")).rejects.toThrow(/uit/);
    expect(fs.existsSync(store.confDir)).toBe(false);
  });

  it("enabling renders config, starts ARI and reports status with registered endpoints", async () => {
    const ext = service.addExtension("Laptop");
    service.setEnabled(true);
    expect(ari.ops("start")).toHaveLength(1);
    expect(
      fs.readFileSync(path.join(store.confDir, "pjsip.conf"), "utf8"),
    ).toContain(`[${ext.id}]`);
    expect(
      fs.statSync(path.join(store.confDir, "pjsip.conf")).mode & 0o777,
    ).toBe(0o600);
    ari.endpointList = [
      {
        technology: "PJSIP",
        resource: ext.id,
        state: "online",
        channel_ids: [],
      },
    ];
    const status = await service.status();
    expect(status.connected).toBe(true);
    expect(status.version).toBe("22.11.0");
    expect(status.extensions[0]).toMatchObject({ id: ext.id, state: "online" });
    expect(JSON.stringify(status)).not.toContain(store.get().ariSecret);
    ari.up = false;
    expect((await service.status()).connected).toBe(false);
  });

  it("originates an announcement call, plays the TTS file on answer and hangs up afterwards", async () => {
    const ext = service.addExtension("Laptop");
    service.setEnabled(true);
    const result = await service.call(
      ext.id,
      "Er staat een pakket voor de deur",
    );
    expect(result.kind).toBe("internal");
    const origin = ari.ops("originate")[0]!;
    expect(origin.endpoint).toBe(`PJSIP/${ext.id}`);
    expect(String(origin.appArgs)).toMatch(/^announce,[0-9a-f]{24}$/);
    expect(String(origin.appArgs)).not.toContain("pakket");
    const files = fs.readdirSync(path.join(store.recordingDir, "nova"));
    expect(files).toHaveLength(1);
    await service.handle({
      type: "StasisStart",
      channel: {
        id: result.callId,
        name: "",
        state: "Up",
        caller: { name: "", number: "" },
      },
      args: String(origin.appArgs).split(","),
    });
    const play = ari.ops("play")[0]!;
    expect(play.media).toMatch(/^recording:nova\/[0-9a-f]{16}$/);
    await service.handle({
      type: "PlaybackFinished",
      playback: { id: String(play.id), state: "done" },
    });
    expect(ari.ops("hangup").at(-1)).toMatchObject({
      channelId: result.callId,
    });
    expect(fs.readdirSync(path.join(store.recordingDir, "nova"))).toHaveLength(
      0,
    );
    expect(service.recentEvents().map((e) => e.type)).toEqual([
      "outbound",
      "answered",
      "announcement",
    ]);
  });

  it("does not play for an unknown announcement token and hangs up", async () => {
    service.setEnabled(true);
    await service.handle({
      type: "StasisStart",
      channel: {
        id: "c9",
        name: "",
        state: "Up",
        caller: { name: "", number: "" },
      },
      args: ["announce", "deadbeef"],
    });
    expect(ari.ops("play")).toHaveLength(0);
    expect(ari.ops("hangup")[0]).toMatchObject({ channelId: "c9" });
  });

  it("refuses unknown targets, external numbers without trunk, empty messages and call floods", async () => {
    const ext = service.addExtension("Laptop");
    service.addExtension("Voordeur", "doorbell");
    service.setEnabled(true);
    await expect(service.call("999", "x")).rejects.toThrow(/Onbekend/);
    await expect(service.call("801", "x")).rejects.toThrow(/Onbekend/);
    await expect(service.call("+31612345678", "x")).rejects.toThrow(/trunk/);
    await expect(service.call(ext.id, "  ")).rejects.toThrow(/bericht/);
    for (let i = 0; i < 5; i++) {
      await service.call(ext.id, `bericht ${i}`);
      ari.channelList = [];
    }
    await expect(service.call(ext.id, "zes")).rejects.toThrow(/Te veel/);
  });

  it("dials external numbers through the trunk only when one is configured", async () => {
    service.setEnabled(true);
    service.setTrunk({
      host: "sip.example.net",
      username: "u1",
      secret: "trunkSecret123",
      number: "+31201234567",
      allowExtensionsToDialOut: false,
    });
    const result = await service.call("+31 6 1234-5678", "hallo");
    expect(result.kind).toBe("external");
    expect(ari.ops("originate")[0]).toMatchObject({
      endpoint: "PJSIP/+31612345678@trunk",
      callerId: "+31201234567",
    });
    expect(renderPjsip(store.get())).toContain("[trunk]");
  });

  it("cleans up when originate fails and only hangs up channels that exist", async () => {
    const ext = service.addExtension("Laptop");
    service.setEnabled(true);
    ari.failOriginate = true;
    await expect(service.call(ext.id, "hoi")).rejects.toThrow();
    expect(fs.readdirSync(path.join(store.recordingDir, "nova"))).toHaveLength(
      0,
    );
    await expect(service.hangup("nope")).rejects.toThrow(/loopt niet/);
    await expect(service.hangup("bad id;")).rejects.toThrow(/Ongeldig/);
    ari.channelList = [
      { id: "c1", name: "x", state: "Up", caller: { name: "", number: "101" } },
    ];
    await service.hangup("c1");
    expect(ari.ops("hangup")[0]).toMatchObject({ channelId: "c1" });
    const calls = await service.listCalls();
    expect(calls).toEqual([]);
  });

  it("alerts NOVA on an inbound call and answers with a spoken notice", async () => {
    service.setEnabled(true);
    await service.handle({
      type: "StasisStart",
      channel: {
        id: "in1",
        name: "",
        state: "Ring",
        caller: { name: "Laptop", number: "101" },
      },
      args: ["inbound"],
    });
    expect(emitted[0]!.topic).toBe("jarvis/alerts");
    expect(emitted[0]!.payload).toMatchObject({
      title: "Inkomend gesprek voor NOVA",
      severity: "info",
      key: "telephony",
    });
    expect(String(emitted[0]!.payload.detail)).toContain("Laptop (101)");
    expect(ari.ops("answer")[0]).toMatchObject({ channelId: "in1" });
    expect(ari.ops("play")).toHaveLength(1);
  });

  it("rings the doorbell: critical alert, rings configured phones and bridges the first answer", async () => {
    const a = service.addExtension("Laptop");
    const b = service.addExtension("Telefoon");
    service.setEnabled(true);
    service.setPolicy({ ringExtensions: [a.id, b.id] });
    await service.handle({
      type: "StasisStart",
      channel: {
        id: "door",
        name: "",
        state: "Ring",
        caller: { name: "Voordeur", number: "801" },
      },
      args: ["doorbell"],
    });
    expect(emitted[0]!.payload).toMatchObject({
      title: "Er wordt aangebeld",
      severity: "critical",
    });
    const legs = ari.ops("originate");
    expect(legs.map((l) => l.endpoint)).toEqual([
      `PJSIP/${a.id}`,
      `PJSIP/${b.id}`,
    ]);
    const bridgeId = String(ari.ops("createBridge")[0]!.id);
    await service.handle({
      type: "StasisStart",
      channel: {
        id: String(legs[1]!.id),
        name: "",
        state: "Up",
        caller: { name: "", number: "" },
      },
      args: ["ring", bridgeId],
    });
    expect(ari.ops("addToBridge").map((c) => c.channelId)).toEqual([
      "door",
      legs[1]!.id,
    ]);
    expect(ari.ops("hangup").map((c) => c.channelId)).toContain(legs[0]!.id);
    await service.handle({
      type: "ChannelDestroyed",
      channel: {
        id: "door",
        name: "",
        state: "Up",
        caller: { name: "", number: "" },
      },
    });
    expect(ari.ops("destroyBridge")[0]).toMatchObject({ bridgeId });
  });

  it("hangs up the doorbell when nobody is configured to ring", async () => {
    service.setEnabled(true);
    await service.handle({
      type: "StasisStart",
      channel: {
        id: "door",
        name: "",
        state: "Ring",
        caller: { name: "", number: "801" },
      },
      args: ["doorbell"],
    });
    expect(emitted).toHaveLength(1);
    expect(ari.ops("originate")).toHaveLength(0);
    expect(ari.ops("hangup")[0]).toMatchObject({ channelId: "door" });
  });

  it("validates ring group members and the public host", () => {
    service.addExtension("Voordeur", "doorbell");
    expect(() => service.setPolicy({ ringExtensions: ["801"] })).toThrow(
      /Onbekend/,
    );
    expect(() => service.setPublicHost("bad host;")).toThrow();
    expect(() => service.addExtension("x".repeat(5), "phone")).not.toThrow();
  });
});

describe("WAV conversion", () => {
  it("round-trips and resamples to 16 kHz mono", () => {
    const wav = encodeWav16k(new Int16Array([1, 2, 3, 4]));
    const parsed = parseWav(wav);
    expect(parsed.rate).toBe(16000);
    expect([...parsed.samples]).toEqual([1, 2, 3, 4]);
    const out = resampleTo16k(new Int16Array(24000).fill(500), 24000);
    expect(out.length).toBe(16000);
    expect(out[100]).toBe(500);
    expect(() => parseWav(Buffer.from("nope"))).toThrow();
  });
});

describe("phone tools through the tool registry", () => {
  let tools: ToolsService;
  let confirmations: ConfirmationsService;
  let svc: TelephonyService;
  let fake: FakeAri;
  let level: AutonomyLevelStore;
  const events: unknown[] = [];

  @Module({
    imports: [CoreModule],
    providers: [
      TelephonyStore,
      { provide: ARI_PORT, useFactory: () => (fake = new FakeAri()) },
      {
        provide: JarvisStateStore,
        useValue: { emit: (e: unknown) => events.push(e) },
      },
      { provide: "TTS", useValue: tts },
      {
        provide: TelephonyService,
        inject: [TelephonyStore, ARI_PORT, JarvisStateStore],
        useFactory: (s: TelephonyStore, a: FakeAri, j: JarvisStateStore) =>
          (svc = new TelephonyService(s, a, j, tts as never, decoder)),
      },
      TelephonySource,
    ],
  })
  class TelephonyTestModule {}

  beforeAll(async () => {
    process.env.JARVIS_ENABLE_ACTIONS = "true";
    process.env.NOVA_ENABLE_ACTIONS = "true";
    const moduleRef = await Test.createTestingModule({
      imports: [CoreModule, ToolsModule, TelephonyTestModule],
    }).compile();
    await moduleRef.init();
    tools = moduleRef.get(ToolsService);
    confirmations = moduleRef.get(ConfirmationsService);
    level = moduleRef.get(AutonomyLevelStore);
    const ext = svc.addExtension("Laptop");
    expect(ext.id).toBe("101");
    svc.setEnabled(true);
  });
  afterAll(() => {
    delete process.env.JARVIS_ENABLE_ACTIONS;
    delete process.env.NOVA_ENABLE_ACTIONS;
    svc.setEnabled(false);
  });

  it("registers three phone tools with the expected risks", () => {
    const phone = tools.list().filter((t) => t.name.startsWith("phone_"));
    expect(phone.map((t) => [t.name, t.risk, t.enabled])).toEqual([
      ["phone_status", "READ_ONLY", true],
      ["phone_call", "CONFIRM", true],
      ["phone_hangup", "SAFE", true],
    ]);
  });

  it("phone_status is read-only and works in read-only mode", async () => {
    const result = await tools.execute("phone_status", {}, "p1", null, false, {
      readOnlyOnly: true,
    });
    expect(result.ok).toBe(true);
    expect((result.result as { enabled: boolean }).enabled).toBe(true);
    expect(JSON.stringify(result)).not.toContain(svc["store"].get().ariSecret);
  });

  it("with autonomy balanced, a call to your own phone runs by itself but a raw external number still asks", async () => {
    level.set("balanced");
    const before = fake.ops("originate").length;
    const own = await tools.execute(
      "phone_call",
      { to: "101", message: "De pasta is klaar." },
      "p-auto",
    );
    expect(own.ok).toBe(true);
    expect(own.requiresConfirmation).toBeUndefined();
    expect(fake.ops("originate")).toHaveLength(before + 1);
    // with no trunk an external number is rejected before anything is asked or sent
    const external = await tools.execute(
      "phone_call",
      { to: "+31612345678", message: "Hoi" },
      "p-auto",
    );
    expect(external.ok).toBe(false);
    expect(fake.ops("originate")).toHaveLength(before + 1);
    level.set("careful");
    const careful = await tools.execute(
      "phone_call",
      { to: "101", message: "Nog een keer." },
      "p-auto-2",
    );
    expect(careful.requiresConfirmation).toBe(true);
    confirmations.cancel("p-auto-2");
  });

  it("phone_call needs a fresh confirmation and never a standing 'Altijd' approval (careful level)", async () => {
    level.set("careful");
    const base = fake.ops("originate").length;
    const first = await tools.execute(
      "phone_call",
      { to: "101", message: "Hoi" },
      "p2",
    );
    expect(first.requiresConfirmation).toBe(true);
    expect(first.action?.allowAlways).toBe(false);
    expect(fake.ops("originate")).toHaveLength(base);
    const approved = confirmations.take("p2", first.action!.confirmationId)!;
    const other = await tools.execute(
      "phone_call",
      { to: "101", message: "Iets anders" },
      "p2",
      approved,
    );
    expect(other.requiresConfirmation).toBe(true);
    confirmations.cancel("p2");
    const second = await tools.execute(
      "phone_call",
      { to: "101", message: "Hoi" },
      "p2",
    );
    const ok = confirmations.take("p2", second.action!.confirmationId)!;
    const done = await tools.execute(
      "phone_call",
      { to: "101", message: "Hoi" },
      "p2",
      ok,
      true,
    );
    expect(done.ok).toBe(true);
    expect(fake.ops("originate")).toHaveLength(base + 1);
    const again = await tools.execute(
      "phone_call",
      { to: "101", message: "Hoi" },
      "p2",
    );
    expect(again.requiresConfirmation).toBe(true);
    confirmations.cancel("p2");
    level.set("balanced");
  });

  it("external numbers always ask, even when internal calls are allowed without confirmation", async () => {
    svc.setPolicy({ allowInternalCallsWithoutConfirmation: true });
    svc.setTrunk({
      host: "sip.example.net",
      username: "u1",
      secret: "trunkSecret123",
      number: "",
      allowExtensionsToDialOut: false,
    });
    fake.channelList = [];
    const external = await tools.execute(
      "phone_call",
      { to: "+31612345678", message: "Hoi" },
      "p3",
    );
    expect(external.requiresConfirmation).toBe(true);
    confirmations.cancel("p3");
    const before = fake.ops("originate").length;
    const internal = await tools.execute(
      "phone_call",
      { to: "101", message: "Hoi" },
      "p3",
    );
    expect(internal.ok).toBe(true);
    expect(fake.ops("originate")).toHaveLength(before + 1);
    svc.setPolicy({ allowInternalCallsWithoutConfirmation: false });
  });

  it("rejects an invalid target before asking for confirmation", async () => {
    const result = await tools.execute(
      "phone_call",
      { to: "abc", message: "x" },
      "p4",
    );
    expect(result.ok).toBe(false);
    expect(result.requiresConfirmation).toBeFalsy();
  });

  it("is blocked when device actions are disabled and hidden when telephony is off", async () => {
    svc.setEnabled(false);
    expect(tools.list().find((t) => t.name === "phone_call")?.enabled).toBe(
      false,
    );
    svc.setEnabled(true);
  });
});
