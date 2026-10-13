import { Module } from "@nestjs/common";
import { NotesService } from "./notes.service.js";
import { NotesSource } from "./notes.source.js";
import { QuickNoteController } from "./quick-note.controller.js";

@Module({
  controllers: [QuickNoteController],
  providers: [NotesService, NotesSource],
  exports: [NotesService],
})
export class NotesModule {}
