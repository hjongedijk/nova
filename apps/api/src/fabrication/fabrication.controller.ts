import {
  Controller,
  Get,
  NotFoundException,
  Param,
  ParseIntPipe,
  Res,
} from "@nestjs/common";
import type { Response } from "express";
import { FabricationService } from "./fabrication.service.js";
import { FabricationError } from "./fabrication.types.js";
import { describeJob, describeRevision } from "./fabrication.source.js";
import { listTemplates } from "./templates.js";

const ID = /^[a-z0-9]{6,24}$/;

/** App-guarded read access for the viewer and the 3D workspace: model files, designs, jobs, templates. */
@Controller("fabrication")
export class FabricationController {
  constructor(private readonly fab: FabricationService) {}

  @Get("designs")
  designs() {
    return {
      designs: this.fab
        .listDesigns()
        .map((d) => describeRevision(d, this.fab.revision(d))),
    };
  }

  @Get("jobs")
  jobs() {
    return { jobs: this.fab.history(50).map(describeJob) };
  }

  @Get("templates")
  templates() {
    return { templates: listTemplates(), buildVolume: this.fab.buildVolume() };
  }

  @Get("providers")
  providers() {
    return { providers: this.fab.providerStates() };
  }

  @Get("designs/:id/revisions/:n/model.stl")
  model(
    @Param("id") id: string,
    @Param("n", ParseIntPipe) n: number,
    @Res() res: Response,
  ) {
    if (!ID.test(id)) throw new NotFoundException();
    try {
      const bytes = this.fab.model(id, n);
      res.setHeader("content-type", "model/stl");
      res.setHeader("cache-control", "private, max-age=60");
      res.setHeader("content-disposition", `inline; filename="model-${n}.stl"`);
      res.send(bytes);
    } catch (error) {
      if (error instanceof FabricationError) throw new NotFoundException();
      throw error;
    }
  }

  @Get("designs/:id/revisions/:n/source.scad")
  source(
    @Param("id") id: string,
    @Param("n", ParseIntPipe) n: number,
    @Res() res: Response,
  ) {
    if (!ID.test(id)) throw new NotFoundException();
    try {
      const design = this.fab.design(id);
      const rev = this.fab.revision(design, n);
      if (!rev.scad) throw new NotFoundException();
      res.setHeader("content-type", "text/plain; charset=utf-8");
      res.send(rev.scad);
    } catch (error) {
      if (error instanceof FabricationError) throw new NotFoundException();
      throw error;
    }
  }
}
