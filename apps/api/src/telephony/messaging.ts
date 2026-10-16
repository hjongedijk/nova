import { Injectable, Logger } from "@nestjs/common";
import crypto from "node:crypto";
import { OrchestratorService } from "../chat/orchestrator.service.js";
import { AuditService } from "../core/audit/audit.service.js";
import { NovaConfig } from "../core/config/nova-config.js";
import { TelephonyStore } from "./telephony.store.js";

const MAX_IN = 1000;
const MAX_OUT = 900;
const PER_MINUTE = 10;

const TEXT = {
  nl: {
    busy: "Ik ben nog bezig met je vorige bericht.",
    slow: "Je stuurt wel erg snel berichten. Probeer het over een minuut nog eens.",
    screen:
      "Dat moet je op het scherm bevestigen. Via een bericht voer ik zoiets niet uit.",
    failed: "Daar ging iets mis. Probeer het zo nog eens.",
  },
  en: {
    busy: "I'm still working on your previous message.",
    slow: "You are sending messages very quickly. Please try again in a minute.",
    screen:
      "That needs confirmation on the screen. I won't do that over a message.",
    failed: "Something went wrong. Please try again in a moment.",
  },
} as const;

/** The plain text of an incoming SIP MESSAGE: text/plain as is, message/cpim unwrapped, anything else (typing, receipts, encrypted) is ignored. */
export function messageText(type: string, body: string): string | null {
  const kind = type.split(";")[0]!.trim().toLowerCase();
  if (kind === "text/plain") return body.trim() || null;
  if (kind !== "message/cpim") return null;
  const outer = body.replace(/\r\n/g, "\n").split("\n\n");
  if (outer.length < 2) return null;
  const inner = outer.slice(1).join("\n\n").split("\n\n");
  const headers = inner[0] ?? "";
  if (!/^content-type:\s*text\/plain/im.test(headers)) return null;
  const text = inner.slice(1).join("\n\n").trim();
  return text || null;
}

/** "Harm" <sip:user@domain;gr=...> or sip:user@domain to user@domain, lower case. */
export function sipAddress(from: string): string | null {
  const m = /sips?:([^@;>\s"]+)@([^;>\s:"]+)/i.exec(from);
  return m ? `${m[1]}@${m[2]}`.toLowerCase() : null;
}

/** Plain, short chat text: no code fences or emphasis markers, bounded length. */
export function chatText(text: string): string {
  const clean = text
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/[*_~]{1,3}([^*_~\n]+)[*_~]{1,3}/g, "$1")
    .replace(/^\s{0,3}#{1,6}\s+/gm, "")
    .replace(/\|/g, "/")
    .replace(/[ \t]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  if (clean.length <= MAX_OUT) return clean;
  const cut = clean.slice(0, MAX_OUT);
  const end = Math.max(cut.lastIndexOf(". "), cut.lastIndexOf("\n"));
  return `${(end > MAX_OUT / 2 ? cut.slice(0, end + 1) : cut).trim()} …`;
}

const same = (a: string, b: string) => {
  const x = crypto.createHash("sha256").update(a).digest();
  const y = crypto.createHash("sha256").update(b).digest();
  return crypto.timingSafeEqual(x, y);
};

/**
 * Text chat with NOVA from a Linphone contact. Asterisk forwards each SIP MESSAGE here; the answer goes back the same way.
 * Only contacts marked "Mag met NOVA praten" are answered, with read-only tools only, and nothing that needs a confirmation.
 */
@Injectable()
export class TelephonyMessaging {
  private readonly log = new Logger("NOVA messages");
  private readonly active = new Set<string>();
  private readonly recent = new Map<string, number[]>();
  /** Replaceable in tests. */
  now: () => number = Date.now;

  constructor(
    private readonly store: TelephonyStore,
    private readonly orchestrator: OrchestratorService,
    private readonly audit: AuditService,
    private readonly config: NovaConfig,
  ) {}

  /** `to|reply` for Asterisk, or an empty string when nothing should be sent. */
  async handle(input: {
    token: unknown;
    from: unknown;
    type: unknown;
    body: unknown;
  }): Promise<string> {
    const expected = this.store.get().messageToken ?? "";
    if (
      typeof input.token !== "string" ||
      !expected ||
      !same(input.token, expected)
    )
      throw new MessageAuthError();
    const address =
      typeof input.from === "string" ? sipAddress(input.from) : null;
    const contact = address
      ? (this.store.get().contacts ?? []).find(
          (c) => c.allowConversation && c.sip.toLowerCase() === address,
        )
      : undefined;
    if (!address || !contact) {
      this.record("rejected", {
        reason: address ? "unknown_contact" : "bad_sender",
      });
      return "";
    }
    const text = messageText(
      typeof input.type === "string" ? input.type : "",
      typeof input.body === "string" ? input.body.slice(0, MAX_IN * 4) : "",
    );
    if (!text) return "";
    const lang = this.config.defaultLanguage.toLowerCase().startsWith("en")
      ? "en"
      : "nl";
    const t = TEXT[lang];
    const to = `sip:${address}`;
    const key = contact.name.toLowerCase();
    const cutoff = this.now() - 60_000;
    const hits = (this.recent.get(key) ?? []).filter((at) => at > cutoff);
    if (hits.length >= PER_MINUTE) return `${to}|${t.slow}`;
    hits.push(this.now());
    this.recent.set(key, hits);
    if (this.active.has(key)) return `${to}|${t.busy}`;
    this.active.add(key);
    try {
      const result = await this.orchestrator.run({
        sessionId: `sipchat_${key.replace(/[^a-z0-9]+/g, "_").slice(0, 40)}`,
        message: text.slice(0, MAX_IN),
        inputMode: "text",
        responseLanguage: lang,
        readOnlyOnly: true,
        signal: AbortSignal.timeout(40_000),
      });
      this.record("answered", {
        contact: contact.name,
        inChars: text.length,
        outChars: result.reply.length,
      });
      if (result.confirmation) return `${to}|${t.screen}`;
      const reply = chatText(result.reply);
      return reply ? `${to}|${reply}` : "";
    } catch {
      this.record("failed", { contact: contact.name });
      return `${to}|${t.failed}`;
    } finally {
      this.active.delete(key);
    }
  }

  /** Only metadata is audited: never the text of a message. */
  private record(phase: string, extra: Record<string, unknown>): void {
    try {
      this.audit.record({
        sessionId: "telephony",
        tool: "phone_message",
        phase,
        ...extra,
      });
    } catch {
      this.log.warn("audit failed");
    }
  }
}

export class MessageAuthError extends Error {}
