import { Injectable } from "@nestjs/common";
import type { UpdateReport } from "@nova/contracts";
import { NovaConfig } from "../core/config/nova-config.js";
import { requestJson } from "../core/http/http-json.js";

const RELEASES = "https://api.github.com/repos/hjongedijk/nova/releases/latest";
const CACHE_MS = 5 * 60 * 1000;
const version = (value: unknown): number[] | null => {
  if (typeof value !== "string" || !/^v?\d{1,6}\.\d{1,6}\.\d{1,6}$/.test(value))
    return null;
  return value.replace(/^v/, "").split(".").map(Number);
};
const newer = (current: number[], latest: number[]) => {
  for (let index = 0; index < 3; index++) {
    if (latest[index] !== current[index])
      return latest[index]! > current[index]!;
  }
  return false;
};

/** Public release metadata, fetched only after an explicit settings-screen check. */
@Injectable()
export class UpdatesService {
  request = requestJson;
  private checkedAt = 0;
  private pending: Promise<UpdateReport> | null = null;
  private latest: UpdateReport["latest"] = null;
  private error: string | undefined;
  constructor(private readonly config: NovaConfig) {}
  status(): UpdateReport {
    const current = version(this.config.version);
    const latest = version(this.latest?.version);
    return {
      running: this.config.version,
      checkedAt: this.checkedAt ? new Date(this.checkedAt).toISOString() : null,
      latest: this.latest ? { ...this.latest } : null,
      updateAvailable: current && latest ? newer(current, latest) : null,
      ...(this.error ? { error: this.error } : {}),
    };
  }
  check(): Promise<UpdateReport> {
    if (this.pending) return this.pending;
    if (this.checkedAt && Date.now() - this.checkedAt < CACHE_MS)
      return Promise.resolve(this.status());
    this.pending = this.fetchRelease().finally(() => {
      this.pending = null;
    });
    return this.pending;
  }
  private async fetchRelease(): Promise<UpdateReport> {
    this.error = undefined;
    try {
      const result = await this.request(RELEASES, {
        headers: {
          accept: "application/vnd.github+json",
          "user-agent": "NOVA-update-check",
        },
        timeoutMs: 5000,
        signal: AbortSignal.timeout(6000),
      });
      if (result.status === 403 || result.status === 429) {
        this.error =
          "GitHub begrenst de controles. Probeer over een paar minuten opnieuw.";
      } else if (result.status !== 200) {
        this.error = "De nieuwste release kon niet worden opgehaald.";
      } else {
        const data = result.data as Record<string, unknown> | null;
        if (
          !data ||
          !version(data.tag_name) ||
          data.draft !== false ||
          data.prerelease !== false
        )
          throw new Error("Invalid release metadata");
        const tag = data.tag_name as string;
        this.latest = {
          version: tag,
          url: `https://github.com/hjongedijk/nova/releases/tag/${encodeURIComponent(tag)}`,
          notes: typeof data.body === "string" ? data.body.slice(0, 12000) : "",
          publishedAt:
            typeof data.published_at === "string" &&
            Number.isFinite(Date.parse(data.published_at))
              ? new Date(data.published_at).toISOString()
              : null,
        };
      }
    } catch {
      this.error =
        "GitHub is nu niet bereikbaar of gaf een ongeldig antwoord. Probeer later opnieuw.";
    }
    this.checkedAt = Date.now();
    return this.status();
  }
}
