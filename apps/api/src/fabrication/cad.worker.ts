import { Injectable } from "@nestjs/common";
import { NovaConfig } from "../core/config/nova-config.js";
import { MAX_SCAD_BYTES } from "./templates.js";

export type CadRender =
  | { ok: true; stl: Buffer; log: string }
  | {
      ok: false;
      error: string;
      log?: string;
      /** The worker could not be reached or is switched off (not a problem with the model): another backend may try. */
      unavailable?: boolean;
    };

/** Renders OpenSCAD source to a binary STL. Implementations must not throw. */
export interface CadWorkerPort {
  readonly engine: string;
  available(): boolean;
  render(scad: string, signal?: AbortSignal): Promise<CadRender>;
}
export const CAD_WORKER = Symbol("nova:cad-worker");

/** The sandboxed OpenSCAD container that stack-control starts: no network, read-only root, hard limits. */
@Injectable()
export class StackControlCadWorker implements CadWorkerPort {
  readonly engine = "openscad";
  constructor(private readonly config: NovaConfig) {}

  available(): boolean {
    return Boolean(
      this.config.stackControlUrl && this.config.stackControlToken,
    );
  }

  async render(scad: string, signal?: AbortSignal): Promise<CadRender> {
    if (!this.available())
      return {
        ok: false,
        unavailable: true,
        error: "De CAD-werker is niet geconfigureerd (stack-control).",
      };
    if (Buffer.byteLength(scad) > MAX_SCAD_BYTES)
      return { ok: false, error: "De OpenSCAD-code is te lang." };
    const timeout = AbortSignal.timeout(75_000);
    try {
      const response = await fetch(
        `${this.config.stackControlUrl}/cad/render`,
        {
          method: "POST",
          headers: {
            "content-type": "application/json",
            authorization: `Bearer ${this.config.stackControlToken}`,
          },
          body: JSON.stringify({ scad }),
          signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
        },
      );
      if (response.status !== 200)
        return {
          ok: false,
          unavailable: true,
          error: "De CAD-werker weigerde de opdracht.",
        };
      const body = (await response.json()) as {
        ok?: boolean;
        stl?: string | null;
        log?: string;
        timedOut?: boolean;
      };
      if (body.timedOut)
        return {
          ok: false,
          error: "Het renderen duurde te lang en is gestopt.",
          log: body.log,
        };
      if (!body.ok || typeof body.stl !== "string")
        return {
          ok: false,
          error: "OpenSCAD kon het model niet maken.",
          log: typeof body.log === "string" ? body.log.slice(-1500) : undefined,
        };
      return {
        ok: true,
        stl: Buffer.from(body.stl, "base64"),
        log: body.log ?? "",
      };
    } catch {
      return {
        ok: false,
        unavailable: true,
        error: "De CAD-werker antwoordt niet.",
      };
    }
  }
}

export type FabBackend = "auto" | "windows" | "server";

export function fabBackend(): FabBackend {
  const raw = process.env.NOVA_FAB_BACKEND?.trim().toLowerCase();
  return raw === "windows" || raw === "server" ? raw : "auto";
}

/** What the Windows agent says about its 3D tools; cached briefly so every tool call does not probe the PC. */
export interface FabAgentStatus {
  reachable: boolean;
  enabled: boolean;
  openscad: boolean;
  slicer: boolean;
  slicerProfile: string | null;
}

@Injectable()
export class WindowsFabAgent {
  private cached?: { at: number; status: FabAgentStatus };
  constructor(private readonly config: NovaConfig) {}

  get configured(): boolean {
    return Boolean(
      this.config.windowsAgent.url && this.config.windowsAgent.token,
    );
  }
  headers(): Record<string, string> {
    return { authorization: `Bearer ${this.config.windowsAgent.token}` };
  }
  url(path: string): string {
    return `${this.config.windowsAgent.url}/v1/fab/${path}`;
  }

  async status(force = false, signal?: AbortSignal): Promise<FabAgentStatus> {
    const off: FabAgentStatus = {
      reachable: false,
      enabled: false,
      openscad: false,
      slicer: false,
      slicerProfile: null,
    };
    if (!this.configured) return off;
    if (!force && this.cached && Date.now() - this.cached.at < 15_000)
      return this.cached.status;
    let status: FabAgentStatus;
    try {
      const response = await fetch(this.url("status"), {
        headers: this.headers(),
        signal: signal
          ? AbortSignal.any([signal, AbortSignal.timeout(4_000)])
          : AbortSignal.timeout(4_000),
      });
      if (response.status === 200) {
        const body = (await response.json()) as Record<string, unknown>;
        status = {
          reachable: true,
          enabled: body.enabled === true,
          openscad: body.openscad === true,
          slicer: body.slicer === true,
          slicerProfile:
            typeof body.slicerProfile === "string" ? body.slicerProfile : null,
        };
      } else status = { ...off, reachable: true };
    } catch {
      status = off;
    }
    this.cached = { at: Date.now(), status };
    return status;
  }
}

/** OpenSCAD on the user's Windows PC through the agent (the server has no GPU or desktop). */
@Injectable()
export class WindowsAgentCadWorker implements CadWorkerPort {
  readonly engine = "openscad-windows";
  constructor(private readonly agent: WindowsFabAgent) {}

  available(): boolean {
    return this.agent.configured;
  }

  async render(scad: string, signal?: AbortSignal): Promise<CadRender> {
    const status = await this.agent.status(false, signal);
    if (!status.reachable)
      return {
        ok: false,
        unavailable: true,
        error:
          "De Windows-pc antwoordt niet. Staat hij aan en draait de agent?",
      };
    if (!status.enabled || !status.openscad)
      return {
        ok: false,
        unavailable: true,
        error: status.enabled
          ? "OpenSCAD is niet geïnstalleerd op de pc."
          : "3D-modelleren staat uit op de pc (agent.json: fabrication.enabled).",
      };
    if (Buffer.byteLength(scad) > MAX_SCAD_BYTES)
      return { ok: false, error: "De OpenSCAD-code is te lang." };
    try {
      const response = await fetch(this.agent.url("render"), {
        method: "POST",
        headers: {
          ...this.agent.headers(),
          "content-type": "text/plain; charset=utf-8",
        },
        body: scad,
        signal: signal
          ? AbortSignal.any([signal, AbortSignal.timeout(75_000)])
          : AbortSignal.timeout(75_000),
      });
      if (response.status === 200) {
        const bytes = Buffer.from(await response.arrayBuffer());
        if (bytes.length < 84)
          return { ok: false, error: "De pc gaf een leeg model terug." };
        return { ok: true, stl: bytes, log: "" };
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
            ? "Het renderen op de pc duurde te lang en is gestopt."
            : "OpenSCAD kon het model niet maken.",
          log: typeof body.log === "string" ? body.log.slice(-1500) : undefined,
        };
      }
      return {
        ok: false,
        unavailable: true,
        error:
          "De Windows-agent weigerde het renderen (staat het uit, gepauzeerd of is OpenSCAD niet gevonden?).",
      };
    } catch {
      return {
        ok: false,
        unavailable: true,
        error: "De Windows-pc antwoordt niet.",
      };
    }
  }
}

/**
 * Chooses where models are rendered. "auto" (default) prefers the Windows PC and falls back to the
 * server's sandbox container only when the PC cannot be used; a model error from OpenSCAD is never retried elsewhere.
 * NOVA_FAB_BACKEND=windows or server forces one.
 */
@Injectable()
export class CadWorkerRouter implements CadWorkerPort {
  readonly engine = "openscad";
  constructor(
    private readonly windows: WindowsAgentCadWorker,
    private readonly server: StackControlCadWorker,
  ) {}

  available(): boolean {
    const mode = fabBackend();
    return (
      (mode !== "server" && this.windows.available()) ||
      (mode !== "windows" && this.server.available())
    );
  }

  async render(scad: string, signal?: AbortSignal): Promise<CadRender> {
    const mode = fabBackend();
    let first: CadRender | undefined;
    if (mode !== "server" && this.windows.available()) {
      first = await this.windows.render(scad, signal);
      if (first.ok || !first.unavailable || mode === "windows") return first;
    }
    if (mode !== "windows" && this.server.available()) {
      const second = await this.server.render(scad, signal);
      if (second.ok || !first || first.ok) return second;
      return {
        ...second,
        error: `${first.error} Terugvallen op de server mislukte ook: ${second.error}`,
      };
    }
    return (
      first ?? {
        ok: false,
        unavailable: true,
        error:
          "Er is geen CAD-werker beschikbaar (Windows-pc of stack-control).",
      }
    );
  }
}
