import { Body, Controller, Get, HttpCode, Param, Post } from "@nestjs/common";
import { ValidationError } from "../core/errors/validation.error.js";
import { OmniRouteKeyModelAccess } from "./omniroute-key-model-access.service.js";
import { strictBody } from "./request-input.js";

@Controller("settings/omniroute/accounts/keys/:id/model-access")
export class OmniRouteKeyModelAccessController {
  constructor(private readonly access: OmniRouteKeyModelAccess) {}

  @Get()
  get(@Param("id") id: string) {
    return this.access.options(id);
  }

  @Get("history")
  history(@Param("id") id: string) {
    return this.access.history(id);
  }

  @Post("rollback")
  @HttpCode(200)
  rollback(@Param("id") id: string, @Body() body: unknown) {
    const value = strictBody(
      body,
      ["revisionId"],
      "Ongeldige modelrechtenhistorie.",
    );
    if (typeof value.revisionId !== "string")
      throw new ValidationError(["Ongeldige modelrechtenhistorie."]);
    return this.access.rollback(id, value.revisionId);
  }

  @Post()
  @HttpCode(200)
  apply(@Param("id") id: string, @Body() body: unknown) {
    const value = strictBody(
      body,
      ["allowedModels"],
      "Ongeldige modelrechten.",
    );
    return this.access.apply(id, value.allowedModels);
  }
}
