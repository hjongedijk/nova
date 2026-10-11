import {
  Body,
  Controller,
  Get,
  HttpException,
  HttpCode,
  Post,
  Req,
  Res,
} from "@nestjs/common";
import type { Request, Response } from "express";
import { AppAccessPublic } from "./access-public.js";
import { AppAccessService } from "./access.service.js";

@Controller("access")
export class AppAccessController {
  constructor(private readonly access: AppAccessService) {}

  @Get("status")
  @AppAccessPublic()
  status(@Req() request: Request) {
    return this.access.status(request);
  }

  @Post("unlock")
  @HttpCode(200)
  @AppAccessPublic()
  unlock(
    @Body() body: { token?: unknown },
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
  ) {
    try {
      this.access.unlock(body?.token, request, response);
      return { unlocked: true };
    } catch (error) {
      const status =
        error && typeof error === "object" && "status" in error
          ? Number((error as { status?: unknown }).status)
          : 401;
      const message =
        error instanceof Error ? error.message : "Toegangscode onjuist.";
      throw new HttpException({ message }, status === 429 ? 429 : 401);
    }
  }
}
