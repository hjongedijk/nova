import { Body, Controller, Get, HttpCode, Param, Post } from "@nestjs/common";
import { OmniRouteAccountRename } from "./omniroute-account-rename.service.js";
import { strictBody } from "./request-input.js";

@Controller("settings/omniroute/accounts/rename")
export class OmniRouteAccountRenameController {
  constructor(private readonly renameAccount: OmniRouteAccountRename) {}

  @Get(":id/history")
  listHistory(@Param("id") id: string) {
    return this.renameAccount.listHistory(id);
  }

  @Post(":id/history/:revision/rollback")
  @HttpCode(200)
  rollback(@Param("id") id: string, @Param("revision") revision: string) {
    return this.renameAccount.rollback(id, revision);
  }

  @Post()
  @HttpCode(200)
  rename(@Body() body: unknown) {
    const value = strictBody(
      body,
      ["id", "name"],
      "Ongeldige accountnaamwijziging.",
    );
    return this.renameAccount.rename(value.id, value.name);
  }
}
