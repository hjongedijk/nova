import { Module } from "@nestjs/common";
import { DownloadsController } from "./downloads.controller.js";

@Module({ controllers: [DownloadsController] })
export class DownloadsModule {}
