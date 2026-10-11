import {
  Body,
  Controller,
  Get,
  HttpCode,
  Param,
  Post,
  Put,
  UseGuards,
} from "@nestjs/common";
import { SettingsGuard } from "./settings.guard.js";
import { WorkspaceProjects } from "./workspace-projects.service.js";
import { ValidationError } from "../core/errors/validation.error.js";

@Controller("settings/workspace/projects")
@UseGuards(SettingsGuard)
export class WorkspaceProjectsController {
  constructor(private readonly projects: WorkspaceProjects) {}

  @Get()
  list() {
    return this.projects.list();
  }

  @Post()
  create(@Body() body: unknown) {
    return this.projects.create(body);
  }

  @Put("active")
  select(@Body() body: unknown) {
    return this.projects.select(body);
  }

  @Get("history")
  history() {
    return this.projects.history();
  }

  @Post("history/:revision/prepare-rollback")
  @HttpCode(200)
  prepareRollback(@Param("revision") revision: string) {
    return this.projects.prepareRollback(revision);
  }

  @Post("history/confirm-rollback")
  @HttpCode(200)
  confirmRollback(@Body() body: unknown) {
    if (!body || typeof body !== "object" || Array.isArray(body))
      throw new ValidationError(["Ongeldige projectbevestiging."]);
    const input = body as Record<string, unknown>;
    if (
      Object.keys(input).some(
        (key) => !["sessionId", "confirmationId", "approve"].includes(key),
      ) ||
      typeof input.sessionId !== "string" ||
      typeof input.confirmationId !== "string" ||
      typeof input.approve !== "boolean"
    )
      throw new ValidationError(["Ongeldige projectbevestiging."]);
    return this.projects.confirmRollback(
      input.sessionId,
      input.confirmationId,
      input.approve,
    );
  }
}
