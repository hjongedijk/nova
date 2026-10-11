import { Injectable } from "@nestjs/common";
import crypto from "node:crypto";
import { NovaConfig } from "../../core/config/nova-config.js";
import { sanitize } from "../../core/security/sanitize.js";
import { RemoteEmbeddings } from "../semantic/qdrant.backend.js";
import { SemanticMemoryService } from "../semantic-memory.service.js";

const MAX_DOCUMENTS = 200;
const MAX_CHUNKS = 40;
const CHUNK_SIZE = 1200;
const OVERLAP = 160;

export interface IndexedDocument {
  id: string;
  name: string;
  chunks: number;
  createdAt: string;
}

export interface DocumentHit {
  documentId: string;
  name: string;
  text: string;
  score: number;
  chunk: number;
}

/** Private document vectors in a separate Qdrant collection from personal semantic memory. */
@Injectable()
export class DocumentIndexService {
  private readonly url: string;
  private readonly collection: string;
  private readonly apiKey: string;
  private readonly embeddings: RemoteEmbeddings | null;
  private initialized = false;

  constructor(config: NovaConfig, memory: SemanticMemoryService) {
    this.url = config.qdrantUrl.replace(/\/$/, "");
    this.apiKey = config.qdrantApiKey;
    this.collection = `nova_docs_${crypto.createHash("sha256").update(config.qdrantCollection).digest("hex").slice(0, 16)}`;
    this.embeddings = memory.documentEmbeddings;
  }

  get configured(): boolean {
    return Boolean(this.embeddings?.configured && this.url);
  }

  async list(): Promise<IndexedDocument[]> {
    await this.ensureCollection();
    const points = await this.scroll();
    const documents = new Map<string, IndexedDocument>();
    for (const point of points) {
      const payload = point.payload;
      if (
        typeof payload?.document_id !== "string" ||
        typeof payload.name !== "string" ||
        typeof payload.created_at !== "string"
      )
        continue;
      const current = documents.get(payload.document_id);
      if (current) current.chunks++;
      else
        documents.set(payload.document_id, {
          id: payload.document_id,
          name: payload.name,
          chunks: 1,
          createdAt: payload.created_at,
        });
    }
    return [...documents.values()]
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .slice(0, MAX_DOCUMENTS);
  }

  async index(name: string, content: string): Promise<IndexedDocument> {
    if (!this.embeddings?.configured)
      throw new Error(
        "Een geverifieerd gratis embeddingmodel is niet ingesteld.",
      );
    const cleanName = sanitize(name).trim().slice(0, 200);
    const cleanContent = sanitize(content).trim();
    if (!cleanName || !cleanContent || cleanContent.length > 24_000)
      throw new Error("Dit document heeft geen leesbare tekst of is te groot.");
    const current = await this.list();
    if (current.length >= MAX_DOCUMENTS)
      throw new Error("De documentbibliotheek bevat maximaal 200 documenten.");
    const chunks = splitDocument(cleanContent);
    if (!chunks.length || chunks.length > MAX_CHUNKS)
      throw new Error(
        "Dit document bevat te veel tekst om veilig te indexeren.",
      );
    const id = crypto.randomUUID();
    const createdAt = new Date().toISOString();
    const points = [];
    for (let chunk = 0; chunk < chunks.length; chunk++) {
      const text = chunks[chunk]!;
      points.push({
        id: crypto.randomUUID(),
        vector: await this.embeddings.embed(`${cleanName}\n${text}`),
        payload: {
          namespace: "document",
          document_id: id,
          name: cleanName,
          chunk,
          text,
          created_at: createdAt,
          embedding_model: this.embeddings.model,
        },
      });
    }
    await this.ensureCollection();
    await this.request(
      `/collections/${this.collection}/points?wait=true`,
      "PUT",
      { points },
    );
    return { id, name: cleanName, chunks: chunks.length, createdAt };
  }

  async search(query: string): Promise<DocumentHit[]> {
    if (!this.embeddings?.configured)
      throw new Error(
        "Een geverifieerd gratis embeddingmodel is niet ingesteld.",
      );
    const value = query.trim();
    if (value.length < 2 || value.length > 500)
      throw new Error("Zoek op 2 tot 500 tekens.");
    await this.ensureCollection();
    const vector = await this.embeddings.embed(value);
    const response = await this.request<{
      result?: {
        points?: { score: number; payload?: Record<string, unknown> }[];
      };
    }>(`/collections/${this.collection}/points/query`, "POST", {
      query: vector,
      limit: 8,
      with_payload: true,
      filter: {
        must: [
          { key: "namespace", match: { value: "document" } },
          { key: "embedding_model", match: { value: this.embeddings.model } },
        ],
      },
    });
    return (response.result?.points ?? [])
      .filter(
        (point) =>
          point.score >= 0.35 && typeof point.payload?.text === "string",
      )
      .map((point) => ({
        documentId: String(point.payload?.document_id ?? ""),
        name: String(point.payload?.name ?? "Document"),
        text: String(point.payload?.text).slice(0, CHUNK_SIZE),
        score: point.score,
        chunk: Number(point.payload?.chunk) || 0,
      }));
  }

  async remove(id: string): Promise<{ ok: true }> {
    if (
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
        id,
      )
    )
      throw new Error("Dit document bestaat niet.");
    if (!(await this.list()).some((document) => document.id === id))
      throw new Error("Dit document bestaat niet.");
    await this.ensureCollection();
    await this.request(
      `/collections/${this.collection}/points/delete?wait=true`,
      "POST",
      {
        filter: {
          must: [
            { key: "namespace", match: { value: "document" } },
            { key: "document_id", match: { value: id } },
          ],
        },
      },
    );
    return { ok: true };
  }

  private async scroll(): Promise<{ payload?: Record<string, unknown> }[]> {
    const points: { payload?: Record<string, unknown> }[] = [];
    let offset: string | number | null | undefined;
    for (let page = 0; page < 20; page++) {
      const response = await this.request<{
        result?: {
          points?: { payload?: Record<string, unknown> }[];
          next_page_offset?: string | number | null;
        };
      }>(`/collections/${this.collection}/points/scroll`, "POST", {
        limit: 500,
        ...(offset ? { offset } : {}),
        with_payload: ["namespace", "document_id", "name", "created_at"],
        with_vector: false,
        filter: { must: [{ key: "namespace", match: { value: "document" } }] },
      });
      points.push(...(response.result?.points ?? []));
      offset = response.result?.next_page_offset;
      if (
        offset === undefined ||
        offset === null ||
        points.length >= MAX_DOCUMENTS * MAX_CHUNKS
      )
        break;
    }
    return points;
  }

  private async ensureCollection(): Promise<void> {
    if (this.initialized) return;
    if (!this.embeddings?.configured)
      throw new Error(
        "Een geverifieerd gratis embeddingmodel is niet ingesteld.",
      );
    try {
      const info = await this.request<{
        result?: {
          config?: {
            params?: { vectors?: { size?: number; distance?: string } };
          };
        };
      }>(`/collections/${this.collection}`);
      const vectors = info.result?.config?.params?.vectors;
      if (
        vectors?.size !== this.embeddings.dimensions ||
        vectors?.distance !== "Cosine"
      )
        throw new Error(
          "De documentindex heeft een andere embeddingsconfiguratie.",
        );
    } catch (error) {
      if (
        !(error instanceof Error) ||
        error.message !== "Qdrant unavailable (404)"
      )
        throw error;
      try {
        await this.request(`/collections/${this.collection}`, "PUT", {
          vectors: { size: this.embeddings.dimensions, distance: "Cosine" },
        });
      } catch (createError) {
        if (
          !(createError instanceof Error) ||
          createError.message !== "Qdrant unavailable (409)"
        )
          throw createError;
        await this.request(`/collections/${this.collection}`);
      }
    }
    this.initialized = true;
  }

  private async request<T = unknown>(
    endpoint: string,
    method = "GET",
    body?: unknown,
  ): Promise<T> {
    const response = await fetch(`${this.url}${endpoint}`, {
      method,
      headers: {
        "content-type": "application/json",
        ...(this.apiKey ? { "api-key": this.apiKey } : {}),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(8000),
    });
    if (!response.ok)
      throw new Error(`Qdrant unavailable (${response.status})`);
    return (await response.json()) as T;
  }
}

function splitDocument(content: string): string[] {
  const normalized = content.replace(/\r\n?/g, "\n").trim();
  const chunks: string[] = [];
  for (
    let start = 0;
    start < normalized.length;
    start += CHUNK_SIZE - OVERLAP
  ) {
    const end = Math.min(normalized.length, start + CHUNK_SIZE);
    const chunk = normalized.slice(start, end).trim();
    if (chunk) chunks.push(chunk);
    if (end === normalized.length) break;
  }
  return chunks;
}
