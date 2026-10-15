import {
  Body,
  Controller,
  Delete,
  ForbiddenException,
  HttpCode,
  Post,
  Req,
  Res,
  ServiceUnavailableException,
  UseGuards,
} from "@nestjs/common";
import type { Request, Response } from "express";
import { AppAccessService } from "../access/access.service.js";
import { ValidationError } from "../core/errors/validation.error.js";
import { NodeRedEditorAccess } from "./node-red-editor-access.service.js";
import { NodeRedEditorProxy } from "./node-red-editor-proxy.service.js";
import { SettingsGuard } from "./settings.guard.js";

function emptyBody(body: unknown): void {
  if (
    body !== undefined &&
    (!body ||
      typeof body !== "object" ||
      Array.isArray(body) ||
      Object.keys(body).length > 0)
  )
    throw new ValidationError(["Ongeldig Node-RED-editorverzoek."]);
}

function sameOrigin(request: Request): boolean {
  const raw = request.headers.origin;
  if (typeof raw !== "string") return false;
  try {
    const origin = new URL(raw);
    return (
      raw === origin.origin &&
      origin.host === request.headers.host &&
      !origin.username &&
      !origin.password &&
      (origin.protocol === "https:" ||
        (origin.protocol === "http:" &&
          ["localhost", "127.0.0.1"].includes(origin.hostname)))
    );
  } catch {
    return false;
  }
}

@Controller("node-red-editor/_nova")
export class NodeRedEditorController {
  constructor(
    private readonly editorAccess: NodeRedEditorAccess,
    private readonly proxy: NodeRedEditorProxy,
    private readonly appAccess: AppAccessService,
  ) {}

  /** A fresh editor capability needs the settings screen's normal admin checks. */
  @Post("session")
  @HttpCode(200)
  @UseGuards(SettingsGuard)
  async open(
    @Body() body: unknown,
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
  ) {
    response.setHeader("Cache-Control", "no-store");
    emptyBody(body);
    if (
      !this.appAccess.privacyProtected ||
      !this.appAccess.isAuthorized(request)
    )
      throw new ForbiddenException(
        "Node-RED-editor vereist beveiligde NOVA-toegang.",
      );
    if (!sameOrigin(request))
      throw new ForbiddenException("Ongeldige oorsprong voor Node-RED-editor.");
    let upstreamAuth: boolean;
    try {
      upstreamAuth = await this.proxy.ready();
    } catch {
      throw new ServiceUnavailableException(
        "Node-RED-editor is tijdelijk niet beschikbaar.",
      );
    }
    return this.editorAccess.open(request, response, upstreamAuth);
  }

  /** Renewal requires an existing capability and never opens a locked editor. */
  @Post("renew")
  @HttpCode(200)
  renew(
    @Body() body: unknown,
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
  ) {
    response.setHeader("Cache-Control", "no-store");
    emptyBody(body);
    const session = this.editorAccess.authorize(request, true);
    if (!session)
      throw new ForbiddenException(
        "Node-RED-editorsessie is niet beschikbaar.",
      );
    return this.editorAccess.open(request, response, session.upstreamAuth);
  }

  @Delete("session")
  @HttpCode(200)
  close(
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
  ): { ok: true } {
    response.setHeader("Cache-Control", "no-store");
    const session = this.editorAccess.authorize(request, true);
    this.editorAccess.close(request, response);
    if (session) this.proxy.closeSession(session.key);
    return { ok: true };
  }
}
