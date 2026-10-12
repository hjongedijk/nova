import {
  Body,
  Controller,
  Get,
  HttpCode,
  Post,
  Query,
  Req,
  Res,
  UseGuards,
} from "@nestjs/common";
import type { Request, Response } from "express";
import { PublicRoute, SettingsGuard } from "../../settings/settings.guard.js";
import { YoutubeOAuthService } from "./youtube-oauth.service.js";

const COOKIE = "nova_youtube_oauth";
const COOKIE_PATH = "/api/settings/youtube/oauth/callback";

@Controller("settings/youtube/oauth")
@UseGuards(SettingsGuard)
export class YoutubeOAuthController {
  constructor(private readonly oauth: YoutubeOAuthService) {}

  @Get("status")
  status() {
    return this.oauth.status();
  }

  @Post("config")
  @HttpCode(200)
  saveConfig(@Body() body: unknown) {
    return this.oauth.saveClient(body);
  }

  @Post("start")
  @HttpCode(200)
  start(@Res({ passthrough: true }) response: Response) {
    const result = this.oauth.begin();
    response.cookie(result.cookieName, result.cookieValue, {
      httpOnly: true,
      secure: true,
      sameSite: "lax",
      path: COOKIE_PATH,
      maxAge: result.maxAgeMs,
    });
    return { authorizationUrl: result.authorizationUrl };
  }

  /** Google's redirect cannot carry NOVA's SettingsGuard headers; the one-use state and cookie gate it. */
  @Get("callback")
  @PublicRoute()
  async callback(
    @Query("state") state: unknown,
    @Query("code") code: unknown,
    @Req() request: Request,
    @Res() response: Response,
  ) {
    response.clearCookie(COOKIE, {
      path: COOKIE_PATH,
      httpOnly: true,
      secure: true,
      sameSite: "lax",
    });
    try {
      const cookie = readCookie(request.headers.cookie, COOKIE);
      await this.oauth.complete({ state, code, cookie });
      response.redirect(
        303,
        "/settings?section=connections&youtubeOAuth=connected",
      );
    } catch {
      response.redirect(
        303,
        "/settings?section=connections&youtubeOAuth=error",
      );
    }
  }

  @Post("disconnect")
  @HttpCode(200)
  disconnect() {
    return this.oauth.disconnect();
  }
}

function readCookie(
  header: string | undefined,
  name: string,
): string | undefined {
  const value = header
    ?.split(";")
    .map((part) => part.trim())
    .find((part) => part.startsWith(`${name}=`));
  if (!value) return undefined;
  try {
    return decodeURIComponent(value.slice(name.length + 1));
  } catch {
    return undefined;
  }
}
