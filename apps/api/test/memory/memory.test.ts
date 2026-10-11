import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { NovaConfig } from "../../src/core/config/nova-config.js";
import { MemorySource } from "../../src/memory/memory.source.js";
import { SemanticMemoryService } from "../../src/memory/semantic-memory.service.js";
import { memoryCandidate } from "../../src/memory/semantic/candidate.js";
import { OmniRouteMemory } from "../../src/memory/semantic/omniroute.backend.js";
import {
  QdrantMemory,
  RemoteEmbeddings,
} from "../../src/memory/semantic/qdrant.backend.js";
import { OmniRouteManagement } from "../../src/routing/omniroute-management.service.js";
import { RoutingService } from "../../src/routing/routing.service.js";
import type { ToolSource } from "../../src/tools/tool.types.js";
import { listen } from "../integrations/helpers.js";

type Point = {
  id: string;
  vector: number[];
  payload: Record<string, unknown>;
};

/** A fake Qdrant plus an embedding gateway: "volume" texts point one way, everything else another. */
async function fakeServices() {
  const points = new Map<string, Point>();
  let collection = false;
  let outage = false;
  const server = await listen((seen, send) => {
    const path = (seen.url ?? "").split("?")[0]!;
    const body = seen.body ? JSON.parse(seen.body) : {};
    if (path === "/v1/embeddings")
      return send(200, {
        data: [
          { embedding: /volume/i.test(body.input) ? [1, 0, 0] : [0, 1, 0] },
        ],
      });
    if (!path.startsWith("/collections/")) return send(200, { ok: true });
    if (outage) return send(503, {});
    if (/^\/collections\/[^/]+$/.test(path)) {
      if (seen.method === "PUT") {
        collection = true;
        return send(200, { result: true });
      }
      return send(collection ? 200 : 404, {
        result: {
          config: { params: { vectors: { size: 3, distance: "Cosine" } } },
        },
      });
    }
    if (path.endsWith("/index")) return send(200, { result: true });
    if (path.endsWith("/points") && seen.method === "PUT") {
      for (const point of body.points) points.set(point.id, point);
      return send(200, { result: true });
    }
    if (path.endsWith("/points/query"))
      return send(200, {
        result: {
          points: [...points.values()]
            .filter((point) => !point.payload.archived)
            .map((point) => ({
              ...point,
              score: point.vector.reduce(
                (sum, v, i) => sum + v * body.query[i],
                0,
              ),
            }))
            .sort((a, b) => b.score - a.score)
            .slice(0, body.limit),
        },
      });
    if (path.endsWith("/points/scroll"))
      return send(200, {
        result: {
          points: [...points.values()].slice(0, body.limit),
          next_page_offset: null,
        },
      });
    if (path.endsWith("/points/payload")) {
      for (const id of body.points)
        Object.assign(points.get(id)?.payload ?? {}, body.payload);
      return send(200, { result: true });
    }
    if (path.endsWith("/points/delete")) {
      for (const id of body.points) points.delete(id);
      return send(200, { result: true });
    }
    send(200, { ok: true });
  });
  return {
    server,
    points,
    setOutage: (value: boolean) => (outage = value),
  };
}

describe("QdrantMemory", () => {
  let fixture: Awaited<ReturnType<typeof fakeServices>>;
  let embeddings: RemoteEmbeddings;
  let memory: QdrantMemory;
  beforeEach(async () => {
    fixture = await fakeServices();
    embeddings = new RemoteEmbeddings({
      url: `${fixture.server.url}/v1`,
      key: "fixture-key",
      model: "free-embed",
      dimensions: 3,
      freeVerified: true,
      assertFreeModel: () => {},
    });
    memory = new QdrantMemory({
      url: fixture.server.url,
      collection: "jarvis_test",
      apiKey: "qdrant-key",
      embeddings,
    });
  });
  afterEach(() => fixture.server.close());

  it("rejects secrets, transient states and chatter as memory candidates", () => {
    for (const text of [
      "hello",
      "turn on the lights",
      "remember it is on right now",
      "remember my password is abcdef",
      "remember token: abc",
      "remember Bearer abcdef",
    ])
      expect(memoryCandidate(text)).toBeNull();
  });

  it("stores relationship memories only on explicit request and keeps their links", () => {
    expect(memoryCandidate("Mijn partner heet Alex")).toBeNull();
    expect(memoryCandidate("Onthoud dat mijn partner Alex heet")?.type).toBe(
      "PERSON",
    );
    expect(
      memoryCandidate("Onthoud dat mijn hond Nova heet", {
        related_entity: "Nova",
      }),
    ).toMatchObject({
      type: "PET",
      related_entity: "Nova",
      source: "explicit_user",
    });
    expect(
      memoryCandidate("Onthoud dat het project Nova eind oktober klaar is", {
        type: "PROJECT",
      })?.type,
    ).toBe("PROJECT");
    expect(
      memoryCandidate("Onthoud elke ochtend een korte planning", {
        type: "HABIT",
      })?.type,
    ).toBe("HABIT");
    expect(
      memoryCandidate("Onthoud dat mijn partner Alex heet", {
        related_entity: "Bearer secret-token",
      }),
    ).toBeNull();
  });

  it("writes, merges duplicates, searches, lists, deletes and archives", async () => {
    const stored = await memory.write(
      "Onthoud mijn volume voorkeur is 20 procent",
    );
    expect(stored.ok).toBe(true);
    expect(stored.memory?.type).toBe("PREFERENCE");
    const duplicate = await memory.write(
      "Onthoud mijn volume voorkeur is 20 procent",
    );
    expect(duplicate.id).toBe(stored.id);
    expect(duplicate.operation).toBe("merged");
    const retrieved = await memory.search("volume");
    expect(retrieved[0]?.id).toBe(stored.id);
    expect(fixture.points.get(stored.id!)?.payload.access_count).toBe(1);
    expect((await memory.list()).memories).toHaveLength(1);
    expect((await memory.remove(stored.id!)).ok).toBe(true);
    expect(fixture.points.size).toBe(0);

    const stale = await memory.write("Remember my office is upstairs", {
      importance: 0.2,
    });
    fixture.points.get(stale.id!)!.payload.updated_at = "2020-01-01";
    expect((await memory.maintain()).archived).toBe(1);
    expect(await memory.search("office")).toHaveLength(0);
    const requests = fixture.server.requests;
    expect(
      requests.every(
        (r) =>
          r.url?.startsWith("/v1/") || r.headers["api-key"] === "qdrant-key",
      ),
    ).toBe(true);
  });

  it("refuses an invalid ID and an invalid collection name", async () => {
    await expect(memory.remove("../x")).rejects.toThrow("Invalid memory ID");
    expect(
      () =>
        new QdrantMemory({ url: "http://x", collection: "a/b", embeddings }),
    ).toThrow("Invalid memory collection");
  });

  it("degrades without verified embeddings or when Qdrant is down", async () => {
    embeddings.freeVerified = false;
    expect(await memory.search("office")).toEqual([]);
    expect((await memory.write("Remember my office is upstairs")).ok).toBe(
      false,
    );
    expect((await memory.list()).unavailable).toMatch(/onboarding/);
    embeddings.freeVerified = true;
    fixture.setOutage(true);
    expect(await memory.search("office")).toEqual([]);
    expect(memory.lastError).toMatch(/Qdrant unavailable \(503\)/);
    const health = await memory.health();
    expect(health).toMatchObject({ online: true, ready: true });
  });

  it("rechecks the verified free model before every embedding request", async () => {
    let sent = false;
    const blocked = new RemoteEmbeddings({
      url: "https://omniroute.example/v1",
      key: "fixture-key",
      model: "provider/free-embed",
      dimensions: 3,
      freeVerified: true,
      assertFreeModel: () => {
        throw new Error("route policy changed");
      },
      fetcher: async () => {
        sent = true;
        return new Response("{}", { status: 200 });
      },
    });
    await expect(blocked.embed("private text")).rejects.toThrow(
      "route policy changed",
    );
    expect(sent).toBe(false);
  });

  it("redacts credential-shaped text before sending it for embeddings", async () => {
    let sent = "";
    const embeddings = new RemoteEmbeddings({
      url: "https://omniroute.example/v1",
      key: "fixture-key",
      model: "provider/free-embed",
      dimensions: 3,
      freeVerified: true,
      assertFreeModel: () => {},
      fetcher: async (_url, init) => {
        sent = String(JSON.parse(String(init?.body)).input);
        return new Response(
          JSON.stringify({ data: [{ embedding: [1, 0, 0] }] }),
          { status: 200 },
        );
      },
    });
    await embeddings.embed("password: do-not-send-embedding-secret");
    expect(sent).toBe("password: [redacted]");
    expect(sent).not.toContain("do-not-send-embedding-secret");
  });

  it("rejects embeddings with the wrong dimensions", async () => {
    embeddings.dimensions = 5;
    const result = await memory.write("Remember my office is upstairs");
    expect(result).toMatchObject({ ok: false });
    expect(result.error).toMatch(/dimensions/);
  });

  it("reindexes off-path, verifies the new collection, and durably switches on success", async () => {
    const id = "11111111-1111-4111-8111-111111111111";
    const collections = new Map<string, Map<string, Point>>([
      [
        "legacy_memory",
        new Map([
          [
            id,
            {
              id,
              vector: [1, 0, 0],
              payload: {
                id,
                text: "Remember my office is upstairs",
                type: "FACT",
                importance: 0.8,
                archived: false,
                embedding_model: "old-model",
              },
            },
          ],
        ]),
      ],
    ]);
    let failEmbeddings = true;
    const server = await listen((seen, send) => {
      const pathname = (seen.url ?? "").split("?")[0]!;
      if (pathname === "/v1/embeddings" && failEmbeddings) return send(503, {});
      if (pathname === "/v1/embeddings")
        return send(200, { data: [{ embedding: [0, 1, 0] }] });
      const [, , collectionName, ...tail] = pathname.split("/");
      const points = collections.get(collectionName!);
      if (tail.length === 0) {
        if (seen.method === "DELETE") {
          collections.delete(collectionName!);
          return send(200, { result: true });
        }
        if (seen.method === "PUT") {
          collections.set(collectionName!, new Map());
          return send(200, { result: true });
        }
        return send(
          points ? 200 : 404,
          points
            ? {
                result: {
                  points_count: points.size,
                  config: {
                    params: { vectors: { size: 3, distance: "Cosine" } },
                  },
                },
              }
            : { status: { error: "not found" } },
        );
      }
      if (tail[0] === "index") return send(200, { result: true });
      if (tail[0] === "points" && tail[1] === "scroll")
        return send(200, {
          result: {
            points: [...(points?.values() ?? [])].map(({ id, payload }) => ({
              id,
              payload,
            })),
            next_page_offset: null,
          },
        });
      if (tail[0] === "points" && tail[1]?.startsWith("?"))
        return send(200, { result: true });
      if (tail[0] === "points" && seen.method === "PUT") {
        const target = points ?? new Map<string, Point>();
        for (const point of JSON.parse(seen.body).points)
          target.set(point.id, point);
        collections.set(collectionName!, target);
        return send(200, { result: true });
      }
      return send(200, { result: true });
    });
    const directory = fs.mkdtempSync(
      path.join(os.tmpdir(), "nova-qdrant-reindex-"),
    );
    const pointer = path.join(directory, "active.json");
    const options = {
      url: server.url,
      collection: "legacy_memory",
      activeCollectionPath: pointer,
      embeddings: new RemoteEmbeddings({
        url: `${server.url}/v1`,
        key: "fixture-key",
        model: "free-embed-v2",
        dimensions: 3,
        freeVerified: true,
        assertFreeModel: () => {},
      }),
    };
    try {
      const first = new QdrantMemory(options);
      const failed = await first.reindex();
      expect(failed).toMatchObject({ ok: false });
      expect(first.collection).toBe("legacy_memory");
      expect(fs.existsSync(pointer)).toBe(false);
      expect(collections.size).toBe(1);

      failEmbeddings = false;
      const result = await first.reindex();
      expect(result).toMatchObject({ ok: true, points: 1 });
      expect(result.collection).not.toBe("legacy_memory");
      expect(fs.statSync(pointer).mode & 0o777).toBe(0o600);
      expect(collections.get(result.collection!)?.get(id)).toMatchObject({
        vector: [0, 1, 0],
        payload: { id, embedding_model: "free-embed-v2" },
      });
      const restored = new QdrantMemory(options);
      expect(restored.collection).toBe(result.collection);
      expect((await restored.list()).memories).toHaveLength(1);
      expect(collections.has("legacy_memory")).toBe(true);
      const revision = restored.indexHistory()[0]!;
      expect(revision).toMatchObject({
        before: "legacy_memory",
        after: result.collection,
      });
      expect(await restored.rollbackIndex(revision.id)).toMatchObject({
        ok: true,
        collection: "legacy_memory",
      });
      expect(await restored.rollbackIndex(revision.id)).toMatchObject({
        ok: false,
        error: expect.stringContaining("daarna gewijzigd"),
      });
      const recovered = new QdrantMemory(options);
      expect(recovered.collection).toBe("legacy_memory");
      expect((await recovered.list()).memories).toHaveLength(1);
      expect(recovered.indexHistory()).toHaveLength(2);
    } finally {
      server.close();
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });
});

describe("OmniRouteMemory", () => {
  const id = "11111111-1111-4111-8111-111111111111";
  const foreign = "22222222-2222-4222-8222-222222222222";
  function fakeClient() {
    const calls: {
      endpoint: string;
      options: { method?: string; body: Record<string, string> };
    }[] = [];
    const rows = new Map<string, Record<string, unknown>>();
    rows.set(foreign, {
      id: foreign,
      content: "Not Jarvis",
      apiKeyId: "someone-else",
      metadata: { application: "other" },
    });
    const client = {
      configured: true,
      scope: "jarvis-owner",
      calls,
      status: async () => ({
        configured: true,
        online: true,
        memory: { keyword: true },
      }),
      async request(
        endpoint: string,
        options: { method?: string; body: Record<string, string> } = {
          body: {},
        },
      ) {
        calls.push({ endpoint, options });
        if (endpoint === "/api/memory" && options.method === "POST") {
          rows.set(id, {
            id,
            content: options.body.content,
            apiKeyId: options.body.apiKeyId,
            metadata: options.body.metadata,
            createdAt: "2026-10-04",
            updatedAt: "2026-10-04",
          });
          return { success: true, id: rows.get(id) };
        }
        if (endpoint.startsWith("/api/memory?")) {
          const found = [...rows.values()];
          return {
            data: endpoint.includes("q=unmatched") ? [] : found,
            total: found.length,
          };
        }
        if (endpoint.endsWith("retrieve-preview"))
          return { memories: [{ id }, { id: foreign }] };
        const rowId = endpoint.split("/").at(-1)!;
        if (options.method === "DELETE") {
          rows.delete(rowId);
          return {};
        }
        return { memory: rows.get(rowId) };
      },
    };
    return { client, calls, rows };
  }

  it("writes with stable keys, owner scope and secret rejection, and never touches foreign rows", async () => {
    const { client, calls, rows } = fakeClient();
    const memory = new OmniRouteMemory(client as never);
    expect((await memory.write("Onthoud mijn wachtwoord is private")).ok).toBe(
      false,
    );
    expect(calls).toHaveLength(0);
    expect(
      (await memory.write("Onthoud mijn voorkeur is zacht volume")).ok,
    ).toBe(true);
    await memory.write("Onthoud mijn voorkeur is zacht volume");
    expect(calls[0]!.options?.body.key).toBe(calls[1]!.options.body.key);
    expect(calls[0]!.options?.body.apiKeyId).toBe("jarvis-owner");
    expect((await memory.list()).memories).toHaveLength(1);
    expect(await memory.search("volume")).toHaveLength(1);
    const query = calls.find((c) => c.endpoint.includes("q=volume"))!.endpoint;
    expect(new URLSearchParams(query.split("?")[1]).get("apiKeyId")).toBe(
      "jarvis-owner",
    );
    expect(await memory.search("unmatched")).toHaveLength(1);
    expect(
      calls.find((c) => c.endpoint.endsWith("retrieve-preview"))!.options?.body
        .apiKeyId,
    ).toBe("jarvis-owner");
    await expect(memory.remove(foreign)).rejects.toThrow(/not owned/);
    expect(rows.has(foreign)).toBe(true);
    await memory.remove(id);
    expect(rows.has(id)).toBe(false);
    expect((await memory.health()).ready).toBe(true);
    expect(memory.embeddings.configured).toBe(false);
  });

  it("a management failure cannot report readiness or leak upstream content", async () => {
    const management = new OmniRouteManagement(new NovaConfig());
    management.configure({
      password: "fixture-password",
      scope: "jarvis-owner",
      fetcher: async () => new Response("private-error", { status: 401 }),
    });
    const memory = new OmniRouteMemory(management);
    const health = await memory.health();
    expect(health.ready).toBe(false);
    expect(JSON.stringify(health)).not.toContain("private-error");
    expect((await memory.write("Onthoud mijn voorkeur is koffie")).ok).toBe(
      false,
    );
  });

  it("is unavailable without a management login", async () => {
    const management = new OmniRouteManagement(new NovaConfig());
    management.configure({ scope: "x" });
    const memory = new OmniRouteMemory(management);
    if (management.configured) return;
    expect(await memory.search("volume")).toEqual([]);
    expect((await memory.list()).unavailable).toMatch(/not configured/);
  });
});

describe("SemanticMemoryService and MemorySource", () => {
  const saved = { ...process.env };
  afterEach(() => {
    process.env = { ...saved };
  });

  it("does not crash when nothing is configured and says why", async () => {
    delete process.env.EMBEDDING_MODEL;
    const service = new SemanticMemoryService(
      new NovaConfig(),
      new OmniRouteManagement(new NovaConfig()),
      new RoutingService(new NovaConfig()),
    );
    expect(service.configured).toBe(false);
    expect(await service.search("volume")).toEqual([]);
    const source: ToolSource = new MemorySource(service);
    const call = { sessionId: "t", signal: new AbortController().signal };
    expect(
      await source.execute("memory_search", { query: "x" }, call),
    ).toMatchObject({
      ok: false,
      error: "Long-term memory is not configured",
    });
    expect((await service.write("Onthoud mijn voorkeur is koffie")).ok).toBe(
      false,
    );
    await expect(service.runMaintenance()).resolves.toBeUndefined();
    expect((await service.health()).ready).toBe(false);
  });

  it("an invalid collection name degrades instead of throwing", async () => {
    process.env.QDRANT_COLLECTION = "bad/name";
    const service = new SemanticMemoryService(
      new NovaConfig(),
      new OmniRouteManagement(new NovaConfig()),
      new RoutingService(new NovaConfig()),
    );
    expect(service.configured).toBe(false);
    expect((await service.health()).error).toBe("Invalid memory collection");
  });

  it("selects the OmniRoute backend and exposes the tools with the prototype's risks", async () => {
    process.env.JARVIS_MEMORY_BACKEND = "omniroute";
    const management = new OmniRouteManagement(new NovaConfig());
    management.configure({
      password: "p",
      scope: "jarvis-owner",
      fetcher: async () => new Response("{}", { status: 500 }),
    });
    const service = new SemanticMemoryService(
      new NovaConfig(),
      management,
      new RoutingService(new NovaConfig()),
    );
    expect(service.backend).toBeInstanceOf(OmniRouteMemory);
    const source: ToolSource = new MemorySource(service);
    expect(
      Object.fromEntries(source.definitions().map((d) => [d.name, d.risk])),
    ).toEqual({
      memory_search: "READ_ONLY",
      memory_remember: "SAFE",
      memory_forget: "CONFIRM",
    });
    expect(source.definitions().every((d) => d.enabled !== false)).toBe(true);
    const call = { sessionId: "t", signal: new AbortController().signal };
    expect(
      await source.prepare?.(
        "memory_remember",
        { text: "Onthoud mijn wachtwoord is x" },
        call,
      ),
    ).toEqual({ error: "Memory rejected: not durable or contains secrets" });
    expect(
      await source.prepare?.(
        "memory_remember",
        { text: "Onthoud mijn voorkeur is koffie" },
        call,
      ),
    ).toMatchObject({ risk: "SAFE" });
    expect(await source.execute("memory_forget", { id: "nope" }, call)).toEqual(
      {
        ok: false,
        error: "Invalid memory ID",
      },
    );
  });
});
