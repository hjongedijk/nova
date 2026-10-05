import { Injectable, Logger } from "@nestjs/common";
import fs from "node:fs";
import { NovaConfig } from "../core/config/nova-config.js";
import { ValidationError } from "../core/errors/validation.error.js";
import { sanitize } from "../core/security/sanitize.js";

export interface StoredMessage {
  role: "user" | "assistant";
  content: string;
  at: string;
}

/** What NOVA keeps in mind between turns: which device, room or speaker "it" means. */
export interface SessionContext {
  activeEntities: string[];
  activeArea: string | null;
  activeMediaTarget: string | null;
  recentToolResults: {
    name: string;
    ok: boolean;
    verified: boolean | null;
    at: string;
  }[];
  ambiguity: unknown;
}

interface Session {
  createdAt: string;
  updatedAt: string;
  messages: StoredMessage[];
  context?: SessionContext;
}

export interface ChatMessage {
  role: "user" | "assistant";
  content: string;
}

/*
 * Earlier refusals poison later answers: a model that reads "Ik kan het weer niet vinden" in its
 * own history repeats it, even when the tool that answers the question exists now. Replies like
 * that, and the question they answered, are kept out of what the model sees (not out of storage).
 */
const REFUSAL =
  /\b(?:kan|kunnen|kon)\b[^.!?\n]{0,60}\b(?:niet|geen)\b[^.!?\n]{0,40}\b(?:vinden|openen|uitvoeren|bereiken|ophalen|doen|geven|bieden|beschikbaar|toegang)|kom er niet bij|lukt (?:het )?niet|geen (?:echte )?(?:weer)?informatie|geen toegang|kennismap|weersvoorspellingssite|ik kan alleen (?:de |het )?(?:apparaten|huis)|\bhelaas\b|mijn excuses|\bsorry\b|i (?:can(?:no|')t|am unable)|unable to (?:find|access)/i;

export const isRefusal = (text: unknown) =>
  typeof text === "string" && REFUSAL.test(text);

export function withoutRefusals<T extends { role: string; content: string }>(
  messages: T[],
): T[] {
  const drop = new Set<number>();
  messages.forEach((item, index) => {
    if (item.role !== "assistant" || !isRefusal(item.content)) return;
    drop.add(index);
    if (messages[index - 1]?.role === "user") drop.add(index - 1);
  });
  return messages.filter((_, index) => !drop.has(index));
}

const STOP_WORDS = new Set([
  "de",
  "het",
  "een",
  "en",
  "of",
  "ik",
  "je",
  "jij",
  "mijn",
  "dat",
  "dit",
  "die",
  "wat",
  "waar",
  "hoe",
  "is",
  "zijn",
  "was",
  "waren",
  "heb",
  "heeft",
  "had",
  "the",
  "a",
  "an",
  "and",
  "or",
  "i",
  "you",
  "my",
  "what",
  "where",
  "how",
  "are",
  "were",
]);

const tokenize = (text: string) =>
  String(text || "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .split(/\s+/)
    .filter((word) => word.length >= 3 && !STOP_WORDS.has(word));

/** A session id from a request: letters, digits, - and _; "default" when absent. */
export function normalizeSessionId(value: unknown): string {
  const id = value === undefined ? "default" : value;
  if (
    typeof id !== "string" ||
    !/^[a-zA-Z0-9_-]{1,100}$/.test(id) ||
    ["__proto__", "constructor", "prototype"].includes(id)
  )
    throw new ValidationError(["Ongeldige sessie."]);
  return id;
}

/**
 * Conversations per session, kept in memory.json (written atomically). A damaged file is left
 * alone and memory then stays in this process only, so nothing good is overwritten.
 */
@Injectable()
export class SessionMemoryService {
  private readonly file: string;
  private readonly log = new Logger("MEMORY");
  private healthy = true;
  private sessions: Record<string, Session>;

  constructor(config: NovaConfig) {
    this.file = config.dataFile("memory.json");
    this.sessions = this.load();
  }

  get isHealthy(): boolean {
    return this.healthy;
  }

  private load(): Record<string, Session> {
    try {
      if (!fs.existsSync(this.file)) return {};
      const parsed = JSON.parse(fs.readFileSync(this.file, "utf8")) as {
        sessions?: unknown;
      };
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
        throw new Error("format");
      const sessions = parsed.sessions ?? {};
      if (typeof sessions !== "object" || Array.isArray(sessions))
        throw new Error("format");
      return sessions as Record<string, Session>;
    } catch {
      this.healthy = false;
      this.log.error("load failed; the original file is kept");
      return {};
    }
  }

  save(): void {
    if (!this.healthy) return;
    try {
      const temporary = `${this.file}.tmp`;
      fs.writeFileSync(
        temporary,
        JSON.stringify({ sessions: this.sessions }, null, 2),
        { mode: 0o600 },
      );
      fs.renameSync(temporary, this.file);
    } catch {
      this.healthy = false;
      this.log.error("save failed");
    }
  }

  session(sessionId: string): Session {
    if (!Object.hasOwn(this.sessions, sessionId) || !this.sessions[sessionId]) {
      const now = new Date().toISOString();
      this.sessions[sessionId] = {
        createdAt: now,
        updatedAt: now,
        messages: [],
      };
    }
    return this.sessions[sessionId]!;
  }

  /** Forget one conversation entirely. */
  clear(sessionId: string): void {
    if (Object.hasOwn(this.sessions, sessionId))
      delete this.sessions[sessionId];
    this.save();
  }

  sessionIds(): string[] {
    return Object.keys(this.sessions);
  }

  add(sessionId: string, role: StoredMessage["role"], content: string): void {
    if (!content || !String(content).trim()) return;
    const session = this.session(sessionId);
    session.messages.push({
      role,
      content: sanitize(String(content)),
      at: new Date().toISOString(),
    });
    if (session.messages.length > 2000)
      session.messages = session.messages.slice(-2000);
    session.updatedAt = new Date().toISOString();
    this.save();
  }

  /** The last turns, without refusals, for the model. */
  recent(sessionId: string, limit = 12): ChatMessage[] {
    return withoutRefusals(this.session(sessionId).messages)
      .slice(-limit)
      .map((item) => ({ role: item.role, content: sanitize(item.content) }));
  }

  /** Earlier things the user said that share words with the question (not NOVA's answers). */
  relevant(sessionId: string, query: string, limit = 6): StoredMessage[] {
    const wanted = new Set(tokenize(query));
    if (!wanted.size) return [];
    const clean = withoutRefusals(this.session(sessionId).messages);
    return clean
      .slice(0, Math.max(0, clean.length - 12))
      .filter((item) => item.role === "user")
      .map((item, index) => ({
        item,
        index,
        score:
          tokenize(item.content).filter((token) => wanted.has(token)).length *
          1.3,
      }))
      .filter((entry) => entry.score > 0)
      .sort((a, b) => b.score - a.score || b.index - a.index)
      .slice(0, limit)
      .map((entry) => entry.item);
  }

  /** Earlier memory as a system note for the model, or null when there is none. */
  static memoryNote(relevant: StoredMessage[]): string | null {
    if (!relevant.length) return null;
    const lines = relevant.map(
      (item) => `${item.role === "user" ? "User" : "NOVA"}: ${item.content}`,
    );
    return `Relevant earlier conversation memory:\n\n${lines.join("\n")}\n\nUse this only when relevant.`;
  }

  context(sessionId: string): SessionContext {
    return (this.session(sessionId).context ??= {
      activeEntities: [],
      activeArea: null,
      activeMediaTarget: null,
      recentToolResults: [],
      ambiguity: null,
    });
  }

  /** After a tool ran: which device or room the conversation is now about. */
  rememberTool(
    sessionId: string,
    name: string,
    args: Record<string, unknown>,
    result: {
      ok: boolean;
      verified?: boolean | null;
      ambiguous?: boolean;
      candidates?: unknown;
    },
    entity?: { area?: string | null } | null,
  ): void {
    const context = this.context(sessionId);
    if (result.ok && Array.isArray(args.entity_ids))
      context.activeEntities = [...(args.entity_ids as string[])];
    if (result.ok && entity?.area) context.activeArea = entity.area;
    if (result.ok && typeof args.entity_id === "string") {
      context.activeEntities = [args.entity_id];
      if (args.entity_id.startsWith("media_player."))
        context.activeMediaTarget = args.entity_id;
    }
    context.recentToolResults = [
      ...context.recentToolResults,
      {
        name,
        ok: result.ok,
        verified: result.verified ?? null,
        at: new Date().toISOString(),
      },
    ].slice(-8);
    if (result.ambiguous) context.ambiguity = result.candidates;
    else if (result.ok) context.ambiguity = null;
    this.save();
  }
}
