import {
  Body,
  Controller,
  Get,
  HttpCode,
  Param,
  Post,
  Put,
} from "@nestjs/common";
import { WorkspaceProjects } from "./workspace-projects.service.js";

@Controller("settings/workspace/projects")
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

  @Post("history/:revision/rollback")
  @HttpCode(200)
  rollback(@Param("revision") revision: string) {
    return this.projects.rollback(revision);
  }
}
