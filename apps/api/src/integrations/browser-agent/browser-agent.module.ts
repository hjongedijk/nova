import { Module } from "@nestjs/common";
import { BrowserAgentService } from "./browser-agent.service.js";

@Module({ providers: [BrowserAgentService], exports: [BrowserAgentService] })
export class BrowserAgentModule {}
