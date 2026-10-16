import { Injectable } from "@nestjs/common";
import { NovaConfig } from "../core/config/nova-config.js";

export interface PrinterMaterial {
  slot: string;
  type: string;
  color?: string;
  remainingPercent?: number;
}

export interface PrinterStatus {
  /** Which backend answered; "none" means no printer is linked. */
  driver: string;
  model: string;
  online: boolean;
  state: "idle" | "printing" | "paused" | "error" | "offline" | "unknown";
  simulated: boolean;
  progressPercent?: number;
  remainingMinutes?: number;
  nozzleC?: number;
  bedC?: number;
  nozzleDiameter?: number;
  jobName?: string;
  error?: string;
  materials?: PrinterMaterial[];
  /** Why the printer cannot be used, in Dutch, when it cannot. */
  note?: string;
}

/** Thrown when a command may or may not have reached the printer. Never retried automatically. */
export class PrinterUncertain extends Error {}
/** Thrown when the printer or its firmware refused the command (nothing was started). */
export class PrinterRefused extends Error {}

export interface StartRequest {
  jobName: string;
  file: Buffer;
  fileName: string;
  idempotencyKey: string;
}

/** One physical (or simulated) printer. Implementations throw PrinterRefused or PrinterUncertain on commands. */
export interface PrinterPort {
  readonly driver: string;
  status(signal?: AbortSignal): Promise<PrinterStatus>;
  start(request: StartRequest, signal?: AbortSignal): Promise<{ ref: string }>;
  pause(signal?: AbortSignal): Promise<void>;
  resume(signal?: AbortSignal): Promise<void>;
  cancel(signal?: AbortSignal): Promise<void>;
}
export const PRINTER_PORT = Symbol("nova:printer-port");

/** Used when no printer is linked: honest about it, never pretends. */
export class NoPrinter implements PrinterPort {
  readonly driver = "none";
  async status(): Promise<PrinterStatus> {
    return {
      driver: "none",
      model: "Bambu Lab P2S",
      online: false,
      state: "offline",
      simulated: false,
      note: "Er is nog geen printer gekoppeld. Zet de P2S in LAN-modus met Developer Mode en koppel hem in Instellingen (zie docs/fabrication-printer.md).",
    };
  }
  async start(): Promise<never> {
    throw new PrinterRefused("Er is geen printer gekoppeld.");
  }
  async pause(): Promise<never> {
    throw new PrinterRefused("Er is geen printer gekoppeld.");
  }
  async resume(): Promise<never> {
    throw new PrinterRefused("Er is geen printer gekoppeld.");
  }
  async cancel(): Promise<never> {
    throw new PrinterRefused("Er is geen printer gekoppeld.");
  }
}

/**
 * A deterministic printer for development and tests. Time advances only when `advance()` is called,
 * and failures can be injected. It never touches hardware and is only selected explicitly.
 */
export class SimulatedPrinter implements PrinterPort {
  readonly driver = "simulated";
  private state: PrinterStatus["state"] = "idle";
  private progress = 0;
  private job?: string;
  private reachable = true;
  failNextStart?: "refuse" | "uncertain";
  /** What was submitted, for assertions. */
  readonly received: StartRequest[] = [];
  materials: PrinterMaterial[] = [
    { slot: "AMS A1", type: "PLA", color: "#222222", remainingPercent: 80 },
  ];
  nozzleDiameter = 0.4;
  /** When a start fails as "uncertain", the print really started (the worst case to handle). */
  startsDespiteUncertain = false;

  setReachable(value: boolean): void {
    this.reachable = value;
  }
  advance(percent: number): void {
    if (this.state === "printing") {
      this.progress = Math.min(100, this.progress + percent);
      if (this.progress >= 100) {
        this.state = "idle";
        this.job = undefined;
        this.progress = 100;
      }
    }
  }
  breakDown(message: string): void {
    this.state = "error";
    this.errorText = message;
  }
  private errorText?: string;

  async status(): Promise<PrinterStatus> {
    if (!this.reachable)
      return {
        driver: "simulated",
        model: "Bambu Lab P2S (simulatie)",
        online: false,
        state: "offline",
        simulated: true,
      };
    return {
      driver: "simulated",
      model: "Bambu Lab P2S (simulatie)",
      online: true,
      state: this.state,
      simulated: true,
      progressPercent: this.progress,
      remainingMinutes:
        this.state === "printing"
          ? Math.round(((100 - this.progress) / 100) * 60)
          : undefined,
      nozzleC: this.state === "printing" ? 215 : 24,
      bedC: this.state === "printing" ? 60 : 24,
      nozzleDiameter: this.nozzleDiameter,
      jobName: this.job,
      error: this.errorText,
      materials: this.materials,
    };
  }
  async start(request: StartRequest): Promise<{ ref: string }> {
    if (!this.reachable)
      throw new PrinterUncertain("Verbinding verbroken tijdens het versturen.");
    if (this.state !== "idle")
      throw new PrinterRefused("De printer is niet vrij.");
    const mode = this.failNextStart;
    this.failNextStart = undefined;
    if (mode === "refuse")
      throw new PrinterRefused("De printer weigerde de opdracht.");
    if (mode === "uncertain" && !this.startsDespiteUncertain)
      throw new PrinterUncertain("Geen antwoord van de printer.");
    this.received.push(request);
    this.state = "printing";
    this.progress = 0;
    this.job = request.jobName;
    if (mode === "uncertain")
      throw new PrinterUncertain("Geen antwoord van de printer.");
    return { ref: `sim-${request.idempotencyKey.slice(0, 8)}` };
  }
  async pause(): Promise<void> {
    if (this.state !== "printing")
      throw new PrinterRefused("Er loopt geen print.");
    this.state = "paused";
  }
  async resume(): Promise<void> {
    if (this.state !== "paused")
      throw new PrinterRefused("De print is niet gepauzeerd.");
    this.state = "printing";
  }
  async cancel(): Promise<void> {
    if (this.state !== "printing" && this.state !== "paused")
      throw new PrinterRefused("Er loopt geen print.");
    this.state = "idle";
    this.job = undefined;
    this.progress = 0;
  }
}

/** Chooses the printer backend from NOVA_PRINTER_DRIVER: "none" (default) or "simulated". Real drivers register here. */
@Injectable()
export class PrinterProvider implements PrinterPort {
  private readonly inner: PrinterPort;
  constructor(config: NovaConfig) {
    const driver = process.env.NOVA_PRINTER_DRIVER?.trim().toLowerCase();
    this.inner =
      driver === "simulated" ? new SimulatedPrinter() : new NoPrinter();
    void config;
  }
  get driver() {
    return this.inner.driver;
  }
  status(signal?: AbortSignal) {
    return this.inner.status(signal);
  }
  start(request: StartRequest, signal?: AbortSignal) {
    return this.inner.start(request, signal);
  }
  pause(signal?: AbortSignal) {
    return this.inner.pause(signal);
  }
  resume(signal?: AbortSignal) {
    return this.inner.resume(signal);
  }
  cancel(signal?: AbortSignal) {
    return this.inner.cancel(signal);
  }
}
