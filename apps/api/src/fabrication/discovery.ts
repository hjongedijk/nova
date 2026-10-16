import { Injectable } from "@nestjs/common";
import { NovaConfig } from "../core/config/nova-config.js";

export interface RemoteModel {
  provider: string;
  id: string;
  title: string;
  url: string;
  creator?: string;
  license?: string;
  likes?: number;
  downloads?: number;
  thumbnail?: string;
}

export interface RemoteFile {
  id: string;
  name: string;
  size?: number;
  format: "stl" | "3mf" | "other";
  url: string;
}

export interface ProviderState {
  name: string;
  status: "ready" | "needs_token" | "unsupported" | "failed";
  note?: string;
}

/** A model repository with an official API. Implementations must not throw on ordinary failures. */
export interface DiscoveryProvider {
  readonly name: string;
  state(): ProviderState;
  search(
    query: string,
    limit: number,
    signal?: AbortSignal,
  ): Promise<RemoteModel[]>;
  details(
    id: string,
    signal?: AbortSignal,
  ): Promise<{
    model: RemoteModel;
    files: RemoteFile[];
    description?: string;
  } | null>;
  download(file: RemoteFile, signal?: AbortSignal): Promise<Buffer>;
}
export const DISCOVERY_PROVIDERS = Symbol("nova:discovery-providers");

const MAX_DOWNLOAD = 60 * 1024 * 1024;
const THINGIVERSE_HOSTS = /^(api|cdn)\.thingiverse\.com$/;

const asString = (v: unknown, max = 200) =>
  typeof v === "string" ? v.slice(0, max) : undefined;
const asNumber = (v: unknown) =>
  typeof v === "number" && Number.isFinite(v) ? v : undefined;

/** Thingiverse through its official REST API (needs an app token from the user: THINGIVERSE_TOKEN). */
@Injectable()
export class ThingiverseProvider implements DiscoveryProvider {
  readonly name = "thingiverse";
  constructor(private readonly config: NovaConfig) {}

  private get token() {
    return this.config.thingiverseToken;
  }

  state(): ProviderState {
    return this.token
      ? { name: this.name, status: "ready" }
      : {
          name: this.name,
          status: "needs_token",
          note: "Maak een app aan op thingiverse.com/developers en zet THINGIVERSE_TOKEN.",
        };
  }

  private async get(path: string, signal?: AbortSignal): Promise<unknown> {
    const response = await fetch(`https://api.thingiverse.com${path}`, {
      headers: {
        authorization: `Bearer ${this.token}`,
        accept: "application/json",
      },
      signal: signal
        ? AbortSignal.any([signal, AbortSignal.timeout(15_000)])
        : AbortSignal.timeout(15_000),
      redirect: "error",
    });
    if (response.status === 429) throw new Error("rate_limited");
    if (!response.ok) throw new Error(`http_${response.status}`);
    return response.json();
  }

  private map(item: Record<string, unknown>): RemoteModel | null {
    const id = item.id;
    const title = asString(item.name, 160);
    if ((typeof id !== "number" && typeof id !== "string") || !title)
      return null;
    const creator = (item.creator ?? {}) as Record<string, unknown>;
    return {
      provider: this.name,
      id: String(id),
      title,
      url:
        asString(item.public_url, 300) ??
        `https://www.thingiverse.com/thing:${id}`,
      creator: asString(creator.name, 80),
      license: asString(item.license, 80),
      likes: asNumber(item.like_count),
      downloads: asNumber(item.download_count),
      thumbnail: asString(item.thumbnail, 300),
    };
  }

  async search(
    query: string,
    limit: number,
    signal?: AbortSignal,
  ): Promise<RemoteModel[]> {
    if (!this.token) return [];
    const data = (await this.get(
      `/search/${encodeURIComponent(query.slice(0, 100))}?type=things&per_page=${Math.min(30, Math.max(1, limit))}&sort=relevant`,
      signal,
    )) as { hits?: unknown[] };
    return (Array.isArray(data.hits) ? data.hits : [])
      .map((hit) => this.map(hit as Record<string, unknown>))
      .filter((m): m is RemoteModel => Boolean(m));
  }

  async details(id: string, signal?: AbortSignal) {
    if (!this.token || !/^\d{1,10}$/.test(id)) return null;
    const thing = (await this.get(`/things/${id}`, signal)) as Record<
      string,
      unknown
    >;
    const model = this.map(thing);
    if (!model) return null;
    const list = (await this.get(`/things/${id}/files`, signal)) as unknown[];
    const files: RemoteFile[] = (Array.isArray(list) ? list : []).flatMap(
      (raw) => {
        const f = raw as Record<string, unknown>;
        const name = asString(f.name, 160);
        const url =
          asString(f.direct_url, 400) ?? asString(f.download_url, 400);
        if (
          !name ||
          !url ||
          (typeof f.id !== "number" && typeof f.id !== "string")
        )
          return [];
        const format = /\.stl$/i.test(name)
          ? "stl"
          : /\.3mf$/i.test(name)
            ? "3mf"
            : "other";
        return [
          {
            id: String(f.id),
            name,
            size: asNumber(f.size),
            format,
            url,
          } as RemoteFile,
        ];
      },
    );
    return { model, files, description: asString(thing.description, 1200) };
  }

  async download(file: RemoteFile, signal?: AbortSignal): Promise<Buffer> {
    const url = new URL(file.url);
    if (url.protocol !== "https:" || !THINGIVERSE_HOSTS.test(url.hostname))
      throw new Error("Download alleen van thingiverse.com toegestaan.");
    const headers: Record<string, string> = url.hostname.startsWith("api.")
      ? { authorization: `Bearer ${this.token}` }
      : {};
    const response = await fetch(url, {
      headers,
      signal: signal
        ? AbortSignal.any([signal, AbortSignal.timeout(60_000)])
        : AbortSignal.timeout(60_000),
      redirect: "follow",
    });
    // A redirect may only land on the same allow-listed hosts.
    const finalHost = new URL(response.url).hostname;
    if (
      !THINGIVERSE_HOSTS.test(finalHost) &&
      !/\.thingiverse\.com$|\.amazonaws\.com$/.test(finalHost)
    )
      throw new Error("Download werd doorgestuurd naar een onbekende host.");
    if (!response.ok) throw new Error(`http_${response.status}`);
    const length = Number(response.headers.get("content-length") ?? 0);
    if (length > MAX_DOWNLOAD) throw new Error("Bestand te groot.");
    const buffer = Buffer.from(await response.arrayBuffer());
    if (buffer.length > MAX_DOWNLOAD) throw new Error("Bestand te groot.");
    return buffer;
  }
}

/** What NOVA reports for repositories without a usable official API; no scraping is attempted. */
export const UNSUPPORTED_PROVIDERS: ProviderState[] = [
  {
    name: "printables",
    status: "unsupported",
    note: "Printables heeft geen gedocumenteerde publieke API; scrapen is niet toegevoegd (voorwaarden en betrouwbaarheid).",
  },
  {
    name: "makerworld",
    status: "unsupported",
    note: "MakerWorld heeft geen gedocumenteerde publieke API; scrapen is niet toegevoegd (voorwaarden en betrouwbaarheid).",
  },
];

const words = (s: string) =>
  s
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((w) => w.length > 1);

/** Dedupes by normalised title+creator and ranks by query overlap, popularity and a known licence. */
export function rankModels(
  models: RemoteModel[],
  query: string,
): RemoteModel[] {
  const terms = new Set(words(query));
  const seen = new Set<string>();
  const scored = models
    .filter((m) => {
      const key = `${words(m.title).join(" ")}|${(m.creator ?? "").toLowerCase()}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .map((m) => {
      const titleWords = new Set(words(m.title));
      const overlap =
        [...terms].filter((t) => titleWords.has(t)).length /
        Math.max(1, terms.size);
      const popularity =
        Math.log10(1 + (m.likes ?? 0) * 3 + (m.downloads ?? 0)) / 6;
      const score =
        overlap * 3 + Math.min(1, popularity) + (m.license ? 0.2 : 0);
      return { m, score };
    });
  return scored.sort((a, b) => b.score - a.score).map((x) => x.m);
}
