import { Injectable } from "@nestjs/common";
import { NovaConfig } from "../core/config/nova-config.js";
import { MAX_SCAD_BYTES } from "./templates.js";

export type CadRender =
  | { ok: true; stl: Buffer; log: string }
  | { ok: false; error: string; log?: string };

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
        return { ok: false, error: "De CAD-werker weigerde de opdracht." };
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
      return { ok: false, error: "De CAD-werker antwoordt niet." };
    }
  }
}
