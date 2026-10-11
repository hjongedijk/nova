import { Body, ConflictException, Controller, Get, Post } from "@nestjs/common";
import { ValidationError } from "../../core/errors/validation.error.js";
import { sanitize } from "../../core/security/sanitize.js";
import {
  checkAttachments,
  extractDocumentAttachments,
} from "../../chat/attachments.js";
import { DocumentIndexService } from "./document-index.service.js";

@Controller("documents")
export class DocumentsController {
  constructor(private readonly documents: DocumentIndexService) {}

  @Get()
  async list() {
    if (!this.documents.configured) return { configured: false, documents: [] };
    return { configured: true, documents: await this.documents.list() };
  }

  @Post("index")
  async index(@Body() body: { attachments?: unknown }) {
    if (!this.documents.configured)
      throw new ConflictException(
        "Een geverifieerd gratis embeddingmodel is nog niet ingesteld.",
      );
    const attachments = checkAttachments(body?.attachments);
    if (!attachments.length)
      throw new ValidationError(["Kies minstens één document."]);
    const extracted = await extractDocumentAttachments(attachments);
    const documents = [];
    try {
      for (const file of extracted)
        documents.push(await this.documents.index(file.name, file.content));
    } catch (error) {
      await Promise.all(
        documents.map((document) =>
          this.documents.remove(document.id).catch(() => undefined),
        ),
      );
      throw error;
    }
    return sanitize({
      documents,
      truncated: extracted.some((file) => file.truncated),
    });
  }

  @Post("search")
  async search(@Body() body: { query?: unknown }) {
    if (!this.documents.configured)
      throw new ConflictException(
        "Een geverifieerd gratis embeddingmodel is nog niet ingesteld.",
      );
    if (typeof body?.query !== "string" || body.query.length > 500)
      throw new ValidationError(["Zoek op 2 tot 500 tekens."]);
    const results = await this.documents.search(body.query);
    return sanitize({ results, count: results.length, untrusted: true });
  }
}
