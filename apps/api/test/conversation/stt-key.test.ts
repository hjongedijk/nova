import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";
import { encodeWav, tone } from "../../src/conversation/audio.js";
import { OmniRouteStt, sttKeyProblem } from "../../src/conversation/stt.js";
import type { NovaConfig } from "../../src/core/config/nova-config.js";

const MODEL = "groq/whisper-large-v3-turbo";
const KEY = "sk-stt-fixture-key";
const dirs: string[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const d of dirs.splice(0))
    fs.rmSync(d, { recursive: true, force: true });
});

function database(
  over: {
    models?: string[] | null;
    connections?: string[] | null;
    mode?: string;
    active?: number;
    revoked?: string | null;
    connection?: { provider: string; active: number };
  } = {},
) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "nova-stt-"));
  dirs.push(dir);
  const file = path.join(dir, "gateway.sqlite");
  const db = new DatabaseSync(file);
  db.exec(
    "CREATE TABLE api_keys(key TEXT,is_active INTEGER,revoked_at TEXT,model_access_mode TEXT,allowed_models TEXT,allowed_connections TEXT)",
  );
  db.exec(
    "CREATE TABLE provider_connections(id TEXT,provider TEXT,is_active INTEGER)",
  );
  db.prepare("INSERT INTO api_keys VALUES(?,?,?,?,?,?)").run(
    KEY,
    over.active ?? 1,
    over.revoked ?? null,
    over.mode ?? "restricted",
    over.models === null ? null : JSON.stringify(over.models ?? [MODEL]),
    over.connections === null
      ? null
      : JSON.stringify(over.connections ?? ["c1"]),
  );
  db.prepare("INSERT INTO provider_connections VALUES(?,?,?)").run(
    "c1",
    over.connection?.provider ?? "groq",
    over.connection?.active ?? 1,
  );
  db.close();
  return file;
}

describe("dedicated speech key verification", () => {
  it("accepts a key restricted to exactly the model and one active connection of its provider", () => {
    expect(sttKeyProblem(database(), KEY, MODEL)).toBeNull();
  });

  it("refuses a widened, unrestricted, revoked or mismatched key", () => {
    expect(
      sttKeyProblem(
        database({ models: [MODEL, "groq/llama-3.3-70b-versatile"] }),
        KEY,
        MODEL,
      ),
    ).toMatch(/alleen het spraakmodel/);
    expect(
      sttKeyProblem(database({ models: ["groq/other"] }), KEY, MODEL),
    ).toMatch(/alleen het spraakmodel/);
    expect(sttKeyProblem(database({ models: null }), KEY, MODEL)).toMatch(
      /alleen het spraakmodel/,
    );
    expect(sttKeyProblem(database({ mode: "all" }), KEY, MODEL)).toMatch(
      /alleen het spraakmodel/,
    );
    expect(
      sttKeyProblem(database({ connections: ["c1", "c2"] }), KEY, MODEL),
    ).toMatch(/één providerverbinding/);
    expect(sttKeyProblem(database({ connections: null }), KEY, MODEL)).toMatch(
      /één providerverbinding/,
    );
    expect(
      sttKeyProblem(database({ revoked: "2026-10-16" }), KEY, MODEL),
    ).toMatch(/ingetrokken/);
    expect(sttKeyProblem(database({ active: 0 }), KEY, MODEL)).toMatch(
      /ingetrokken/,
    );
    expect(
      sttKeyProblem(
        database({ connection: { provider: "openai", active: 1 } }),
        KEY,
        MODEL,
      ),
    ).toMatch(/hoort niet bij/);
    expect(
      sttKeyProblem(
        database({ connection: { provider: "groq", active: 0 } }),
        KEY,
        MODEL,
      ),
    ).toMatch(/niet actief/);
    expect(sttKeyProblem(database(), "sk-other", MODEL)).toMatch(/ingetrokken/);
    expect(sttKeyProblem("/nonexistent/db.sqlite", KEY, MODEL)).toMatch(
      /kon niet worden gecontroleerd/,
    );
    expect(sttKeyProblem(database(), KEY, "whisper-without-provider")).toMatch(
      /provider\/model/,
    );
  });
});

describe("speech-to-text with the dedicated key", () => {
  const cfg = (file: string, over: Record<string, unknown> = {}) =>
    ({
      omniKey: "main-key",
      omniUrl: "http://omni/v1",
      omniDatabase: file,
      sttModel: MODEL,
      sttMode: "transcriptions",
      sttFreeVerified: true,
      sttKey: KEY,
      ...over,
    }) as unknown as NovaConfig;
  const routing = {
    assertFreeModel: vi.fn(() => {
      throw new Error("main key policy must not be used");
    }),
  } as never;
  const wav = encodeWav(tone(16000, 200), 16000);

  it("sends the speech key, not the main chat key, and never consults the chat policy", async () => {
    let auth = "";
    vi.spyOn(globalThis, "fetch").mockImplementation(async (_u, init) => {
      auth = String((init!.headers as Record<string, string>).authorization);
      return new Response(
        JSON.stringify({ text: "Hallo Nova, hoe laat is het?" }),
        { status: 200 },
      );
    });
    const r = await new OmniRouteStt(cfg(database()), routing).transcribe(wav, {
      language: "nl",
    });
    expect(r).toEqual({ ok: true, text: "Hallo Nova, hoe laat is het?" });
    expect(auth).toBe(`Bearer ${KEY}`);
  });

  it("sends nothing when the key was widened after setup", async () => {
    const spy = vi.spyOn(globalThis, "fetch");
    const r = await new OmniRouteStt(
      cfg(database({ models: [MODEL, "groq/llama-3.3-70b-versatile"] })),
      routing,
    ).transcribe(wav, { language: "nl" });
    expect(r).toMatchObject({
      ok: false,
      error: expect.stringContaining("alleen het spraakmodel"),
    });
    expect(spy).not.toHaveBeenCalled();
  });

  it("still needs the operator's free declaration", async () => {
    const stt = new OmniRouteStt(
      cfg(database(), { sttFreeVerified: false }),
      routing,
    );
    expect(stt.unavailable()).toMatch(/NOVA_STT_FREE_VERIFIED/);
  });
});
