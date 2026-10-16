import { getJson } from "./client.ts";

export interface FabDesign {
  id: string;
  title: string;
  revision: number;
  revisions: number;
  canUndo: boolean;
  canRedo: boolean;
  engine: string;
  template: string;
  params?: Record<string, number>;
  sizeMm: number[];
  triangles: number;
  watertight: boolean;
  volumeCm3: number;
  supportsLikely: boolean;
  issues: string[];
  note: string;
  origin?: {
    provider?: string;
    creator?: string;
    license?: string;
    url?: string;
  };
  validation: string;
}

export interface FabJob {
  id: string;
  design: string;
  designId: string;
  revision: number;
  printer: string;
  material: string;
  nozzleMm: number;
  state: string;
  estimatedMinutes: number | string;
  estimatedFilamentGrams: number | string;
  warnings: string[];
  unverified: string[];
  approved: boolean;
  outcome?: string;
  lastEvent?: string;
}

export interface FabPrinter {
  driver: string;
  model: string;
  online: boolean;
  state: string;
  simulated: boolean;
  progressPercent?: number;
  remainingMinutes?: number;
  nozzleC?: number;
  bedC?: number;
  jobName?: string;
  error?: string;
  note?: string;
  materials?: { slot: string; type: string; remainingPercent?: number }[];
}

export interface FabProvider {
  name: string;
  status: string;
  note?: string;
}

export const getFabDesigns = () =>
  getJson<{ designs: FabDesign[] }>("/fabrication/designs");
export const getFabJobs = () =>
  getJson<{ jobs: FabJob[] }>("/fabrication/jobs");
export const getFabPrinter = () =>
  getJson<{ printer: FabPrinter }>("/fabrication/printer");
export const getFabProviders = () =>
  getJson<{ providers: FabProvider[] }>("/fabrication/providers");
export const fabModelUrl = (id: string, revision: number) =>
  `/api/fabrication/designs/${id}/revisions/${revision}/model.stl`;
