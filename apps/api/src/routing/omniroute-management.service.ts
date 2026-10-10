import { Injectable } from "@nestjs/common";
import { DatabaseSync } from "node:sqlite";
import { NovaConfig } from "../core/config/nova-config.js";

type Fetcher = typeof fetch;

export interface OmniRouteStatus {
  configured: boolean;
  online: boolean;
  error?: string;
  memory?: {
    keyword: boolean;
    embedding: boolean;
    backend: string;
    automaticExtraction: boolean;
  };
  skills?: { count: number; automaticExecution: false };
  compression?: {
    enabled: boolean;
    mode: string;
    preserveSystemPrompt: boolean;
  };
  cache?: {
    hits: number;
    misses: number;
    entries: number;
    toolRequestsBypass: true;
  };
}

interface SkillSummary {
  id: string;
  name: string;
  description: string;
  category: string;
  area: string;
}

/**
 * OmniRoute's management API (memory, agent skills, compression, cache) behind one private session.
 * Concurrent logins are shared, and an expired session is renewed once. The password never leaves
 * this class.
 */
@Injectable()
export class OmniRouteManagement {
  private cookie: string | null = null;
  private loginPromise: Promise<void> | null = null;
  private activeRequests = 0;
  private snapshot: { at: number; data: OmniRouteStatus } | null = null;
  /** Replaceable in tests. */
  fetcher: Fetcher = (...args) => fetch(...args);
  private scopeOverride?: string;
  private urlOverride?: string;
  private passwordOverride?: string;

  constructor(private readonly config: NovaConfig) {}

  /** For tests. */
  configure(options: {
    url?: string;
    password?: string;
    scope?: string;
    fetcher?: Fetcher;
  }): void {
    const changed =
      (options.url !== undefined && options.url !== this.urlOverride) ||
      (options.password !== undefined &&
        options.password !== this.passwordOverride) ||
      (options.scope !== undefined && options.scope !== this.scopeOverride) ||
      (options.fetcher !== undefined && options.fetcher !== this.fetcher);
    if (changed && (this.loginPromise || this.activeRequests > 0))
      throw new Error("OmniRoute management configuration is in use");
    if (changed) {
      this.cookie = null;
      this.snapshot = null;
    }
    if (options.url !== undefined) this.urlOverride = options.url;
    if (options.password !== undefined)
      this.passwordOverride = options.password;
    if (options.scope !== undefined) this.scopeOverride = options.scope;
    if (options.fetcher !== undefined) this.fetcher = options.fetcher;
  }

  private get url(): string {
    return (
      this.urlOverride ?? this.config.omniUrl.replace(/\/v1$/, "")
    ).replace(/\/$/, "");
  }

  private get password(): string {
    return this.passwordOverride ?? this.config.omniAdminPassword;
  }

  get configured(): boolean {
    return Boolean(this.password);
  }

  /** The OmniRoute API key NOVA's memories belong to. */
  get scope(): string {
    if (this.scopeOverride) return this.scopeOverride;
    const db = new DatabaseSync(this.config.omniDatabase, { readOnly: true });
    try {
      const row = db
        .prepare(
          "SELECT id FROM api_keys WHERE key=? AND is_active=1 AND revoked_at IS NULL",
        )
        .get(this.config.omniKey) as { id?: string } | undefined;
      if (!row?.id) throw new Error("NOVA memory owner unavailable");
      return row.id;
    } finally {
      db.close();
    }
  }

  async login(): Promise<void> {
    if (!this.configured)
      throw new Error("OmniRoute management login is not configured");
    this.loginPromise ??= (async () => {
      const response = await this.fetcher(`${this.url}/api/auth/login`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ password: this.password }),
        signal: AbortSignal.timeout(10_000),
        redirect: "error",
      });
      if (!response.ok)
        throw new Error(
          `OmniRoute management login failed (${response.status})`,
        );
      const cookie = response.headers
        .getSetCookie()
        .find((value) => value.startsWith("auth_token="));
      if (!cookie)
        throw new Error("OmniRoute did not return a management session");
      this.cookie = cookie.split(";")[0]!;
    })().finally(() => {
      this.loginPromise = null;
    });
    return this.loginPromise;
  }

  async request<T = unknown>(
    endpoint: string,
    options: { method?: string; body?: unknown; raw?: boolean } = {},
    retry = true,
  ): Promise<T> {
    if (!endpoint.startsWith("/api/") || endpoint.includes(".."))
      throw new Error("Invalid OmniRoute endpoint");
    this.activeRequests += 1;
    try {
      if (!this.cookie) await this.login();
      const response = await this.fetcher(`${this.url}${endpoint}`, {
        method: options.method ?? "GET",
        headers: { "content-type": "application/json", cookie: this.cookie! },
        ...(options.body === undefined
          ? {}
          : { body: JSON.stringify(options.body) }),
        signal: AbortSignal.timeout(10_000),
        redirect: "error",
      });
      if (response.status === 401 && retry) {
        this.cookie = null;
        await this.login();
        return this.request<T>(endpoint, options, false);
      }
      if (!response.ok)
        throw new Error(
          `OmniRoute management request failed (${response.status})`,
        );
      if (response.status === 204) return {} as T;
      return (await this.readResponse(response, options.raw === true)) as T;
    } finally {
      this.activeRequests -= 1;
    }
  }

  private async readResponse(
    response: Response,
    raw: boolean,
  ): Promise<unknown> {
    const reader = response.body?.getReader();
    if (!reader) throw new Error("OmniRoute management response is invalid");
    const decoder = new TextDecoder();
    let bytes = 0;
    let text = "";
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        bytes += value.byteLength;
        if (bytes > 2_000_000) {
          await reader.cancel().catch(() => undefined);
          throw new Error("OmniRoute management response is too large");
        }
        text += decoder.decode(value, { stream: true });
      }
      text += decoder.decode();
    } catch {
      throw new Error("OmniRoute management response could not be read");
    } finally {
      reader.releaseLock();
    }
    if (raw) return text.slice(0, 16_000);
    try {
      return JSON.parse(text);
    } catch {
      throw new Error("OmniRoute management response is invalid");
    }
  }

  async skills(
    id?: string,
  ): Promise<
    | { count?: number; skills: SkillSummary[] }
    | (SkillSummary & { documentation: string })
  > {
    if (id && !/^[a-z][a-z0-9-]{1,80}$/.test(id))
      throw new Error("Invalid skill ID");
    const select = (skill: SkillSummary): SkillSummary => ({
      id: skill.id,
      name: skill.name,
      description: skill.description,
      category: skill.category,
      area: skill.area,
    });
    if (id) {
      const data = await this.request<{ skill?: SkillSummary } & SkillSummary>(
        `/api/agent-skills/${id}`,
      );
      return {
        ...select(data.skill ?? data),
        documentation: await this.request<string>(
          `/api/agent-skills/${id}/raw`,
          { raw: true },
        ),
      };
    }
    const data = await this.request<{
      count?: number;
      skills?: SkillSummary[];
    }>("/api/agent-skills");
    return { count: data.count, skills: (data.skills ?? []).map(select) };
  }

  async status(force = false): Promise<OmniRouteStatus> {
    if (!this.configured)
      return {
        configured: false,
        online: false,
        error: "Management login ontbreekt",
      };
    if (!force && this.snapshot && Date.now() - this.snapshot.at < 30_000)
      return this.snapshot.data;
    try {
      const [engine, memory, skills, compression, cache] = await Promise.all([
        this.request<{
          keyword?: { available?: boolean };
          embedding?: { available?: boolean };
        }>("/api/memory/engine-status"),
        this.request<{ primaryBackend?: string; enabled?: boolean }>(
          "/api/settings/memory",
        ),
        this.skills() as Promise<{ count?: number }>,
        this.request<{ enabled?: boolean; preserveSystemPrompt?: boolean }>(
          "/api/settings/compression",
        ),
        this.request<{ hits?: number; misses?: number; size?: number }>(
          "/api/cache/stats",
        ),
      ]);
      const data: OmniRouteStatus = {
        configured: true,
        online: true,
        memory: {
          keyword: engine.keyword?.available === true,
          embedding: engine.embedding?.available === true,
          backend: memory.primaryBackend || "sqlite",
          automaticExtraction: memory.enabled === true,
        },
        skills: { count: skills.count ?? 0, automaticExecution: false },
        compression: {
          enabled: compression.enabled === true,
          mode: this.config.omniCompression,
          preserveSystemPrompt: compression.preserveSystemPrompt === true,
        },
        cache: {
          hits: cache.hits || 0,
          misses: cache.misses || 0,
          entries: cache.size || 0,
          toolRequestsBypass: true,
        },
      };
      this.snapshot = { at: Date.now(), data };
      return data;
    } catch {
      this.snapshot = null;
      return {
        configured: true,
        online: false,
        error: "OmniRoute beheer-API niet beschikbaar",
      };
    }
  }
}
