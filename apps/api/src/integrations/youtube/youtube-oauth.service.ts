import { Inject, Injectable, Optional } from "@nestjs/common";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { NovaConfig } from "../../core/config/nova-config.js";
import { ValidationError } from "../../core/errors/validation.error.js";

export const YOUTUBE_OAUTH_HTTP = "YOUTUBE_OAUTH_HTTP";
export type YoutubeOAuthHttp = typeof fetch;

const SCOPE = "https://www.googleapis.com/auth/youtube.force-ssl";
const COOKIE = "nova_youtube_oauth";
const CALLBACK_PATH = "/api/settings/youtube/oauth/callback";
const STATE_MS = 5 * 60_000;
const TOKEN_URL = "https://oauth2.googleapis.com/token";
const REVOKE_URL = "https://oauth2.googleapis.com/revoke";

type Credentials = {
  clientId: string;
  clientSecret: string;
  refreshToken?: string;
};
type Pending = { nonce: string; expiresAt: number };

/** Google OAuth credentials are held only by the API; access tokens stay in memory. */
@Injectable()
export class YoutubeOAuthService {
  private readonly file: string;
  private readonly pending = new Map<string, Pending>();
  private access: { token: string; expiresAt: number } | null = null;
  private generation = 0;
  private refreshing: {
    generation: number;
    promise: Promise<string | null>;
  } | null = null;

  constructor(
    private readonly config: NovaConfig,
    @Optional()
    @Inject(YOUTUBE_OAUTH_HTTP)
    private readonly http: YoutubeOAuthHttp = fetch,
  ) {
    this.file = config.dataFile("youtube-oauth.json");
  }

  callbackUrl(): string | null {
    try {
      const url = new URL(this.config.publicUrl);
      if (
        (url.protocol !== "https:" &&
          !(
            url.protocol === "http:" &&
            ["localhost", "127.0.0.1"].includes(url.hostname)
          )) ||
        url.username ||
        url.password ||
        url.search ||
        url.hash ||
        url.pathname !== "/"
      )
        return null;
      return new URL(CALLBACK_PATH, url.origin).href;
    } catch {
      return null;
    }
  }

  status() {
    const credentials = this.read();
    return {
      configured: Boolean(credentials?.clientId && credentials.clientSecret),
      connected: Boolean(credentials?.refreshToken),
      callbackUrl: this.callbackUrl(),
    };
  }

  saveClient(input: unknown) {
    if (!input || typeof input !== "object" || Array.isArray(input))
      throw new ValidationError(["Ongeldige YouTube OAuth-instellingen."]);
    const values = input as Record<string, unknown>;
    if (
      Object.keys(values).some(
        (key) => !["clientId", "clientSecret"].includes(key),
      )
    )
      throw new ValidationError(["Onbekend YouTube OAuth-veld."]);
    const clientId = values.clientId;
    const clientSecret = values.clientSecret;
    if (
      typeof clientId !== "string" ||
      !/^[A-Za-z0-9._-]{10,300}\.apps\.googleusercontent\.com$/.test(
        clientId,
      ) ||
      typeof clientSecret !== "string" ||
      !/^[\x21-\x7e]{8,2048}$/.test(clientSecret)
    )
      throw new ValidationError(["Ongeldige Google OAuth-clientgegevens."]);
    const previous = this.read();
    this.write({
      clientId,
      clientSecret,
      ...(previous?.clientId === clientId &&
      previous.clientSecret === clientSecret &&
      previous.refreshToken
        ? { refreshToken: previous.refreshToken }
        : {}),
    });
    this.generation++;
    this.access = null;
    this.pending.clear();
    return this.status();
  }

  begin(): {
    authorizationUrl: string;
    cookieName: string;
    cookieValue: string;
    maxAgeMs: number;
  } {
    const credentials = this.read();
    const callback = this.callbackUrl();
    if (!credentials || !callback)
      throw new ValidationError([
        "Stel eerst Google OAuth en NOVA_PUBLIC_URL in.",
      ]);
    const now = Date.now();
    for (const [key, value] of this.pending)
      if (value.expiresAt <= now) this.pending.delete(key);
    if (this.pending.size >= 20)
      this.pending.delete(this.pending.keys().next().value!);
    const state = crypto.randomBytes(32).toString("base64url");
    const nonce = crypto.randomBytes(32).toString("base64url");
    this.pending.set(state, { nonce, expiresAt: now + STATE_MS });
    const url = new URL("https://accounts.google.com/o/oauth2/v2/auth");
    url.search = new URLSearchParams({
      client_id: credentials.clientId,
      redirect_uri: callback,
      response_type: "code",
      scope: SCOPE,
      access_type: "offline",
      prompt: "consent",
      state,
    }).toString();
    return {
      authorizationUrl: url.href,
      cookieName: COOKIE,
      cookieValue: nonce,
      maxAgeMs: STATE_MS,
    };
  }

  async complete(input: {
    state?: unknown;
    code?: unknown;
    cookie?: unknown;
  }): Promise<void> {
    const state = input.state;
    const code = input.code;
    const nonce = input.cookie;
    if (
      typeof state !== "string" ||
      typeof code !== "string" ||
      typeof nonce !== "string" ||
      !/^[A-Za-z0-9_-]{40,60}$/.test(state) ||
      code.length > 4096 ||
      !code
    )
      throw new ValidationError(["YouTube-koppeling is verlopen of ongeldig."]);
    const pending = this.pending.get(state);
    this.pending.delete(state);
    if (
      !pending ||
      pending.expiresAt <= Date.now() ||
      !safeEqual(pending.nonce, nonce)
    )
      throw new ValidationError(["YouTube-koppeling is verlopen of ongeldig."]);
    const credentials = this.read();
    const callback = this.callbackUrl();
    if (!credentials || !callback)
      throw new ValidationError(["YouTube OAuth is niet ingesteld."]);
    const generation = this.generation;
    const token = await this.tokenRequest({
      code,
      client_id: credentials.clientId,
      client_secret: credentials.clientSecret,
      redirect_uri: callback,
      grant_type: "authorization_code",
    });
    if (generation !== this.generation)
      throw new ValidationError(["YouTube-koppeling is intussen gewijzigd."]);
    if (!token.refresh_token || !token.scope?.split(" ").includes(SCOPE))
      throw new ValidationError([
        "Google gaf geen blijvende YouTube-toestemming.",
      ]);
    this.write({ ...credentials, refreshToken: token.refresh_token });
    this.generation++;
    this.access = {
      token: token.access_token,
      expiresAt: Date.now() + token.expires_in * 1000,
    };
  }

  async getAccessToken(): Promise<string | null> {
    if (this.access && this.access.expiresAt > Date.now() + 60_000)
      return this.access.token;
    if (this.refreshing?.generation === this.generation)
      return this.refreshing.promise;
    const credentials = this.read();
    if (!credentials?.refreshToken) return null;
    const generation = this.generation;
    const promise = (async () => {
      try {
        const token = await this.tokenRequest({
          client_id: credentials.clientId,
          client_secret: credentials.clientSecret,
          refresh_token: credentials.refreshToken!,
          grant_type: "refresh_token",
        });
        if (generation !== this.generation) return null;
        this.access = {
          token: token.access_token,
          expiresAt: Date.now() + token.expires_in * 1000,
        };
        return token.access_token;
      } catch {
        if (generation === this.generation) this.access = null;
        return null;
      } finally {
        if (this.refreshing?.generation === generation) this.refreshing = null;
      }
    })();
    this.refreshing = { generation, promise };
    return promise;
  }

  async disconnect(): Promise<ReturnType<YoutubeOAuthService["status"]>> {
    const credentials = this.read();
    this.generation++;
    this.access = null;
    this.pending.clear();
    if (!credentials) return this.status();
    this.write({
      clientId: credentials.clientId,
      clientSecret: credentials.clientSecret,
    });
    if (credentials.refreshToken) {
      try {
        await this.http(REVOKE_URL, {
          method: "POST",
          headers: { "content-type": "application/x-www-form-urlencoded" },
          body: new URLSearchParams({ token: credentials.refreshToken }),
          signal: AbortSignal.timeout(10_000),
        });
      } catch {
        // Local disconnect takes effect even when Google's revocation endpoint is offline.
      }
    }
    return this.status();
  }

  private async tokenRequest(fields: Record<string, string>): Promise<{
    access_token: string;
    refresh_token?: string;
    expires_in: number;
    scope?: string;
  }> {
    let response: Response;
    try {
      response = await this.http(TOKEN_URL, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams(fields),
        signal: AbortSignal.timeout(10_000),
      });
    } catch {
      throw new ValidationError(["Google OAuth is tijdelijk niet bereikbaar."]);
    }
    if (!response.ok)
      throw new ValidationError(["Google OAuth heeft de koppeling geweigerd."]);
    let body: unknown;
    try {
      body = await response.json();
    } catch {
      throw new ValidationError(["Google OAuth gaf een ongeldig antwoord."]);
    }
    const token = body as Record<string, unknown>;
    if (
      !token ||
      typeof token.access_token !== "string" ||
      !token.access_token ||
      typeof token.expires_in !== "number" ||
      !Number.isFinite(token.expires_in) ||
      token.expires_in <= 0 ||
      (token.refresh_token !== undefined &&
        typeof token.refresh_token !== "string") ||
      (token.scope !== undefined && typeof token.scope !== "string")
    )
      throw new ValidationError(["Google OAuth gaf een ongeldig antwoord."]);
    return token as {
      access_token: string;
      refresh_token?: string;
      expires_in: number;
      scope?: string;
    };
  }

  private read(): Credentials | null {
    try {
      const value: unknown = JSON.parse(fs.readFileSync(this.file, "utf8"));
      if (!value || typeof value !== "object" || Array.isArray(value))
        return null;
      const row = value as Record<string, unknown>;
      if (
        typeof row.clientId !== "string" ||
        typeof row.clientSecret !== "string" ||
        (row.refreshToken !== undefined && typeof row.refreshToken !== "string")
      )
        return null;
      return row as Credentials;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw new ValidationError(["YouTube OAuth-opslag is niet leesbaar."]);
    }
  }

  private write(value: Credentials): void {
    fs.mkdirSync(path.dirname(this.file), { recursive: true, mode: 0o700 });
    const temp = `${this.file}.${process.pid}.${crypto.randomBytes(8).toString("hex")}.tmp`;
    try {
      fs.writeFileSync(temp, JSON.stringify(value), {
        mode: 0o600,
        flag: "wx",
      });
      fs.chmodSync(temp, 0o600);
      const fd = fs.openSync(temp, "r");
      try {
        fs.fsyncSync(fd);
      } finally {
        fs.closeSync(fd);
      }
      fs.renameSync(temp, this.file);
      const dir = fs.openSync(path.dirname(this.file), "r");
      try {
        fs.fsyncSync(dir);
      } finally {
        fs.closeSync(dir);
      }
    } finally {
      fs.rmSync(temp, { force: true });
    }
  }
}

function safeEqual(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && crypto.timingSafeEqual(left, right);
}
