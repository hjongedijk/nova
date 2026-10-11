import { Module } from "@nestjs/common";
import { APP_GUARD } from "@nestjs/core";
import { CoreModule } from "../core/core.module.js";
import { AppAccessController } from "./access.controller.js";
import { AppAccessGuard } from "./access.guard.js";
import { AppAccessService } from "./access.service.js";

@Module({
  imports: [CoreModule],
  controllers: [AppAccessController],
  providers: [
    AppAccessService,
    { provide: APP_GUARD, useClass: AppAccessGuard },
  ],
  exports: [AppAccessService],
})
export class AppAccessModule {}
