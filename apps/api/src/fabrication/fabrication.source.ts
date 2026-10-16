import {
  integer,
  number,
  schema,
  text,
  ToolSourceProvider,
  type ToolDefinition,
  type ToolResult,
  type ToolSource,
} from "../tools/tool.types.js";
import { VisualizationService } from "../visualization/visualization.service.js";
import {
  FabricationError,
  type Design,
  type DesignRevision,
  type PrintJob,
} from "./fabrication.types.js";
import { FabricationService } from "./fabrication.service.js";
import { MeshError } from "./mesh.js";
import { DesignError, listTemplates } from "./templates.js";

const templateHelp = () =>
  listTemplates()
    .map(
      (t) =>
        `${t.id} (${t.title}; params in mm: ${Object.entries(t.params)
          .map(
            ([k, p]) =>
              `${k} ${p.min}-${p.max}${p.unit === "count" ? " count" : p.unit === "bool" ? " 0/1" : ""} default ${p.default}`,
          )
          .join(", ")})`,
    )
    .join("; ");

export function describeRevision(design: Design, rev: DesignRevision) {
  return {
    id: design.id,
    title: design.title,
    revision: rev.n,
    revisions: design.revisions.length,
    canUndo: design.head > 0,
    canRedo: design.head < design.revisions.length - 1,
    engine: rev.engine,
    template:
      rev.template ?? (rev.engine === "openscad" ? "custom_scad" : "imported"),
    params: rev.params,
    sizeMm: rev.report.bounds.size.map((v) => Number(v.toFixed(2))),
    triangles: rev.report.triangles,
    watertight: rev.report.watertight,
    volumeCm3: Number((rev.report.volumeMm3 / 1000).toFixed(2)),
    supportsLikely: rev.report.supportsLikely,
    issues: rev.issues
      .filter((i) => i.level !== "info")
      .map((i) => `${i.level}: ${i.message}`),
    note: rev.note,
    origin:
      design.origin.kind === "downloaded"
        ? {
            provider: design.origin.provider,
            creator: design.origin.creator,
            license: design.origin.license ?? "onbekend",
            url: design.origin.url,
          }
        : undefined,
    validation:
      "Geometriecontrole; geen garantie voor sterkte, pasvorm of veiligheid.",
  };
}

export function describeJob(job: PrintJob) {
  return {
    id: job.id,
    design: job.designTitle,
    designId: job.designId,
    revision: job.revision,
    printer: job.printer,
    material: job.material,
    nozzleMm: job.nozzle,
    state: job.state,
    estimatedMinutes: job.estimates.minutes ?? "onbekend",
    estimatedFilamentGrams: job.estimates.filamentGrams ?? "onbekend",
    warnings: job.warnings,
    unverified: job.unverified,
    approved: Boolean(job.approval),
    outcome: job.outcome,
    lastEvent: job.history.at(-1)?.note,
  };
}

/** Tools for searching, designing, validating, slicing and (only with explicit approval) printing 3D models. */
@ToolSourceProvider()
export class FabricationSource implements ToolSource {
  readonly source = "fabrication";
  constructor(
    private readonly fab: FabricationService,
    private readonly viz: VisualizationService,
  ) {}

  definitions(): ToolDefinition[] {
    const id = text(20);
    const rev = integer(1, 1000);
    return [
      {
        name: "search_3d_models",
        description:
          "Search 3D model repositories with an official API (currently Thingiverse, needs the user's token) for existing printable models. Always search before designing something new. Results include creator, licence and popularity; the answer lists which repositories are unavailable. Never print a result without validation and the user's approval.",
        parameters: schema({ query: text(100), limit: integer(1, 20) }, [
          "query",
        ]),
        risk: "READ_ONLY",
        timeoutMs: 30_000,
      },
      {
        name: "get_3d_model_details",
        description:
          "Details of a model: pass `designId` for a model in the user's design library (parameters, revisions, size, printability findings), or `provider` + `modelId` for a repository model (licence, files). Without arguments it lists the design library.",
        parameters: schema(
          { designId: id, provider: text(30), modelId: text(20) },
          [],
        ),
        risk: "READ_ONLY",
        timeoutMs: 30_000,
      },
      {
        name: "download_3d_model",
        description:
          "Download an STL from a repository into the design library after the user chose it. The file is only parsed as a mesh and validated, never executed. Licence and creator are stored. 3MF import is not supported yet.",
        parameters: schema(
          { provider: text(30), modelId: text(20), fileId: text(20) },
          ["provider", "modelId"],
        ),
        risk: "SAFE",
        timeoutMs: 58_000,
      },
      {
        name: "generate_3d_model",
        description: `Create an original design from a parametric template (fill the parameters from the user's request; units are millimetres) or from custom OpenSCAD code. Templates: ${templateHelp()}. For custom code give "scad" only (no include/use/import). The result is rendered in a sandbox, measured and checked for printability; show it with load_holographic_preview.`,
        parameters: schema(
          {
            title: text(120),
            prompt: text(400),
            template: {
              type: "string",
              enum: listTemplates().map((t) => t.id),
            },
            params: { type: "object" },
            scad: text(60_000),
          },
          ["title"],
        ),
        risk: "SAFE",
        timeoutMs: 58_000,
      },
      {
        name: "modify_3d_model",
        description:
          'Change a design: `changes` sets template parameters (absolute values in mm, only the ones that change), or `scad` replaces custom OpenSCAD code. Or `undo: true` / `redo: true` to move through the revision history. Each change is a new revision and is re-validated. For "make it wider" read the current parameters with get_3d_model_details first.',
        parameters: schema(
          {
            designId: id,
            changes: { type: "object" },
            scad: text(60_000),
            note: text(160),
            undo: { type: "boolean" },
            redo: { type: "boolean" },
          },
          ["designId"],
        ),
        risk: "SAFE",
        timeoutMs: 58_000,
      },
      {
        name: "validate_3d_model",
        description:
          "Check a design revision for printability: build volume, watertightness, non-manifold and degenerate geometry, bed contact, overhangs. With repair=true a bounded repair (remove degenerate/duplicate faces, drop onto the bed) is stored as a new revision; holes are not filled and remaining problems are reported. A clean result is not a guarantee of strength or safety.",
        parameters: schema(
          { designId: id, revision: rev, repair: { type: "boolean" } },
          ["designId"],
        ),
        risk: "SAFE",
        timeoutMs: 30_000,
      },
      {
        name: "export_3d_model",
        description:
          "Give the download paths of a design revision (STL, and the OpenSCAD source when there is one).",
        parameters: schema({ designId: id, revision: rev }, ["designId"]),
        risk: "READ_ONLY",
      },
      {
        name: "load_holographic_preview",
        description:
          "Show a design revision in the holographic 3D viewer. The viewer shows the real geometry only; it is a preview, not proof that the file is printable.",
        parameters: schema({ designId: id, revision: rev }, ["designId"]),
        risk: "READ_ONLY",
      },
      {
        name: "slice_3d_model",
        description:
          "Slice the active revision of a design for the Bambu Lab P2S with the configured slicer. Needs a material from the P2S profile (PLA, PETG, ABS, ASA, TPU, PA, PC, PET). Returns a print job with estimates (unknown stays unknown). Fails clearly when no slicer is installed; no other printer's profile is ever used.",
        parameters: schema(
          {
            designId: id,
            material: text(10),
            nozzle: number(0.2, 0.8),
            layerHeight: number(0.05, 0.6),
            infillPercent: integer(0, 100),
            walls: integer(1, 10),
            supports: { type: "string", enum: ["auto", "on", "off"] },
          },
          ["designId", "material"],
        ),
        risk: "SAFE",
        timeoutMs: 58_000,
      },
      {
        name: "get_printer_status",
        description:
          "Live status of the printer: online, state, progress, temperatures, current job, errors. Says plainly when no printer is linked or the data is simulated.",
        parameters: schema(),
        risk: "READ_ONLY",
        timeoutMs: 20_000,
      },
      {
        name: "get_printer_materials",
        description:
          "Filament slots (AMS) the printer reports, with type and remaining amount. Says when the printer does not report them.",
        parameters: schema(),
        risk: "READ_ONLY",
        timeoutMs: 20_000,
      },
      {
        name: "prepare_print_job",
        description:
          "Check readiness of a sliced job against the printer (online, idle, nozzle, loaded material, no other job) and list what cannot be verified remotely (clean plate). Returns the summary the user must see before approving: model, material, printer, estimated time and filament, warnings.",
        parameters: schema({ jobId: id }),
        risk: "SAFE",
        timeoutMs: 25_000,
      },
      {
        name: "approve_print_job",
        description:
          "Record the user's explicit approval of a prepared print job (exactly this model, slice, material and printer). Only after the user has seen the summary and agreed. This does not start the print.",
        parameters: schema({ jobId: id }),
        risk: "CONFIRM",
        allowStandingApproval: false,
      },
      {
        name: "submit_print_job",
        description:
          "Start the approved print job on the printer. Physical action: always needs a fresh confirmation from the user. Sent at most once: when the outcome is uncertain the job becomes 'unknown' and is never retried automatically.",
        parameters: schema({ jobId: id }),
        risk: "DANGEROUS",
        allowStandingApproval: false,
        timeoutMs: 55_000,
      },
      {
        name: "monitor_print_job",
        description:
          "Read the printer and update the job: progress, remaining time, completion or errors. Without jobId it follows the active (or latest) job.",
        parameters: schema({ jobId: id }, []),
        risk: "READ_ONLY",
        timeoutMs: 20_000,
      },
      {
        name: "pause_print_job",
        description: "Pause the running print. Needs the user's confirmation.",
        parameters: schema({ jobId: id }),
        risk: "CONFIRM",
        allowStandingApproval: false,
        timeoutMs: 25_000,
      },
      {
        name: "resume_print_job",
        description: "Resume a paused print. Needs the user's confirmation.",
        parameters: schema({ jobId: id }),
        risk: "CONFIRM",
        allowStandingApproval: false,
        timeoutMs: 25_000,
      },
      {
        name: "cancel_print_job",
        description:
          "Cancel a running or paused print (irreversible). Needs a fresh confirmation.",
        parameters: schema({ jobId: id }),
        risk: "DANGEROUS",
        allowStandingApproval: false,
        timeoutMs: 25_000,
      },
      {
        name: "get_print_history",
        description:
          "Recent print jobs with design, material, outcome and timestamps, newest first.",
        parameters: schema({ limit: integer(1, 50) }, []),
        risk: "READ_ONLY",
      },
    ];
  }

  async execute(
    name: string,
    args: Record<string, unknown>,
    call: { signal: AbortSignal },
  ): Promise<ToolResult> {
    const signal = call.signal;
    const designId = typeof args.designId === "string" ? args.designId : "";
    const revision =
      typeof args.revision === "number" ? args.revision : undefined;
    const jobId = typeof args.jobId === "string" ? args.jobId : "";
    try {
      switch (name) {
        case "search_3d_models": {
          const found = await this.fab.search(
            String(args.query),
            Number(args.limit ?? 10),
            signal,
          );
          return {
            ok: true,
            result: {
              results: found.results.map((m) => ({
                provider: m.provider,
                id: m.id,
                title: m.title,
                creator: m.creator,
                license: m.license ?? "onbekend",
                likes: m.likes,
                downloads: m.downloads,
                url: m.url,
              })),
              repositories: found.providers,
              errors: found.errors,
            },
            hint: found.results.length
              ? undefined
              : "Geen resultaten. Controleer de bronnen hierboven; ontwerp anders een eigen model.",
          };
        }
        case "get_3d_model_details": {
          if (
            typeof args.provider === "string" &&
            typeof args.modelId === "string"
          ) {
            const d = await this.fab.remoteDetails(
              args.provider,
              args.modelId,
              signal,
            );
            return {
              ok: true,
              result: {
                ...d.model,
                description: d.description,
                files: d.files.map((f) => ({
                  id: f.id,
                  name: f.name,
                  format: f.format,
                  size: f.size,
                })),
              },
            };
          }
          if (designId) {
            const design = this.fab.design(designId);
            return {
              ok: true,
              result: describeRevision(
                design,
                this.fab.revision(design, revision),
              ),
            };
          }
          return {
            ok: true,
            result: this.fab.listDesigns().map((d) => ({
              id: d.id,
              title: d.title,
              revisions: d.revisions.length,
              updated: new Date(d.updatedAt).toISOString(),
            })),
          };
        }
        case "download_3d_model": {
          const { design, revision: rev } = await this.fab.download(
            String(args.provider),
            String(args.modelId),
            typeof args.fileId === "string" ? args.fileId : undefined,
            signal,
          );
          return {
            ok: true,
            verified: true,
            result: describeRevision(design, rev),
          };
        }
        case "generate_3d_model": {
          const { design, revision: rev } = await this.fab.generate(
            {
              title: String(args.title),
              prompt: typeof args.prompt === "string" ? args.prompt : undefined,
              template:
                typeof args.template === "string" ? args.template : undefined,
              params: args.params as Record<string, unknown> | undefined,
              scad: typeof args.scad === "string" ? args.scad : undefined,
            },
            signal,
          );
          return {
            ok: true,
            verified: true,
            result: describeRevision(design, rev),
          };
        }
        case "modify_3d_model": {
          if (args.undo === true) {
            const r = this.fab.undo(designId);
            return {
              ok: true,
              verified: true,
              result: describeRevision(r.design, r.revision),
            };
          }
          if (args.redo === true) {
            const r = this.fab.redo(designId);
            return {
              ok: true,
              verified: true,
              result: describeRevision(r.design, r.revision),
            };
          }
          const r = await this.fab.modify(
            designId,
            {
              changes: args.changes as Record<string, unknown> | undefined,
              scad: typeof args.scad === "string" ? args.scad : undefined,
              note: typeof args.note === "string" ? args.note : undefined,
            },
            signal,
          );
          return {
            ok: true,
            verified: true,
            result: describeRevision(r.design, r.revision),
          };
        }
        case "validate_3d_model": {
          const r = this.fab.validate(designId, revision, args.repair === true);
          return {
            ok: true,
            verified: true,
            result: {
              ...describeRevision(r.design, r.revision),
              repaired: r.repaired,
              removedFaces: r.removed,
            },
          };
        }
        case "export_3d_model": {
          const design = this.fab.design(designId);
          const rev = this.fab.revision(design, revision);
          const base = `/api/fabrication/designs/${design.id}/revisions/${rev.n}`;
          return {
            ok: true,
            result: {
              stl: `${base}/model.stl`,
              openscad: rev.scad ? `${base}/source.scad` : null,
              revision: rev.n,
            },
          };
        }
        case "load_holographic_preview": {
          const preview = this.fab.previewScene(designId, revision);
          const scene = this.viz.createCustom({
            title: preview.title,
            kind: "model",
            models: preview.models,
            units: preview.units,
          });
          return {
            ok: true,
            verified: true,
            result: { summary: preview.summary, note: preview.note },
            visualization: this.viz.eventFor(scene, "open"),
          };
        }
        case "slice_3d_model": {
          const job = await this.fab.slice(
            designId,
            {
              material: String(args.material),
              nozzle: typeof args.nozzle === "number" ? args.nozzle : undefined,
              layerHeight:
                typeof args.layerHeight === "number"
                  ? args.layerHeight
                  : undefined,
              infillPercent:
                typeof args.infillPercent === "number"
                  ? args.infillPercent
                  : undefined,
              walls: typeof args.walls === "number" ? args.walls : undefined,
              supports: args.supports as "auto" | "on" | "off" | undefined,
            },
            signal,
          );
          return { ok: true, verified: true, result: describeJob(job) };
        }
        case "get_printer_status": {
          const status = await this.fab.printerStatus(signal);
          return {
            ok: true,
            result: status,
            hint: status.simulated
              ? "Dit is een gesimuleerde printer."
              : undefined,
          };
        }
        case "get_printer_materials": {
          const status = await this.fab.printerStatus(signal);
          return status.materials?.length
            ? {
                ok: true,
                result: {
                  materials: status.materials,
                  simulated: status.simulated,
                },
              }
            : {
                ok: true,
                result: {
                  materials: [],
                  note:
                    status.note ??
                    "De printer meldt geen filament (geen AMS of niet uit te lezen).",
                },
              };
        }
        case "prepare_print_job": {
          const r = await this.fab.prepare(jobId, signal);
          return {
            ok: true,
            verified: true,
            result: {
              ...describeJob(r.job),
              ready: r.ready,
              blockers: r.blockers,
              printerState: r.status.state,
              simulated: r.status.simulated,
            },
            hint: r.ready
              ? "Laat de gebruiker de samenvatting zien en vraag om goedkeuring (approve_print_job)."
              : "De opdracht is nog niet klaar om te printen; los de blokkades op.",
          };
        }
        case "approve_print_job":
          return {
            ok: true,
            verified: true,
            result: describeJob(this.fab.approve(jobId)),
          };
        case "submit_print_job": {
          const job = await this.fab.submit(jobId, signal);
          const good = job.state === "printing";
          return {
            ok: good,
            verified: good ? true : null,
            result: describeJob(job),
            error: good
              ? undefined
              : job.state === "unknown"
                ? "De uitkomst is onbekend; controleer de printer. NOVA verstuurt dit niet opnieuw."
                : (job.outcome ?? "De printer nam de opdracht niet aan."),
          };
        }
        case "monitor_print_job": {
          const r = await this.fab.monitor(jobId || undefined, signal);
          return {
            ok: true,
            result: { job: describeJob(r.job), printer: r.status },
          };
        }
        case "pause_print_job":
        case "resume_print_job":
        case "cancel_print_job": {
          const what = name.startsWith("pause")
            ? "pause"
            : name.startsWith("resume")
              ? "resume"
              : "cancel";
          return {
            ok: true,
            verified: true,
            result: describeJob(await this.fab.command(jobId, what, signal)),
          };
        }
        case "get_print_history":
          return {
            ok: true,
            result: this.fab.history(Number(args.limit ?? 20)).map(describeJob),
          };
        default:
          return { ok: false, error: "Onbekende fabricagetool." };
      }
    } catch (error) {
      if (
        error instanceof FabricationError ||
        error instanceof DesignError ||
        error instanceof MeshError
      )
        return { ok: false, error: error.message };
      return { ok: false, error: "De fabricageactie is mislukt." };
    }
  }
}
