import { Module } from "@nestjs/common";
import { TermixService } from "./termix.service.js";

@Module({ providers: [TermixService], exports: [TermixService] })
export class TermixModule {}
