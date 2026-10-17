import type {
  ApiOperation,
  ApiProtocol,
  AuthHint,
  DiscoveryReport,
  ProbeLog,
} from "./api.types.js";
import type { ResolvedAuth } from "./auth.js";
import {
  INTROSPECTION_QUERY,
  looksLikeIntrospection,
  parseGraphqlIntrospection,
} from "./graphql.js";
import { looksLikeJsonRpc, parseMethodList, parseOpenRpc } from "./jsonrpc.js";
import { looksLikeOpenApi, parseOpenApi } from "./openapi.js";
import {
  ApiHttpClient,
  ApiHttpError,
  type ApiHttpResponse,
} from "./safe-http.js";
import { newOperation } from "./spec-util.js";
import { looksLikeWsdl, parseWsdl } from "./wsdl.js";
import { classify } from "./risk.js";

const SPEC_PATHS = [
  "/openapi.json",
  "/swagger.json",
  "/v3/api-docs",
  "/v2/api-docs",
  "/api-docs",
  "/swagger/v1/swagger.json",
  "/.well-known/openapi.json",
  "/.well-known/openapi",
  "/.well-known/api-catalog",
];
const DOC_PAGES = ["/docs", "/redoc", "/swagger-ui/", "/"];

export interface DiscoverOptions {
  baseUrl: string;
  local: boolean;
  integrationId: string;
  auth?: ResolvedAuth;
  /** A documentation or spec URL the user gave. */
  docsUrl?: string;
  http: ApiHttpClient;
  signal?: AbortSignal;
}

export function findSpecLinks(html: string, pageUrl: URL): string[] {
  const found = new Set<string>();
  const patterns = [
    /\burl\s*:\s*["']([^"']+)["']/g,
    /spec-url=["']([^"']+)["']/g,
    /["'(]([^"'()\s]*(?:openapi|swagger|api-docs)[^"'()\s]*\.(?:json|ya?ml))["')]/gi,
    /href=["']([^"']*(?:openapi|swagger|api-docs)[^"']*)["']/gi,
  ];
  for (const pattern of patterns)
    for (const match of html.matchAll(pattern)) {
      try {
        const url = new URL(match[1]!, pageUrl);
        if (
          url.origin === pageUrl.origin &&
          /openapi|swagger|api-docs|\.json$/i.test(url.pathname)
        )
          found.add(url.toString());
      } catch {
        /* ignore */
      }
    }
  return [...found].slice(0, 4);
}

function authHintFrom(responses: ApiHttpResponse[]): AuthHint {
  for (const r of responses) {
    if (r.status !== 401 && r.status !== 403) continue;
    const challenge = r.headers["www-authenticate"] ?? "";
    if (/^\s*bearer/i.test(challenge))
      return {
        type: "bearer",
        note: "WWW-Authenticate asks for a bearer token",
      };
    if (/^\s*basic/i.test(challenge))
      return {
        type: "basic",
        note: "WWW-Authenticate asks for basic authentication",
      };
    const header =
      /x-[a-z-]*(?:api[_-]?key|token|auth)[a-z-]*/i.exec(r.body) ??
      /\b(api[_-]?key)\b/i.exec(r.body);
    if (header)
      return {
        type: "header",
        name: /^x-/i.test(header[0]) ? header[0] : "X-API-Key",
        note: "the error text mentions an API key header",
      };
    return {
      type: "unknown",
      note: `HTTP ${r.status} without a usable WWW-Authenticate challenge`,
    };
  }
  return { type: "none" };
}

export async function discover(
  options: DiscoverOptions,
): Promise<DiscoveryReport> {
  const base = new URL(options.baseUrl);
  const prefix = base.pathname.replace(/\/$/, "");
  const tried: ProbeLog[] = [];
  const notes: string[] = [];
  const denied: ApiHttpResponse[] = [];
  let probes = 0;

  const request = async (
    probe: string,
    url: string,
    method = "GET",
    body?: unknown,
  ): Promise<ApiHttpResponse | null> => {
    if (probes++ > 40) return null;
    const sameOrigin = new URL(url).origin === base.origin;
    try {
      const response = await options.http.request({
        url,
        method,
        integrationId: options.integrationId,
        headers:
          body !== undefined ? { "content-type": "application/json" } : {},
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
        credentials: sameOrigin && options.auth ? options.auth : undefined,
        local: options.local,
        timeoutMs: 8_000,
        rateLimit: 200,
        signal: options.signal,
      });
      if (response.status === 401 || response.status === 403)
        denied.push(response);
      tried.push({
        probe,
        url: response.url,
        status: response.status,
        outcome: response.status < 300 ? "answered" : `HTTP ${response.status}`,
      });
      return response;
    } catch (error) {
      tried.push({
        probe,
        url,
        outcome:
          error instanceof ApiHttpError
            ? `${error.code}: ${error.message}`.slice(0, 160)
            : "failed",
      });
      if (
        error instanceof ApiHttpError &&
        (error.code === "blocked_address" ||
          error.code === "blocked_host" ||
          error.code === "blocked_scheme")
      )
        throw error;
      return null;
    }
  };
  const json = (r: ApiHttpResponse | null): unknown => {
    if (!r || r.status >= 300) return undefined;
    try {
      return JSON.parse(r.body);
    } catch {
      return undefined;
    }
  };
  const finish = (
    partial: Partial<DiscoveryReport> & { operations: ApiOperation[] },
  ): DiscoveryReport => ({
    ok: partial.operations.length > 0,
    tried,
    needs: [],
    notes,
    auth: authHintFrom(denied),
    ...partial,
  });

  const tryOpenApi = async (
    url: string,
    label: string,
  ): Promise<DiscoveryReport | null> => {
    const response = await request(label, url);
    if (!response || response.status >= 300) return null;
    if (
      /^\s*(?:openapi|swagger)\s*:/m.test(response.body) &&
      !response.body.trimStart().startsWith("{")
    ) {
      notes.push(
        `Found a YAML spec at ${new URL(url).pathname}. YAML is not parsed by NOVA; convert it to JSON and attach it with api_attach_docs.`,
      );
      return null;
    }
    let doc = json(response);
    if (
      doc &&
      typeof doc === "object" &&
      Array.isArray((doc as { linkset?: unknown }).linkset)
    ) {
      for (const link of (
        doc as { linkset: { "service-desc"?: { href?: string }[] }[] }
      ).linkset
        .flatMap((l) => l["service-desc"] ?? [])
        .slice(0, 2)) {
        try {
          const target = new URL(String(link.href), url);
          if (target.origin === base.origin) {
            const inner = await request(
              "api-catalog service-desc",
              target.toString(),
            );
            doc = json(inner) ?? doc;
          }
        } catch {
          /* ignore */
        }
      }
    }
    if (!looksLikeOpenApi(doc)) return null;
    const parsed = parseOpenApi(doc, base);
    notes.push(...parsed.notes);
    return finish({
      protocol: "rest",
      baseUrl:
        parsed.serverBase ??
        (prefix ? base.toString().replace(/\/$/, "") : base.origin),
      title: parsed.title,
      source: `openapi:${new URL(url).pathname}`,
      operations: parsed.operations,
      auth:
        parsed.auth.type === "unknown" || parsed.auth.type === "none"
          ? authHintFrom(denied)
          : parsed.auth,
    });
  };

  // 0. A URL the user gave that is itself a spec / wsdl / documentation page.
  const given =
    options.docsUrl ??
    (/\.(json|wsdl)$|[?&]wsdl\b/i.test(base.pathname + base.search)
      ? options.baseUrl
      : undefined);
  if (given) {
    const direct = await tryOpenApi(given, "given spec URL");
    if (direct) return direct;
    const page = await request("given documentation URL", given);
    if (page && looksLikeWsdl(page.body)) {
      const wsdl = parseWsdl(page.body);
      if (wsdl?.operations.length)
        return finish({
          protocol: "soap",
          baseUrl: endpointFor(wsdl.endpoint, base),
          title: wsdl.title,
          source: "wsdl",
          operations: wsdl.operations,
        });
    }
    if (page && /html/i.test(page.contentType))
      for (const link of findSpecLinks(page.body, new URL(given))) {
        const found = await tryOpenApi(link, "link in given documentation");
        if (found) return found;
      }
  }

  // 1. OpenAPI / Swagger at well-known places (under the given path first, then the host root).
  const roots = [...new Set([prefix, ""])];
  for (const root of roots)
    for (const path of SPEC_PATHS) {
      const found = await tryOpenApi(
        `${base.origin}${root}${path}`,
        `openapi ${path}`,
      );
      if (found) return found;
    }

  // 2. GraphQL introspection (a read-only query).
  const gqlUrls = /\/graphql\/?$|\/gql\/?$/i.test(prefix)
    ? [base.toString()]
    : [
        `${base.origin}${prefix}/graphql`,
        ...(prefix ? [`${base.origin}/graphql`] : []),
      ];
  for (const url of gqlUrls) {
    const response = await request("graphql introspection", url, "POST", {
      query: INTROSPECTION_QUERY,
    });
    const doc = json(response);
    if (doc && looksLikeIntrospection(doc)) {
      const parsed = parseGraphqlIntrospection(doc);
      notes.push(...parsed.notes);
      return finish({
        protocol: "graphql",
        baseUrl: url,
        title: "GraphQL API",
        source: "graphql introspection",
        operations: parsed.operations,
      });
    }
    if (
      doc &&
      (doc as { errors?: { message?: string }[] }).errors?.some((e) =>
        /introspection/i.test(String(e.message)),
      )
    )
      notes.push(
        "The GraphQL endpoint answered but has introspection disabled; attach the schema (introspection JSON) or example queries with api_attach_docs.",
      );
  }

  // 3. SOAP WSDL.
  for (const suffix of ["?wsdl", "?WSDL"]) {
    const response = await request(
      "wsdl",
      `${base.origin}${base.pathname}${suffix}`,
    );
    if (response && response.status < 300 && looksLikeWsdl(response.body)) {
      const wsdl = parseWsdl(response.body);
      if (wsdl?.operations.length) {
        notes.push(...wsdl.notes);
        return finish({
          protocol: "soap",
          baseUrl: endpointFor(wsdl.endpoint, base),
          title: wsdl.title,
          source: "wsdl",
          operations: wsdl.operations,
        });
      }
    }
  }

  // 4. JSON-RPC.
  let rpcEndpoint: string | undefined;
  for (const url of [
    ...new Set([
      base.toString(),
      `${base.origin}${prefix}/rpc`,
      `${base.origin}${prefix}/jsonrpc`,
    ]),
  ]) {
    for (const method of ["rpc.discover", "system.listMethods"]) {
      const doc = json(
        await request(`jsonrpc ${method}`, url, "POST", {
          jsonrpc: "2.0",
          id: 1,
          method,
        }),
      );
      if (!doc || !looksLikeJsonRpc(doc)) continue;
      rpcEndpoint = url;
      const operations =
        method === "rpc.discover" ? parseOpenRpc(doc) : parseMethodList(doc);
      if (operations.length)
        return finish({
          protocol: "jsonrpc",
          baseUrl: url,
          title: "JSON-RPC API",
          source: method,
          operations,
        });
    }
  }
  if (rpcEndpoint)
    return finish({
      protocol: "jsonrpc",
      baseUrl: rpcEndpoint,
      operations: [],
      source: "jsonrpc (no method list)",
      needs: [
        "The endpoint speaks JSON-RPC but does not publish a method list. Provide the method names and parameters (documentation text or example requests).",
      ],
    });

  // 5. HTML documentation pages that point to a spec.
  for (const root of roots)
    for (const page of DOC_PAGES) {
      const url = `${base.origin}${root}${page}`;
      const response = await request(`docs page ${page}`, url);
      if (
        !response ||
        response.status >= 300 ||
        !/html|json/i.test(response.contentType)
      )
        continue;
      for (const link of findSpecLinks(response.body, new URL(url))) {
        const found = await tryOpenApi(link, "spec link in docs page");
        if (found) return found;
      }
    }

  // 6. Nothing machine-readable.
  const root = await request("root request", base.toString());
  const auth = authHintFrom(denied);
  const needs: string[] = [];
  const operations: ApiOperation[] = [];
  if (denied.length && !options.auth)
    needs.push(
      "The API asks for credentials (HTTP 401/403) before it shows anything: give a token or API key so discovery can continue.",
    );
  else if (denied.length)
    needs.push(
      "The credentials were rejected (HTTP 401/403): check the token and how it must be sent (bearer, header name, basic).",
    );
  if (root && root.status < 300) {
    operations.push(
      newOperation({
        id: "root",
        summary: "GET the base URL (the only thing known about this API)",
        method: "GET",
        path: "",
        params: [],
        risk: classify({ protocol: "rest", method: "GET", name: "root" }),
        hints: ["no machine-readable description found"],
      }),
    );
  }
  needs.push(
    "No OpenAPI/Swagger, GraphQL introspection, WSDL or JSON-RPC method list was found. Any of these will let NOVA learn the API:",
    "- the URL of the API documentation or of an OpenAPI/Swagger JSON file",
    "- the spec itself, pasted or as a file (OpenAPI/Swagger JSON, Postman collection v2.1, HAR, WSDL)",
    "- one or more example requests as a curl command (token may be included; it is moved to the vault)",
  );
  return {
    ok: false,
    protocol: "rest" as ApiProtocol,
    baseUrl: base.toString().replace(/\/$/, ""),
    source: "none",
    operations,
    auth,
    tried,
    needs,
    notes,
  };
}

function endpointFor(endpoint: string | undefined, base: URL): string {
  if (endpoint) {
    try {
      const url = new URL(endpoint);
      if (url.origin === base.origin) return url.toString();
      // WSDL often lists an internal host; keep calling the host the user gave.
      return `${base.origin}${url.pathname}`;
    } catch {
      /* fall through */
    }
  }
  return `${base.origin}${base.pathname}`;
}
