import { Module } from "@nestjs/common";
import { PlanningModule } from "../planning/planning.module.js";
import { VisualizationModule } from "../visualization/visualization.module.js";
import {
  CAD_WORKER,
  CadWorkerRouter,
  StackControlCadWorker,
  WindowsAgentCadWorker,
  WindowsFabAgent,
} from "./cad.worker.js";
import { DISCOVERY_PROVIDERS, ThingiverseProvider } from "./discovery.js";
import { FabricationController } from "./fabrication.controller.js";
import { FabricationService } from "./fabrication.service.js";
import { FabricationSource } from "./fabrication.source.js";
import { FabricationStore } from "./fabrication.store.js";
import { PRINTER_PORT, PrinterProvider } from "./printer.port.js";
import {
  ConfiguredCliSlicer,
  SLICER_PORT,
  SlicerRouter,
  WindowsAgentSlicer,
} from "./slicer.port.js";

/**
 * 3D discovery, parametric CAD in a sandbox, validation, slicing and the approval-gated print workflow
 * for the Bambu Lab P2S. See docs/fabrication-architecture.md. The CAD worker, printer, slicer and
 * repositories sit behind ports so another engine, printer or repository is one provider away.
 */
@Module({
  imports: [PlanningModule, VisualizationModule],
  controllers: [FabricationController],
  providers: [
    FabricationStore,
    FabricationService,
    FabricationSource,
    ThingiverseProvider,
    StackControlCadWorker,
    WindowsFabAgent,
    WindowsAgentCadWorker,
    CadWorkerRouter,
    WindowsAgentSlicer,
    SlicerRouter,
    PrinterProvider,
    ConfiguredCliSlicer,
    { provide: CAD_WORKER, useExisting: CadWorkerRouter },
    { provide: PRINTER_PORT, useExisting: PrinterProvider },
    { provide: SLICER_PORT, useExisting: SlicerRouter },
    {
      provide: DISCOVERY_PROVIDERS,
      useFactory: (t: ThingiverseProvider) => [t],
      inject: [ThingiverseProvider],
    },
  ],
  exports: [FabricationService],
})
export class FabricationModule {}
