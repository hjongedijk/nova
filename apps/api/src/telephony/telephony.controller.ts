import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  Header,
  HttpCode,
  NotFoundException,
  Param,
  Post,
  Put,
  Req,
  Res,
  UseGuards,
} from "@nestjs/common";
import type { Request, Response } from "express";
import { AppAccessPublic } from "../access/access-public.js";
import { SettingsGuard } from "../settings/settings.guard.js";
import { TelephonyService } from "./telephony.service.js";
import { TelephonyError } from "./telephony.types.js";

const obj = (value: unknown): Record<string, unknown> =>
  value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};

function guard<T>(run: () => T): T {
  try {
    return run();
  } catch (error) {
    if (error instanceof TelephonyError)
      throw new BadRequestException(error.message);
    throw error;
  }
}

/** Settings API for telephony (PIN-protected like other settings) plus the one-time Linphone provisioning download. */
@Controller("telephony")
export class TelephonyController {
  private windowStart = Date.now();
  private served = 0;
  constructor(private readonly telephony: TelephonyService) {}

  @Get("status")
  @UseGuards(SettingsGuard)
  async status() {
    return {
      ...(await this.telephony.status()),
      events: this.telephony.recentEvents().slice(-20).reverse(),
    };
  }

  @Put("enabled")
  @UseGuards(SettingsGuard)
  async enabled(@Body() body: unknown) {
    const { enabled } = obj(body);
    if (typeof enabled !== "boolean")
      throw new BadRequestException("enabled moet true of false zijn.");
    guard(() => this.telephony.setEnabled(enabled));
    return this.status();
  }

  @Put("settings")
  @UseGuards(SettingsGuard)
  async settings(@Body() body: unknown) {
    const input = obj(body);
    guard(() => {
      if (input.publicHost !== undefined)
        this.telephony.setPublicHost(String(input.publicHost));
      this.telephony.setPolicy({
        allowInternalCallsWithoutConfirmation:
          input.allowInternalCallsWithoutConfirmation as boolean | undefined,
        voice: input.voice as "edge" | "piper" | undefined,
        ringExtensions: Array.isArray(input.ringExtensions)
          ? input.ringExtensions.map(String)
          : undefined,
      });
    });
    return this.status();
  }

  @Put("trunk")
  @UseGuards(SettingsGuard)
  async trunk(@Body() body: unknown) {
    const input = obj(body);
    guard(() =>
      this.telephony.setTrunk({
        host: String(input.host ?? ""),
        username: String(input.username ?? ""),
        secret:
          typeof input.secret === "string" && input.secret
            ? input.secret
            : undefined,
        number: String(input.number ?? ""),
        allowExtensionsToDialOut: input.allowExtensionsToDialOut === true,
      }),
    );
    return this.status();
  }

  @Put("contacts")
  @UseGuards(SettingsGuard)
  async contacts(@Body() body: unknown) {
    const input = obj(body);
    guard(() => this.telephony.setContacts(input.contacts));
    return this.status();
  }

  @Delete("trunk")
  @UseGuards(SettingsGuard)
  async removeTrunk() {
    guard(() => this.telephony.setTrunk(null));
    return this.status();
  }

  @Post("extensions")
  @HttpCode(201)
  @UseGuards(SettingsGuard)
  addExtension(@Body() body: unknown) {
    const input = obj(body);
    const kind = input.kind === "doorbell" ? "doorbell" : "phone";
    if (typeof input.name !== "string" || !input.name.trim())
      throw new BadRequestException("Geef het toestel een naam.");
    const created = guard(() =>
      this.telephony.addExtension(input.name as string, kind),
    );
    return { id: created.id, name: created.name, kind: created.kind };
  }

  @Delete("extensions/:id")
  @UseGuards(SettingsGuard)
  removeExtension(@Param("id") id: string) {
    if (!guard(() => this.telephony.removeExtension(id)))
      throw new NotFoundException("Onbekend toestel.");
    return { ok: true };
  }

  /** The file itself contains the SIP password: PIN-protected, never cached. */
  @Get("extensions/:id/linphone.xml")
  @UseGuards(SettingsGuard)
  @Header("Content-Type", "application/xml; charset=utf-8")
  @Header("Cache-Control", "no-store")
  linphone(@Param("id") id: string) {
    return guard(() => this.telephony.linphoneXml(id));
  }

  @Post("extensions/:id/provisioning-link")
  @HttpCode(200)
  @UseGuards(SettingsGuard)
  link(@Param("id") id: string, @Req() request: Request) {
    const { token, expiresAt } = guard(() =>
      this.telephony.createProvisioningLink(id),
    );
    return {
      url: `${request.protocol}://${request.get("host")}/api/telephony/provisioning/${token}`,
      expiresAt,
      singleUse: true,
    };
  }

  /** Called by the Linphone app. The unguessable one-time token is the credential. */
  @Get("provisioning/:token")
  @AppAccessPublic()
  provisioning(@Param("token") token: string, @Res() response: Response) {
    const now = Date.now();
    if (now - this.windowStart > 60_000) {
      this.windowStart = now;
      this.served = 0;
    }
    response.setHeader("Cache-Control", "no-store");
    if (++this.served > 20) {
      response.status(429).json({ error: "Te veel verzoeken." });
      return;
    }
    const xml =
      token.length >= 20 && token.length <= 64
        ? this.telephony.redeemProvisioningLink(token)
        : null;
    if (!xml) {
      response.status(404).json({ error: "Link verlopen of al gebruikt." });
      return;
    }
    response.type("application/xml").send(xml);
  }
}
