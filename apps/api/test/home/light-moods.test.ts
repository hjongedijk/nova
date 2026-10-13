import { HttpException } from "@nestjs/common";
import { describe, expect, it, vi } from "vitest";
import { HomeController } from "../../src/home/home.controller.js";

const light = (
  areaId: string,
  areaName: string,
  state: string,
  rgb: unknown,
  domain = "light",
) => ({
  area_id: areaId,
  area: areaName,
  state,
  domain,
  attributes: { rgb_color: rgb, private_note: "private upstream detail" },
  entity_id: `light.${areaId}`,
});

describe("read-only Home Assistant light mood", () => {
  it("projects only allowed on-light colors as bounded unique area hues", async () => {
    const sync = vi.fn(async () => []);
    const visibleEntities = vi.fn(() => [
      light("office", "Kantoor", "on", [255, 0, 0]),
      light("office", "Kantoor", "on", [0, 255, 0]),
      light("living", "Woonkamer", "on", [0, 0, 255]),
      light("hidden", "Verborgen", "on", [255, 0, 0], "sensor"),
      light("off", "Uit", "off", [255, 0, 0]),
      light("invalid", "Ongeldig", "on", [Infinity, 0, 0]),
      light("gray", "Grijs", "on", [100, 100, 100]),
    ]);
    const home = {
      sync,
      visibleEntities,
      service: vi.fn(),
      state: vi.fn(),
      entities: [light("private", "Privé", "on", [255, 0, 0])],
    };
    const controller = new HomeController(home as never);
    const result = await controller.lightMoods();
    expect(sync).toHaveBeenCalledOnce();
    expect(visibleEntities).toHaveBeenCalledOnce();
    expect(result).toEqual({
      areas: [
        { areaId: "living", areaName: "Woonkamer", hue: 240 },
        { areaId: "office", areaName: "Kantoor", hue: 60 },
      ],
    });
    expect(JSON.stringify(result)).not.toContain("private upstream detail");
    expect(JSON.stringify(result)).not.toContain("light.office");
    expect(home.service).not.toHaveBeenCalled();
    expect(home.state).not.toHaveBeenCalled();
  });

  it("returns empty areas without valid visible colors and fixed 503 on sync failure", async () => {
    const home = {
      sync: vi.fn(async () => []),
      visibleEntities: vi.fn(() => [
        light("office", "Kantoor", "off", [255, 0, 0]),
      ]),
    };
    const controller = new HomeController(home as never);
    await expect(controller.lightMoods()).resolves.toEqual({ areas: [] });
    home.sync.mockRejectedValueOnce(new Error("private Home Assistant token"));
    try {
      await controller.lightMoods();
      throw new Error("expected failure");
    } catch (error) {
      expect(error).toBeInstanceOf(HttpException);
      expect((error as HttpException).getStatus()).toBe(503);
      expect(JSON.stringify((error as HttpException).getResponse())).toBe(
        '{"error":"Home Assistant is tijdelijk niet beschikbaar."}',
      );
    }
  });
});
