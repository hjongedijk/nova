import { Module } from "@nestjs/common";
import { RoutingModule } from "../routing/routing.module.js";
import { MemoryController } from "./memory.controller.js";
import { MemorySource } from "./memory.source.js";
import { SemanticMemoryService } from "./semantic-memory.service.js";
import { SessionMemoryService } from "./session-memory.service.js";
import { DocumentsController } from "./documents/documents.controller.js";
import { DocumentIndexService } from "./documents/document-index.service.js";
import { DocumentsSource } from "./documents/documents.source.js";

/**
 * Conversations and session context (memory.json), and long-term semantic memory (Qdrant or
 * OmniRoute's native memory) with its tools, routes and daily maintenance. Exports
 * SessionMemoryService and SemanticMemoryService (health() for the dashboard).
 */
@Module({
  imports: [RoutingModule],
  controllers: [MemoryController, DocumentsController],
  providers: [
    SessionMemoryService,
    SemanticMemoryService,
    MemorySource,
    DocumentIndexService,
    DocumentsSource,
  ],
  exports: [SessionMemoryService, SemanticMemoryService],
})
export class MemoryModule {}
