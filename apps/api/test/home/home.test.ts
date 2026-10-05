import { HttpException } from "@nestjs/common";
import { Test, type TestingModule } from "@nestjs/testing";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { ConfirmationsService } from "../../src/confirmations/confirmations.service.js";
import { NovaConfig } from "../../src/core/config/nova-config.js";
import { CoreModule } from "../../src/core/core.module.js";
import {
  HomeAssistantService,
  HomeController,
  HomeModule,
  HomeSummaryService,
} from "../../src/home/index.js";
import { HomeSource } from "../../src/home/home.source.js";
import { ToolsModule } from "../../src/tools/tools.module.js";
import { ToolsService } from "../../src/tools/tools.service.js";
import type { ToolResult } from "../../src/tools/tool.types.js";
import { fakeHomeAssistant, TOKEN } from "./fake-ha.js";

type Fake = Awaited<ReturnType<typeof fakeHomeAssistant>>;

describe("Home Assistant", () => {
  let fake: Fake;
  let moduleRef: TestingModule;
  let tools: ToolsService;
  let home: HomeAssistantService;
  let confirmations: ConfirmationsService;
  let config: { actionsEnabled: boolean; autoExecuteSafe: boolean };

  /** Run a tool; a pending confirmation is approved right away when `approve` is set. */
  const run = (name: string, args: Record<string, unknown>, session: string) =>
    tools.execute(name, args, session);
  const approve = async (
    name: string,
    args: Record<string, unknown>,
    session: string,
  ): Promise<ToolResult> => {
    const first = await run(name, args, session);
    expect(first.requiresConfirmation).toBe(true);
    const action = confirmations.take(session, first.action!.confirmationId)!;
    return tools.execute(action.tool, action.args, session, action);
  };

  beforeAll(async () => {
    fake = await fakeHomeAssistant();
    process.env.HOME_ASSISTANT_URL = fake.url;
    process.env.HOME_ASSISTANT_TOKEN = TOKEN;
    process.env.JARVIS_ENABLE_ACTIONS = "true";
    moduleRef = await Test.createTestingModule({
      imports: [CoreModule, ToolsModule, HomeModule],
    }).compile();
    await moduleRef.init();
    tools = moduleRef.get(ToolsService);
    home = moduleRef.get(HomeAssistantService);
    confirmations = moduleRef.get(ConfirmationsService);
    config = moduleRef.get(NovaConfig) as unknown as typeof config;
    moduleRef.get(HomeSource).verifyDelayMs = 0;
    await home.sync(true);
  });
  afterAll(async () => {
    await moduleRef.close();
    await fake.close();
    delete process.env.HOME_ASSISTANT_URL;
    delete process.env.HOME_ASSISTANT_TOKEN;
    delete process.env.JARVIS_ENABLE_ACTIONS;
  });
  beforeEach(() => {
    fake.setVerificationFailure(false);
    fake.setOffline(false);
  });

  it("loads the catalog over REST and WebSocket, resolves area and alias, refuses invented and ambiguous entities", () => {
    expect(home.entities).toHaveLength(9);
    expect(home.resolve("Werklicht")).toMatchObject({
      entity: { entity_id: "light.office", area: "Kantoor" },
    });
    expect(home.search("", undefined, "Kantoor")).toHaveLength(3);
    expect(home.resolve("lamp")).toMatchObject({ ambiguous: true });
    const unknown = home.resolve("light.invented");
    expect("error" in unknown && unknown.error).toMatch(/Unknown/);
    expect("hint" in unknown && unknown.hint).toMatch(/Kantoor lamp/);
    expect(home.health()).toMatchObject({
      configured: true,
      online: true,
      stale: false,
      entities: 9,
      sonos: true,
      musicAssistant: true,
      error: null,
    });
  });

  it("lists the tools of the prototype, enabled while Home Assistant is configured", () => {
    const names = tools
      .list()
      .filter((tool) => tool.source === "home-assistant")
      .map((tool) => tool.name);
    expect(names).toEqual([
      "home_status",
      "ha_search_entities",
      "ha_get_state",
      "ha_get_registry",
      "ha_call_service",
      "ha_turn_on",
      "ha_turn_off",
      "ha_toggle",
      "ha_set_brightness",
      "ha_set_color",
      "ha_set_temperature",
      "ha_activate_scene",
      "ha_run_script",
      "ha_bulk_turn_off",
      "media_set_volume",
      "media_mute",
      "sonos_group",
      "sonos_ungroup",
      "sonos_announce",
      "media_play_media",
      "media_play_same",
      "sonos_play_favorite",
      "media_bulk_pause",
      "sonos_favorites",
      "music_play",
      "media_play",
      "media_pause",
      "media_stop",
      "media_next",
      "media_previous",
    ]);
    expect(
      tools
        .list()
        .every((tool) => tool.source !== "home-assistant" || tool.enabled),
    ).toBe(true);
  });

  it("a safe action runs and is verified; a follow-up uses exactly the recent target", async () => {
    const result = await run("ha_turn_on", { entity_id: "Werklicht" }, "safe");
    expect(result).toMatchObject({
      ok: true,
      verified: true,
      status: "verified",
    });
    const followup = await run(
      "ha_set_brightness",
      { entity_id: "die", brightness_pct: 30 },
      "safe",
    );
    expect(followup.verified).toBe(true);
    expect(
      (await run("ha_turn_off", { entity_id: "lamp" }, "ambiguous")).ambiguous,
    ).toBe(true);
    expect(
      (await run("ha_turn_off", { entity_id: "die" }, "different")).ok,
    ).toBe(false);
  });

  it("large volume, climate changes, scripts and locks need confirmation and nothing runs before", async () => {
    for (const [name, args, risk] of [
      [
        "media_set_volume",
        { entity_id: "media_player.office", volume_level: 0.9 },
        "CONFIRM",
      ],
      [
        "ha_set_temperature",
        { entity_id: "climate.office", temperature: 30 },
        "CONFIRM",
      ],
      ["ha_run_script", { entity_id: "script.evening" }, "CONFIRM"],
      ["ha_toggle", { entity_id: "light.living" }, "CONFIRM"],
      [
        "ha_call_service",
        { entity_id: "lock.front", domain: "lock", service: "unlock" },
        "DANGEROUS",
      ],
      ["ha_turn_off", { entity_id: "switch.server_rack" }, "DANGEROUS"],
    ] as const) {
      const before = fake.actions.length;
      const result = await run(name, args, "risky");
      expect(result.requiresConfirmation).toBe(true);
      expect(result.action?.risk).toBe(risk);
      expect(fake.actions.length).toBe(before);
      confirmations.cancel("risky");
    }
  });

  it("a small climate change and a quiet volume change run directly", async () => {
    expect(
      (
        await run(
          "ha_set_temperature",
          { entity_id: "climate.office", temperature: 21 },
          "small",
        )
      ).verified,
    ).toBe(true);
    expect(
      (
        await run(
          "media_set_volume",
          { entity_id: "media_player.living", volume_level: 0.3 },
          "small",
        )
      ).verified,
    ).toBe(true);
  });

  it("exact confirmation approves once; another session or id does nothing", async () => {
    const before = fake.actions.length;
    const pending = await run(
      "media_set_volume",
      { entity_id: "media_player.office", volume_level: 0.9 },
      "confirmation",
    );
    expect(
      confirmations.take("other", pending.action!.confirmationId),
    ).toBeNull();
    expect(confirmations.take("confirmation", "wrong")).toBeNull();
    expect(fake.actions.length).toBe(before);
    const action = confirmations.take(
      "confirmation",
      pending.action!.confirmationId,
    )!;
    const approved = await tools.execute(
      action.tool,
      action.args,
      "confirmation",
      action,
    );
    expect(approved.verified).toBe(true);
    expect(fake.actions.length).toBe(before + 1);
    expect(
      confirmations.take("confirmation", pending.action!.confirmationId),
    ).toBeNull();
  });

  it("an unlock only happens after confirmation, and is verified", async () => {
    const result = await approve(
      "ha_call_service",
      { entity_id: "lock.front", domain: "lock", service: "unlock" },
      "unlock",
    );
    expect(result).toMatchObject({ ok: true, verified: true });
    expect(
      fake.entities.find((item) => item.entity_id === "lock.front")?.state,
    ).toBe("unlocked");
    await approve(
      "ha_call_service",
      { entity_id: "lock.front", domain: "lock", service: "lock" },
      "unlock",
    );
  });

  it("scripts are accepted but never reported as verified", async () => {
    const result = await approve(
      "ha_run_script",
      { entity_id: "script.evening" },
      "script",
    );
    expect(result).toMatchObject({
      ok: true,
      accepted: true,
      verified: null,
      status: "accepted_unverified",
    });
  });

  it("generic services reject arbitrary domain, URL, target override, invalid values and missing data", async () => {
    const before = fake.actions.length;
    for (const args of [
      { entity_id: "light.office", domain: "shell_command", service: "run" },
      {
        entity_id: "light.office",
        domain: "light",
        service: "turn_on",
        data: { entity_id: "lock.front" },
      },
      {
        entity_id: "media_player.office",
        domain: "media_player",
        service: "play_media",
        data: { media_content_id: "https://evil" },
      },
      {
        entity_id: "climate.office",
        domain: "climate",
        service: "set_temperature",
      },
      {
        entity_id: "light.office",
        domain: "light",
        service: "turn_on",
        data: { brightness_pct: "100" },
      },
      {
        entity_id: "light.office",
        domain: "light",
        service: "turn_on",
        data: { rgb_color: [500, 0, 0] },
      },
    ])
      expect((await run("ha_call_service", args, "invalid")).ok).toBe(false);
    expect(fake.actions.length).toBe(before);
  });

  it("an accepted action with the wrong poststate never becomes verified success", async () => {
    fake.setVerificationFailure(true);
    const result = await run(
      "ha_turn_off",
      { entity_id: "light.office" },
      "verifyfail",
    );
    expect(result).toMatchObject({
      accepted: true,
      ok: false,
      verified: false,
      status: "verification_failed",
    });
  });

  it("actions disabled fail without side effects; safe autoexec can be disabled independently", async () => {
    const before = fake.actions.length;
    config.actionsEnabled = false;
    expect(
      (await run("ha_turn_off", { entity_id: "light.office" }, "disabled")).ok,
    ).toBe(false);
    expect(fake.actions.length).toBe(before);
    config.actionsEnabled = true;
    config.autoExecuteSafe = false;
    expect(
      (await run("ha_turn_off", { entity_id: "light.office" }, "manualsafe"))
        .requiresConfirmation,
    ).toBe(true);
    config.autoExecuteSafe = true;
    confirmations.cancel("manualsafe");
  });

  it("bulk control and Sonos grouping need confirmation; music uses the installed integration", async () => {
    let result = await run(
      "ha_bulk_turn_off",
      { entity_ids: ["light.office", "light.living"] },
      "bulk",
    );
    expect(result.requiresConfirmation).toBe(true);
    const action = confirmations.take("bulk", result.action!.confirmationId)!;
    result = await tools.execute(action.tool, action.args, "bulk", action);
    expect(result).toMatchObject({ ok: true, verified: true });
    expect(
      (
        await run(
          "sonos_group",
          {
            entity_id: "media_player.office",
            group_members: ["media_player.living"],
          },
          "group",
        )
      ).requiresConfirmation,
    ).toBe(true);
    confirmations.cancel("group");
    expect(
      (
        await run(
          "ha_bulk_turn_off",
          { entity_ids: ["light.office", "lock.front"] },
          "bulk2",
        )
      ).error,
    ).toMatch(/only lights/);
    result = await run(
      "music_play",
      {
        entity_id: "media_player.office",
        media_id: "spotify:playlist:fixture",
        media_type: "playlist",
      },
      "music",
    );
    expect(result.verified).toBe(true);
    expect(fake.actions.at(-1)?.path).toMatch(/music_assistant/);
    fake.hideMusicAssistant(true);
    await home.sync(true);
    expect(
      (
        await run(
          "music_play",
          {
            entity_id: "media_player.office",
            media_id: "jazz",
            media_type: "playlist",
          },
          "music",
        )
      ).error,
    ).toMatch(/not installed/);
    fake.hideMusicAssistant(false);
    await home.sync(true);
  });

  it("a bulk with a dangerous switch is DANGEROUS", async () => {
    const result = await run(
      "ha_bulk_turn_off",
      { entity_ids: ["switch.server_rack", "light.living"] },
      "bulkd",
    );
    expect(result.action?.risk).toBe("DANGEROUS");
    confirmations.cancel("bulkd");
  });

  it("media: only exact favorites, only known media identifiers, sonos tools only on Sonos devices", async () => {
    expect(
      (
        await run(
          "sonos_play_favorite",
          { entity_id: "media_player.office", source: "Nope" },
          "m",
        )
      ).error,
    ).toMatch(/not exposed/);
    expect(
      (
        await run(
          "sonos_play_favorite",
          { entity_id: "media_player.office", source: "Favorite" },
          "m",
        )
      ).verified,
    ).toBe(true);
    expect(
      (
        await run(
          "media_play_media",
          {
            entity_id: "media_player.office",
            media_content_id: "https://evil",
            media_content_type: "music",
          },
          "m",
        )
      ).error,
    ).toMatch(/arbitrary URLs/);
    const played = await run(
      "media_play_media",
      {
        entity_id: "media_player.office",
        media_content_id: "spotify:track:1",
        media_content_type: "music",
      },
      "m",
    );
    expect(played.verified).toBe(true);
    expect(
      (await run("sonos_favorites", { entity_id: "media_player.office" }, "m"))
        .result,
    ).toEqual(["Favorite"]);
    expect(
      (await run("media_pause", { entity_id: "media_player.office" }, "m"))
        .verified,
    ).toBe(true);
    expect((await run("media_play", { entity_id: "die" }, "m")).verified).toBe(
      true,
    );
  });

  it("an announcement needs confirmation and is accepted unverified", async () => {
    const result = await approve(
      "sonos_announce",
      {
        entity_id: "media_player.office",
        message: "Eten is klaar",
        tts_entity_id: "tts.fixture",
      },
      "announce",
    );
    expect(result).toMatchObject({
      ok: true,
      verified: null,
      status: "accepted_unverified",
    });
    expect(fake.actions.at(-1)?.body.media_content_id).toBe(
      "media-source://tts/tts.fixture?message=Eten%20is%20klaar",
    );
  });

  it("reading tools: search, state, registry and home_status", async () => {
    const found = await run(
      "ha_search_entities",
      { query: "kantoor", domain: "light" },
      "r",
    );
    expect(
      (found.result as { entity_id: string }[]).map((item) => item.entity_id),
    ).toEqual(["light.office"]);
    expect(
      (
        (await run("ha_get_state", { entity_id: "Voordeur" }, "r")).result as {
          state: string;
        }
      ).state,
    ).toBe("locked");
    expect(
      (await run("ha_get_state", { entity_id: "light.invented" }, "r")).error,
    ).toMatch(/Unknown/);
    const registry = (await run("ha_get_registry", {}, "r")).result as {
      areas: unknown[];
    };
    expect(registry.areas).toHaveLength(2);
    const status = (await run("home_status", {}, "r")).result as {
      lights: { total: number };
      missing: string[];
    };
    expect(status.lights.total).toBe(2);
    expect(status.missing).toEqual([
      "Er is geen temperatuursensor gekoppeld, dus de temperatuur binnen is onbekend.",
    ]);
  });

  it("a Home Assistant outage gives a tool error, not a crash", async () => {
    fake.setOffline(true);
    await home.sync(true).catch(() => undefined);
    expect(home.health()).toMatchObject({
      online: false,
      error: expect.stringMatching(/503/),
    });
    const result = await run(
      "ha_turn_on",
      { entity_id: "light.office" },
      "down",
    );
    expect(result.ok).toBe(false);
    fake.setOffline(false);
    await home.sync(true);
    expect(home.health().online).toBe(true);
  });

  it("GET /api/entities searches the catalog, and answers 503 when Home Assistant is down", async () => {
    const controller = moduleRef.get(HomeController);
    const answer = await controller.entities({
      query: "sonos",
      domain: "media_player",
    });
    expect(answer.entities.map((item) => item.entity_id).sort()).toEqual([
      "media_player.living",
      "media_player.office",
    ]);
    expect(answer.syncedAt).toBe(home.syncedAt);
    fake.setOffline(true);
    home.syncedAt = new Date(Date.now() - 120_000).toISOString();
    const error = await controller
      .entities({})
      .catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(HttpException);
    expect((error as HttpException).getStatus()).toBe(503);
    fake.setOffline(false);
    await home.sync(true);
  });

  it("summarizes the house for the dashboard panel and for the model", () => {
    const summary = moduleRef.get(HomeSummaryService);
    const entities = [
      {
        entity_id: "person.a",
        domain: "person",
        state: "home",
        friendly_name: "Anna",
        attributes: {},
      },
      {
        entity_id: "person.b",
        domain: "person",
        state: "unknown",
        friendly_name: "Bas",
        attributes: {},
      },
      {
        entity_id: "light.a",
        domain: "light",
        state: "on",
        friendly_name: "Lamp A",
        attributes: {},
      },
      {
        entity_id: "light.b",
        domain: "light",
        state: "off",
        friendly_name: "Lamp B",
        attributes: {},
      },
      {
        entity_id: "sensor.t",
        domain: "sensor",
        state: "21.46",
        friendly_name: "Woonkamer",
        attributes: { device_class: "temperature", unit_of_measurement: "°C" },
      },
      {
        entity_id: "climate.c",
        domain: "climate",
        state: "heat",
        friendly_name: "Thermostaat",
        attributes: { current_temperature: 20, temperature: 21 },
      },
      {
        entity_id: "media_player.m",
        domain: "media_player",
        state: "playing",
        friendly_name: "Sonos",
        attributes: {},
      },
      {
        entity_id: "todo.t",
        domain: "todo",
        state: "3",
        friendly_name: "Boodschappen",
        attributes: {},
      },
      {
        entity_id: "update.u",
        domain: "update",
        state: "on",
        friendly_name: "Core",
        attributes: {},
      },
    ] as never[];
    expect(summary.summarize(entities)).toMatchObject({
      people: [
        { name: "Anna", state: "home" },
        { name: "Bas", state: "unknown" },
      ],
      lights: { on: 1, total: 2 },
      switches: null,
      climate: [{ name: "Thermostaat", current: 20, target: 21 }],
      temperatures: [{ name: "Woonkamer", value: 21.46, unit: "°C" }],
      updates: ["Core"],
      lists: [{ name: "Boodschappen", open: 3 }],
      playing: ["Sonos"],
    });
    const described = summary.describe(entities);
    expect(described.answers.presence).toBe(
      "Anna is thuis. Ik weet niet of Bas thuis is: Home Assistant ziet geen telefoon of tracker.",
    );
    expect(described.answers.temperatureInside).toBe("Woonkamer: 21.5 graden.");
    expect(described.answers.lights).toBe("1 van de 2 lampen staat aan.");
    expect(described.missing).toEqual([]);
    expect(summary.summarize([])).toBeNull();
    expect(summary.describe([]).missing).toHaveLength(4);
  });
});

describe("Home Assistant not configured", () => {
  it("reports every tool as unavailable and answers with an error, never a crash", async () => {
    process.env.HOME_ASSISTANT_URL = "";
    process.env.HOME_ASSISTANT_TOKEN = "";
    const moduleRef = await Test.createTestingModule({
      imports: [CoreModule, ToolsModule, HomeModule],
    }).compile();
    await moduleRef.init();
    const tools = moduleRef.get(ToolsService);
    const mine = tools
      .list()
      .filter((tool) => tool.source === "home-assistant");
    expect(mine.length).toBeGreaterThan(20);
    expect(mine.every((tool) => !tool.enabled)).toBe(true);
    expect(moduleRef.get(HomeAssistantService).health()).toMatchObject({
      configured: false,
      online: false,
      stale: true,
      entities: 0,
    });
    expect((await tools.execute("home_status", {}, "off")).ok).toBe(false);
    await moduleRef.close();
    delete process.env.HOME_ASSISTANT_URL;
    delete process.env.HOME_ASSISTANT_TOKEN;
  });
});
