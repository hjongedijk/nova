import { Injectable, Optional } from "@nestjs/common";
import fs from "node:fs";
import path from "node:path";
import { NovaConfig } from "../core/config/nova-config.js";
import { ApiRegistry } from "./api-registry.js";
import {
  DEFAULT_LIMITS,
  realTransport,
  scanLan,
  type Candidate,
  type DiscoveryTransport,
  type ScanLimits,
} from "./lan-discovery.js";

const MIN = 60_000;
/** A manual rescan is allowed this often; the autopilot looks at most once a day. */
export const MANUAL_COOLDOWN_MS = 10 * MIN;
export const AUTOPILOT_INTERVAL_MS = 24 * 60 * MIN;
const KEEP_UNSEEN_MS = 30 * 24 * 60 * MIN;

interface DiscoveryFile {
  version: 1;
  lastScanAt: number;
  candidates: Candidate[];
}

/**
 * Remembers what the read-only LAN scan found (lan-discovery.json) and hands it to the chat tool and
 * the autopilot as proposals. A scan is rate limited and budgeted; nothing is ever connected here.
 */
@Injectable()
export class LanDiscoveryService {
  private data?: DiscoveryFile;
  private running?: Promise<Candidate[]>;
  /** Replaceable in tests. */
  transport: DiscoveryTransport = realTransport;
  limits: ScanLimits = DEFAULT_LIMITS;
  now: () => number = Date.now;

  constructor(
    private readonly config: NovaConfig,
    @Optional() private readonly registry?: ApiRegistry,
  ) {}

  private get file(): string {
    return this.config.dataFile("lan-discovery.json");
  }

  private load(): DiscoveryFile {
    if (this.data) return this.data;
    try {
      const raw = JSON.parse(
        fs.readFileSync(this.file, "utf8"),
      ) as Partial<DiscoveryFile>;
      this.data = {
        version: 1,
        lastScanAt: typeof raw.lastScanAt === "number" ? raw.lastScanAt : 0,
        candidates: Array.isArray(raw.candidates)
          ? raw.candidates.filter(
              (c): c is Candidate =>
                typeof c?.id === "string" && typeof c.host === "string",
            )
          : [],
      };
    } catch {
      this.data = { version: 1, lastScanAt: 0, candidates: [] };
    }
    return this.data;
  }

  private save(): void {
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      const temporary = `${this.file}.${process.pid}.tmp`;
      fs.writeFileSync(temporary, JSON.stringify(this.data, null, 1), {
        mode: 0o600,
      });
      fs.renameSync(temporary, this.file);
    } catch {
      /* memory stays authoritative */
    }
  }

  get lastScanAt(): number {
    return this.load().lastScanAt;
  }

  candidates(): Candidate[] {
    const data = this.load();
    this.markConnected(data);
    return structuredClone(data.candidates);
  }

  /** What is worth telling the owner: found, not dismissed, not yet connected. */
  proposals(): Candidate[] {
    return this.candidates().filter(
      (c) => c.state === "new" || c.state === "proposed",
    );
  }

  markProposed(id: string): void {
    const c = this.load().candidates.find((item) => item.id === id);
    if (c && c.state === "new") {
      c.state = "proposed";
      this.save();
    }
  }

  dismiss(id: string): boolean {
    const c = this.load().candidates.find((item) => item.id === id);
    if (!c) return false;
    c.state = "dismissed";
    this.save();
    return true;
  }

  /** Rescan unless one ran recently. `minGapMs` is the rate limit for this caller. */
  async scan(
    minGapMs = MANUAL_COOLDOWN_MS,
    signal?: AbortSignal,
  ): Promise<{ scanned: boolean; candidates: Candidate[] }> {
    const data = this.load();
    if (this.running) return { scanned: true, candidates: await this.running };
    if (data.lastScanAt && this.now() - data.lastScanAt < minGapMs)
      return { scanned: false, candidates: this.candidates() };
    // Set before the work: a crash must not turn into a scan storm.
    data.lastScanAt = this.now();
    this.save();
    this.running = this.run(signal).finally(() => {
      this.running = undefined;
    });
    return { scanned: true, candidates: await this.running };
  }

  private async run(signal?: AbortSignal): Promise<Candidate[]> {
    const data = this.load();
    const now = this.now();
    const report = await scanLan(this.transport, now, this.limits, signal);
    for (const found of report.found) {
      const known = data.candidates.find((c) => c.id === found.id);
      if (known) known.lastSeen = now;
      else data.candidates.push(found);
    }
    data.candidates = data.candidates.filter(
      (c) => now - c.lastSeen < KEEP_UNSEEN_MS,
    );
    this.save();
    return this.candidates();
  }

  private markConnected(data: DiscoveryFile): void {
    if (!this.registry) return;
    let hosts: Set<string>;
    try {
      hosts = new Set(
        this.registry.list().flatMap((integration) => {
          try {
            return [new URL(integration.baseUrl).hostname];
          } catch {
            return [];
          }
        }),
      );
    } catch {
      return;
    }
    for (const c of data.candidates)
      if (c.state !== "dismissed" && hosts.has(c.host)) c.state = "connected";
  }
}
