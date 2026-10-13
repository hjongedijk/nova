import { BadRequestException, Body, Controller, Post } from "@nestjs/common";
import { NotesService } from "./notes.service.js";

@Controller("notes")
export class QuickNoteController {
  constructor(private readonly notes: NotesService) {}

  /** Explicit, one-phrase capture through the existing private notes store. */
  @Post("quick")
  save(@Body() body: unknown) {
    const content =
      body && typeof body === "object" && !Array.isArray(body)
        ? (body as Record<string, unknown>).content
        : null;
    if (
      typeof content !== "string" ||
      !content.trim() ||
      content.length > 500 ||
      [...content].some((character) => character.charCodeAt(0) < 32)
    )
      throw new BadRequestException("Spreek één korte zin in voor je notitie.");
    try {
      return this.notes.save("Snelle notitie", content);
    } catch {
      // Do not project note text or storage diagnostics into the response.
      throw new BadRequestException("De notitie is niet opgeslagen.");
    }
  }
}
