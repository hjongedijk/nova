import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  AutopilotController,
  AutopilotSettingsController,
} from "../../src/autopilot/autopilot.controller.js";
import { AutopilotSource } from "../../src/autopilot/autopilot.source.js";
import type { ConfirmationHandler } from "../../src/chat/confirmation-handler.service.js";
import type { ContextBuilder } from "../../src/chat/context-builder.service.js";
import type { OmniRouteClient } from "../../src/chat/omniroute-client.service.js";
import { OrchestratorService } from "../../src/chat/orchestrator.service.js";
import type { ConfirmationsService } from "../../src/confirmations/confirmations.service.js";
import type { NovaConfig } from "../../src/core/config/nova-config.js";
import { ValidationError } from "../../src/core/errors/validation.error.js";
import type { RoutingService } from "../../src/routing/routing.service.js";
import { encodeWav16k } from "../../src/telephony/announce.js";
import { TelephonyService } from "../../src/telephony/telephony.service.js";
import { TelephonyStore } from "../../src/telephony/telephony.store.js";
import type { ToolsService } from "../../src/tools/tools.service.js";
import { FakeAri } from "../telephony/fake-ari.js";
import { rig, type Rig } from "./harness.js";

delete process.env.COREPACK_ENABLE_AUTO_PIN;

describe("TelephonyService.sendText over ARI", () => {
  let dir: string;
  let ari: FakeAri;
  let service: TelephonyService;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "nova-text-"));
    ari = new FakeAri();
    service = new TelephonyService(
      new TelephonyStore({
        dataFile: (n: string) => path.join(dir, n),
      } as unknown as NovaConfig),
      ari,
      { emit: () => undefined } as never,
      {
        speakProfile: async () => ({
          audio: Buffer.from("x"),
          contentType: "audio/mpeg",
        }),
      } as never,
      async () => encodeWav16k(new Int16Array([0, 1000, -1000, 0])),
    );
    service.setEnabled(true);
    service.setTrunk({
      host: "sip.linphone.org",
      username: "nova-bot",
      secret: "geheim-wachtwoord",
      number: "",
      allowExtensionsToDialOut: false,
    });
    service.setContacts([
      { name: "Harm", sip: "harm@sip.linphone.org", allowConversation: true },
      { name: "Anna", sip: "anna@sip.linphone.org", allowConversation: false },
    ]);
  });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  it("sends a SIP MESSAGE to the contact through the trunk", async () => {
    await service.sendText("harm", "NOVA: test");
    expect(ari.commands.at(-1)).toEqual({
      op: "sendMessage",
      to: "pjsip:trunk/sip:harm@sip.linphone.org",
      from: "sip:nova-bot@sip.linphone.org",
      body: "NOVA: test",
    });
  });

  it("lists only contacts that may talk with NOVA", () => {
    expect(service.conversationContacts()).toEqual(["Harm"]);
  });

  it("refuses unknown contacts, empty text, telephony off and a missing trunk", async () => {
    await expect(service.sendText("Piet", "hoi")).rejects.toThrow(/contact/i);
    await expect(service.sendText("Harm", "   ")).rejects.toThrow(/leeg/);
    expect(ari.commands.some((c) => c.op === "sendMessage")).toBe(false);
    service.setTrunk(null);
    await expect(service.sendText("Harm", "hoi")).rejects.toThrow(/trunk/i);
    service.setEnabled(false);
    await expect(service.sendText("Harm", "hoi")).rejects.toThrow(/uit/i);
  });

  it("caps very long text", async () => {
    await service.sendText("Harm", "x".repeat(5000));
    expect(String(ari.commands.at(-1)!.body).length).toBe(900);
  });

  it("is ready only with telephony on, a trunk and a reachable Asterisk that does not report the trunk offline", async () => {
    expect(await service.textReady()).toEqual({ ready: true });
    ari.endpointList = [
      {
        technology: "PJSIP",
        resource: "trunk",
        state: "offline",
        channel_ids: [],
      },
    ];
    expect(await service.textReady()).toMatchObject({
      ready: false,
      reason: expect.stringContaining("geregistreerd"),
    });
    ari.endpointList = [
      {
        technology: "PJSIP",
        resource: "trunk",
        state: "online",
        channel_ids: [],
      },
    ];
    expect(await service.textReady()).toEqual({ ready: true });
    vi.spyOn(ari, "endpoints").mockRejectedValue(new Error("down"));
    expect(await service.textReady()).toMatchObject({ ready: false });
    service.setTrunk(null);
    expect(await service.textReady()).toMatchObject({ ready: false });
    service.setEnabled(false);
    expect(await service.textReady()).toMatchObject({
      ready: false,
      reason: "telefonie staat uit",
    });
  });
});

describe("orchestrator delegation hook", () => {
  function harness() {
    const client = { call: vi.fn() } as unknown as OmniRouteClient;
    const tools = {
      list: vi.fn().mockReturnValue([]),
      forModel: vi.fn().mockReturnValue([]),
      execute: vi.fn(),
    } as unknown as ToolsService;
    const confirmations = {
      cancel: vi.fn(),
    } as unknown as ConfirmationsService;
    const handler = {
      handle: vi.fn().mockResolvedValue(null),
    } as unknown as ConfirmationHandler;
    const context = {
      build: vi.fn().mockResolvedValue([]),
    } as unknown as ContextBuilder;
    const routing = {
      assertFree: vi.fn(),
      preferredModelForRole: vi.fn(),
    } as unknown as RoutingService;
    const service = new OrchestratorService(
      { maxToolRounds: 4 } as NovaConfig,
      client,
      routing,
      tools,
      confirmations,
      handler,
      context,
    );
    return { service, client, routing };
  }

  it("answers explicit delegation without a model call", async () => {
    const { service, client, routing } = harness();
    const delegate = vi
      .fn()
      .mockResolvedValue(
        "Ik ga ermee aan de slag en meld me zodra het klaar is.",
      );
    service.setGoalDelegator(delegate);
    const reply = await service.run({
      sessionId: "web",
      message: "zoek uit waarom mijn wifi zo traag is",
    });
    expect(reply.reply).toBe(
      "Ik ga ermee aan de slag en meld me zodra het klaar is.",
    );
    expect(reply.model).toBeNull();
    expect(delegate).toHaveBeenCalledWith(
      { kind: "agent", goal: "zoek uit waarom mijn wifi zo traag is" },
      { sessionId: "web" },
    );
    expect(client.call).not.toHaveBeenCalled();
    expect(routing.assertFree).not.toHaveBeenCalled();
  });

  it("never delegates from an agent session or a read-only (text chat) turn", async () => {
    for (const input of [
      { sessionId: "agent_ab12cd34" },
      { sessionId: "sipchat_harm", readOnlyOnly: true },
    ]) {
      const { service, routing } = harness();
      const delegate = vi.fn().mockResolvedValue("x");
      service.setGoalDelegator(delegate);
      await service
        .run({ ...input, message: "regel dat voor me met de verzekering" })
        .catch(() => undefined);
      expect(delegate).not.toHaveBeenCalled();
      expect(routing.assertFree).toHaveBeenCalled();
    }
  });

  it("falls through to the model when the delegator declines, and for plain questions", async () => {
    const { service, routing } = harness();
    const delegate = vi.fn().mockResolvedValue(null);
    service.setGoalDelegator(delegate);
    await service
      .run({
        sessionId: "web",
        message: "regel dat voor me met de verzekering",
      })
      .catch(() => undefined);
    expect(delegate).toHaveBeenCalledTimes(1);
    expect(routing.assertFree).toHaveBeenCalledTimes(1);
    await service
      .run({ sessionId: "web", message: "wat is het regelen van een lening" })
      .catch(() => undefined);
    expect(delegate).toHaveBeenCalledTimes(1);
  });

  it("does nothing without a delegator", async () => {
    const { service, routing } = harness();
    await service
      .run({
        sessionId: "web",
        message: "regel dat voor me met de verzekering",
      })
      .catch(() => undefined);
    expect(routing.assertFree).toHaveBeenCalled();
  });
});

describe("REST and tools", () => {
  let r: Rig;
  beforeEach(() => {
    r = rig();
  });
  afterEach(() => fs.rmSync(r.dir, { recursive: true, force: true }));

  it("GET /autopilot/status shows last scan, findings, initiatives today, next due and enabled", async () => {
    const controller = new AutopilotController(r.service);
    r.world.routing = { ready: false, status: "POLICY_UNAVAILABLE" };
    const before = controller.status();
    expect(before).toMatchObject({
      enabled: true,
      lastScanAt: null,
      initiativesToday: 0,
    });
    const scanned = await controller.scan();
    expect(scanned.delivered).toBe(1);
    const status = controller.status();
    expect(status).toMatchObject({
      enabled: true,
      initiativesToday: 1,
      dailyBudget: 10,
      findings: [
        expect.objectContaining({ scan: "health", outcome: "gemeld" }),
      ],
    });
    expect(status.lastScanAt).toBeTruthy();
    expect(status.nextDueAt).toBeTruthy();
    expect(controller.activity().activity.length).toBeGreaterThan(0);
  });

  it("GET/PUT /settings/autopilot, including the kill switch and validation errors", () => {
    const controller = new AutopilotSettingsController(r.service);
    expect(controller.get().settings.enabled).toBe(true);
    expect(controller.put({ enabled: false }).settings.enabled).toBe(false);
    expect(controller.put({ dailyBudget: 3 }).settings).toMatchObject({
      enabled: false,
      dailyBudget: 3,
    });
    expect(() => controller.put({ dailyBudget: "veel" })).toThrow(
      ValidationError,
    );
  });

  it("autopilot_set is the tool kill switch and autopilot_status is read-only", async () => {
    const source = new AutopilotSource(r.service);
    const defs = source.definitions();
    expect(defs.find((d) => d.name === "autopilot_status")!.risk).toBe(
      "READ_ONLY",
    );
    expect(defs.find((d) => d.name === "autopilot_set")!.risk).toBe("SAFE");
    expect(
      await source.execute("autopilot_set", { enabled: false }),
    ).toMatchObject({
      ok: true,
      result: { enabled: false },
    });
    expect(r.service.settings.enabled).toBe(false);
    expect((await source.execute("autopilot_status", {})).ok).toBe(true);
    expect((await source.execute("autopilot_set", { enabled: "nee" })).ok).toBe(
      false,
    );
  });
});
