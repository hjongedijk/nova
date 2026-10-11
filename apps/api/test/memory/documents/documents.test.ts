import { afterEach, describe, expect, it, vi } from "vitest";
import type { NovaConfig } from "../../../src/core/config/nova-config.js";
import { DocumentIndexService } from "../../../src/memory/documents/document-index.service.js";
import type { SemanticMemoryService } from "../../../src/memory/semantic-memory.service.js";

afterEach(() => vi.unstubAllGlobals());

function setup(configured = true) {
  let exists = false;
  const points: {
    id: string;
    vector: number[];
    payload: Record<string, unknown>;
  }[] = [];
  const requests: {
    path: string;
    method: string;
    body?: Record<string, unknown>;
  }[] = [];
  const fetcher = vi.fn(async (input: string | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    const method = init?.method ?? "GET";
    const body = init?.body
      ? (JSON.parse(String(init.body)) as Record<string, unknown>)
      : undefined;
    requests.push({ path: url.pathname, method, body });
    if (url.pathname.endsWith("/points/scroll"))
      return Response.json({
        result: {
          points: points.map(({ id, payload }) => ({ id, payload })),
          next_page_offset: null,
        },
      });
    if (url.pathname.endsWith("/points/query"))
      return Response.json({
        result: {
          points: points.map(({ id, payload }) => ({
            id,
            payload,
            score: 0.8,
          })),
        },
      });
    if (url.pathname.endsWith("/points/delete")) {
      const filter = body?.filter as {
        must?: { key: string; match: { value: string } }[];
      };
      const id = filter.must?.find((item) => item.key === "document_id")?.match
        .value;
      for (let index = points.length - 1; index >= 0; index--)
        if (points[index]?.payload.document_id === id) points.splice(index, 1);
      return Response.json({ result: { status: "completed" } });
    }
    if (url.pathname.endsWith("/points")) {
      const inserted = body?.points as typeof points;
      points.push(...inserted);
      return Response.json({ result: { status: "completed" } });
    }
    if (url.pathname.startsWith("/collections/")) {
      if (method === "PUT") {
        exists = true;
        return Response.json({ result: { status: "ok" } });
      }
      if (!exists) return Response.json({}, { status: 404 });
      return Response.json({
        result: {
          config: { params: { vectors: { size: 2, distance: "Cosine" } } },
        },
      });
    }
    return Response.json({}, { status: 404 });
  });
  vi.stubGlobal("fetch", fetcher);
  const embeddings = {
    configured,
    dimensions: 2,
    model: "verified-free",
    embed: vi.fn(async () => [1, 0]),
  };
  const memory = {
    documentEmbeddings: embeddings,
  } as unknown as SemanticMemoryService;
  const config = {
    qdrantUrl: "http://qdrant:6333",
    qdrantCollection: "nova_memory",
    qdrantApiKey: "",
  } as NovaConfig;
  return {
    service: new DocumentIndexService(config, memory),
    points,
    requests,
    embeddings,
  };
}

describe("document library index", () => {
  it("keeps chunks in a separate collection and supports search, list and removal", async () => {
    const { service, points, requests, embeddings } = setup();
    const saved = await service.index(
      "Heat pump.pdf",
      "Warranty coverage for the heat pump.",
    );
    expect(saved).toMatchObject({ name: "Heat pump.pdf", chunks: 1 });
    expect(points[0]?.payload.namespace).toBe("document");
    expect(points[0]?.payload.text).toContain("Warranty coverage");
    expect(embeddings.embed).toHaveBeenCalledWith(
      "Heat pump.pdf\nWarranty coverage for the heat pump.",
    );
    expect(await service.list()).toMatchObject([
      { id: saved.id, name: saved.name, chunks: 1 },
    ]);
    expect(await service.search("heat pump warranty")).toMatchObject([
      {
        documentId: saved.id,
        name: saved.name,
        text: "Warranty coverage for the heat pump.",
      },
    ]);
    expect(requests.find(({ method }) => method === "PUT")?.path).toMatch(
      /^\/collections\/nova_docs_/,
    );
    await service.remove(saved.id);
    expect(points).toHaveLength(0);
  });

  it("refuses indexing without a verified free embedding configuration", async () => {
    const { service } = setup(false);
    await expect(
      service.index("Plan.txt", "A useful document."),
    ).rejects.toThrow(/geverifieerd gratis/);
  });
});
