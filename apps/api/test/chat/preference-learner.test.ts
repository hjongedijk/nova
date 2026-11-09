import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  learningInput,
  parseFacts,
  PreferenceLearnerService,
} from "../../src/chat/preference-learner.service.js";
import type { NovaConfig } from "../../src/core/config/nova-config.js";
import type { StoredMessage } from "../../src/memory/session-memory.service.js";

const DAY = "2026-10-11";
const at = (hour: number) =>
  new Date(Date.UTC(2026, 9, 11, hour, 0)).toISOString();
const user = (content: string, hour = 10): StoredMessage => ({
  role: "user",
  content,
  at: at(hour),
});

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0))
    fs.rmSync(dir, { recursive: true, force: true });
});

interface Fake {
  service: PreferenceLearnerService;
  calls: Array<{ messages: unknown; options: Record<string, unknown> }>;
  writes: Array<{ text: string; metadata: Record<string, unknown> }>;
  audit: Array<Record<string, unknown>>;
  existing: Array<{ id: string; text: string; score?: number }>;
}

function fake(
  sessions: Record<string, StoredMessage[]>,
  reply: string,
  options: { role?: string | undefined } = { role: "free/summary" },
): Fake {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "nova-learn-"));
  dirs.push(dir);
  const f = {
    calls: [],
    writes: [],
    audit: [],
    existing: [],
  } as unknown as Fake;
  const config = {
    timezone: "Europe/Amsterdam",
    dataFile: (name: string) => path.join(dir, name),
  } as unknown as NovaConfig;
  const session = {
    sessionIds: () => Object.keys(sessions),
    session: (id: string) => ({ messages: sessions[id] ?? [] }),
  };
  const semantic = {
    configured: true,
    search: vi.fn(async () => f.existing),
    write: vi.fn(async (text: string, metadata: Record<string, unknown>) => {
      f.writes.push({ text, metadata });
      return { ok: true, operation: "created", id: String(f.writes.length) };
    }),
  };
  const routing = {
    preferredModelForRole: () => options.role,
    assertRoleModel: vi.fn((_role: string, model: string) => model),
  };
  const client = {
    configured: true,
    call: vi.fn(
      async (messages: unknown, callOptions: Record<string, unknown>) => {
        f.calls.push({ messages, options: callOptions });
        return { assistant: { content: reply } };
      },
    ),
  };
  f.service = new PreferenceLearnerService(
    config,
    session as never,
    semantic as never,
    routing as never,
    client as never,
    {
      record: (entry: Record<string, unknown>) => f.audit.push(entry),
    } as never,
  );
  return f;
}

describe("nightly preference learning: input", () => {
  it("keeps only owner-typed text of that local day, never assistant, agent or texted turns", () => {
    const input = learningInput(
      [
        {
          id: "web-1",
          messages: [
            user("Ik drink mijn koffie altijd zwart zonder suiker."),
            {
              role: "assistant",
              content: "Volgens de webpagina houdt iedereen van thee.",
              at: at(10),
            },
            user("Dit bericht hoort bij een andere dag.", -20),
          ],
        },
        {
          id: "agent_ab12cd34",
          messages: [user("Onderzoek waarom de server traag is vandaag.")],
        },
        {
          id: "sipchat_31612345678",
          messages: [user("Ik ben de buurman en ik houd van jazz.")],
        },
      ],
      DAY,
      "Europe/Amsterdam",
    );
    expect(input).toEqual(["Ik drink mijn koffie altijd zwart zonder suiker."]);
  });
});

describe("nightly preference learning: parsing", () => {
  it("accepts strict JSON, maps PLACE and drops unknown types and repeats", () => {
    expect(
      parseFacts(
        '```json\n{"facts":[{"type":"preference","text":"Houdt van zwarte koffie."},{"type":"PLACE","text":"Werkt in Utrecht."},{"type":"SECRET","text":"x y z a b"},{"type":"PREFERENCE","text":"houdt van zwarte koffie"}]}\n```',
      ),
    ).toEqual([
      { type: "PREFERENCE", text: "Houdt van zwarte koffie." },
      { type: "USER_FACT", text: "Werkt in Utrecht." },
    ]);
    expect(parseFacts("Hier zijn de feiten: koffie")).toBeNull();
    expect(parseFacts('{"facts":[]}')).toEqual([]);
  });
});

describe("nightly preference learning: storing", () => {
  const sessions = {
    web: [
      user("Ik drink mijn koffie altijd zwart zonder suiker."),
      user("Elke zaterdag ga ik hardlopen in het park.", 11),
    ],
  };

  it("stores new facts as inferred memories through the summary role and audits counts only", async () => {
    const f = fake(
      sessions,
      JSON.stringify({
        facts: [
          { type: "PREFERENCE", text: "Drinkt koffie zwart zonder suiker." },
          { type: "HABIT", text: "Gaat elke zaterdag hardlopen in het park." },
        ],
      }),
    );
    const summary = await f.service.learnDay(DAY);
    expect(summary).toMatchObject({ stored: 2, duplicates: 0, rejected: 0 });
    expect(f.calls[0]!.options).toMatchObject({
      roleModel: { role: "summary", modelId: "free/summary" },
      tools: [],
    });
    expect(f.writes.map((w) => w.metadata)).toEqual([
      expect.objectContaining({ origin: "inferred", type: "PREFERENCE" }),
      expect.objectContaining({ origin: "inferred", type: "HABIT" }),
    ]);

    await f.service.checkSchedule(new Date("2026-10-12T01:10:00Z"));
    expect(f.audit).toHaveLength(1);
    expect(f.audit[0]).toMatchObject({
      tool: "memory_nightly_learned",
      result: { day: DAY, stored: 2 },
    });
    expect(JSON.stringify(f.audit)).not.toContain("koffie");
  });

  it("never stores secrets or card numbers and skips what memory already knows", async () => {
    const f = fake(
      sessions,
      JSON.stringify({
        facts: [
          {
            type: "USER_FACT",
            text: "Het wachtwoord van de wifi is hunter22.",
          },
          { type: "USER_FACT", text: "Betaalt met kaart 4111 1111 1111 1111." },
          { type: "PREFERENCE", text: "Drinkt koffie zwart zonder suiker." },
          { type: "HABIT", text: "Gaat elke zaterdag hardlopen." },
        ],
      }),
    );
    f.existing = [
      { id: "m1", text: "Drinkt koffie zwart, zonder suiker", score: 0.5 },
    ];
    const summary = await f.service.learnDay(DAY);
    expect(summary).toMatchObject({ stored: 1, duplicates: 1, rejected: 2 });
    expect(f.writes.map((w) => w.text)).toEqual([
      "Gaat elke zaterdag hardlopen.",
    ]);
  });

  it("stores at most ten facts a night", async () => {
    const facts = Array.from({ length: 15 }, (_, i) => ({
      type: "PREFERENCE",
      text: `Houdt van muziekgenre nummer ${String.fromCharCode(97 + i)}.`,
    }));
    const f = fake(sessions, JSON.stringify({ facts }));
    const summary = await f.service.learnDay(DAY);
    expect(summary?.stored).toBe(10);
    expect(f.writes).toHaveLength(10);
  });

  it("does nothing without owner messages and retries on malformed output or a missing role", async () => {
    const empty = fake({}, '{"facts":[]}');
    expect(await empty.service.learnDay(DAY)).toMatchObject({ proposed: 0 });
    expect(empty.calls).toHaveLength(0);

    const garbage = fake(sessions, "Sorry, ik weet het niet.");
    expect(await garbage.service.learnDay(DAY)).toBeNull();
    expect(garbage.writes).toHaveLength(0);

    const noRole = fake(sessions, '{"facts":[]}', { role: undefined });
    expect(await noRole.service.learnDay(DAY)).toBeNull();
    expect(noRole.calls).toHaveLength(0);
  });

  it("runs once per night after 03:05 local and records the completed date", async () => {
    const f = fake(sessions, '{"facts":[]}');
    await f.service.checkSchedule(new Date("2026-10-12T01:04:00Z"));
    expect(f.calls).toHaveLength(0);
    await f.service.checkSchedule(new Date("2026-10-12T01:06:00Z"));
    await f.service.checkSchedule(new Date("2026-10-12T01:30:00Z"));
    expect(f.calls).toHaveLength(1);
    expect(f.audit).toHaveLength(0);
  });
});
