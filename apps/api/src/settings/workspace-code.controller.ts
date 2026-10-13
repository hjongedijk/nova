import { Controller, Get, Query, Res, UseGuards } from "@nestjs/common";
import type { Response } from "express";
import { SettingsGuard } from "./settings.guard.js";
import { WorkspaceCodeService } from "./workspace-code.service.js";

@Controller("settings/workspace/code")
@UseGuards(SettingsGuard)
export class WorkspaceCodeController {
  constructor(private readonly code: WorkspaceCodeService) {}

  @Get("tree")
  tree() {
    return this.code.tree();
  }

  @Get("file")
  file(@Query("path") filePath: string) {
    return this.code.read(filePath);
  }

  @Get("latest-run")
  latestRun(@Res() response: Response) {
    // Nest otherwise sends an empty body for null, which is not JSON null.
    response.json(this.code.latestRunReport());
  }
}
