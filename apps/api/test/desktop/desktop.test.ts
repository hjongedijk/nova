/* eslint-disable @typescript-eslint/no-unused-vars -- fixtures left from the removed confirmation flow */
import { Module } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
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
import { AuditService } from "../../src/core/audit/audit.service.js";
import { CoreModule } from "../../src/core/core.module.js";
import { NovaConfig } from "../../src/core/config/nova-config.js";
import {
  classifyAction,
  viewAllowed,
} from "../../src/desktop/desktop.classifier.js";
import { DESKTOP_LIMITS } from "../../src/desktop/desktop.limits.js";
import { DesktopService } from "../../src/desktop/desktop.service.js";
import { DesktopSource } from "../../src/desktop/desktop.source.js";
import { DesktopSettingsStore } from "../../src/desktop/desktop-settings.store.js";
import {
  DESKTOP_PORT,
  DESKTOP_VISION,
  type DesktopInputAction,
  type DesktopPort,
  type DesktopVision,
  type DesktopWindow,
} from "../../src/desktop/desktop.types.js";
import { SettingsStore } from "../../src/settings/store/settings.store.js";
import { ToolsModule } from "../../src/tools/tools.module.js";
import { ToolsService } from "../../src/tools/tools.service.js";

const notepad: DesktopWindow = {
  id: "w1",
  title: "Notities - Kladblok",
  process: "notepad",
  active: true,
};
const checkout: DesktopWindow = {
  id: "w2",
  title: "Afrekenen - betaal nu - Webshop",
  process: "chrome",
  active: true,
};

const fake = {
  configured: true,
  windows: [notepad] as DesktopWindow[],
  controlAvailable: true,
  failWindows: false,
  failScreenshot: false,
  failInput: false,
  failControl: false,
  throwInput: false,
  inputs: [] as unknown[],
  controls: [] as { armed: boolean; ttl: number }[],
  screenshots: 0,
};
const visionLog: { question?: string; size: number }[] = [];
let visionAnswer = "Een kladblok met tekst.";
let visionOk = true;

const port: DesktopPort = {
  get configured() {
    return fake.configured;
  },
  async status() {
    return {
      ok: true,
      status: {
        viewAvailable: true,
        controlAvailable: fake.controlAvailable,
        armed: false,
      },
    };
  },
  async windows() {
    return fake.failWindows
      ? { ok: false, error: "geen vensters" }
      : { ok: true, windows: fake.windows };
  },
  async screenshot() {
    if (fake.failScreenshot) return { ok: false, error: "capture mislukt" };
    fake.screenshots += 1;
    return {
      ok: true,
      screenshot: {
        mimeType: "image/png",
        base64: "iVBORw0KGgo=",
        width: 1280,
        height: 720,
        display: 0,
      },
    };
  },
  async input(input: DesktopInputAction) {
    if (fake.throwInput) throw new Error("boom");
    fake.inputs.push(input);
    return fake.failInput
      ? { ok: false, error: "agent weigert" }
      : { ok: true };
  },
  async control(armed: boolean, ttl: number) {
    fake.controls.push({ armed, ttl });
    return fake.failControl
      ? { ok: false, error: "control mislukt" }
      : { ok: true };
  },
};
const vision: DesktopVision = {
  async describe(image, question) {
    visionLog.push({ question, size: image.base64.length });
    return visionOk
      ? { ok: true, description: visionAnswer }
      : { ok: false, error: "Geen geverifieerd gratis visiemodel." };
  },
};

@Module({
  providers: [
    DesktopSettingsStore,
    { provide: DESKTOP_PORT, useValue: port },
    { provide: DESKTOP_VISION, useValue: vision },
    DesktopService,
    DesktopSource,
  ],
})
class DesktopTestModule {}

describe("desktop settings compatibility", () => {
  it("keeps paired access enabled for missing, legacy and broken files", () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "nova-desktop-"));
    const file = path.join(directory, "desktop-settings.json");
    const store = new DesktopSettingsStore({
      dataFile: () => file,
    } as unknown as NovaConfig);
    try {
      expect(store.get()).toEqual({
        viewEnabled: true,
        controlEnabled: true,
        cacheEnabled: true,
      });
      fs.writeFileSync(
        file,
        JSON.stringify({
          viewEnabled: false,
          controlEnabled: false,
          cacheEnabled: false,
        }),
      );
      expect(store.get()).toEqual({
        viewEnabled: true,
        controlEnabled: true,
        cacheEnabled: false,
      });
      const saved = store.set({ viewEnabled: false, controlEnabled: false });
      expect(saved).toEqual(store.get());
      expect(JSON.parse(fs.readFileSync(file, "utf8"))).toEqual(saved);
      expect(fs.statSync(file).mode & 0o777).toBe(0o600);
      fs.writeFileSync(file, "{broken");
      expect(store.get()).toEqual({
        viewEnabled: true,
        controlEnabled: true,
        cacheEnabled: true,
      });
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });
});

describe("desktop control", () => {
  let tools: ToolsService;
  let desktop: DesktopService;
  let confirmations: ConfirmationsService;
  let settings: SettingsStore;
  let audit: AuditService;
  let clock: number;
  let n = 0;
  const sid = () => `desk-${++n}`;

  beforeAll(async () => {
    process.env.JARVIS_ENABLE_ACTIONS = "true";
    const moduleRef = await Test.createTestingModule({
      imports: [CoreModule, ToolsModule, DesktopTestModule],
    }).compile();
    await moduleRef.init();
    tools = moduleRef.get(ToolsService);
    desktop = moduleRef.get(DesktopService);
    confirmations = moduleRef.get(ConfirmationsService);
    settings = moduleRef.get(SettingsStore);
    audit = moduleRef.get(AuditService);
  });
  afterAll(() => delete process.env.JARVIS_ENABLE_ACTIONS);
  beforeEach(async () => {
    await desktop.stop("user", "test");
    desktop.updateSettings({
      viewEnabled: false,
      controlEnabled: false,
      cacheEnabled: true,
    });
    Object.assign(fake, {
      configured: true,
      windows: [notepad],
      controlAvailable: true,
      failWindows: false,
      failScreenshot: false,
      failInput: false,
      failControl: false,
      throwInput: false,
    });
    fake.inputs.length = 0;
    fake.controls.length = 0;
    fake.screenshots = 0;
    visionLog.length = 0;
    visionAnswer = "Een kladblok met tekst.";
    visionOk = true;
    clock = Date.parse("2026-10-16T10:00:00Z");
    desktop.now = () => clock;
    settings.update((next) => {
      next.standingApprovals = [];
    });
  });

  const enable = () =>
    desktop.updateSettings({ viewEnabled: true, controlEnabled: true });
  const run = (
    name: string,
    args: Record<string, unknown>,
    session: string,
    approved: Parameters<ToolsService["execute"]>[3] = null,
    always = false,
    options: Parameters<ToolsService["execute"]>[5] = {},
  ) => tools.execute(name, args, session, approved, always, options);
  /** Ask, confirm on screen, run. */
  async function confirmed(
    name: string,
    args: Record<string, unknown>,
    session: string,
    always = false,
  ) {
    // NOVA runs unrestricted: the tool executes at once, nothing is asked.
    const result = await run(name, args, session, null, always);
    return { asked: result, result };
  }
  async function takeover(session: string, ttl = 300) {
    enable();
    const { result } = await confirmed(
      "desktop_takeover_start",
      { goal: "Open de notities", ttlSeconds: ttl },
      session,
    );
    expect(result.ok).toBe(true);
    return result;
  }
  const look = (session: string) => run("desktop_screenshot", {}, session);

  describe("paired PC access", () => {
    it("enables viewing and control despite legacy off settings", () => {
      expect(desktop.settings()).toEqual({
        viewEnabled: true,
        controlEnabled: true,
        cacheEnabled: true,
      });
      const info = (name: string) => tools.list().find((t) => t.name === name);
      expect(info("desktop_status")?.enabled).toBe(true);
      for (const name of [
        "desktop_windows",
        "desktop_screenshot",
        "desktop_takeover_start",
        "desktop_act",
      ])
        expect(info(name)?.enabled, name).toBe(true);
    });

    it("looks and starts without additional permission switches", async () => {
      expect((await look(sid())).ok).toBe(true);
      const start = await run(
        "desktop_takeover_start",
        { goal: "x", ttlSeconds: 60 },
        sid(),
      );
      expect(start.ok).toBe(true);
      expect(fake.screenshots).toBe(1);
      expect(fake.controls).toEqual([{ armed: true, ttl: 60 }]);
    });

    it("ignores legacy permission flags while preserving cache preferences", () => {
      desktop.updateSettings({
        viewEnabled: false,
        controlEnabled: false,
        cacheEnabled: false,
      });
      expect(desktop.settings()).toEqual({
        viewEnabled: true,
        controlEnabled: true,
        cacheEnabled: false,
      });
    });
  });

  describe("looking", () => {
    beforeEach(() => desktop.updateSettings({ viewEnabled: true }));

    it("previews fresh frames without vision calls, caching or session observations", async () => {
      const first = await desktop.previewFrame(0);
      expect(first.ok).toBe(true);
      expect(first).toHaveProperty("screenshot.base64", "iVBORw0KGgo=");
      expect((await desktop.previewFrame(0)).ok).toBe(true);
      expect(fake.screenshots).toBe(2);
      expect(visionLog).toHaveLength(0);
      expect(desktop.info()).toBeNull();
      expect(JSON.stringify(audit.read(20))).not.toContain("iVBORw0KGgo=");
    });

    it("shares concurrent viewers of one display without duplicating capture", async () => {
      const capture = vi.spyOn(port, "screenshot");
      try {
        const results = await Promise.all(
          Array.from({ length: 8 }, () => desktop.previewFrame(0)),
        );
        expect(results.every((result) => result.ok)).toBe(true);
        expect(capture).toHaveBeenCalledTimes(1);
        expect(visionLog).toHaveLength(0);
        expect((await desktop.previewFrame(0)).ok).toBe(true);
        expect(capture).toHaveBeenCalledTimes(2);
      } finally {
        capture.mockRestore();
      }
    });

    it("previews even when window enumeration is unavailable", async () => {
      fake.failWindows = true;
      expect((await desktop.previewFrame(0)).ok).toBe(true);
      expect(fake.screenshots).toBe(1);
      expect(visionLog).toHaveLength(0);
    });

    it("previews sensitive windows without an extra consent gate or image logging", async () => {
      for (const title of ["Bitwarden", "Mijn bank - Rabobank"]) {
        fake.windows = [{ id: "private", title, active: true }];
        expect((await desktop.previewFrame(0)).ok).toBe(true);
      }
      expect(fake.screenshots).toBe(2);
      expect(visionLog).toHaveLength(0);
      expect(JSON.stringify(audit.read(20))).not.toContain("iVBORw0KGgo=");
    });

    it("human previews neither arm actions nor keep a takeover alive", async () => {
      const session = sid();
      await takeover(session);
      const before = desktop.info();
      clock += 5000;
      expect((await desktop.previewFrame(0)).ok).toBe(true);
      expect(desktop.info()?.observations).toBe(0);
      expect(desktop.info()?.lastActivityAt).toBe(before?.lastActivityAt);
      const action = await run(
        "desktop_act",
        { action: "move", x: 10, y: 10 },
        session,
      );
      expect(action.ok).toBe(false);
      expect(fake.inputs).toHaveLength(0);
    });

    it("sends the image to the vision role and marks the answer untrusted, with no image in the log", async () => {
      const sessionId = sid();
      const result = await run(
        "desktop_screenshot",
        { question: "welke knop sluit af?" },
        sessionId,
      );
      expect(result.ok).toBe(true);
      expect(result.untrusted).toBe(true);
      expect(String(result.warning)).toMatch(/DATA/);
      expect(result.screenDescription).toBe(visionAnswer);
      expect(visionLog).toHaveLength(1);
      expect(visionLog[0]!.question).toBe("welke knop sluit af?");
      const logged = JSON.stringify(audit.read(20, sessionId));
      expect(logged).not.toContain(visionAnswer);
      expect(logged).not.toContain("iVBOR");
    });

    it("caches briefly, not past the ttl, and not when the setting is off", async () => {
      const sessionId = sid();
      expect((await look(sessionId)).cached).toBe(false);
      expect((await look(sessionId)).cached).toBe(true);
      expect(fake.screenshots).toBe(1);
      clock += DESKTOP_LIMITS.cacheTtlMs + 1;
      expect((await look(sessionId)).cached).toBe(false);
      desktop.updateSettings({ cacheEnabled: false });
      await look(sessionId);
      await look(sessionId);
      expect(fake.screenshots).toBe(4);
    });

    it("looks afresh after starting takeover even when a pre-session screenshot was cached", async () => {
      const session = sid();
      expect((await look(session)).ok).toBe(true);
      expect(fake.screenshots).toBe(1);
      expect(
        (
          await run(
            "desktop_takeover_start",
            { goal: "Test cursor routing", ttlSeconds: 60 },
            session,
          )
        ).ok,
      ).toBe(true);
      const observation = await look(session);
      expect(observation.cached).toBe(false);
      expect(desktop.info()?.observations).toBe(1);
      expect(
        (await run("desktop_act", { action: "move", x: 10, y: 10 }, session))
          .ok,
      ).toBe(true);
      expect(fake.inputs).toHaveLength(1);
      expect((await look(session)).cached).toBe(false);
      expect((await look(session)).cached).toBe(false);
    });

    it("fails closed without a free vision model", async () => {
      visionOk = false;
      const result = await look(sid());
      expect(result.ok).toBe(false);
      expect(result.screenDescription).toBeUndefined();
    });

    it("describes the screen even when window enumeration is unavailable", async () => {
      fake.failWindows = true;
      const result = await look(sid());
      expect(result.ok).toBe(true);
      expect(result.screenDescription).toBe(visionAnswer);
      expect(fake.screenshots).toBe(1);
      expect(visionLog).toHaveLength(1);
    });

    it("describes sensitive windows directly and keeps their contents out of the audit", async () => {
      const session = sid();
      fake.windows = [{ id: "p", title: "Bitwarden", active: true }];
      visionAnswer = "private-window-contents";
      const result = await look(session);
      expect(result.ok).toBe(true);
      expect(result.screenDescription).toBe(visionAnswer);
      expect(fake.screenshots).toBe(1);
      expect(visionLog).toHaveLength(1);
      const logged = JSON.stringify(audit.read(20, session));
      expect(logged).not.toContain(visionAnswer);
      expect(logged).not.toContain("iVBORw0KGgo=");
    });

    it("reports agent failures without throwing", async () => {
      fake.failScreenshot = true;
      const result = await look(sid());
      expect(result).toMatchObject({ ok: false });
      fake.configured = false;
      expect((await look(sid())).ok).toBe(false);
    });
  });

  describe("takeover start", () => {
    it("limits the duration to 15 minutes", async () => {
      enable();
      const tooLong = await run(
        "desktop_takeover_start",
        { goal: "x", ttlSeconds: 901 },
        sid(),
      );
      expect(tooLong).toMatchObject({
        ok: false,
        error: "Invalid tool arguments",
      });
      // The service clamps too, whatever a caller passes.
      const result = await desktop.startTakeover("x", 99_999, "direct");
      expect(result.ok).toBe(true);
      expect(fake.controls.at(-1)).toEqual({ armed: true, ttl: 900 });
    });

    it("does not arm when the agent has control off or fails", async () => {
      enable();
      fake.controlAvailable = false;
      expect((await desktop.startTakeover("x", 60, "s")).ok).toBe(false);
      fake.controlAvailable = true;
      fake.failControl = true;
      expect((await desktop.startTakeover("x", 60, "s")).ok).toBe(false);
      expect(desktop.info()).toBeNull();
    });

    it("refuses a second session", async () => {
      const sessionId = sid();
      await takeover(sessionId);
      expect((await desktop.startTakeover("y", 60, sessionId)).ok).toBe(false);
    });
  });

  describe("acting", () => {
    it("needs a running session and a look first, and only from the same conversation", async () => {
      enable();
      const sessionId = sid();
      const none = await run(
        "desktop_act",
        { action: "key", key: "tab" },
        sessionId,
      );
      expect(none.ok).toBe(false);
      await takeover(sessionId);
      const blind = await run(
        "desktop_act",
        { action: "key", key: "tab" },
        sessionId,
      );
      expect(blind.ok).toBe(false);
      expect(String(blind.error)).toMatch(/screenshot/);
      await look(sessionId);
      const other = await run(
        "desktop_act",
        { action: "key", key: "tab" },
        "other-chat",
      );
      expect(other.ok).toBe(false);
      expect(fake.inputs).toEqual([]);
      const ok = await run(
        "desktop_act",
        { action: "key", key: "tab" },
        sessionId,
      );
      expect(ok.ok).toBe(true);
      expect(fake.inputs).toHaveLength(1);
    });

    it("does ordinary actions without asking, and keeps typed text out of the log", async () => {
      const sessionId = sid();
      await takeover(sessionId);
      await look(sessionId);
      const click = await run(
        "desktop_act",
        { action: "click", x: 10, y: 20 },
        sessionId,
      );
      expect(click.ok).toBe(true);
      expect(fake.inputs[0]).toMatchObject({
        action: "click",
        x: 10,
        y: 20,
        relativeTo: { width: 1280, height: 720 },
      });
      const typed = await run(
        "desktop_act",
        { action: "type", text: "geheime-boodschap-qwerty" },
        sessionId,
      );
      expect(typed.ok).toBe(true);
      expect(fake.inputs[1]).toMatchObject({
        text: "geheime-boodschap-qwerty",
      });
      const logged = JSON.stringify(audit.read(100, sessionId));
      expect(logged).not.toContain("geheime-boodschap");
      expect(logged).toContain("textCharacters");
    });

    it("executes after the active window changes without a new confirmation", async () => {
      const session = sid();
      await takeover(session);
      await look(session);
      fake.windows = [checkout];
      const result = await desktop.act(
        { action: "click", x: 10, y: 20 },
        session,
        "benign",
      );
      expect(result.ok).toBe(true);
      expect(fake.inputs).toHaveLength(1);
      expect(fake.inputs[0]).toMatchObject({
        action: "click",
        x: 10,
        y: 20,
        relativeTo: { width: 1280, height: 720 },
      });
    });

    it("keeps the observe-then-act budget", async () => {
      const sessionId = sid();
      await takeover(sessionId);
      await look(sessionId);
      for (let i = 0; i < DESKTOP_LIMITS.maxActionsPerObservation; i++)
        expect(
          (await run("desktop_act", { action: "move", x: i, y: 1 }, sessionId))
            .ok,
        ).toBe(true);
      const blocked = await run(
        "desktop_act",
        { action: "move", x: 1, y: 1 },
        sessionId,
      );
      expect(blocked.ok).toBe(false);
      clock += DESKTOP_LIMITS.cacheTtlMs + 1;
      await look(sessionId);
      expect(
        (await run("desktop_act", { action: "move", x: 1, y: 1 }, sessionId))
          .ok,
      ).toBe(true);
    });

    it("stops at the maximum number of actions and disarms the agent", async () => {
      const sessionId = sid();
      await takeover(sessionId);
      for (let i = 0; i < DESKTOP_LIMITS.maxActions; i++) {
        if (i % DESKTOP_LIMITS.maxActionsPerObservation === 0) {
          clock += DESKTOP_LIMITS.cacheTtlMs + 1;
          await look(sessionId);
        }
        const result = await run(
          "desktop_act",
          { action: "move", x: i, y: 1 },
          sessionId,
        );
        expect(result.ok, `action ${i}`).toBe(true);
      }
      expect(desktop.info()).toBeNull();
      expect(fake.controls.at(-1)).toEqual({ armed: false, ttl: 0 });
      expect(
        (await run("desktop_act", { action: "move", x: 1, y: 1 }, sessionId))
          .ok,
      ).toBe(false);
    });

    it("ends the session after repeated failures", async () => {
      const sessionId = sid();
      await takeover(sessionId);
      await look(sessionId);
      fake.failInput = true;
      for (let i = 0; i < DESKTOP_LIMITS.maxErrorsInRow; i++)
        expect(
          (await run("desktop_act", { action: "move", x: 1, y: 1 }, sessionId))
            .ok,
        ).toBe(false);
      expect(desktop.info()).toBeNull();
      expect(fake.controls.at(-1)?.armed).toBe(false);
    });

    it("survives an agent that throws", async () => {
      const sessionId = sid();
      await takeover(sessionId);
      await look(sessionId);
      fake.throwInput = true;
      const result = await run(
        "desktop_act",
        { action: "move", x: 1, y: 1 },
        sessionId,
      );
      expect(result.ok).toBe(false);
      expect(desktop.info()).not.toBeNull();
    });
  });

  describe("ending a session", () => {
    it("ends at the ttl and when idle, and tells the agent", async () => {
      const sessionId = sid();
      await takeover(sessionId, 60);
      clock += DESKTOP_LIMITS.idleTimeoutMs + 1;
      await desktop.tick();
      expect(desktop.info()).toBeNull();
      expect(fake.controls.at(-1)?.armed).toBe(false);
      await takeover(sid(), 60);
      clock += 61_000;
      await desktop.tick();
      expect(desktop.info()).toBeNull();
    });

    it("activity keeps a session from going idle", async () => {
      const sessionId = sid();
      await takeover(sessionId, 600);
      for (let i = 0; i < 4; i++) {
        clock += DESKTOP_LIMITS.idleTimeoutMs - 1000;
        await look(sessionId);
        await desktop.tick();
      }
      expect(desktop.info()).not.toBeNull();
    });

    it("the stop tool works at once despite legacy off settings", async () => {
      const sessionId = sid();
      await takeover(sessionId);
      desktop.updateSettings({ viewEnabled: false, controlEnabled: false });
      const stopped = await run("desktop_takeover_stop", {}, sessionId);
      expect(stopped.ok).toBe(true);
      expect(desktop.info()).toBeNull();
      expect(fake.controls.at(-1)?.armed).toBe(false);
    });

    it("legacy permission changes do not interrupt a running session", async () => {
      await takeover(sid());
      desktop.updateSettings({ controlEnabled: false });
      await new Promise((resolve) => setTimeout(resolve, 10));
      expect(desktop.info()).not.toBeNull();
    });

    it("keeps retrying the disarm when the PC cannot be reached", async () => {
      await takeover(sid());
      fake.failControl = true;
      const stopped = await desktop.stop("user", "test");
      expect(stopped.agentDisarmed).toBe(false);
      fake.controls.length = 0;
      fake.failControl = false;
      await desktop.tick();
      expect(fake.controls).toEqual([{ armed: false, ttl: 0 }]);
    });

    it("writes the start and stop of a session to the action log", async () => {
      const sessionId = sid();
      await takeover(sessionId);
      await desktop.stop("user", "test");
      const phases = audit
        .read(100, sessionId)
        .filter((entry) => entry.tool === "desktop_session")
        .map((entry) => entry.phase);
      expect(phases).toEqual(expect.arrayContaining(["started", "stopped"]));
    });
  });

  describe("classifier", () => {
    const win = (title: string, process = "app"): DesktopWindow[] => [
      { id: "1", title, process, active: true },
    ];
    const level = (
      input: DesktopInputAction,
      windows: DesktopWindow[] | null,
    ) => classifyAction(input, windows).level;
    it("is benign only for what is positively harmless", () => {
      expect(level({ action: "scroll", dy: 3 }, null)).toBe("benign");
      expect(level({ action: "click", x: 1, y: 1 }, win("Notities"))).toBe(
        "benign",
      );
      expect(level({ action: "key", key: "ctrl+f" }, win("Notities"))).toBe(
        "benign",
      );
      expect(level({ action: "type", text: "hallo" }, win("Notities"))).toBe(
        "benign",
      );
    });
    it("is conservative when anything is unclear", () => {
      expect(level({ action: "click", x: 1, y: 1 }, null)).toBe("unknown");
      expect(level({ action: "click", x: 1, y: 1 }, [])).toBe("unknown");
      expect(
        level({ action: "click", x: 1, y: 1 }, [
          ...win("a"),
          { id: "2", title: "b", active: true },
        ]),
      ).toBe("unknown");
      expect(
        level({ action: "key", key: "ctrl+shift+q" }, win("Notities")),
      ).toBe("unknown");
      expect(
        level({ action: "focus_window", windowId: "zzz" }, win("Notities")),
      ).toBe("unknown");
      expect(level({ action: "click", x: 1, y: 1 }, win("   "))).toBe(
        "unknown",
      );
    });
    it("flags payment, mail, login, terminals and credential-looking text", () => {
      for (const title of [
        "Betaal nu",
        "Inbox - Outlook",
        "Inloggen",
        "PowerShell",
        "Checkout",
      ])
        expect(level({ action: "click", x: 1, y: 1 }, win(title)), title).toBe(
          "risky",
        );
      for (const text of [
        "NL91ABNA0417164300",
        "sk-abcdefghijklmnop1234",
        "password: abc",
        "x".repeat(40),
      ])
        expect(level({ action: "type", text }, win("Notities")), text).toBe(
          "risky",
        );
      expect(
        level(
          { action: "key", key: "enter" },
          win("Pagina - Chrome", "chrome"),
        ),
      ).toBe("risky");
      expect(
        level({ action: "focus_window", windowId: "1" }, win("Banking")),
      ).toBe("risky");
    });
    it("identifies sensitive windows for informational classification", () => {
      expect(viewAllowed(win("KeePassXC"))).toBe(false);
      expect(viewAllowed(win("Mijn bank - Rabobank"))).toBe(false);
      expect(viewAllowed(win("Kladblok"))).toBe(true);
    });
  });
});
