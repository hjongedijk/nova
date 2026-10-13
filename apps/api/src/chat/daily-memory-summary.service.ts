import {
  Injectable,
  Logger,
  type OnModuleDestroy,
  type OnModuleInit,
} from "@nestjs/common";
import fs from "node:fs";
import { NovaConfig } from "../core/config/nova-config.js";
import { sanitize } from "../core/security/sanitize.js";
import { SemanticMemoryService } from "../memory/semantic-memory.service.js";
import { memoryCandidate } from "../memory/semantic/candidate.js";
import {
  withoutRefusals,
  type StoredMessage,
  SessionMemoryService,
} from "../memory/session-memory.service.js";
import { RoutingService } from "../routing/routing.service.js";
import {
  OmniRouteClient,
  type ModelMessage,
} from "./omniroute-client.service.js";

const CHECK_MS = 30_000;
const RETRY_MS = 5 * 60_000;
const MAX_ATTEMPTS = 3;
const SUMMARY_AT = "02:45";
const MAX_TRANSCRIPT_CHARS = 12_000;

function localParts(date: Date, timezone: string): Record<string, string> {
  return Object.fromEntries(
    new Intl.DateTimeFormat("en-CA", {
      timeZone: timezone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
    })
      .formatToParts(date)
      .filter((part) => part.type !== "literal")
      .map(({ type, value }) => [type, value]),
  );
}

/** The prior local calendar date, once the configured local summary time has passed. */
export function dueSummaryDate(date: Date, timezone: string): string | null {
  const parts = localParts(date, timezone);
  if (`${parts.hour}:${parts.minute}` < SUMMARY_AT) return null;
  const yesterday = new Date(
    Date.UTC(
      Number(parts.year),
      Number(parts.month) - 1,
      Number(parts.day) - 1,
    ),
  );
  return yesterday.toISOString().slice(0, 10);
}

export function summaryInput(
  messages: StoredMessage[],
  day: string,
  timezone: string,
): StoredMessage[] {
  const dated = withoutRefusals(messages)
    .filter((item) => {
      if (!item.content.trim()) return false;
      try {
        const localDate = localParts(new Date(item.at), timezone);
        return `${localDate.year}-${localDate.month}-${localDate.day}` === day;
      } catch {
        return false;
      }
    })
    .sort((a, b) => a.at.localeCompare(b.at));
  let remaining = MAX_TRANSCRIPT_CHARS;
  const bounded: StoredMessage[] = [];
  for (const item of dated.slice(-80).reverse()) {
    const content = item.content.slice(0, Math.min(1200, remaining));
    if (content.trim().length < 12) continue;
    bounded.unshift({ ...item, content });
    remaining -= content.length;
    if (remaining <= 0) break;
  }
  return bounded;
}

interface Progress {
  completedDate: string | null;
}

/** Nightly, bounded summaries use only the configured verified-free summary role. */
@Injectable()
export class DailyMemorySummaryService
  implements OnModuleInit, OnModuleDestroy
{
  private readonly logger = new Logger(DailyMemorySummaryService.name);
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
  ) {
    this.progressFile = config.dataFile("daily-memory-summary.json");
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
    const day = dueSummaryDate(now, this.config.timezone);
    if (!day || this.completedDate() === day) return;
    const attempts = this.attempts.get(day) ?? 0;
    if (attempts >= MAX_ATTEMPTS) return;
    if (now.getTime() - this.lastAttemptAt < RETRY_MS) return;
    this.running = true;
    this.lastAttemptAt = now.getTime();
    this.attempts.set(day, attempts + 1);
    try {
      const done = await this.summarize(day);
      if (done) this.saveCompletedDate(day);
    } catch {
      this.logger.warn("Nightly memory summary unavailable; retry scheduled");
    } finally {
      this.running = false;
    }
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
        "Nightly summary progress is unreadable; summaries paused",
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
      this.logger.error("Nightly summary progress could not be saved");
    }
  }

  private async summarize(day: string): Promise<boolean> {
    const messages = this.session
      .sessionIds()
      .flatMap((id) => this.session.session(id).messages);
    const input = summaryInput(messages, day, this.config.timezone);
    if (!input.some((item) => item.role === "user")) return true;
    if (!this.semantic.configured || !this.client.configured) return false;

    // No role configuration means no inference: never silently use the default chat model.
    const modelId = this.routing.preferredModelForRole("summary");
    if (!modelId) return false;
    this.routing.assertRoleModel("summary", modelId);

    const transcript = input
      .map(
        ({ role, content }) =>
          `${role === "user" ? "Gebruiker" : "NOVA"}: ${content}`,
      )
      .join("\n");
    const prompt: ModelMessage[] = [
      {
        role: "system",
        content:
          "Maak een korte, feitelijke geheugen-samenvatting van het gesprek van de gebruiker. Bewaar alleen blijvende doelen, besluiten, voortgang en expliciet genoemde voorkeuren. Laat begroetingen, herhaling, model/tool-ruis, tijdelijke statussen, aannames, gezondheidsdetails en credentials weg. Leid geen relatiegegevens af; neem die alleen mee als de gebruiker expliciet vroeg ze te onthouden. Gebruik maximaal 5 korte bullets, schrijf in de taal van de gebruiker en gebruik de absolute datum. Als niets nuttigs overblijft, antwoord exact: GEEN SAMENVATTING.",
      },
      {
        role: "user",
        content: `Datum: ${day}\nGesprekken:\n${transcript}`,
      },
    ];
    const response = await this.client.call(prompt, {
      roleModel: { role: "summary", modelId },
      tools: [],
      maxTokens: 500,
    });
    const text = sanitize(String(response.assistant.content ?? "")).trim();
    if (!text || /^GEEN SAMENVATTING\.?$/i.test(text)) return true;
    const memoryText = `Gespreksnotitie ${day}: ${text}`;
    if (
      !memoryCandidate(memoryText, {
        scheduledSummary: true,
        type: "CONVERSATION_SUMMARY",
      })
    ) {
      this.logger.warn(
        "Nightly memory summary rejected by memory safety checks",
      );
      return true;
    }
    const written = await this.semantic.write(memoryText, {
      scheduledSummary: true,
      type: "CONVERSATION_SUMMARY",
    });
    return written.ok;
  }
}
