import { Module } from "@nestjs/common";
import { PangolinService } from "./pangolin.service.js";

@Module({ providers: [PangolinService], exports: [PangolinService] })
export class PangolinModule {}
