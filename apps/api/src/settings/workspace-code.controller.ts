import { Controller, Get, Query, UseGuards } from "@nestjs/common";
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
  latestRun() {
    return this.code.latestRunReport();
  }
}
