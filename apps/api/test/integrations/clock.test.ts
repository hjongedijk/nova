import { afterEach, describe, expect, it, vi } from "vitest";
import type { NovaConfig } from "../../src/core/config/nova-config.js";
import { WorldService } from "../../src/integrations/world/world.service.js";
import type { WorldHttp } from "../../src/integrations/world/world.types.js";
import {
  worldDefinitions,
  WORLD_TOOL_NAMES,
} from "../../src/integrations/world/world.definitions.js";
import {
  selectToolsForRequest,
  type SelectableTool,
  TOOL_DISCOVERY_NAME,
} from "../../src/tools/tool-selection.js";

afterEach(() => vi.useRealTimers());
function setup(instant = "2026-10-15T16:30:45.000Z") {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date(instant));
  const network = { getJson: vi.fn(), getPage: vi.fn() };
  const dataFile = vi.fn();
  const world = new WorldService(
    { timezone: "Europe/Amsterdam", dataFile } as unknown as NovaConfig,
    network as WorldHttp,
  );
  const home = { sync: vi.fn(), zoneHome: vi.fn() };
  world.useHomeSource(home);
  return { world, network, home, dataFile };
}

describe("live server clock", () => {
  it("returns the configured local date/time and the exact UTC observation without network or storage", async () => {
    const { world, network, home, dataFile } = setup();
    expect(await world.execute("clock_time", {})).toEqual({
      ok: true,
      result: {
        source: "server-clock",
        timezone: "Europe/Amsterdam",
        observedAt: "2026-10-15T16:30:45.000Z",
        date: "2026-10-15",
        time: "18:30:45",
      },
    });
    expect(network.getJson).not.toHaveBeenCalled();
    expect(network.getPage).not.toHaveBeenCalled();
    expect(home.sync).not.toHaveBeenCalled();
    expect(home.zoneHome).not.toHaveBeenCalled();
    expect(dataFile).not.toHaveBeenCalled();
  });

  it.each([
    ["2026-03-29T00:59:59.000Z", "Europe/Amsterdam", "2026-03-29", "01:59:59"],
    ["2026-03-29T01:00:00.000Z", "Europe/Amsterdam", "2026-03-29", "03:00:00"],
    ["2026-10-25T00:59:59.000Z", "Europe/Amsterdam", "2026-10-25", "02:59:59"],
    ["2026-10-25T01:00:00.000Z", "Europe/Amsterdam", "2026-10-25", "02:00:00"],
    ["2026-12-31T20:00:00.000Z", "Asia/Tokyo", "2027-01-01", "05:00:00"],
    ["2026-12-31T20:00:00.000Z", "UTC", "2026-12-31", "20:00:00"],
  ])(
    "observes %s in %s across DST and date boundaries",
    async (instant, timezone, date, time) => {
      const { world } = setup(instant);
      expect(await world.execute("clock_time", { timezone })).toEqual({
        ok: true,
        result: {
          source: "server-clock",
          timezone,
          observedAt: instant,
          date,
          time,
        },
      });
    },
  );

  it.each([
    "",
    "Private/Fixture",
    "https://private-fixture.invalid",
    "A".repeat(129),
    null,
    42,
    {},
  ])(
    "rejects invalid zone %j without echoing input or diagnostics",
    async (timezone) => {
      const { world, network } = setup();
      expect(await world.execute("clock_time", { timezone })).toEqual({
        ok: false,
        error: "Gebruik een geldige IANA-tijdzone, zoals Europe/Amsterdam.",
      });
      expect(network.getJson).not.toHaveBeenCalled();
    },
  );

  it("does not read the clock after cancellation", async () => {
    const { world } = setup();
    const controller = new AbortController();
    controller.abort();
    expect(await world.execute("clock_time", {}, controller.signal)).toEqual({
      ok: false,
      error: "Tijdslimiet bereikt",
    });
  });

  it("registers one read-only clock and selects it directly for Dutch and English time/date questions", () => {
    const clock = worldDefinitions().find((tool) => tool.name === "clock_time");
    expect(clock).toBeDefined();
    expect(clock!.risk).toBe("READ_ONLY");
    expect(WORLD_TOOL_NAMES).toContain("clock_time");
    const tools: SelectableTool[] = worldDefinitions().map((tool) => ({
      type: "function" as const,
      function: {
        name: tool.name,
        description: tool.description,
        parameters: tool.parameters,
      },
    }));
    tools.push(
      ...Array.from({ length: 30 }, (_, index) => ({
        type: "function" as const,
        function: {
          name: `unrelated_${index}`,
          description: "Unrelated capability",
          parameters: { type: "object" },
        },
      })),
    );
    tools.push({
      type: "function",
      function: {
        name: TOOL_DISCOVERY_NAME,
        description: "Search tools",
        parameters: { type: "object" },
      },
    });
    for (const question of [
      "Hoe laat is het nu in Amsterdam?",
      "Wat is de huidige tijd?",
      "Welke datum is het vandaag?",
      "What time is it in Tokyo?",
      "What date is it?",
    ]) {
      expect(
        selectToolsForRequest(tools, question, "conversation")[0]?.function
          .name,
      ).toBe("clock_time");
    }
  });
});
