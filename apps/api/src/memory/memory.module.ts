import { Module } from "@nestjs/common";
import { RoutingModule } from "../routing/routing.module.js";
import { MemoryController } from "./memory.controller.js";
import { MemorySource } from "./memory.source.js";
import { SemanticMemoryService } from "./semantic-memory.service.js";
import { SessionMemoryService } from "./session-memory.service.js";

/**
 * Conversations and session context (memory.json), and long-term semantic memory (Qdrant or
 * OmniRoute's native memory) with its tools, routes and daily maintenance. Exports
 * SessionMemoryService and SemanticMemoryService (health() for the dashboard).
 */
@Module({
  imports: [RoutingModule],
  controllers: [MemoryController],
  providers: [SessionMemoryService, SemanticMemoryService, MemorySource],
  exports: [SessionMemoryService, SemanticMemoryService],
})
export class MemoryModule {}
