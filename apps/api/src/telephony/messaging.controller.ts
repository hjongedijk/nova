import {
  Body,
  Controller,
  Header,
  HttpCode,
  Post,
  UnauthorizedException,
} from "@nestjs/common";
import { MessageAuthError, TelephonyMessaging } from "./messaging.js";

/** Called by the Asterisk dialplan over the private network for every text message; guarded by a generated shared token. */
@Controller("integrations/asterisk")
export class TelephonyMessagingController {
  constructor(private readonly messaging: TelephonyMessaging) {}

  @Post("message")
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

/**
 * Called by the Linphone end-to-end encrypted chat bridge (deploy/linphone-chat) over the private network.
 * The bridge decrypts, so `text` is plain; same shared token as the Asterisk endpoint, same allow-list, rate limit and read-only tools.
 */
@Controller("integrations/linphone-chat")
export class LinphoneChatController {
  constructor(private readonly messaging: TelephonyMessaging) {}

  @Post("message")
  @HttpCode(200)
  @Header("Cache-Control", "no-store")
  async message(
    @Body() body: Record<string, unknown>,
  ): Promise<{ reply: string }> {
    try {
      return {
        reply: await this.messaging.handleChat({
          token: body?.token,
          from: body?.from,
          text: body?.text,
        }),
      };
    } catch (error) {
      if (error instanceof MessageAuthError) throw new UnauthorizedException();
      throw error;
    }
  }

  /**
   * SIP addresses of contacts marked "Mag met NOVA praten": the bridge accepts encrypted rooms only from these.
   * `identity` is the trunk account (username@host, no password) the bridge shares with Asterisk; null while no trunk exists.
   */
  @Post("allowlist")
  @HttpCode(200)
  @Header("Cache-Control", "no-store")
  allowlist(@Body() body: Record<string, unknown>): {
    contacts: string[];
    identity: string | null;
  } {
    try {
      return {
        contacts: this.messaging.allowedContacts(body?.token),
        identity: this.messaging.chatIdentity(body?.token),
      };
    } catch (error) {
      if (error instanceof MessageAuthError) throw new UnauthorizedException();
      throw error;
    }
  }
}
