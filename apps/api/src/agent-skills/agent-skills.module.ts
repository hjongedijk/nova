import { Module } from "@nestjs/common";
import { AgentSkillsController } from "./agent-skills.controller.js";
import { AgentSkillsService } from "./agent-skills.service.js";
import { AgentSkillsSource } from "./agent-skills.source.js";
import { SkillInstallerService } from "./skill-installer.service.js";

/** Open Agent Skills (SKILL.md) support: storage, prompt list, skill_* tools and the settings API. */
@Module({
  controllers: [AgentSkillsController],
  providers: [AgentSkillsService, SkillInstallerService, AgentSkillsSource],
  exports: [AgentSkillsService],
})
export class AgentSkillsModule {}
