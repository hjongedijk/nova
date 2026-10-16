import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  NotFoundException,
  Param,
  Post,
  Query,
  Res,
  ServiceUnavailableException,
} from "@nestjs/common";
import type { Response } from "express";
import type {
  VizProviderInfo,
  VizScene,
  VizSceneResponse,
} from "@nova/contracts";
import { resolveTopic } from "./intent.js";
import { VisualizationRegistry } from "./visualization.registry.js";
import {
  VisualizationError,
  VisualizationService,
} from "./visualization.service.js";

const ID = /^viz-[0-9a-f]{10}$/;
const signal = () => AbortSignal.timeout(20_000);

/** App-guarded API the viewer uses: provider list, open, poll, export, close. */
@Controller("visualizations")
export class VisualizationController {
  constructor(
    private readonly viz: VisualizationService,
    private readonly registry: VisualizationRegistry,
  ) {}

  @Get("providers")
  providers(): { providers: VizProviderInfo[] } {
    return { providers: this.registry.info() };
  }

  /** Open a provider's visualisation from the menu (the same thing create_visualization does). */
  @Post()
  @HttpCode(201)
  async open(@Body() body: { source?: unknown }): Promise<{ scene: VizScene }> {
    const source = typeof body?.source === "string" ? body.source : "";
    const ref = resolveTopic(source, this.registry);
    if (!ref) throw new BadRequestException("Onbekende visualisatie.");
    try {
      return { scene: await this.viz.create(ref, {}, signal()) };
    } catch (error) {
      if (error instanceof VisualizationError)
        throw new ServiceUnavailableException(error.message);
      throw new ServiceUnavailableException(
        "De visualisatie kon niet worden opgebouwd.",
      );
    }
  }

  @Get(":id")
  async read(
    @Param("id") id: string,
    @Query("since") since?: string,
  ): Promise<VizSceneResponse> {
    if (!ID.test(id))
      throw new NotFoundException("Visualisatie niet gevonden.");
    const parsed = since === undefined ? undefined : Number(since);
    const answer = await this.viz.read(
      id,
      Number.isInteger(parsed) ? parsed : undefined,
      signal(),
    );
    if (!answer) throw new NotFoundException("Visualisatie niet gevonden.");
    return answer;
  }

  @Get(":id/export")
  export(
    @Param("id") id: string,
    @Query("format") format: string | undefined,
    @Res() res: Response,
  ): void {
    if (!ID.test(id) || !this.viz.get(id))
      throw new NotFoundException("Visualisatie niet gevonden.");
    const out = this.viz.export(id, format === "csv" ? "csv" : "json");
    res
      .type(out.mime)
      .setHeader(
        "content-disposition",
        `attachment; filename="${out.filename}"`,
      )
      .send(out.content);
  }

  @Delete(":id")
  close(@Param("id") id: string): { cleared: true } {
    if (!ID.test(id) || !this.viz.get(id))
      throw new NotFoundException("Visualisatie niet gevonden.");
    this.viz.clear(id);
    return { cleared: true };
  }
}
