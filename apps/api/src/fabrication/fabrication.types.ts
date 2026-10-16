import type { MeshReport, PrintabilityIssue } from "./mesh.js";
import type { TemplateId } from "./templates.js";

export class FabricationError extends Error {}

/** The one supported printer. Dimensions are the manufacturer's; override with NOVA_PRINTER_BUILD_VOLUME. */
export const P2S_PROFILE = {
  id: "bambu-p2s",
  name: "Bambu Lab P2S",
  buildVolume: { x: 256, y: 256, z: 256 },
  nozzles: [0.2, 0.4, 0.6, 0.8],
  materials: ["PLA", "PETG", "ABS", "ASA", "TPU", "PA", "PC", "PET"],
} as const;

export interface DesignOrigin {
  kind: "generated" | "downloaded";
  provider?: string;
  url?: string;
  creator?: string;
  license?: string;
  title?: string;
}

export interface DesignRevision {
  n: number;
  at: number;
  note: string;
  engine: "openscad" | "imported";
  template?: TemplateId;
  params?: Record<string, number>;
  /** OpenSCAD source for generated revisions. */
  scad?: string;
  sha256: string;
  report: MeshReport;
  issues: PrintabilityIssue[];
}

export interface Design {
  id: string;
  title: string;
  prompt: string;
  createdAt: number;
  updatedAt: number;
  origin: DesignOrigin;
  revisions: DesignRevision[];
  /** Index into `revisions` of the active one; undo/redo move it. */
  head: number;
  /** Revision numbers only grow, also after an undo drops the redo tail. */
  nextRevision?: number;
}

export type JobState =
  | "sliced"
  | "awaiting_approval"
  | "approved"
  | "submitting"
  | "printing"
  | "paused"
  | "completed"
  | "failed"
  | "cancelled"
  | "unknown";

export interface PrintJob {
  id: string;
  designId: string;
  revision: number;
  designTitle: string;
  printer: string;
  material: string;
  nozzle: number;
  settings: Record<string, unknown>;
  modelSha: string;
  sliceSha: string;
  sliceName: string;
  estimates: { minutes: number | null; filamentGrams: number | null };
  warnings: string[];
  /** Readiness signals that cannot be verified remotely. */
  unverified: string[];
  state: JobState;
  approval?: { at: number; fingerprint: string };
  idempotencyKey: string;
  submittedAt?: number;
  printerRef?: string;
  createdAt: number;
  history: { at: number; state: JobState; note: string }[];
  outcome?: string;
}

export interface FabricationFile {
  version: 1;
  designs: Design[];
  jobs: PrintJob[];
}

export const ACTIVE_JOB_STATES: JobState[] = [
  "submitting",
  "printing",
  "paused",
  "unknown",
];
