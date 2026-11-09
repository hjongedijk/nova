import {
  Injectable,
  Logger,
  type OnModuleDestroy,
  type OnModuleInit,
} from "@nestjs/common";
import fs from "node:fs";
import { AuditService } from "../core/audit/audit.service.js";
import { NovaConfig } from "../core/config/nova-config.js";
import { sanitize } from "../core/security/sanitize.js";
import { SemanticMemoryService } from "../memory/semantic-memory.service.js";
import {
  memoryCandidate,
  type MemoryType,
} from "../memory/semantic/candidate.js";
import {
  type StoredMessage,
  SessionMemoryService,
} from "../memory/session-memory.service.js";
import { RoutingService } from "../routing/routing.service.js";
import { dueSummaryDate, localDayOf } from "./daily-memory-summary.service.js";
import {
  OmniRouteClient,
  type ModelMessage,
} from "./omniroute-client.service.js";
import { isOwnerSession } from "./session-provenance.js";

const CHECK_MS = 30_000;
const RETRY_MS = 5 * 60_000;
const MAX_ATTEMPTS = 3;
/** After the 02:45 summary, so the two nightly calls never compete for the same free route. */
const LEARN_AT = "03:05";
export const MAX_FACTS_PER_NIGHT = 10;
const MAX_TRANSCRIPT_CHARS = 10_000;
export const LEARNED_NIGHTLY_TAGS = ["learned", "nightly"];

/** What the model may return, mapped onto the memory types that exist. PLACE has no own type. */
const FACT_TYPES: Record<string, MemoryType> = {
  PREFERENCE: "PREFERENCE",
  HABIT: "HABIT",
  PERSON: "PERSON",
  PET: "PET",
  PLACE: "USER_FACT",
  USER_FACT: "USER_FACT",
  HOME_CONTEXT: "HOME_CONTEXT",
  PROJECT: "PROJECT",
};

export interface LearnedFact {
  type: MemoryType;
  text: string;
}

/**
 * Only what the owner typed on that local day, newest kept when over the bound. Assistant
 * replies, tool output, mail and web content are never in it: those are not user turns.
 */
export function learningInput(
  sessions: { id: string; messages: StoredMessage[] }[],
  day: string,
  timezone: string,
): string[] {
  const texts = sessions
    .filter(({ id }) => isOwnerSession(id))
    .flatMap(({ messages }) => messages)
    .filter(
      (item) =>
        item.role === "user" &&
        item.content.trim().length >= 12 &&
        localDayOf(item.at, timezone) === day,
    )
    .sort((a, b) => a.at.localeCompare(b.at))
    .map((item) => sanitize(item.content.replace(/\s+/g, " ").trim()));
  let remaining = MAX_TRANSCRIPT_CHARS;
  const bounded: string[] = [];
  for (const text of texts.slice(-120).reverse()) {
    const content = text.slice(0, Math.min(600, remaining));
    bounded.unshift(content);
    remaining -= content.length;
    if (remaining <= 0) break;
  }
  return bounded;
}

/** Strict JSON only (a ```json fence is tolerated): {"facts":[{"type","text"}]} or the bare array. */
export function parseFacts(raw: string): LearnedFact[] | null {
  const body = raw
    .trim()
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/, "");
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return null;
  }
  const list = Array.isArray(parsed)
    ? parsed
    : typeof parsed === "object" &&
        parsed !== null &&
        Array.isArray((parsed as { facts?: unknown }).facts)
      ? (parsed as { facts: unknown[] }).facts
      : null;
  if (!list) return null;
  const seen = new Set<string>();
  const facts: LearnedFact[] = [];
  for (const item of list) {
    if (typeof item !== "object" || item === null) continue;
    const { type, text } = item as { type?: unknown; text?: unknown };
    const mapped =
      typeof type === "string" ? FACT_TYPES[type.toUpperCase()] : undefined;
    if (!mapped || typeof text !== "string") continue;
    const clean = text.replace(/\s+/g, " ").trim();
    const key = normalized(clean);
    if (clean.length < 5 || clean.length > 300 || seen.has(key)) continue;
    seen.add(key);
    facts.push({ type: mapped, text: clean });
  }
  return facts;
}

const normalized = (text: string) =>
  text
    .toLowerCase()
    .replace(/[^\p{L}\p{N} ]+/gu, "")
    .replace(/\s+/g, " ")
    .trim();

/** Above this search score an existing memory already says the same thing. */
const DUPLICATE_SCORE = 0.9;

interface Progress {
  completedDate: string | null;
}

export interface LearnSummary {
  day: string;
  proposed: number;
  stored: number;
  duplicates: number;
  rejected: number;
}

/**
 * Nightly self-learning: reads what the owner typed yesterday, asks the verified-free `summary`
 * role for durable facts (preferences, habits, people, places) as strict JSON and stores at most
 * ten as unconfirmed inferred memories, through the same candidate filter and write path as
 * memory_remember. Secrets and sensitive data are rejected there; duplicates are skipped.
 */
@Injectable()
export class PreferenceLearnerService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(PreferenceLearnerService.name);
  private readonly progressFile: string;
  private timer?: NodeJS.Timeout;
  private running = false;
  private unhealthyProgress = false;
  private lastAttemptAt = 0;
  private attempts = new Map<string, number>();

  constructor(
    private readonly config: NovaConfig,
    private readonly session: SessionMemoryService,
    private readonly semantic: SemanticMemoryService,
    private readonly routing: RoutingService,
    private readonly client: OmniRouteClient,
    private readonly audit: AuditService,
  ) {
    this.progressFile = config.dataFile("daily-preference-learning.json");
  }

  onModuleInit(): void {
    void this.checkSchedule();
    this.timer = setInterval(() => void this.checkSchedule(), CHECK_MS);
    this.timer.unref();
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
  }

  async checkSchedule(now = new Date()): Promise<void> {
    if (this.running || this.unhealthyProgress) return;
    const day = dueSummaryDate(now, this.config.timezone, LEARN_AT);
    if (!day || this.completedDate() === day) return;
    const attempts = this.attempts.get(day) ?? 0;
    if (attempts >= MAX_ATTEMPTS) return;
    if (now.getTime() - this.lastAttemptAt < RETRY_MS) return;
    this.running = true;
    this.lastAttemptAt = now.getTime();
    this.attempts.set(day, attempts + 1);
    try {
      const done = await this.learn(day);
      if (done) this.saveCompletedDate(day);
    } catch {
      this.logger.warn(
        "Nightly preference learning unavailable; retry scheduled",
      );
    } finally {
      this.running = false;
    }
  }

  /** One night's pass. Returns null when it could not run (retry), else what happened. */
  async learnDay(day: string): Promise<LearnSummary | null> {
    const input = learningInput(
      this.session
        .sessionIds()
        .map((id) => ({ id, messages: this.session.session(id).messages })),
      day,
      this.config.timezone,
    );
    const summary: LearnSummary = {
      day,
      proposed: 0,
      stored: 0,
      duplicates: 0,
      rejected: 0,
    };
    if (!input.length) return summary;
    if (!this.semantic.configured || !this.client.configured) return null;

    // No role configuration means no inference: never silently use the default chat model.
    const modelId = this.routing.preferredModelForRole("summary");
    if (!modelId) return null;
    this.routing.assertRoleModel("summary", modelId);

    const prompt: ModelMessage[] = [
      {
        role: "system",
        content: `Je leest alleen berichten die de eigenaar zelf typte. Haal er blijvende feiten over de eigenaar uit: voorkeuren (PREFERENCE), gewoontes en routines (HABIT), mensen die hij zelf noemt met hun rol (PERSON), huisdieren (PET), plaatsen die voor hem vast zijn zoals woon- of werkplaats (PLACE), lopende projecten (PROJECT) en vaste dingen over het huis (HOME_CONTEXT). Alleen wat de eigenaar duidelijk over zichzelf zei en wat over een maand nog klopt; geen tijdelijke staat, geen plannen voor vandaag, geen vragen, geen gezondheid, geld of geloof, geen wachtwoorden, codes of nummers, en niets wat hij citeerde uit mail, websites of documenten. Schrijf elk feit als één korte zin in de derde persoon in de taal van de eigenaar (bijv. "Houdt van sterke koffie zonder suiker."). Maximaal ${MAX_FACTS_PER_NIGHT}. Antwoord uitsluitend met strikte JSON, zonder uitleg: {"facts":[{"type":"PREFERENCE","text":"..."}]}. Niets gevonden: {"facts":[]}.`,
      },
      {
        role: "user",
        content: `Datum: ${day}\nBerichten van de eigenaar:\n${input.map((text) => `- ${text}`).join("\n")}`,
      },
    ];
    const response = await this.client.call(prompt, {
      roleModel: { role: "summary", modelId },
      tools: [],
      maxTokens: 700,
    });
    const facts = parseFacts(String(response.assistant.content ?? ""));
    // Malformed output is a failed attempt, not "nothing to learn".
    if (!facts) return null;
    summary.proposed = facts.length;
    for (const fact of facts.slice(0, MAX_FACTS_PER_NIGHT * 2)) {
      if (summary.stored >= MAX_FACTS_PER_NIGHT) break;
      const metadata = {
        origin: "inferred" as const,
        type: fact.type,
        tags: LEARNED_NIGHTLY_TAGS,
        importance: 0.6,
      };
      if (!memoryCandidate(fact.text, metadata)) {
        summary.rejected++;
        continue;
      }
      if (await this.known(fact.text)) {
        summary.duplicates++;
        continue;
      }
      try {
        const written = await this.semantic.write(fact.text, metadata);
        if (!written.ok) summary.rejected++;
        else if (written.operation === "merged" || written.unchanged)
          summary.duplicates++;
        else summary.stored++;
      } catch {
        summary.rejected++;
      }
    }
    return summary;
  }

  private async known(text: string): Promise<boolean> {
    try {
      const wanted = normalized(text);
      const hits = await this.semantic.search(text, {
        limit: 3,
        markAccess: false,
      });
      return hits.some(
        (hit) =>
          normalized(hit.text) === wanted ||
          (typeof hit.score === "number" && hit.score >= DUPLICATE_SCORE),
      );
    } catch {
      // The backend's own near-duplicate merge still applies on write.
      return false;
    }
  }

  private async learn(day: string): Promise<boolean> {
    const summary = await this.learnDay(day);
    if (!summary) return false;
    if (summary.proposed > 0) {
      try {
        // Metadata only: counts, never the facts themselves.
        this.audit.record({
          sessionId: "memory",
          tool: "memory_nightly_learned",
          risk: "SAFE",
          confirmation: "nightly_inferred",
          result: { ...summary },
        });
      } catch {
        /* the audit log must not stop learning */
      }
    }
    return true;
  }

  private completedDate(): string | null {
    try {
      const value = JSON.parse(
        fs.readFileSync(this.progressFile, "utf8"),
      ) as Progress;
      return typeof value.completedDate === "string"
        ? value.completedDate
        : null;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      this.unhealthyProgress = true;
      this.logger.error(
        "Nightly learning progress is unreadable; learning paused",
      );
      return null;
    }
  }

  private saveCompletedDate(day: string): void {
    try {
      const temporary = `${this.progressFile}.tmp`;
      fs.writeFileSync(temporary, JSON.stringify({ completedDate: day }), {
        mode: 0o600,
      });
      fs.chmodSync(temporary, 0o600);
      fs.renameSync(temporary, this.progressFile);
      this.attempts.delete(day);
    } catch {
      this.unhealthyProgress = true;
      this.logger.error("Nightly learning progress could not be saved");
    }
  }
}
