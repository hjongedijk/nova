import { Controller, HttpCode, Param, Post } from "@nestjs/common";
import { NativeSkillRemoval } from "./native-skill-removal.service.js";

@Controller("settings/omniroute/native/skills")
export class NativeSkillRemovalController {
  constructor(private readonly removal: NativeSkillRemoval) {}
  @Post(":id/remove")
  @HttpCode(200)
  remove(@Param("id") id: string) {
    return this.removal.remove(id);
  }
}
