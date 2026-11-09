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
  Put,
  Query,
} from "@nestjs/common";
import { AgentSkillError, AgentSkillsService } from "./agent-skills.service.js";
import { isSkillName } from "./skill-format.js";
import { SkillInstallerService } from "./skill-installer.service.js";

const field = (body: unknown, key: string): unknown =>
  body && typeof body === "object"
    ? (body as Record<string, unknown>)[key]
    : undefined;

function translate(error: unknown): never {
  if (error instanceof AgentSkillError) {
    if (/bestaat niet/.test(error.message))
      throw new NotFoundException(error.message);
    throw new BadRequestException(error.message);
  }
  throw error;
}

function skillName(value: string): string {
  if (!isSkillName(value))
    throw new NotFoundException("Onbekende vaardigheid.");
  return value;
}

/** Instellingen > Geavanceerd > Agent Skills. */
@Controller("settings/agent-skills")
export class AgentSkillsController {
  constructor(
    private readonly skills: AgentSkillsService,
    private readonly installer: SkillInstallerService,
  ) {}

  @Get()
  list() {
    return this.skills.report();
  }

  @Get("search")
  search(@Query("q") query?: string) {
    return this.installer.search(typeof query === "string" ? query : "", 12);
  }

  @Get(":name")
  read(@Param("name") name: string) {
    const skill = this.skills
      .list()
      .find((item) => item.name === skillName(name));
    if (!skill) throw new NotFoundException("Onbekende vaardigheid.");
    try {
      const content =
        skill.enabled && !skill.error
          ? this.skills.read(skill.name).content
          : null;
      return { skill, content };
    } catch (error) {
      return translate(error);
    }
  }

  @Post("install")
  @HttpCode(200)
  async install(@Body() body: unknown) {
    try {
      return await this.installer.install(field(body, "source"), {
        replace: field(body, "replace") === true,
      });
    } catch (error) {
      return translate(error);
    }
  }

  @Put(":name")
  toggle(@Param("name") name: string, @Body() body: unknown) {
    const enabled = field(body, "enabled");
    if (typeof enabled !== "boolean")
      throw new BadRequestException(
        "Geef aan of de vaardigheid aan of uit moet.",
      );
    try {
      return {
        ok: true,
        skill: this.skills.setEnabled(skillName(name), enabled),
      };
    } catch (error) {
      return translate(error);
    }
  }

  @Delete(":name")
  remove(@Param("name") name: string) {
    try {
      return this.skills.remove(skillName(name));
    } catch (error) {
      return translate(error);
    }
  }
}
