import { afterEach, describe, expect, it, vi } from "vitest";
import type { NovaConfig } from "../../src/core/config/nova-config.js";
import { worldDefinitions } from "../../src/integrations/world/world.definitions.js";
import { SystemTimeSource } from "../../src/proxmox/system-time.source.js";
import type { ToolCall } from "../../src/tools/tool.types.js";
import {
  selectToolsForRequest,
  type SelectableTool,
  TOOL_DISCOVERY_NAME,
} from "../../src/tools/tool-selection.js";

afterEach(() => vi.useRealTimers());
function setup(instant = "2026-10-15T16:30:45.000Z") {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date(instant));
  const dataFile = vi.fn();
  const source = new SystemTimeSource({
    timezone: "Europe/Amsterdam",
    dataFile,
  } as unknown as NovaConfig);
  return { source, dataFile };
}

describe("live server clock", () => {
  it("returns the configured local date/time and the exact UTC observation without network or storage", async () => {
    const { source, dataFile } = setup();
    expect(await source.execute("system_time", {})).toMatchObject({
      ok: true,
      result: {
        iso: "2026-10-15T16:30:45.000Z",
        timestamp: Date.parse("2026-10-15T16:30:45.000Z"),
        serverTimezone: "Europe/Amsterdam",
        timezone: "Europe/Amsterdam",
        local: {
          isoDate: "2026-10-15",
          time: "18:30",
          timeWithSeconds: "18:30:45",
        },
      },
    });

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
      const { source } = setup(instant);
      expect(await source.execute("system_time", { timezone })).toMatchObject({
        ok: true,
        result: {
          iso: instant,
          timezone,
          serverTimezone: "Europe/Amsterdam",
          local: {
            isoDate: date,
            time: time.slice(0, 5),
            timeWithSeconds: time,
          },
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
      const { source } = setup();
      expect(await source.execute("system_time", { timezone })).toEqual({
        ok: false,
        error: "Gebruik een geldige IANA-tijdzone, zoals Europe/Amsterdam.",
      });
    },
  );

  it("does not read the clock after cancellation", async () => {
    const { source } = setup();
    const controller = new AbortController();
    controller.abort();
    expect(
      await source.execute("system_time", {}, {
        signal: controller.signal,
      } as ToolCall),
    ).toEqual({
      ok: false,
      error: "Tijdslimiet bereikt",
    });
  });

  it("registers one read-only clock and selects it directly for Dutch and English time/date questions", () => {
    const clock = new SystemTimeSource({
      timezone: "Europe/Amsterdam",
    } as NovaConfig)
      .definitions()
      .find((tool) => tool.name === "system_time");
    expect(clock).toBeDefined();
    expect(clock!.risk).toBe("READ_ONLY");

    const tools: SelectableTool[] = new SystemTimeSource({
      timezone: "Europe/Amsterdam",
    } as NovaConfig)
      .definitions()
      .map((tool) => ({
        type: "function" as const,
        function: {
          name: tool.name,
          description: tool.description,
          parameters: tool.parameters,
        },
      }));
    tools.push(
      ...worldDefinitions().map((tool) => ({
        type: "function" as const,
        function: {
          name: tool.name,
          description: tool.description,
          parameters: tool.parameters,
        },
      })),
    );
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
      ).toBe("system_time");
    }
  });
});
