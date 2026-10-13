import { Module } from "@nestjs/common";
import { NodeRedFlowRevisions } from "./node-red-flow-revisions.service.js";

/** Shared private flow history without a Settings/Dashboard module cycle. */
@Module({
  providers: [NodeRedFlowRevisions],
  exports: [NodeRedFlowRevisions],
})
export class NodeRedFlowRevisionsModule {}
