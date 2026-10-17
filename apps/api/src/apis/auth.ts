import { ApiVault } from "./api-vault.js";
import { ApiHttpClient, ApiHttpError } from "./safe-http.js";
import type { ApiIntegration, AuthScheme } from "./api.types.js";

export interface ResolvedAuth {
  headers: Record<string, string>;
  query: Record<string, string>;
}

const tokenCache = new Map<string, { token: string; expiresAt: number }>();
export const forgetTokens = (id: string) => tokenCache.delete(id);

/** Turns an auth scheme (references only) into the headers/query of one request. The values never leave this call. */
export async function resolveAuth(
  integration: Pick<ApiIntegration, "id" | "baseUrl" | "local" | "rateLimit">,
  scheme: AuthScheme,
  vault: ApiVault,
  http: ApiHttpClient,
  signal?: AbortSignal,
): Promise<ResolvedAuth> {
  const none: ResolvedAuth = { headers: {}, query: {} };
  if (scheme.type === "none") return none;
  const secret = vault.get(scheme.ref);
  if (secret === undefined)
    throw new ApiHttpError(
      "network",
      "The stored credential for this integration is missing; add it again.",
    );
  switch (scheme.type) {
    case "bearer":
      return { headers: { authorization: `Bearer ${secret}` }, query: {} };
    case "basic":
      return {
        headers: {
          authorization: `Basic ${Buffer.from(secret).toString("base64")}`,
        },
        query: {},
      };
    case "header":
      return {
        headers: {
          [scheme.name.toLowerCase()]: `${scheme.prefix ?? ""}${secret}`,
        },
        query: {},
      };
    case "query":
      return { headers: {}, query: { [scheme.name]: secret } };
    case "oauth2_client_credentials": {
      const cached = tokenCache.get(integration.id);
      if (cached && cached.expiresAt > Date.now() + 30_000)
        return {
          headers: { authorization: `Bearer ${cached.token}` },
          query: {},
        };
      let creds: { clientId?: string; clientSecret?: string } = {};
      try {
        creds = JSON.parse(secret) as typeof creds;
      } catch {
        const [clientId, ...rest] = secret.split(":");
        creds = { clientId, clientSecret: rest.join(":") };
      }
      if (!creds.clientId || !creds.clientSecret)
        throw new ApiHttpError(
          "network",
          "OAuth2 credentials need a client id and a client secret.",
        );
      if (
        new URL(scheme.tokenUrl).origin !== new URL(integration.baseUrl).origin
      )
        throw new ApiHttpError(
          "credentials_origin",
          "The OAuth2 token URL is on another host than the API; client credentials are not sent there.",
        );
      const form = new URLSearchParams({
        grant_type: "client_credentials",
        ...(scheme.scope ? { scope: scheme.scope } : {}),
      });
      const response = await http.request({
        url: scheme.tokenUrl,
        method: "POST",
        integrationId: `${integration.id}:token`,
        headers: {
          "content-type": "application/x-www-form-urlencoded",
          accept: "application/json",
        },
        body: form.toString(),
        credentials: {
          headers: {
            authorization: `Basic ${Buffer.from(`${creds.clientId}:${creds.clientSecret}`).toString("base64")}`,
          },
        },
        local: integration.local,
        rateLimit: 10,
        timeoutMs: 10_000,
        signal,
      });
      let parsed: { access_token?: string; expires_in?: number } = {};
      try {
        parsed = JSON.parse(response.body) as typeof parsed;
      } catch {
        /* handled below */
      }
      if (response.status !== 200 || !parsed.access_token)
        throw new ApiHttpError(
          "network",
          `The OAuth2 token request failed (HTTP ${response.status}); check the client id and secret.`,
        );
      tokenCache.set(integration.id, {
        token: parsed.access_token,
        expiresAt:
          Date.now() +
          Math.max(60, Math.min(parsed.expires_in ?? 3600, 86_400)) * 1000,
      });
      return {
        headers: { authorization: `Bearer ${parsed.access_token}` },
        query: {},
      };
    }
  }
}
