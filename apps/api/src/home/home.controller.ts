import { Controller, Get, HttpException, Query } from "@nestjs/common";
import type { EntitiesResponse } from "@nova/contracts";
import { sanitize } from "../core/security/sanitize.js";
import { HomeAssistantService } from "./home-assistant.service.js";

const one = (value: unknown) => (typeof value === "string" ? value : undefined);
const validRgb = (value: unknown): value is [number, number, number] =>
  Array.isArray(value) &&
  value.length === 3 &&
  value.every(
    (channel) => Number.isInteger(channel) && channel >= 0 && channel <= 255,
  );

function hueOf(r: number, g: number, b: number): number | null {
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const delta = max - min;
  if (delta === 0) return null;
  const sector =
    max === r
      ? ((g - b) / delta) % 6
      : max === g
        ? (b - r) / delta + 2
        : (r - g) / delta + 4;
  return ((Math.round(sector * 60) % 360) + 360) % 360;
}

@Controller()
export class HomeController {
  constructor(private readonly home: HomeAssistantService) {}

  /** GET /api/home/light-moods: bounded color mood for visible, on lights only. */
  @Get("home/light-moods")
  async lightMoods(): Promise<{
    areas: { areaId: string; areaName: string; hue: number }[];
  }> {
    try {
      await this.home.sync();
    } catch {
      throw new HttpException(
        { error: "Home Assistant is tijdelijk niet beschikbaar." },
        503,
      );
    }
    const sums = new Map<
      string,
      { name: string; r: number; g: number; b: number; count: number }
    >();
    for (const entity of this.home.visibleEntities()) {
      if (
        entity.domain !== "light" ||
        entity.state !== "on" ||
        !entity.area_id ||
        !/^[A-Za-z0-9_-]{1,128}$/.test(entity.area_id) ||
        typeof entity.area !== "string" ||
        !validRgb(entity.attributes?.rgb_color)
      )
        continue;
      const name = sanitize(entity.area).trim().slice(0, 80);
      if (!name) continue;
      const rgb = entity.attributes.rgb_color;
      const current = sums.get(entity.area_id);
      if (!current && sums.size >= 32) continue;
      if (current) {
        current.r += rgb[0];
        current.g += rgb[1];
        current.b += rgb[2];
        current.count++;
      } else {
        sums.set(entity.area_id, {
          name,
          r: rgb[0],
          g: rgb[1],
          b: rgb[2],
          count: 1,
        });
      }
    }
    return {
      areas: [...sums]
        .flatMap(([areaId, value]) => {
          const hue = hueOf(
            value.r / value.count,
            value.g / value.count,
            value.b / value.count,
          );
          return hue === null ? [] : [{ areaId, areaName: value.name, hue }];
        })
        .sort((a, b) => a.areaId.localeCompare(b.areaId)),
    };
  }

  /** GET /api/entities?query=&domain=&area=: the Home Assistant catalog, searched. */
  @Get("entities")
  async entities(
    @Query() query: Record<string, unknown>,
  ): Promise<EntitiesResponse> {
    try {
      await this.home.sync();
    } catch {
      throw new HttpException(
        { error: "Home Assistant is tijdelijk niet beschikbaar." },
        503,
      );
    }
    return {
      entities: this.home.search(
        one(query.query),
        one(query.domain),
        one(query.area),
      ),
      syncedAt: this.home.syncedAt,
    };
  }
}
