import { Injectable } from "@nestjs/common";
import { fabBackend, WindowsFabAgent } from "./cad.worker.js";
import { execFile } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

const run = promisify(execFile);

export interface SliceRequest {
  model: Buffer;
  /** Must name the P2S; a profile of another printer is never substituted. */
  printerProfile: string;
  material: string;
  nozzle: number;
  layerHeight: number;
  infillPercent: number;
  walls: number;
  supports: "auto" | "on" | "off";
}

export type SliceResult =
  | {
      ok: true;
      file: Buffer;
      fileName: string;
      minutes: number | null;
      filamentGrams: number | null;
      log: string;
    }
  | { ok: false; error: string; log?: string };

/** Turns a validated model into a printer-ready file. Implementations must not throw. */
export interface SlicerPort {
  readonly name: string;
  /** Why slicing cannot run now, or null when it can. */
  unavailable(): Promise<string | null>;
  /** The printer profile this slicer uses (it must name the P2S), or null when there is none. */
  profileName(): Promise<string | null>;
  slice(request: SliceRequest, signal?: AbortSignal): Promise<SliceResult>;
}
export const SLICER_PORT = Symbol("nova:slicer-port");

/** Parses the estimate comments slicers write into G-code headers; unknown stays null. */
export function parseEstimates(text: string): {
  minutes: number | null;
  filamentGrams: number | null;
} {
  const time =
    /total estimated time:\s*(?:(\d+)d\s*)?(?:(\d+)h\s*)?(?:(\d+)m\s*)?(?:(\d+)s)?/i.exec(
      text,
    );
  const grams =
    /total filament weight \[g\]\s*:\s*([\d.]+)/i.exec(text) ??
    /filament used \[g\]\s*=\s*([\d.]+)/i.exec(text);
  let minutes: number | null = null;
  if (time && (time[1] || time[2] || time[3] || time[4]))
    minutes = Math.round(
      Number(time[1] ?? 0) * 1440 +
        Number(time[2] ?? 0) * 60 +
        Number(time[3] ?? 0) +
        Number(time[4] ?? 0) / 60,
    );
  return { minutes, filamentGrams: grams ? Number(grams[1]) : null };
}

/**
 * Runs a slicer command line the operator configured in NOVA_SLICER_COMMAND, a JSON array of arguments
 * with {input} {output} {profile} {material} {nozzle} {layer} {infill} {walls} {supports} placeholders.
 * No shell is involved. NOVA does not ship or assume a slicer: Bambu Studio's CLI flags differ per
 * version, so the exact line is verified by whoever installs it (docs/fabrication-slicing.md).
 */
@Injectable()
export class ConfiguredCliSlicer implements SlicerPort {
  readonly name = "cli";

  private command(): string[] | null {
    try {
      const parsed = JSON.parse(
        process.env.NOVA_SLICER_COMMAND ?? "",
      ) as unknown;
      return Array.isArray(parsed) &&
        parsed.length > 1 &&
        parsed.every((x) => typeof x === "string")
        ? (parsed as string[])
        : null;
    } catch {
      return null;
    }
  }

  async profileName(): Promise<string | null> {
    return process.env.NOVA_SLICER_PRINTER_PROFILE?.trim() || null;
  }

  async unavailable(): Promise<string | null> {
    const command = this.command();
    if (!command)
      return "Er is geen slicer ingesteld (NOVA_SLICER_COMMAND). Zie docs/fabrication-slicing.md.";
    if (!fs.existsSync(command[0]!))
      return "De ingestelde slicer is niet gevonden op de server.";
    return null;
  }

  async slice(
    request: SliceRequest,
    signal?: AbortSignal,
  ): Promise<SliceResult> {
    const problem = await this.unavailable();
    if (problem) return { ok: false, error: problem };
    if (!/p2s/i.test(request.printerProfile))
      return {
        ok: false,
        error:
          "Het slicerprofiel hoort niet bij de Bambu Lab P2S; er wordt geen ander printerprofiel gebruikt.",
      };
    const command = this.command()!;
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "nova-slice-"));
    const input = path.join(dir, "model.stl");
    const output = path.join(dir, "out.gcode.3mf");
    try {
      fs.writeFileSync(input, request.model, { mode: 0o600 });
      const values: Record<string, string> = {
        input,
        output,
        outdir: dir,
        profile: request.printerProfile,
        material: request.material,
        nozzle: String(request.nozzle),
        layer: String(request.layerHeight),
        infill: String(request.infillPercent),
        walls: String(request.walls),
        supports: request.supports,
      };
      const args = command
        .slice(1)
        .map((arg) =>
          arg.replace(/\{(\w+)\}/g, (_m, key: string) => values[key] ?? ""),
        );
      let log = "";
      try {
        const result = await run(command[0]!, args, {
          timeout: 300_000,
          signal,
          maxBuffer: 8 * 1024 * 1024,
          cwd: dir,
        });
        log = `${result.stdout}\n${result.stderr}`;
      } catch (error) {
        const e = error as { stdout?: string; stderr?: string };
        return {
          ok: false,
          error: "De slicer is mislukt.",
          log: `${e.stdout ?? ""}\n${e.stderr ?? ""}`.slice(-1500),
        };
      }
      const produced = fs.existsSync(output)
        ? output
        : fs
            .readdirSync(dir)
            .map((f) => path.join(dir, f))
            .find((f) => /\.(gcode\.3mf|gcode)$/i.test(f));
      if (!produced)
        return {
          ok: false,
          error: "De slicer maakte geen printbestand.",
          log: log.slice(-1500),
        };
      const file = fs.readFileSync(produced);
      if (file.length < 64)
        return {
          ok: false,
          error: "Het printbestand is leeg.",
          log: log.slice(-1500),
        };
      const estimates = parseEstimates(
        /\.gcode$/i.test(produced) ? file.toString("utf8", 0, 200_000) : log,
      );
      return {
        ok: true,
        file,
        fileName: path.basename(produced),
        ...estimates,
        log: log.slice(-1500),
      };
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }
}

/** The slicer on the user's Windows PC (Bambu Studio), started by the agent from its own agent.json; NOVA only sends the model and the settings. */
@Injectable()
export class WindowsAgentSlicer implements SlicerPort {
  readonly name = "windows";
  constructor(private readonly agent: WindowsFabAgent) {}

  async profileName(): Promise<string | null> {
    return (await this.agent.status()).slicerProfile;
  }

  async unavailable(): Promise<string | null> {
    if (!this.agent.configured) return "De Windows-agent is niet ingesteld.";
    const s = await this.agent.status();
    if (!s.reachable)
      return "De Windows-pc antwoordt niet. Staat hij aan en draait de agent?";
    if (!s.enabled)
      return "3D-slicen staat uit op de pc (agent.json: fabrication.enabled).";
    if (!s.slicer)
      return "Op de pc is geen P2S-slicer ingesteld (agent.json: fabrication.slicer).";
    return null;
  }

  async slice(
    request: SliceRequest,
    signal?: AbortSignal,
  ): Promise<SliceResult> {
    const problem = await this.unavailable();
    if (problem) return { ok: false, error: problem };
    const query = new URLSearchParams({
      profile: request.printerProfile,
      material: request.material,
      nozzle: String(request.nozzle),
      layer: String(request.layerHeight),
      infill: String(request.infillPercent),
      walls: String(request.walls),
      supports: request.supports,
    });
    try {
      const response = await fetch(`${this.agent.url("slice")}?${query}`, {
        method: "POST",
        headers: {
          ...this.agent.headers(),
          "content-type": "application/octet-stream",
        },
        body: new Uint8Array(request.model),
        signal: signal
          ? AbortSignal.any([signal, AbortSignal.timeout(130_000)])
          : AbortSignal.timeout(130_000),
      });
      if (response.status === 200) {
        const file = Buffer.from(await response.arrayBuffer());
        if (file.length < 64)
          return { ok: false, error: "De pc gaf een leeg printbestand terug." };
        const encoded = response.headers.get("x-nova-estimate");
        const estimateText = encoded
          ? Buffer.from(encoded, "base64").toString("utf8")
          : "";
        const raw = response.headers.get("x-nova-file-name") ?? "out.gcode.3mf";
        const fileName = /^[\w.-]{1,80}$/.test(raw) ? raw : "out.gcode.3mf";
        return {
          ok: true,
          file,
          fileName,
          ...parseEstimates(estimateText),
          log: "",
        };
      }
      if (response.status === 422) {
        const body = (await response.json().catch(() => ({}))) as {
          error?: string;
          log?: string;
          timedOut?: boolean;
        };
        return {
          ok: false,
          error: body.timedOut
            ? "Het slicen op de pc duurde te lang en is gestopt."
            : "De slicer op de pc is mislukt.",
          log: typeof body.log === "string" ? body.log.slice(-1500) : undefined,
        };
      }
      return {
        ok: false,
        error:
          "De Windows-agent weigerde het slicen (profiel, instellingen of pauze).",
      };
    } catch {
      return { ok: false, error: "De Windows-pc antwoordt niet." };
    }
  }
}

/** Prefers the PC's slicer; the server-side command is only used when the PC has none (NOVA_FAB_BACKEND can force either). */
@Injectable()
export class SlicerRouter implements SlicerPort {
  readonly name = "router";
  constructor(
    private readonly windows: WindowsAgentSlicer,
    private readonly cli: ConfiguredCliSlicer,
  ) {}

  private async choose(): Promise<{
    slicer: SlicerPort;
    problem: string | null;
  }> {
    const mode = fabBackend();
    const windowsProblem =
      mode === "server" ? "uitgeschakeld" : await this.windows.unavailable();
    if (!windowsProblem) return { slicer: this.windows, problem: null };
    if (mode === "windows")
      return { slicer: this.windows, problem: windowsProblem };
    const cliProblem = await this.cli.unavailable();
    return cliProblem
      ? {
          slicer: this.windows,
          problem:
            mode === "server"
              ? cliProblem
              : `${windowsProblem} (server: ${cliProblem})`,
        }
      : { slicer: this.cli, problem: null };
  }

  async unavailable(): Promise<string | null> {
    return (await this.choose()).problem;
  }
  async profileName(): Promise<string | null> {
    const { slicer, problem } = await this.choose();
    return problem ? null : slicer.profileName();
  }
  async slice(
    request: SliceRequest,
    signal?: AbortSignal,
  ): Promise<SliceResult> {
    const { slicer, problem } = await this.choose();
    return problem
      ? { ok: false, error: problem }
      : slicer.slice(request, signal);
  }
}
