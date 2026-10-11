import { Module } from "@nestjs/common";
import { NotesService } from "./notes.service.js";
import { NotesSource } from "./notes.source.js";

@Module({ providers: [NotesService, NotesSource], exports: [NotesService] })
export class NotesModule {}
