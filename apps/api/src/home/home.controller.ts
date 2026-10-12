import { Controller, Get, HttpException, Query } from "@nestjs/common";
import type { EntitiesResponse } from "@nova/contracts";
import { HomeAssistantService } from "./home-assistant.service.js";

const one = (value: unknown) => (typeof value === "string" ? value : undefined);

@Controller()
export class HomeController {
  constructor(private readonly home: HomeAssistantService) {}

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
