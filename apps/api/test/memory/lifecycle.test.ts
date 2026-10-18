import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { MemoryRecord } from "@nova/contracts";
import { MemorySource } from "../../src/memory/memory.source.js";
import { SemanticMemoryService } from "../../src/memory/semantic-memory.service.js";
import { memoryCandidate } from "../../src/memory/semantic/candidate.js";
import {
  contradicts,
  normalizeRecord,
  planConsolidation,
  queryKeywords,
  rankMatches,
  subjectClaim,
} from "../../src/memory/semantic/lifecycle.js";
import {
  QdrantMemory,
  RemoteEmbeddings,
} from "../../src/memory/semantic/qdrant.backend.js";
import { listen } from "../integrations/helpers.js";

type Point = {
  id: string;
  vector: number[];
  payload: Record<string, unknown>;
};

/** Fake Qdrant + embeddings: topic words pick the vector axis, so topics are neighbours. */
async function fakeServices() {
  const points = new Map<string, Point>();
  let collection = false;
  const server = await listen((seen, send) => {
    const path = (seen.url ?? "").split("?")[0]!;
    const body = seen.body ? JSON.parse(seen.body) : {};
    if (path === "/v1/embeddings") {
      const input = String(body.input);
      return send(200, {
        data: [
          {
            embedding: /kleur|color/i.test(input)
              ? [1, 0, 0]
              : /hond|dog/i.test(input)
                ? [0, 1, 0]
                : [0, 0, 1],
          },
        ],
      });
    }
    if (!path.startsWith("/collections/")) return send(200, { ok: true });
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
    if (path.endsWith("/points") && seen.method === "POST")
      return send(200, {
        result: body.ids.flatMap((id: string) => {
          const point = points.get(id);
          return point ? [{ id, payload: point.payload }] : [];
        }),
      });
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
          points: [...points.values()].map((p) => ({
            id: p.id,
            payload: p.payload,
          })),
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
  return { server, points };
}

describe("memory lifecycle (Qdrant)", () => {
  let fixture: Awaited<ReturnType<typeof fakeServices>>;
  let memory: QdrantMemory;
  beforeEach(async () => {
    fixture = await fakeServices();
    memory = new QdrantMemory({
      url: fixture.server.url,
      collection: "nova_test",
      embeddings: new RemoteEmbeddings({
        url: `${fixture.server.url}/v1`,
        key: "k",
        model: "free-embed",
        dimensions: 3,
        freeVerified: true,
        assertFreeModel: () => {},
      }),
    });
  });
  afterEach(() => fixture.server.close());

  it("prevents duplicates: same text, even reformatted, updates one record", async () => {
    const a = await memory.write("Onthoud dat mijn hond Bram heet");
    const b = await memory.write("onthoud:  dat mijn hond bram heet!");
    expect(b.id).toBe(a.id);
    expect(b.operation).toBe("merged");
    expect(fixture.points.size).toBe(1);
  });

  it("supersedes a contradicting fact and says what changed", async () => {
    const first = await memory.write(
      "Onthoud dat mijn favoriete kleur blauw is",
    );
    const second = await memory.write(
      "Onthoud dat mijn favoriete kleur rood is",
    );
    expect(second.id).not.toBe(first.id);
    expect(second.superseded).toEqual([
      {
        id: first.id,
        text: "dat mijn favoriete kleur blauw is",
      },
    ]);
    expect(second.message).toContain("Eerder zei je");
    expect(second.message).toContain("blauw");
    expect(second.message).toContain("rood");
    const old = fixture.points.get(first.id!)!.payload;
    expect(old.superseded_by).toBe(second.id);
    expect(typeof old.valid_until).toBe("string");
    const found = await memory.search("favoriete kleur");
    expect(found.map((r) => r.id)).toEqual([second.id]);
  });

  it("an inference never overrides a user-stated fact", async () => {
    const stated = await memory.write(
      "Onthoud dat mijn favoriete kleur blauw is",
    );
    const guess = await memory.write("mijn favoriete kleur is groen", {
      origin: "inferred",
    });
    expect(guess.ok).toBe(true);
    expect(guess.superseded).toBeUndefined();
    expect(guess.conflictWith).toBe(stated.id);
    expect(guess.memory).toMatchObject({
      kind: "assumption",
      origin: "inferred",
      confidence: 0.4,
    });
    expect(fixture.points.get(stated.id!)!.payload.superseded_by).toBeFalsy();
    const found = await memory.search("favoriete kleur");
    expect(found.find((r) => r.id === stated.id)?.text).not.toContain(
      "niet bevestigd",
    );
    expect(found.find((r) => r.id === guess.id)?.text).toContain(
      "(waarschijnlijk, niet bevestigd)",
    );
  });

  it("a later user statement supersedes an earlier inference", async () => {
    const guess = await memory.write("mijn favoriete kleur is groen", {
      origin: "inferred",
    });
    const stated = await memory.write(
      "Onthoud dat mijn favoriete kleur geel is",
    );
    expect(stated.superseded?.[0]?.id).toBe(guess.id);
    expect((await memory.search("favoriete kleur")).map((r) => r.id)).toEqual([
      stated.id,
    ]);
  });

  it("never writes secrets, card numbers or sensitive inferences", async () => {
    for (const text of [
      "Onthoud dat mijn wachtwoord hunter2 is",
      "Onthoud mijn pincode is 1234",
      "Onthoud mijn kaart 4111 1111 1111 1111",
      "Onthoud mijn api key sk-abcdefghijklmnop",
    ])
      expect((await memory.write(text)).ok).toBe(false);
    expect(
      (
        await memory.write("mijn IBAN is NL91ABNA0417164300", {
          origin: "inferred",
        })
      ).ok,
    ).toBe(false);
    expect(
      memoryCandidate("Onthoud mijn IBAN is NL91ABNA0417164300")?.sensitive,
    ).toBe(true);
    expect(fixture.points.size).toBe(0);
  });

  it("correct() supersedes with history; forget with history removes the chain", async () => {
    const v1 = await memory.write("Onthoud dat mijn hond Bram heet");
    const v2 = await memory.correct(v1.id!, "mijn hond heet Max");
    expect(v2.ok).toBe(true);
    expect(v2.message).toContain("Bram");
    expect(v2.message).toContain("Max");
    expect(fixture.points.size).toBe(2);
    const v3 = await memory.correct(v2.id!, "mijn hond heet Rex");
    expect(fixture.points.size).toBe(3);
    await memory.remove(v3.id!);
    expect(fixture.points.size).toBe(2);
    const w1 = await memory.write("Onthoud dat mijn favoriete kleur blauw is");
    const w2 = await memory.correct(w1.id!, "mijn favoriete kleur is rood");
    const removed = await memory.remove(w2.id!, { history: true });
    expect(removed.removed).toBe(2);
    expect(fixture.points.has(w1.id!)).toBe(false);
    expect(fixture.points.has(w2.id!)).toBe(false);
    await expect(memory.correct("nope", "x")).rejects.toThrow(
      "Invalid memory ID",
    );
  });

  it("correct() with options stores the replacement as a tagged inferred memory", async () => {
    const v1 = await memory.write("Onthoud dat mijn hond Bram heet");
    const v2 = await memory.correct(v1.id!, "mijn hond heet Max", {
      origin: "inferred",
      tags: ["learned", "owner-correction"],
    });
    expect(v2.ok).toBe(true);
    expect(v2.memory).toMatchObject({
      origin: "inferred",
      tags: expect.arrayContaining(["learned", "owner-correction"]),
    });
    expect(v2.memory!.confidence).toBeLessThanOrEqual(0.4);
    expect(fixture.points.get(v1.id!)!.payload.superseded_by).toBe(v2.id);
  });

  it("does not fabricate: no match returns an empty list", async () => {
    await memory.write("Onthoud dat mijn hond Bram heet");
    expect(await memory.search("hoe laat is het")).toEqual([]);
  });

  it("expires validUntil records and consolidates duplicates and old episodes", async () => {
    const fact = await memory.write("Onthoud dat ik tot vrijdag in Rome ben", {
      valid_until: "2020-01-01",
    });
    expect(await memory.search("Rome")).toEqual([]);
    const day = "2020-03-01T10:00:00.000Z";
    for (const [i, id] of [
      "11111111-1111-4111-8111-111111111111",
      "22222222-2222-4222-8222-222222222222",
    ].entries())
      fixture.points.set(id, {
        id,
        vector: [0, 0, 1],
        payload: {
          id,
          text: `Gesprek ${i}`,
          type: "CONVERSATION_SUMMARY",
          created_at: day,
          updated_at: day,
          importance: 0.9,
          access_count: 0,
        },
      });
    for (const id of [
      "33333333-3333-4333-8333-333333333333",
      "44444444-4444-4444-8444-444444444444",
    ])
      fixture.points.set(id, {
        id,
        vector: [0, 0, 1],
        payload: {
          id,
          text: "Ik drink koffie zwart",
          type: "USER_FACT",
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
          importance: 0.9,
          access_count: id.startsWith("3") ? 2 : 3,
        },
      });
    const report = await memory.maintain();
    expect(report).toMatchObject({
      expired: 1,
      duplicatesMerged: 1,
      episodesTrimmed: 2,
    });
    expect(fixture.points.get(fact.id!)!.payload.archived).toBe(true);
    const texts = [...fixture.points.values()].map((p) => p.payload.text);
    expect(
      texts.filter((t) => String(t).startsWith("Samenvatting 2020-03-01")),
    ).toHaveLength(1);
    expect(texts.filter((t) => t === "Ik drink koffie zwart")).toHaveLength(1);
    // Idempotent: a second pass changes nothing.
    expect(await memory.maintain()).toMatchObject({
      expired: 0,
      duplicatesMerged: 0,
      episodesTrimmed: 0,
    });
  });
});

describe("lifecycle rules", () => {
  const rec = (over: Partial<MemoryRecord> & Record<string, unknown>) =>
    ({
      id: over.id ?? "a",
      text: "x",
      importance: 0.6,
      updated_at: new Date().toISOString(),
      ...over,
    }) as MemoryRecord;

  it("migrates old records lazily without losing data", () => {
    const old = rec({
      id: "old",
      text: "Mijn partner heet Anna",
      type: "PERSON",
      source: "explicit_user",
      created_at: "2023-01-01T00:00:00.000Z",
    });
    const migrated = normalizeRecord(old);
    expect(migrated).toMatchObject({
      text: old.text,
      kind: "fact",
      origin: "user_stated",
      confidence: 1,
      sensitive: false,
      superseded_by: null,
      valid_until: null,
    });
    expect(normalizeRecord(rec({ type: "PREFERENCE" })).kind).toBe(
      "preference",
    );
    expect(
      normalizeRecord(
        rec({ type: "CONVERSATION_SUMMARY", source: "scheduled_summary" }),
      ),
    ).toMatchObject({ kind: "episode", origin: "tool" });
    expect(
      rankMatches([{ record: old, similarity: 0.9 }], "partner"),
    ).toHaveLength(1);
  });

  it("detects same-subject contradictions only", () => {
    expect(
      contradicts(
        "mijn favoriete kleur is blauw",
        "mijn favoriete kleur is rood",
      ),
    ).toBe(true);
    expect(
      contradicts(
        "mijn favoriete kleur is blauw",
        "Mijn favoriete kleur is Blauw.",
      ),
    ).toBe(false);
    expect(contradicts("mijn hond heet Bram", "mijn kat heet Max")).toBe(false);
    expect(contradicts("ik woon in Utrecht", "ik woon in Zwolle")).toBe(true);
    expect(contradicts("ik ben 40 jaar", "ik ben 41 jaar oud")).toBe(true);
    expect(subjectClaim("ik hou van koffie")).toBeNull();
  });

  it("ranks by similarity, recency, confidence and use; drops superseded and expired", () => {
    const now = Date.now();
    const day = 86_400_000;
    const ranked = rankMatches(
      [
        {
          record: rec({ id: "fresh", text: "a", type: "USER_FACT" }),
          similarity: 0.8,
        },
        {
          record: rec({
            id: "stale",
            text: "b",
            type: "CONVERSATION_SUMMARY",
            updated_at: new Date(now - 400 * day).toISOString(),
          }),
          similarity: 0.8,
        },
        {
          record: rec({
            id: "unsure",
            text: "c",
            confidence: 0.4,
            origin: "inferred",
            kind: "assumption",
          }),
          similarity: 0.8,
        },
        {
          record: rec({ id: "used", text: "d", access_count: 15 }),
          similarity: 0.8,
        },
        {
          record: rec({ id: "gone", text: "e", superseded_by: "fresh" }),
          similarity: 0.99,
        },
        {
          record: rec({ id: "expired", text: "f", valid_until: "2020-01-01" }),
          similarity: 0.99,
        },
        { record: rec({ id: "weak", text: "g" }), similarity: 0.3 },
      ],
      "iets",
      now,
    );
    expect(ranked.map((r) => r.id)).toEqual([
      "used",
      "fresh",
      "unsure",
      "stale",
    ]);
    expect(ranked.find((r) => r.id === "unsure")?.text).toBe(
      "c (waarschijnlijk, niet bevestigd)",
    );
  });

  it("boosts exact names and numbers", () => {
    expect(queryKeywords("wanneer heeft Bram verjaardag op 12-05")).toEqual(
      expect.arrayContaining(["bram", "1205"]),
    );
    const ranked = rankMatches(
      [
        {
          record: rec({ id: "other", text: "Mijn hond is lief" }),
          similarity: 0.7,
        },
        {
          record: rec({ id: "named", text: "Bram is geboren op 12-05" }),
          similarity: 0.6,
        },
      ],
      "wanneer heeft Bram verjaardag",
    );
    expect(ranked[0]?.id).toBe("named");
    expect(
      rankMatches(
        [
          {
            record: rec({ id: "x", text: "Mijn hond is lief" }),
            similarity: 0.6,
          },
        ],
        "iets",
      ),
    ).toEqual([]);
  });

  it("plans consolidation deterministically", () => {
    const old = "2020-01-01T10:00:00.000Z";
    const plan = planConsolidation([
      rec({ id: "e1", text: "een", kind: "episode", created_at: old }),
      rec({ id: "e2", text: "twee", kind: "episode", created_at: old }),
      rec({
        id: "e3",
        text: "alleen",
        kind: "episode",
        created_at: "2020-01-02T10:00:00.000Z",
      }),
      rec({ id: "s", text: "oud", superseded_by: "e1" }),
    ]);
    expect(plan.episodeDays).toHaveLength(1);
    expect(plan.episodeDays[0]).toMatchObject({
      day: "2020-01-01",
      ids: ["e1", "e2"],
    });
    expect(plan.episodeDays[0]!.text).toBe(
      "Samenvatting 2020-01-01: een | twee",
    );
    expect(plan.expire).toEqual([]);
  });
});

describe("memory tools", () => {
  it("memory_list filters by kind and hides history; memory_correct needs a backend", async () => {
    const rows: MemoryRecord[] = [
      { id: "1", text: "Ik drink koffie", type: "USER_FACT" },
      { id: "2", text: "Volume 20", type: "PREFERENCE" },
      {
        id: "3",
        text: "oud",
        type: "USER_FACT",
        superseded_by: "1",
      } as MemoryRecord,
    ];
    const service = new SemanticMemoryService(
      {} as never,
      {} as never,
      {} as never,
    );
    service.useBackends({
      qdrant: {
        configured: true,
        lastError: null,
        embeddings: { configured: true, model: "m" },
        search: async () => [],
        write: async () => ({ ok: true }),
        list: async () => ({ memories: rows, next: null }),
        remove: async () => ({ ok: true }),
        maintain: async () => ({}),
        health: async () => ({
          online: true,
          ready: true,
          embeddings: { configured: true, model: "m", remoteOnly: true },
          error: null,
        }),
      },
    });
    const source = new MemorySource(service);
    const all = await source.execute("memory_list", {});
    expect((all.result as { memories: unknown[] }).memories).toHaveLength(2);
    const prefs = await source.execute("memory_list", { kind: "preference" });
    expect(
      (prefs.result as { memories: { id: string }[] }).memories.map(
        (m) => m.id,
      ),
    ).toEqual(["2"]);
    const hist = await source.execute("memory_list", { include_history: true });
    expect((hist.result as { memories: unknown[] }).memories).toHaveLength(3);
    expect(
      (await source.execute("memory_correct", { id: "1", text: "abc def" })).ok,
    ).toBe(false);
  });
});
