import { Inject, Injectable, Logger, OnModuleInit } from "@nestjs/common";
import crypto from "node:crypto";
import { AuditService } from "../core/audit/audit.service.js";
import { JarvisStateStore } from "../planning/jarvis-state.store.js";
import { CAD_WORKER, type CadWorkerPort } from "./cad.worker.js";
import {
  DISCOVERY_PROVIDERS,
  rankModels,
  UNSUPPORTED_PROVIDERS,
  type DiscoveryProvider,
  type ProviderState,
  type RemoteFile,
  type RemoteModel,
} from "./discovery.js";
import { FabricationStore } from "./fabrication.store.js";
import {
  ACTIVE_JOB_STATES,
  FabricationError,
  P2S_PROFILE,
  type Design,
  type DesignOrigin,
  type DesignRevision,
  type FabricationFile,
  type JobState,
  type PrintJob,
} from "./fabrication.types.js";
import {
  analyzeMesh,
  MeshError,
  parseStl,
  printabilityIssues,
  repairMesh,
  writeBinaryStl,
  type BuildVolume,
} from "./mesh.js";
import {
  PRINTER_PORT,
  PrinterRefused,
  PrinterUncertain,
  type PrinterPort,
  type PrinterStatus,
} from "./printer.port.js";
import { SLICER_PORT, type SlicerPort } from "./slicer.port.js";
import {
  checkCustomScad,
  DesignError,
  getTemplate,
  normalizeParams,
  TEMPLATE_IDS,
  type TemplateId,
} from "./templates.js";

const MAX_DESIGNS = 200;
const MAX_JOBS = 200;
const MAX_REVISIONS = 40;

export interface SliceOptions {
  material: string;
  nozzle?: number;
  layerHeight?: number;
  infillPercent?: number;
  walls?: number;
  supports?: "auto" | "on" | "off";
}

function buildVolume(): BuildVolume {
  const raw = process.env.NOVA_PRINTER_BUILD_VOLUME?.trim();
  const m = raw ? /^(\d{2,4})x(\d{2,4})x(\d{2,4})$/i.exec(raw) : null;
  return m
    ? { x: Number(m[1]), y: Number(m[2]), z: Number(m[3]) }
    : { ...P2S_PROFILE.buildVolume };
}

const sha = (data: Buffer | string) =>
  crypto.createHash("sha256").update(data).digest("hex");
const newId = () => crypto.randomBytes(5).toString("hex");

/**
 * The design library, the CAD and slicing orchestration and the request-to-print state machine.
 * Searching, generating, modifying, validating and slicing run on their own. Starting, pausing,
 * resuming or cancelling a physical print is only ever done through the tools that carry the
 * confirmation risk, and a job can only be submitted once, after an explicit approval of exactly
 * this model, slice, printer and material.
 */
@Injectable()
export class FabricationService implements OnModuleInit {
  private readonly log = new Logger("NOVA fabrication");
  private data: FabricationFile = { version: 1, designs: [], jobs: [] };
  now: () => number = Date.now;

  constructor(
    private readonly store: FabricationStore,
    @Inject(CAD_WORKER) private readonly cad: CadWorkerPort,
    @Inject(PRINTER_PORT) private readonly printer: PrinterPort,
    @Inject(SLICER_PORT) private readonly slicer: SlicerPort,
    @Inject(DISCOVERY_PROVIDERS)
    private readonly providers: DiscoveryProvider[],
    private readonly audit: AuditService,
    private readonly events: JarvisStateStore,
  ) {}

  onModuleInit(): void {
    this.recover();
  }

  /** A submission that was in flight during a restart has an unknown outcome and is never repeated. */
  recover(): void {
    this.data = this.store.load();
    let changed = false;
    for (const job of this.data.jobs)
      if (job.state === "submitting") {
        this.setState(
          job,
          "unknown",
          "Herstart tijdens het versturen: de uitkomst is onbekend. Controleer de printer.",
        );
        changed = true;
      }
    if (changed) this.trySave();
  }

  // ---- bookkeeping --------------------------------------------------------------------------

  private save(): void {
    this.store.save(this.data);
  }
  private trySave(): void {
    try {
      this.save();
    } catch {
      /* memory stays authoritative */
    }
  }
  private record(phase: string, extra: Record<string, unknown>): void {
    try {
      this.audit.record({
        sessionId: "fabrication",
        tool: "fabrication",
        phase,
        ...extra,
      });
    } catch {
      /* the audit log must not stop the workflow */
    }
  }
  private notify(
    severity: "info" | "warning",
    title: string,
    detail: string,
  ): void {
    try {
      this.events.emit({
        topic: "jarvis/alerts",
        payload: {
          title: title.slice(0, 120),
          detail: detail.slice(0, 240),
          severity,
          key: "fabrication",
          at: new Date(this.now()).toISOString(),
        },
      });
    } catch {
      this.log.warn("notification failed");
    }
  }
  private setState(job: PrintJob, state: JobState, note: string): void {
    job.state = state;
    job.history.push({ at: this.now(), state, note: note.slice(0, 240) });
    if (job.history.length > 60) job.history.splice(0, job.history.length - 60);
  }

  // ---- discovery ----------------------------------------------------------------------------

  providerStates(): ProviderState[] {
    return [...this.providers.map((p) => p.state()), ...UNSUPPORTED_PROVIDERS];
  }

  async search(query: string, limit = 10, signal?: AbortSignal) {
    const ready = this.providers.filter((p) => p.state().status === "ready");
    const errors: string[] = [];
    const lists = await Promise.all(
      ready.map(async (p) => {
        try {
          return await p.search(query, limit, signal);
        } catch (error) {
          errors.push(
            `${p.name}: ${(error as Error).message === "rate_limited" ? "limiet bereikt, probeer later" : "niet bereikbaar"}`,
          );
          return [] as RemoteModel[];
        }
      }),
    );
    return {
      results: rankModels(lists.flat(), query).slice(0, limit),
      providers: this.providerStates(),
      errors,
    };
  }

  private provider(name: string): DiscoveryProvider {
    const found = this.providers.find((p) => p.name === name);
    if (!found || found.state().status !== "ready")
      throw new FabricationError(`Bron "${name}" is niet beschikbaar.`);
    return found;
  }

  async remoteDetails(provider: string, id: string, signal?: AbortSignal) {
    const details = await this.provider(provider).details(id, signal);
    if (!details) throw new FabricationError("Model niet gevonden.");
    return details;
  }

  /** Downloads an STL from a repository, validates it as a mesh and stores it as a new design. Never executed or printed. */
  async download(
    provider: string,
    id: string,
    fileId: string | undefined,
    signal?: AbortSignal,
  ) {
    const source = this.provider(provider);
    const details = await this.remoteDetails(provider, id, signal);
    const stl = details.files.filter((f) => f.format === "stl");
    const file: RemoteFile | undefined = fileId
      ? details.files.find((f) => f.id === fileId)
      : stl[0];
    if (!file)
      throw new FabricationError(
        "Geen STL-bestand gevonden bij dit model (3MF-import wordt nog niet ondersteund).",
      );
    if (file.format !== "stl")
      throw new FabricationError(
        "Alleen STL-bestanden worden nu geïmporteerd.",
      );
    const bytes = await source.download(file, signal);
    const origin: DesignOrigin = {
      kind: "downloaded",
      provider,
      url: details.model.url,
      creator: details.model.creator,
      license: details.model.license,
      title: details.model.title,
    };
    return this.importStl(
      details.model.title,
      `download ${provider}:${id}`,
      bytes,
      origin,
      `Gedownload bestand ${file.name}`,
    );
  }

  // ---- designs ------------------------------------------------------------------------------

  listDesigns(): Design[] {
    return [...this.data.designs].sort((a, b) => b.updatedAt - a.updatedAt);
  }

  design(id: string): Design {
    const design = this.data.designs.find((d) => d.id === id);
    if (!design) throw new FabricationError("Ontwerp niet gevonden.");
    return design;
  }

  revision(design: Design, n?: number): DesignRevision {
    const rev =
      n === undefined
        ? design.revisions[design.head]
        : design.revisions.find((r) => r.n === n);
    if (!rev) throw new FabricationError("Revisie niet gevonden.");
    return rev;
  }

  model(designId: string, n?: number): Buffer {
    const design = this.design(designId);
    const rev = this.revision(design, n);
    const bytes = this.store.readModel(design.id, rev.n);
    if (!bytes) throw new FabricationError("Het modelbestand ontbreekt.");
    return bytes;
  }

  private analyze(stl: Buffer) {
    const tri = parseStl(stl);
    const report = analyzeMesh(tri);
    return { report, issues: printabilityIssues(report, buildVolume()) };
  }

  private addDesign(design: Design): void {
    if (this.data.designs.length >= MAX_DESIGNS) {
      const oldest = [...this.data.designs].sort(
        (a, b) => a.updatedAt - b.updatedAt,
      )[0]!;
      throw new FabricationError(
        `De ontwerpbibliotheek zit vol (${MAX_DESIGNS}); verwijder eerst "${oldest.title}".`,
      );
    }
    this.data.designs.push(design);
  }

  private async render(scad: string, signal?: AbortSignal): Promise<Buffer> {
    if (!this.cad.available())
      throw new FabricationError("De CAD-werker is niet beschikbaar.");
    const result = await this.cad.render(scad, signal);
    if (!result.ok)
      throw new FabricationError(
        `${result.error}${result.log ? ` (${result.log.split("\n").filter(Boolean).slice(-2).join(" ")})` : ""}`,
      );
    return result.stl;
  }

  async generate(
    input: {
      title: string;
      prompt?: string;
      template?: string;
      params?: Record<string, unknown>;
      scad?: string;
    },
    signal?: AbortSignal,
  ): Promise<{ design: Design; revision: DesignRevision }> {
    let scad: string;
    let template: TemplateId | undefined;
    let params: Record<string, number> | undefined;
    let expected: [number, number, number] | undefined;
    if (input.template && input.scad)
      throw new FabricationError(
        "Geef een sjabloon of eigen OpenSCAD-code, niet beide.",
      );
    if (input.template) {
      const t = getTemplate(input.template);
      params = normalizeParams(t, input.params);
      const built = t.build(params);
      scad = built.scad;
      expected = built.expected;
      template = t.id;
    } else if (input.scad) {
      scad = checkCustomScad(input.scad);
    } else {
      throw new FabricationError(
        `Kies een sjabloon (${TEMPLATE_IDS.join(", ")}) of lever eigen OpenSCAD-code.`,
      );
    }
    const stl = await this.render(scad, signal);
    const { report, issues } = this.analyze(stl);
    if (expected) this.checkDimensions(report.bounds.size, expected);
    const id = newId();
    const rev: DesignRevision = {
      n: 1,
      at: this.now(),
      note: "Eerste versie",
      engine: "openscad",
      template,
      params,
      scad,
      sha256: sha(stl),
      report,
      issues,
    };
    const design: Design = {
      id,
      title: input.title.slice(0, 120),
      prompt: (input.prompt ?? input.title).slice(0, 500),
      createdAt: this.now(),
      updatedAt: this.now(),
      origin: { kind: "generated" },
      revisions: [rev],
      head: 0,
    };
    this.store.writeModel(id, 1, stl);
    this.addDesign(design);
    this.save();
    this.record("generate", {
      design: id,
      template: template ?? "custom_scad",
      triangles: report.triangles,
    });
    return { design, revision: rev };
  }

  /** The rendered solid must match the dimensions the template promises (rounding aside). */
  private checkDimensions(
    actual: [number, number, number],
    expected: [number, number, number],
  ): void {
    for (let i = 0; i < 3; i++)
      if (Math.abs(actual[i]! - expected[i]!) > 0.05 + expected[i]! * 0.002)
        throw new FabricationError(
          `Het gerenderde model (${actual.map((v) => v.toFixed(2)).join(" × ")} mm) wijkt af van het ontwerp (${expected.join(" × ")} mm); er is niets opgeslagen.`,
        );
  }

  private async importStl(
    title: string,
    prompt: string,
    bytes: Buffer,
    origin: DesignOrigin,
    note: string,
  ) {
    let analysis;
    try {
      analysis = this.analyze(bytes);
    } catch (error) {
      if (error instanceof MeshError) throw new FabricationError(error.message);
      throw error;
    }
    const id = newId();
    const rev: DesignRevision = {
      n: 1,
      at: this.now(),
      note,
      engine: "imported",
      sha256: sha(bytes),
      report: analysis.report,
      issues: analysis.issues,
    };
    const design: Design = {
      id,
      title: title.slice(0, 120),
      prompt: prompt.slice(0, 500),
      createdAt: this.now(),
      updatedAt: this.now(),
      origin,
      revisions: [rev],
      head: 0,
    };
    this.store.writeModel(id, 1, bytes);
    this.addDesign(design);
    this.save();
    this.record("import", {
      design: id,
      provider: origin.provider,
      license: origin.license ?? "onbekend",
    });
    return { design, revision: rev };
  }

  /** Adds a revision from changed parameters or code, then makes it the active one. A redo tail is dropped. */
  async modify(
    id: string,
    change: { changes?: Record<string, unknown>; scad?: string; note?: string },
    signal?: AbortSignal,
  ) {
    const design = this.design(id);
    const current = this.revision(design);
    if (current.engine === "imported")
      throw new FabricationError(
        "Een gedownload model heeft geen parameters; genereer een nieuw ontwerp of gebruik validate_3d_model met repair.",
      );
    let scad: string;
    let params = current.params;
    let expected: [number, number, number] | undefined;
    if (current.template) {
      if (change.scad)
        throw new FabricationError(
          "Dit ontwerp is parametrisch; pas parameters aan (changes).",
        );
      const t = getTemplate(current.template);
      params = normalizeParams(t, change.changes, current.params);
      const built = t.build(params);
      scad = built.scad;
      expected = built.expected;
    } else {
      if (change.changes)
        throw new FabricationError(
          "Dit ontwerp heeft eigen OpenSCAD-code; lever een nieuwe scad.",
        );
      scad = checkCustomScad(change.scad ?? "");
    }
    const stl = await this.render(scad, signal);
    const { report, issues } = this.analyze(stl);
    if (expected) this.checkDimensions(report.bounds.size, expected);
    this.dropRedoTail(design);
    if (design.revisions.length >= MAX_REVISIONS) {
      const dropped = design.revisions.shift()!;
      this.store.removeModel(design.id, dropped.n);
      design.head = design.revisions.length - 1;
    }
    const n = this.allocate(design);
    const rev: DesignRevision = {
      n,
      at: this.now(),
      note: (change.note ?? "Aangepast").slice(0, 160),
      engine: "openscad",
      template: current.template,
      params,
      scad,
      sha256: sha(stl),
      report,
      issues,
    };
    this.store.writeModel(design.id, n, stl);
    design.revisions.push(rev);
    design.head = design.revisions.length - 1;
    design.updatedAt = this.now();
    this.save();
    this.record("modify", { design: id, revision: n });
    return { design, revision: rev };
  }

  private allocate(design: Design): number {
    const n = Math.max(
      design.nextRevision ?? 0,
      ...design.revisions.map((r) => r.n + 1),
    );
    design.nextRevision = n + 1;
    return n;
  }

  private dropRedoTail(design: Design): void {
    const tail = design.revisions.splice(design.head + 1);
    for (const r of tail) this.store.removeModel(design.id, r.n);
  }

  undo(id: string): { design: Design; revision: DesignRevision } {
    const design = this.design(id);
    if (design.head <= 0)
      throw new FabricationError("Er is niets om ongedaan te maken.");
    design.head -= 1;
    design.updatedAt = this.now();
    this.save();
    return { design, revision: this.revision(design) };
  }

  redo(id: string): { design: Design; revision: DesignRevision } {
    const design = this.design(id);
    if (design.head >= design.revisions.length - 1)
      throw new FabricationError("Er is niets om opnieuw te doen.");
    design.head += 1;
    design.updatedAt = this.now();
    this.save();
    return { design, revision: this.revision(design) };
  }

  /** Re-checks a revision. With `repair` the bounded repair becomes a new revision; remaining problems are reported. */
  validate(id: string, n?: number, repair = false) {
    const design = this.design(id);
    const rev = this.revision(design, n);
    const stl = this.model(id, rev.n);
    const analysis = this.analyze(stl);
    rev.report = analysis.report;
    rev.issues = analysis.issues;
    if (!repair) {
      this.save();
      return { design, revision: rev, repaired: false, removed: 0 };
    }
    const fixed = repairMesh(parseStl(stl));
    const bytes = writeBinaryStl(fixed.triangles);
    const next = this.analyze(bytes);
    this.dropRedoTail(design);
    const nn = this.allocate(design);
    const copy: DesignRevision = {
      n: nn,
      at: this.now(),
      note: `Gerepareerd: ${fixed.removed} driehoeken verwijderd, op het bed gezet`,
      engine: rev.engine,
      template: rev.template,
      params: rev.params,
      scad: rev.scad,
      sha256: sha(bytes),
      report: next.report,
      issues: next.issues,
    };
    this.store.writeModel(design.id, nn, bytes);
    design.revisions.push(copy);
    design.head = design.revisions.length - 1;
    design.updatedAt = this.now();
    this.save();
    this.record("repair", { design: id, revision: nn, removed: fixed.removed });
    return { design, revision: copy, repaired: true, removed: fixed.removed };
  }

  // ---- slicing and jobs ---------------------------------------------------------------------

  async slice(
    designId: string,
    options: SliceOptions,
    signal?: AbortSignal,
  ): Promise<PrintJob> {
    const design = this.design(designId);
    const rev = this.revision(design);
    const errors = rev.issues.filter((i) => i.level === "error");
    if (errors.length)
      throw new FabricationError(
        `Het model is niet printklaar: ${errors.map((e) => e.message).join(" ")}`,
      );
    const material = options.material.toUpperCase();
    if (!(P2S_PROFILE.materials as readonly string[]).includes(material))
      throw new FabricationError(
        `Materiaal "${options.material}" staat niet in het P2S-profiel (${P2S_PROFILE.materials.join(", ")}).`,
      );
    const nozzle = options.nozzle ?? 0.4;
    if (!(P2S_PROFILE.nozzles as readonly number[]).includes(nozzle))
      throw new FabricationError("Dit mondstuk bestaat niet voor de P2S.");
    const problem = this.slicer.unavailable();
    if (problem) throw new FabricationError(problem);
    const profile = process.env.NOVA_SLICER_PRINTER_PROFILE?.trim() ?? "";
    if (!/p2s/i.test(profile))
      throw new FabricationError(
        "Stel NOVA_SLICER_PRINTER_PROFILE in op het P2S-profiel van de slicer; er wordt geen ander printerprofiel gebruikt.",
      );
    const settings = {
      layerHeight: options.layerHeight ?? 0.2,
      infillPercent: options.infillPercent ?? 15,
      walls: options.walls ?? 3,
      supports:
        options.supports ?? (rev.report.supportsLikely ? "auto" : "off"),
    } as const;
    const model = this.model(designId, rev.n);
    const sliced = await this.slicer.slice(
      { model, printerProfile: profile, material, nozzle, ...settings },
      signal,
    );
    if (!sliced.ok)
      throw new FabricationError(
        `${sliced.error}${sliced.log ? ` (${sliced.log.split("\n").filter(Boolean).slice(-2).join(" ")})` : ""}`,
      );
    const id = newId();
    const job: PrintJob = {
      id,
      designId,
      revision: rev.n,
      designTitle: design.title,
      printer: P2S_PROFILE.name,
      material,
      nozzle,
      settings: { ...settings, profile },
      modelSha: rev.sha256,
      sliceSha: sha(sliced.file),
      sliceName: sliced.fileName,
      estimates: {
        minutes: sliced.minutes,
        filamentGrams: sliced.filamentGrams,
      },
      warnings: rev.issues
        .filter((i) => i.level === "warning")
        .map((i) => i.message),
      unverified: [],
      state: "sliced",
      idempotencyKey: crypto.randomUUID(),
      createdAt: this.now(),
      history: [{ at: this.now(), state: "sliced", note: "Geslicet" }],
    };
    this.store.writeSlice(id, sliced.fileName, sliced.file);
    this.pruneJobs();
    this.data.jobs.push(job);
    this.save();
    this.record("slice", { job: id, design: designId, material });
    return job;
  }

  private pruneJobs(): void {
    while (this.data.jobs.length >= MAX_JOBS) {
      const index = this.data.jobs.findIndex(
        (j) =>
          !ACTIVE_JOB_STATES.includes(j.state) &&
          !["approved", "awaiting_approval", "sliced"].includes(j.state),
      );
      if (index < 0)
        throw new FabricationError(
          "Te veel printopdrachten; rond er eerst een af.",
        );
      this.data.jobs.splice(index, 1);
    }
  }

  job(id: string): PrintJob {
    const job = this.data.jobs.find((j) => j.id === id);
    if (!job) throw new FabricationError("Printopdracht niet gevonden.");
    return job;
  }

  history(limit = 20): PrintJob[] {
    return [...this.data.jobs]
      .sort((a, b) => b.createdAt - a.createdAt)
      .slice(0, limit);
  }

  private activeJob(): PrintJob | undefined {
    return this.data.jobs.find((j) => ACTIVE_JOB_STATES.includes(j.state));
  }

  async printerStatus(signal?: AbortSignal): Promise<PrinterStatus> {
    try {
      return await this.printer.status(signal);
    } catch {
      return {
        driver: this.printer.driver,
        model: P2S_PROFILE.name,
        online: false,
        state: "unknown",
        simulated: this.printer.driver === "simulated",
        note: "De printer antwoordt niet.",
      };
    }
  }

  /** Verifies every readiness signal that can be verified and lists what cannot. Moves a sliced job to awaiting_approval. */
  async prepare(jobId: string, signal?: AbortSignal) {
    const job = this.job(jobId);
    if (!["sliced", "awaiting_approval"].includes(job.state))
      throw new FabricationError(
        `De opdracht staat op "${job.state}" en kan niet opnieuw worden voorbereid.`,
      );
    const status = await this.printerStatus(signal);
    const blockers: string[] = [];
    const unverified: string[] = [];
    if (!status.online) blockers.push(status.note ?? "De printer is offline.");
    else if (status.state !== "idle")
      blockers.push(`De printer is niet vrij (${status.state}).`);
    if (status.error)
      blockers.push(`De printer meldt een fout: ${status.error}.`);
    if (this.activeJob())
      blockers.push("Er loopt al een andere printopdracht.");
    if (status.online) {
      if (status.nozzleDiameter === undefined)
        unverified.push("Het geplaatste mondstuk is niet uit te lezen.");
      else if (status.nozzleDiameter !== job.nozzle)
        blockers.push(
          `Het printermondstuk is ${status.nozzleDiameter} mm, de slice is voor ${job.nozzle} mm.`,
        );
      if (!status.materials?.length)
        unverified.push("Het geladen filament is niet uit te lezen.");
      else if (
        !status.materials.some((m) => m.type.toUpperCase() === job.material)
      )
        blockers.push(
          `Er is geen ${job.material}-filament geladen (aanwezig: ${status.materials.map((m) => m.type).join(", ")}).`,
        );
    }
    unverified.push(
      "Of de bouwplaat schoon en geplaatst is, kan niet op afstand worden gecontroleerd.",
    );
    unverified.push(
      "Of het printbed vrij is van een vorige print, kan niet op afstand worden gecontroleerd.",
    );
    job.unverified = unverified;
    if (!blockers.length && job.state === "sliced")
      this.setState(job, "awaiting_approval", "Klaar voor goedkeuring");
    this.save();
    return { job, status, blockers, unverified, ready: blockers.length === 0 };
  }

  private fingerprint(job: PrintJob): string {
    return sha(
      `${job.modelSha}|${job.sliceSha}|${job.printer}|${job.material}|${job.nozzle}|${job.idempotencyKey}`,
    );
  }

  /** Records the user's approval of exactly this model, slice, printer and material. */
  approve(jobId: string): PrintJob {
    const job = this.job(jobId);
    if (job.state !== "awaiting_approval")
      throw new FabricationError(
        'Bereid de opdracht eerst voor (prepare_print_job); alleen een "awaiting_approval"-opdracht kan worden goedgekeurd.',
      );
    job.approval = { at: this.now(), fingerprint: this.fingerprint(job) };
    this.setState(job, "approved", "Goedgekeurd door de gebruiker");
    this.save();
    this.record("approve", { job: job.id });
    return job;
  }

  /**
   * Sends an approved job to the printer exactly once. The state is persisted as "submitting" before
   * anything is sent; when the outcome is uncertain the job becomes "unknown" and is never retried.
   */
  async submit(jobId: string, signal?: AbortSignal): Promise<PrintJob> {
    const job = this.job(jobId);
    if (job.state !== "approved" || !job.approval)
      throw new FabricationError(
        `De opdracht is niet goedgekeurd (staat op "${job.state}").`,
      );
    if (job.approval.fingerprint !== this.fingerprint(job))
      throw new FabricationError(
        "De goedgekeuring hoort niet bij deze versie van de opdracht.",
      );
    if (this.activeJob())
      throw new FabricationError(
        "Er loopt al een printopdracht; wacht tot die klaar is.",
      );
    const file = this.store.readSlice(job.id, job.sliceName);
    if (!file || sha(file) !== job.sliceSha)
      throw new FabricationError(
        "Het printbestand ontbreekt of is gewijzigd; slice opnieuw.",
      );
    const status = await this.printerStatus(signal);
    if (!status.online || status.state !== "idle")
      throw new FabricationError(
        "De printer is niet beschikbaar of niet vrij; er is niets verstuurd.",
      );
    // Persist before sending: a crash from here on leaves "submitting", which recovery turns into "unknown".
    this.setState(job, "submitting", "Wordt naar de printer gestuurd");
    job.submittedAt = this.now();
    this.save();
    this.record("submit", {
      job: job.id,
      printer: job.printer,
      simulated: status.simulated,
    });
    try {
      const { ref } = await this.printer.start(
        {
          jobName: `nova-${job.id}`,
          file,
          fileName: job.sliceName,
          idempotencyKey: job.idempotencyKey,
        },
        signal,
      );
      job.printerRef = ref;
      this.setState(job, "printing", "De printer heeft de opdracht aangenomen");
      this.trySave();
      this.notify(
        "info",
        `Print gestart: ${job.designTitle}`,
        `${job.material} op de ${job.printer}.`,
      );
    } catch (error) {
      if (error instanceof PrinterRefused) {
        this.setState(job, "failed", error.message);
        job.outcome = error.message;
      } else {
        const text =
          error instanceof PrinterUncertain
            ? error.message
            : "Onbekende fout tijdens het versturen.";
        this.setState(
          job,
          "unknown",
          `Uitkomst onbekend: ${text} Controleer de printer; NOVA probeert het niet opnieuw.`,
        );
        this.notify(
          "warning",
          `Printstatus onbekend: ${job.designTitle}`,
          "Controleer de printer. NOVA verstuurt dit niet opnieuw.",
        );
      }
      this.trySave();
    }
    return job;
  }

  /** Reads the printer and moves the job along. An unknown submission is resolved only when the printer shows this job. */
  async monitor(jobId?: string, signal?: AbortSignal) {
    const job = jobId
      ? this.job(jobId)
      : (this.activeJob() ?? this.history(1)[0]);
    if (!job) throw new FabricationError("Er is geen printopdracht.");
    const status = await this.printerStatus(signal);
    if (ACTIVE_JOB_STATES.includes(job.state)) {
      const mine = status.jobName === `nova-${job.id}`;
      if (job.state === "unknown") {
        if (mine && status.state === "printing")
          this.setState(
            job,
            "printing",
            "De printer toont deze opdracht: de start is bevestigd.",
          );
        else if (mine && status.state === "paused")
          this.setState(
            job,
            "paused",
            "De printer toont deze opdracht (gepauzeerd).",
          );
        else if (
          mine &&
          status.state === "idle" &&
          (status.progressPercent ?? 0) >= 100
        )
          this.finish(job, "completed", "Klaar (de printer meldt 100%).");
      } else if (job.state === "printing" || job.state === "paused") {
        if (status.state === "error")
          this.finish(
            job,
            "failed",
            status.error ?? "De printer meldt een fout.",
          );
        else if (
          status.state === "idle" &&
          (status.progressPercent ?? 0) >= 100
        )
          this.finish(job, "completed", "Klaar.");
        else if (status.state === "idle" && !status.jobName)
          this.finish(
            job,
            "cancelled",
            "De printer is vrij zonder voltooide print (afgebroken).",
          );
        else if (status.state === "paused" && job.state === "printing")
          this.setState(job, "paused", "De print is gepauzeerd.");
        else if (status.state === "printing" && job.state === "paused")
          this.setState(job, "printing", "De print loopt weer.");
      }
      this.trySave();
    }
    return { job, status };
  }

  private finish(
    job: PrintJob,
    state: "completed" | "failed" | "cancelled",
    note: string,
  ): void {
    this.setState(job, state, note);
    job.outcome = note;
    this.notify(
      state === "completed" ? "info" : "warning",
      `Print ${state === "completed" ? "klaar" : state === "failed" ? "mislukt" : "gestopt"}: ${job.designTitle}`,
      note,
    );
  }

  async command(
    jobId: string,
    what: "pause" | "resume" | "cancel",
    signal?: AbortSignal,
  ): Promise<PrintJob> {
    const job = this.job(jobId);
    const allowed: Record<typeof what, JobState[]> = {
      pause: ["printing"],
      resume: ["paused"],
      cancel: ["printing", "paused", "unknown"],
    };
    if (!allowed[what].includes(job.state))
      throw new FabricationError(
        `"${what}" kan niet bij status "${job.state}".`,
      );
    try {
      if (what === "pause") await this.printer.pause(signal);
      else if (what === "resume") await this.printer.resume(signal);
      else await this.printer.cancel(signal);
    } catch (error) {
      throw new FabricationError(
        error instanceof PrinterRefused
          ? error.message
          : "De printer antwoordt niet; de status is onzeker. Controleer de printer.",
      );
    }
    if (what === "pause") this.setState(job, "paused", "Gepauzeerd op verzoek");
    else if (what === "resume")
      this.setState(job, "printing", "Hervat op verzoek");
    else this.finish(job, "cancelled", "Geannuleerd op verzoek");
    this.save();
    this.record(what, { job: job.id });
    return job;
  }

  // ---- views --------------------------------------------------------------------------------

  /** The scene the holographic viewer shows for a revision. */
  previewScene(designId: string, n?: number) {
    const design = this.design(designId);
    const rev = this.revision(design, n);
    const size = rev.report.bounds.size;
    return {
      title: `${design.title} (revisie ${rev.n})`,
      models: [
        {
          id: "model",
          label: design.title,
          format: "stl" as const,
          url: `/api/fabrication/designs/${design.id}/revisions/${rev.n}/model.stl`,
        },
      ],
      units: "mm",
      summary: `${size.map((v) => v.toFixed(1)).join(" × ")} mm, ${rev.report.triangles} driehoeken, ${rev.report.watertight ? "waterdicht" : "niet waterdicht"}`,
      note: "Dit is een weergave van de geometrie, geen gevalideerd printbestand.",
    };
  }

  buildVolume(): BuildVolume {
    return buildVolume();
  }
}

export { DesignError };
