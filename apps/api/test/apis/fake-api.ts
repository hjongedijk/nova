import http from "node:http";
import type { AddressInfo } from "node:net";

export interface Hit {
  method: string;
  url: string;
  headers: http.IncomingHttpHeaders;
  body: string;
}
export interface Reply {
  status?: number;
  type?: string;
  body?: unknown;
  headers?: Record<string, string>;
}
export type Handler = (hit: Hit) => Reply | undefined;

export interface FakeApi {
  url: string;
  port: number;
  hits: Hit[];
  /** Replace the handler while the server runs. */
  handle: (handler: Handler) => void;
  close: () => Promise<void>;
}

export const SECRET = "sk-test-0000";

export async function startFakeApi(initial: Handler): Promise<FakeApi> {
  let handler = initial;
  const hits: Hit[] = [];
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      const hit = {
        method: req.method ?? "GET",
        url: req.url ?? "/",
        headers: req.headers,
        body: Buffer.concat(chunks).toString("utf8"),
      };
      hits.push(hit);
      const reply = handler(hit) ?? {
        status: 404,
        body: { error: "not found" },
      };
      const type = reply.type ?? "application/json";
      const payload =
        typeof reply.body === "string"
          ? reply.body
          : JSON.stringify(reply.body ?? {});
      res.writeHead(reply.status ?? 200, {
        "content-type": type,
        ...(reply.headers ?? {}),
      });
      res.end(payload);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;
  return {
    url: `http://127.0.0.1:${port}`,
    port,
    hits,
    handle: (next) => {
      handler = next;
    },
    close: () => new Promise((resolve) => server.close(() => resolve())),
  };
}

export const bearerOk = (hit: Hit, token = SECRET) =>
  hit.headers.authorization === `Bearer ${token}`;

export const OPENAPI3 = {
  openapi: "3.0.3",
  info: { title: "Pet Shop", version: "1.0.0" },
  servers: [{ url: "/v1" }],
  components: {
    securitySchemes: { bearerAuth: { type: "http", scheme: "bearer" } },
  },
  security: [{ bearerAuth: [] }],
  paths: {
    "/pets": {
      get: {
        operationId: "listPets",
        summary: "List pets",
        parameters: [
          { name: "limit", in: "query", schema: { type: "integer" } },
        ],
      },
      post: {
        operationId: "createPet",
        summary: "Create a pet",
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: {
                type: "object",
                properties: { name: { type: "string" } },
                required: ["name"],
              },
            },
          },
        },
      },
    },
    "/pets/{id}": {
      get: {
        operationId: "getPet",
        summary: "Get one pet",
        parameters: [
          {
            name: "id",
            in: "path",
            required: true,
            schema: { type: "string" },
          },
        ],
      },
      delete: {
        operationId: "deletePet",
        summary: "Delete a pet",
        parameters: [
          {
            name: "id",
            in: "path",
            required: true,
            schema: { type: "string" },
          },
        ],
      },
    },
    "/pets/search": {
      post: {
        operationId: "searchPets",
        summary: "Search pets",
        "x-readonly": true,
        requestBody: {
          content: {
            "application/json": {
              schema: { type: "object", properties: { q: { type: "string" } } },
            },
          },
        },
      },
    },
    "/pets/{id}/archive": {
      post: {
        operationId: "archivePet",
        summary: "Archive",
        parameters: [
          {
            name: "id",
            in: "path",
            required: true,
            schema: { type: "string" },
          },
        ],
      },
    },
  },
};

export const SWAGGER2 = {
  swagger: "2.0",
  info: { title: "Old Shop" },
  host: "ignored.example.com",
  basePath: "/api",
  securityDefinitions: {
    key: { type: "apiKey", in: "header", name: "X-Api-Token" },
  },
  paths: {
    "/items": {
      get: {
        operationId: "listItems",
        summary: "Items",
        parameters: [{ name: "page", in: "query", type: "integer" }],
      },
    },
    "/items/{id}": {
      put: {
        operationId: "updateItem",
        parameters: [
          { name: "id", in: "path", required: true, type: "string" },
          {
            name: "body",
            in: "body",
            schema: {
              type: "object",
              properties: { title: { type: "string" } },
            },
          },
        ],
      },
    },
  },
};

/** A server that serves OpenAPI 3 under /v1 and checks the bearer token. */
export const petShop: Handler = (hit) => {
  const path = hit.url.split("?")[0]!;
  if (path === "/openapi.json") return { body: OPENAPI3 };
  if (!path.startsWith("/v1/")) return undefined;
  if (!bearerOk(hit))
    return {
      status: 401,
      headers: { "www-authenticate": 'Bearer realm="pets"' },
      body: { error: "unauthorized" },
    };
  if (hit.method === "GET" && path === "/v1/pets")
    return { body: [{ id: "1", name: "Rex" }] };
  if (hit.method === "GET" && path === "/v1/pets/1")
    return { body: { id: "1", name: "Rex" } };
  if (hit.method === "POST" && path === "/v1/pets")
    return { status: 201, body: { id: "2" } };
  if (hit.method === "POST" && path === "/v1/pets/search")
    return { body: { results: [] } };
  if (hit.method === "DELETE") return { status: 204, body: "" };
  return undefined;
};
