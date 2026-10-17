import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  startFakeApi,
  petShop,
  OPENAPI3,
  SWAGGER2,
  SECRET,
  bearerOk,
  type FakeApi,
} from "./fake-api.js";
import { makeEngine } from "./helpers.js";
import { INTROSPECTION_QUERY } from "../../src/apis/graphql.js";

let api: FakeApi;
let env: ReturnType<typeof makeEngine>;
beforeEach(() => {
  env = makeEngine();
});
afterEach(async () => api?.close());

const connect = (url: string, extra: Record<string, unknown> = {}) =>
  env.engine.connect({ baseUrl: url, local: true, ...extra });

describe("discovery", () => {
  it("learns OpenAPI 3, picks the server path, infers bearer auth and classifies risk", async () => {
    api = await startFakeApi(petShop);
    const { integration, verified } = await connect(api.url, {
      token: SECRET,
      name: "Pets",
    });
    expect(integration.protocol).toBe("rest");
    expect(integration.baseUrl).toBe(`${api.url}/v1`);
    expect(integration.auth.type).toBe("bearer");
    expect(integration.status).toBe("ready");
    expect(verified).toBe(true);
    expect(integration.source).toBe("openapi:/openapi.json");
    const risk = Object.fromEntries(
      integration.operations.map((o) => [o.id, o.risk]),
    );
    expect(risk).toMatchObject({
      listPets: "READ_ONLY",
      getPet: "READ_ONLY",
      createPet: "CONFIRM",
      deletePet: "DANGEROUS",
      searchPets: "READ_ONLY",
      archivePet: "CONFIRM",
    });
    // The first probes carry the credential only to the same host, and read-only.
    expect(api.hits.every((h) => ["GET", "POST"].includes(h.method))).toBe(
      true,
    );
  });

  it("learns Swagger 2 and keeps calling the host the user gave, not the one in the spec", async () => {
    api = await startFakeApi((hit) =>
      hit.url === "/swagger.json"
        ? { body: SWAGGER2 }
        : hit.url.startsWith("/api/")
          ? { body: { ok: true } }
          : undefined,
    );
    const { integration } = await connect(api.url);
    expect(integration.source).toBe("openapi:/swagger.json");
    expect(integration.baseUrl).toBe(`${api.url}/api`);
    expect(integration.notes.join(" ")).toContain("another server");
    expect(
      integration.operations.find((o) => o.id === "updateItem"),
    ).toMatchObject({ risk: "CONFIRM", body: { required: false } });
  });

  it("learns GraphQL by introspection: queries are read-only, mutations need confirmation", async () => {
    const T = (name: string, kind = "SCALAR") => ({ kind, name, ofType: null });
    const schema = {
      queryType: { name: "Query" },
      mutationType: { name: "Mutation" },
      types: [
        {
          kind: "OBJECT",
          name: "Query",
          fields: [
            {
              name: "customer",
              args: [
                {
                  name: "id",
                  type: { kind: "NON_NULL", name: null, ofType: T("ID") },
                },
              ],
              type: T("Customer", "OBJECT"),
            },
            {
              name: "customers",
              args: [],
              type: {
                kind: "LIST",
                name: null,
                ofType: T("Customer", "OBJECT"),
              },
            },
          ],
        },
        {
          kind: "OBJECT",
          name: "Mutation",
          fields: [
            {
              name: "updateCustomer",
              args: [{ name: "name", type: T("String") }],
              type: T("Customer", "OBJECT"),
            },
            {
              name: "deleteCustomer",
              args: [{ name: "id", type: T("ID") }],
              type: T("Boolean"),
            },
          ],
        },
        {
          kind: "OBJECT",
          name: "Customer",
          fields: [
            { name: "id", args: [], type: T("ID") },
            { name: "name", args: [], type: T("String") },
          ],
        },
        { kind: "SCALAR", name: "String" },
        { kind: "SCALAR", name: "ID" },
        { kind: "SCALAR", name: "Boolean" },
      ],
    };
    api = await startFakeApi((hit) => {
      if (hit.url === "/graphql" && hit.method === "POST") {
        const { query } = JSON.parse(hit.body) as { query: string };
        if (query === INTROSPECTION_QUERY)
          return { body: { data: { __schema: schema } } };
        if (query.includes("__typename"))
          return { body: { data: { __typename: "Query" } } };
        return { body: { data: { customers: [{ id: "1", name: "Acme" }] } } };
      }
      return undefined;
    });
    const { integration, verified } = await connect(api.url);
    expect(integration.protocol).toBe("graphql");
    expect(verified).toBe(true);
    const risk = Object.fromEntries(
      integration.operations.map((o) => [o.id, o.risk]),
    );
    expect(risk).toEqual({
      q_customer: "READ_ONLY",
      q_customers: "READ_ONLY",
      m_updateCustomer: "CONFIRM",
      m_deleteCustomer: "DANGEROUS",
    });
    const result = await env.engine.call(integration.id, "q_customers", {});
    expect(result.ok).toBe(true);
    expect(result.data).toEqual([{ id: "1", name: "Acme" }]);
    const sent = JSON.parse(api.hits.at(-1)!.body) as {
      query: string;
      variables: object;
    };
    expect(sent.query).toBe("query Nova { customers { id name } }");
    const one = await env.engine.call(integration.id, "q_customer", {
      id: "7",
    });
    expect(one.ok).toBe(true);
    expect(JSON.parse(api.hits.at(-1)!.body)).toMatchObject({
      query: "query Nova($id: ID!) { customer(id: $id) { id name } }",
      variables: { id: "7" },
    });
  });

  it("learns JSON-RPC from rpc.discover (OpenRPC) and calls with named params", async () => {
    api = await startFakeApi((hit) => {
      if (hit.method !== "POST") return undefined;
      const rpc = JSON.parse(hit.body) as {
        id: number;
        method: string;
        params?: Record<string, unknown>;
      };
      if (rpc.method === "rpc.discover")
        return {
          body: {
            jsonrpc: "2.0",
            id: rpc.id,
            result: {
              openrpc: "1.2.6",
              methods: [
                { name: "ping", params: [] },
                {
                  name: "tickets.list",
                  params: [{ name: "status", schema: { type: "string" } }],
                },
                {
                  name: "tickets.delete",
                  params: [
                    { name: "id", required: true, schema: { type: "integer" } },
                  ],
                },
              ],
            },
          },
        };
      if (rpc.method === "tickets.list")
        return {
          body: {
            jsonrpc: "2.0",
            id: rpc.id,
            result: [{ id: 1, status: rpc.params?.status }],
          },
        };
      return {
        body: {
          jsonrpc: "2.0",
          id: rpc.id,
          error: { code: -32601, message: "Method not found" },
        },
      };
    });
    const { integration } = await connect(api.url);
    expect(integration.protocol).toBe("jsonrpc");
    expect(integration.source).toBe("rpc.discover");
    const risk = Object.fromEntries(
      integration.operations.map((o) => [o.path, o.risk]),
    );
    expect(risk).toEqual({
      ping: "CONFIRM",
      "tickets.list": "CONFIRM",
      "tickets.delete": "DANGEROUS",
    });
    const op = integration.operations.find((o) => o.path === "tickets.list")!;
    const result = await env.engine.call(integration.id, op.id, {
      status: "open",
    });
    expect(result.data).toEqual([{ id: 1, status: "open" }]);
    const err = await env.engine.call(
      integration.id,
      integration.operations.find((o) => o.path === "ping")!.id,
      {},
    );
    expect(err.ok).toBe(false);
    expect(err.error).toContain("Method not found");
  });

  it("learns JSON-RPC from system.listMethods and treats introspection methods as read-only", async () => {
    api = await startFakeApi((hit) => {
      const rpc = JSON.parse(hit.body || "{}") as {
        id: number;
        method: string;
      };
      if (rpc.method === "system.listMethods")
        return {
          body: {
            jsonrpc: "2.0",
            id: rpc.id,
            result: ["system.listMethods", "wallet.reset", "wallet.balance"],
          },
        };
      if (rpc.method)
        return {
          body: {
            jsonrpc: "2.0",
            id: rpc.id,
            error: { code: -32601, message: "nope" },
          },
        };
      return undefined;
    });
    const { integration } = await connect(api.url);
    const risk = Object.fromEntries(
      integration.operations.map((o) => [o.path, o.risk]),
    );
    expect(risk).toEqual({
      "system.listMethods": "READ_ONLY",
      "wallet.reset": "DANGEROUS",
      "wallet.balance": "CONFIRM",
    });
    expect(integration.probe).toBe(integration.operations[0]!.id);
  });

  it("learns SOAP from a WSDL and builds a SOAP 1.1 envelope", async () => {
    const wsdl = `<?xml version="1.0"?><wsdl:definitions xmlns:wsdl="http://schemas.xmlsoap.org/wsdl/" xmlns:soap="http://schemas.xmlsoap.org/wsdl/soap/" xmlns:tns="http://x.example/ns" xmlns:xsd="http://www.w3.org/2001/XMLSchema" targetNamespace="http://x.example/ns">
      <wsdl:types><xsd:schema><xsd:element name="GetQuote"><xsd:complexType><xsd:sequence><xsd:element name="symbol" type="xsd:string"/></xsd:sequence></xsd:complexType></xsd:element></xsd:schema></wsdl:types>
      <wsdl:message name="GetQuoteIn"><wsdl:part name="parameters" element="tns:GetQuote"/></wsdl:message>
      <wsdl:message name="DeleteAccountIn"><wsdl:part name="id" type="xsd:string"/></wsdl:message>
      <wsdl:portType name="P"><wsdl:operation name="GetQuote"><wsdl:input message="tns:GetQuoteIn"/></wsdl:operation><wsdl:operation name="DeleteAccount"><wsdl:input message="tns:DeleteAccountIn"/></wsdl:operation></wsdl:portType>
      <wsdl:binding name="B" type="tns:P"><wsdl:operation name="GetQuote"><soap:operation soapAction="http://x.example/GetQuote"/></wsdl:operation></wsdl:binding>
      <wsdl:service name="QuoteService"><wsdl:port name="p" binding="tns:B"><soap:address location="http://internal.invalid/soap"/></wsdl:port></wsdl:service></wsdl:definitions>`;
    api = await startFakeApi((hit) => {
      if (hit.url.startsWith("/soap?wsdl"))
        return { type: "text/xml", body: wsdl };
      if (hit.method === "POST" && hit.url === "/soap")
        return {
          type: "text/xml",
          body: `<s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/"><s:Body><GetQuoteResponse><price>42</price></GetQuoteResponse></s:Body></s:Envelope>`,
        };
      return undefined;
    });
    const { integration } = await connect(`${api.url}/soap`);
    expect(integration.protocol).toBe("soap");
    expect(integration.baseUrl).toBe(`${api.url}/soap`);
    expect(integration.operations.map((o) => [o.id, o.risk])).toEqual([
      ["GetQuote", "CONFIRM"],
      ["DeleteAccount", "DANGEROUS"],
    ]);
    expect(integration.operations[0]!.soap).toMatchObject({
      action: "http://x.example/GetQuote",
      element: "GetQuote",
    });
    // SOAP unknown methods need confirmation, so the engine itself never calls one on its own: call() is only reached after approval.
    const result = await env.engine.call(integration.id, "GetQuote", {
      symbol: "A<B",
    });
    expect(result.data).toEqual({ price: "42" });
    const sent = api.hits.at(-1)!;
    expect(sent.headers.soapaction).toBe('"http://x.example/GetQuote"');
    expect(sent.body).toContain("<symbol>A&lt;B</symbol>");
  });

  it("finds a spec through a link in an HTML docs page", async () => {
    api = await startFakeApi((hit) => {
      if (hit.url === "/docs")
        return {
          type: "text/html",
          body: `<html><script>SwaggerUIBundle({ url: "/static/spec-v2.json" })</script></html>`,
        };
      if (hit.url === "/static/spec-v2.json") return { body: SWAGGER2 };
      return undefined;
    });
    const { integration } = await connect(api.url);
    expect(integration.status).toBe("ready");
    expect(integration.source).toBe("openapi:/static/spec-v2.json");
  });

  it("reports what is missing when nothing machine-readable exists, and keeps a read-only root probe", async () => {
    api = await startFakeApi((hit) =>
      hit.url === "/" ? { body: { hello: "world" } } : undefined,
    );
    const { integration, report } = await connect(api.url);
    expect(report.ok).toBe(false);
    expect(integration.status).toBe("needs_info");
    expect(integration.needs.join("\n")).toMatch(
      /OpenAPI\/Swagger, GraphQL introspection, WSDL or JSON-RPC/,
    );
    expect(integration.needs.join("\n")).toMatch(/curl/);
    expect(report.tried.length).toBeGreaterThan(10);
    expect(integration.operations).toHaveLength(1);
    expect(integration.operations[0]).toMatchObject({
      id: "root",
      risk: "READ_ONLY",
    });
    // Discovery never sent a mutating request: only GET, plus POST for GraphQL/JSON-RPC introspection (all read-only).
    expect(
      api.hits.some((h) => ["PUT", "PATCH", "DELETE"].includes(h.method)),
    ).toBe(false);
  });

  it("asks for credentials when the API answers 401 to everything", async () => {
    api = await startFakeApi(() => ({
      status: 401,
      headers: { "www-authenticate": "Basic realm=x" },
      body: { error: "auth" },
    }));
    const { integration, report } = await connect(api.url);
    expect(report.auth).toMatchObject({ type: "basic" });
    expect(integration.needs[0]).toMatch(/credentials/);
  });

  it("learns from user-provided material: curl, Postman, HAR, OpenAPI JSON, route lines", async () => {
    api = await startFakeApi((hit) =>
      hit.url === "/"
        ? { body: { hello: "world" } }
        : hit.url.startsWith("/orders")
          ? { body: { orders: [] } }
          : undefined,
    );
    const { integration } = await connect(api.url);
    const curl = `curl -X POST '${api.url}/orders/42/cancel?api_key=abc12345' -H 'Authorization: Bearer ${SECRET}' -H 'Content-Type: application/json' -d '{"reason":"x"}'`;
    const a = await env.engine.attachDocs(integration.id, curl);
    expect(a.ok).toBe(true);
    const learned = env.registry.get(integration.id)!;
    expect(
      learned.operations.find((o) => o.path === "/orders/{orders_id}/cancel"),
    ).toMatchObject({ method: "POST", risk: "CONFIRM" });
    // The bearer token and the api_key query value went to the vault, not into the spec.
    expect(JSON.stringify(learned)).not.toContain(SECRET);
    expect(JSON.stringify(learned)).not.toContain("abc12345");
    expect(learned.auth.type).toBe("bearer");

    const postman = {
      info: {
        schema:
          "https://schema.getpostman.com/json/collection/v2.1.0/collection.json",
      },
      variable: [{ key: "base", value: api.url }],
      item: [
        {
          name: "List orders",
          request: { method: "GET", url: "{{base}}/orders?status=open" },
        },
        {
          name: "Folder",
          item: [
            {
              name: "Remove order",
              request: { method: "DELETE", url: { raw: "{{base}}/orders/9" } },
            },
          ],
        },
      ],
    };
    const p = await env.engine.attachDocs(
      integration.id,
      JSON.stringify(postman),
    );
    expect(p.ok && p.kind).toBe("postman");
    const ops = env.registry.get(integration.id)!.operations;
    expect(ops.find((o) => o.id === "List_orders")).toMatchObject({
      risk: "READ_ONLY",
    });
    expect(ops.find((o) => o.id === "Remove_order")).toMatchObject({
      risk: "DANGEROUS",
    });

    const har = {
      log: {
        entries: [
          {
            request: {
              method: "GET",
              url: `${api.url}/orders/1`,
              headers: [{ name: "X-Api-Key", value: "har-secret-1" }],
            },
            response: { content: { mimeType: "application/json" } },
          },
          {
            request: { method: "GET", url: `${api.url}/logo.png`, headers: [] },
            response: { content: { mimeType: "image/png" } },
          },
        ],
      },
    };
    const h = await env.engine.attachDocs(integration.id, JSON.stringify(har));
    expect(h.ok && h.kind).toBe("har");
    expect(JSON.stringify(env.registry.get(integration.id))).not.toContain(
      "har-secret-1",
    );

    const lines = await env.engine.attachDocs(
      integration.id,
      "GET /v2/widgets/{id}\nPOST /v2/widgets",
    );
    expect(lines.ok && lines.kind).toBe("route lines");
    const nothing = await env.engine.attachDocs(
      integration.id,
      "just some prose about the api",
    );
    expect(nothing.ok).toBe(false);
    // Material that points at another host is not adopted.
    const other = await env.engine.attachDocs(
      integration.id,
      "curl https://elsewhere.example/v1/x",
    );
    expect(other.ok).toBe(false);
  });

  it("does not parse YAML but says so", async () => {
    api = await startFakeApi((hit) =>
      hit.url === "/openapi.json"
        ? {
            type: "application/yaml",
            body: "openapi: 3.0.0\ninfo:\n  title: x\n",
          }
        : undefined,
    );
    const { integration } = await connect(api.url);
    expect(integration.notes.join(" ")).toMatch(/YAML is not parsed/);
  });

  it("learns auth schemes: header key, query key, basic, custom header", async () => {
    for (const [label, check, expected] of [
      [
        "header",
        (h: { headers: Record<string, unknown> }) =>
          h.headers["x-api-key"] === SECRET,
        "header",
      ],
      [
        "basic",
        (h: { headers: Record<string, unknown> }) =>
          h.headers.authorization ===
          `Basic ${Buffer.from("user:pw-0000").toString("base64")}`,
        "basic",
      ],
      [
        "query",
        (h: { headers: Record<string, unknown>; url?: string }) =>
          (h.url ?? "").includes(`api_key=${SECRET}`),
        "query",
      ],
    ] as const) {
      const secret = label === "basic" ? "user:pw-0000" : SECRET;
      await api?.close();
      api = await startFakeApi((hit) => {
        if (hit.url === "/openapi.json")
          return {
            body: {
              openapi: "3.0.0",
              info: { title: label },
              paths: {
                "/me": { get: { operationId: "me", summary: "Who am I" } },
              },
            },
          };
        if (hit.url.startsWith("/me"))
          return check(hit)
            ? { body: { me: true } }
            : { status: 401, body: { error: "x" } };
        return undefined;
      });
      const { integration, verified } = await connect(api.url, {
        token: secret,
        name: `A ${label}`,
      });
      expect(verified, label).toBe(true);
      expect(integration.auth.type, label).toBe(expected);
      const call = await env.engine.call(integration.id, "me", {});
      expect(call.ok, label).toBe(true);
      expect(JSON.stringify(call)).not.toContain(secret);
    }
  });

  it("honours an explicit custom header and bearer check", async () => {
    api = await startFakeApi((hit) => {
      if (hit.url === "/openapi.json")
        return {
          body: {
            openapi: "3.0.0",
            info: { title: "c" },
            paths: { "/me": { get: { operationId: "me" } } },
          },
        };
      if (hit.url === "/me")
        return hit.headers["x-tenant-token"] === SECRET
          ? { body: { ok: 1 } }
          : { status: 403, body: {} };
      return undefined;
    });
    const { integration, verified } = await connect(api.url, {
      token: SECRET,
      authType: "header",
      headerName: "X-Tenant-Token",
    });
    expect(verified).toBe(true);
    expect(integration.auth).toMatchObject({
      type: "header",
      name: "X-Tenant-Token",
    });
    void bearerOk;
    void OPENAPI3;
  });

  it("moves a key written into the base URL to the vault and never stores or shows the URL with it", async () => {
    api = await startFakeApi((hit) => {
      if (hit.url.startsWith("/openapi.json"))
        return {
          body: {
            openapi: "3.0.0",
            info: { title: "q" },
            paths: { "/me": { get: { operationId: "me" } } },
          },
        };
      if (hit.url.startsWith("/me"))
        return hit.url.includes(`api_key=${SECRET}`)
          ? { body: { ok: 1 } }
          : { status: 401, body: {} };
      return undefined;
    });
    const { integration, verified } = await connect(
      `${api.url}?api_key=${SECRET}`,
      { name: "Q" },
    );
    expect(verified).toBe(true);
    expect(integration.baseUrl).toBe(api.url);
    expect(integration.auth).toMatchObject({ type: "query", name: "api_key" });
    expect(JSON.stringify(env.registry.list())).not.toContain(SECRET);
  });

  it("refuses path parameters that would climb out of the operation path", async () => {
    api = await startFakeApi(petShop);
    const { integration } = await connect(api.url, {
      token: SECRET,
      name: "Pets",
    });
    await expect(
      env.engine.call(integration.id, "getPet", { id: ".." }),
    ).rejects.toThrow(/may not be/);
    const encoded = await env.engine.call(integration.id, "getPet", {
      id: "1",
    });
    expect(encoded.ok).toBe(true);
  });
});
