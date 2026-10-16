import {
  Body,
  Controller,
  Header,
  HttpCode,
  Post,
  UnauthorizedException,
} from "@nestjs/common";
import { AppAccessPublic } from "../access/access-public.js";
import { MessageAuthError, TelephonyMessaging } from "./messaging.js";

/** Called by the Asterisk dialplan over the private network for every text message; guarded by a generated shared token. */
@Controller("integrations/asterisk")
export class TelephonyMessagingController {
  constructor(private readonly messaging: TelephonyMessaging) {}

  @Post("message")
  @AppAccessPublic()
  @HttpCode(200)
  @Header("Content-Type", "text/plain; charset=utf-8")
  @Header("Cache-Control", "no-store")
  async message(@Body() body: Record<string, unknown>): Promise<string> {
    try {
      return await this.messaging.handle({
        token: body?.token,
        from: body?.from,
        type: body?.type,
        body: body?.body,
      });
    } catch (error) {
      if (error instanceof MessageAuthError) throw new UnauthorizedException();
      throw error;
    }
  }
}
