import {
  type ArgumentsHost,
  Catch,
  type ExceptionFilter,
  HttpException,
  Logger,
} from "@nestjs/common";
import type { Response } from "express";

/** Input that cannot be accepted. The messages are shown to the user, so they are in Dutch. */
export class ValidationError extends Error {
  constructor(readonly details: string[]) {
    super(details[0] ?? "Ongeldige invoer.");
    this.name = "ValidationError";
  }
}

/**
 * One error shape for the whole API: { error, details? }. Validation problems are 400 with the
 * Dutch message; anything unexpected is logged and answered without internals.
 */
@Catch()
export class ApiErrorFilter implements ExceptionFilter {
  private readonly log = new Logger("API");

  catch(exception: unknown, host: ArgumentsHost): void {
    const response = host.switchToHttp().getResponse<Response>();
    if (response.headersSent) return;
    if (exception instanceof ValidationError) {
      response
        .status(400)
        .json({ error: exception.message, details: exception.details });
      return;
    }
    if (exception instanceof HttpException) {
      const body = exception.getResponse();
      const message =
        typeof body === "string"
          ? body
          : ((body as { message?: string | string[] }).message ??
            exception.message);
      response
        .status(exception.getStatus())
        .json({ error: Array.isArray(message) ? message.join(" ") : message });
      return;
    }
    this.log.error(
      exception instanceof Error ? exception.message : String(exception),
    );
    response.status(500).json({ error: "Dat is niet gelukt." });
  }
}
