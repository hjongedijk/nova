import { attachmentMessage } from "./attachments.js";
import { Injectable } from "@nestjs/common";
import type { ChatAttachment, PendingConfirmation } from "@nova/contracts";
import { NovaConfig } from "../core/config/nova-config.js";
import { ConfirmationsService } from "../confirmations/confirmations.service.js";
import { confirmationQuestion } from "../confirmations/confirmation-words.js";
import { RoutingService } from "../routing/routing.service.js";
import { parseToolArguments } from "../tools/tool-arguments.js";
import { ToolsService } from "../tools/tools.service.js";
import {
  OmniRouteClient,
  type GatewayMetadata,
  type ModelAnswer,
  type ModelMessage,
  type ModelInputMessage,
} from "./omniroute-client.service.js";
import { capabilityNotes } from "./prompt.js";
import { ContextBuilder } from "./context-builder.service.js";
import { ConfirmationHandler } from "./confirmation-handler.service.js";

/*
 * Questions whose answer lives outside the model: weather, time, device and server state, news,
 * timers, lists, prices, the web, and anything that acts. A model that has answered such questions
 * from memory before keeps doing so, so for these the first round must call a tool.
 */
const LIVE_DATA =
  /\b(?:weer|temperatuur|regent?|regen|zonnig|wind|buiten|weather|forecast|hoe laat|welke dag|welke datum|datum|nieuws|headlines?|timer|herinner\w*|wekker|lijst\w*|boodschappen|taken|lampen?|licht|verlichting|verwarming|thermostaat|iemand thuis|hoe warm|hoe koud|graden|in huis|woonkamer|slaapkamer|keuken|proxmox|vm|vm['’]?s|virtuele|servers?|status|bereikbaar|storing|meldingen?|watchdog|opslag|cpu|belasting|koers|bitcoin|dollar|euro|valuta|luchtkwaliteit|pollen|maan|iss|ruimtestation|zoek\w*|google|wikipedia|internet|inwoners|bereken\w*|open|sluit|herstart|restart|vergrendel\w*|speel|pauzeer|volume|browser|chrome|website|surf|navigeer|scroll|klik|tabblad|ga naar|youtube|amazon|marktplaats)\b/i;

// Sharing a mood is conversation, even if it mentions the weather or the house.
const PERSONAL_CHAT =
  /\b(?:ik ben (?:moe|verdrietig|blij|gestrest|eenzaam)|ik voel me|wat een dag|i(?:'m| am) (?:tired|sad|happy|stressed|lonely)|i feel)\b/i;
const EXPLICIT_REQUEST =
  /\b(?:kun je|kan je|wil je|hoe|wat is|wat zijn|welke|zoek|check|controleer|zet|doe|open|sluit|speel|help|can you|could you|please|what|when|where|check|turn|play)\b/i;
const LIVE_WITH_FILES =
  /\b(?:nu|momenteel|actueel|live|current|currently|today|vandaag|check|controleer|zet|schakel|herstart|restart|reboot|turn|open|sluit|speel|play)\b/i;
export const requiresLiveData = (
  message: string,
  hasAttachments = false,
): boolean => {
  if (PERSONAL_CHAT.test(message) && !EXPLICIT_REQUEST.test(message))
    return false;
  if (hasAttachments && !LIVE_WITH_FILES.test(message)) return false;
  return LIVE_DATA.test(message);
};

export function responseStyle(inputMode: "text" | "voice" = "text"): string {
  const manner =
    "Answer the user's actual request in their language. Be calm, warm and capable, like a trusted personal assistant. Give the useful result, not a tool report. Keep simple answers brief; give enough detail for complex requests. Do not force a joke, an opening catchphrase or a follow-up question.";
  return inputMode === "voice"
    ? manner +
        " This is a spoken conversation: use natural sentences and no markdown. Start with the key point; expand when asked."
    : manner +
        " This is typed chat: use readable paragraphs, lists, links, tables or code when they help, especially for documents and technical help. Do not arbitrarily stop after four sentences.";
}

const REMINDER: ModelMessage = {
  role: "user",
  content:
    "Dit antwoord hangt af van actuele gegevens. Roep nu een tool aan. Antwoord niet uit je geheugen en niet op basis van eerdere antwoorden in dit gesprek.",
};

export type Emit = (event: string, data: Record<string, unknown>) => void;

export interface OrchestrateInput {
  sessionId: string;
  message: string;
  attachments?: ChatAttachment[];
  inputMode?: "text" | "voice";
  /** The confirmation the user is answering, when the interface knows it. */
  confirmationId?: string;
  stream?: boolean;
  emit?: Emit;
  signal?: AbortSignal;
}

export interface Reply {
  reply: string;
  model: string | null;
  usage: Record<string, unknown> | null;
  confirmation?: PendingConfirmation;
  routing?: GatewayMetadata;
  result?: unknown;
}

/**
 * One turn of conversation: a "ja"/"nee" answers a pending confirmation; anything else goes to the
 * model with the tools, which may call tools for several rounds before it answers. Risky tools come
 * back as a confirmation question instead of running.
 */
@Injectable()
export class OrchestratorService {
  constructor(
    private readonly config: NovaConfig,
    private readonly client: OmniRouteClient,
    private readonly routing: RoutingService,
    private readonly tools: ToolsService,
    private readonly confirmations: ConfirmationsService,
    private readonly confirmationHandler: ConfirmationHandler,
    private readonly context: ContextBuilder,
  ) {}

  /**
   * First round for live-data questions. Tool use is required; if the gateway or model refuses that,
   * or answers in text anyway, one more attempt is made with an explicit reminder. Whatever the model
   * says in a failed attempt is held back, not shown.
   */
  private async firstRoundWithTool(
    messages: ModelInputMessage[],
    options: {
      stream: boolean;
      emit: Emit;
      signal?: AbortSignal;
      sessionId: string;
    },
  ): Promise<ModelAnswer> {
    const held: string[] = [];
    const quiet: Emit = (event, data) => {
      if (event === "token") held.push(String(data.text));
      else options.emit(event, data);
    };
    const tools = this.tools.forModel();
    const attempt = (
      toolChoice: "auto" | "required",
      extra: ModelMessage[] = [],
    ) =>
      this.client.call([...messages, ...extra], {
        ...options,
        emit: quiet,
        toolChoice,
        tools,
      });
    let result: ModelAnswer;
    try {
      result = await attempt("required");
    } catch (error) {
      if (options.signal?.aborted) throw error;
      held.length = 0;
      result = await attempt("auto", [REMINDER]);
    }
    if (!result.assistant.tool_calls?.length) {
      held.length = 0;
      result = await attempt("required", [REMINDER]).catch(() => result);
    }
    if (!result.assistant.tool_calls?.length && options.stream) {
      // Nothing worked: the model really has no tool for this, so its text is the answer.
      const text = held.length
        ? held.join("")
        : (result.assistant.content ?? "");
      if (text) options.emit("token", { text });
    }
    return result;
  }

  async run(input: OrchestrateInput): Promise<Reply> {
    const {
      sessionId,
      message,
      confirmationId,
      stream = false,
      emit = () => {},
      signal,
    } = input;
    const direct = await this.confirmationHandler.handle(
      sessionId,
      message,
      confirmationId,
    );
    if (direct) {
      if (stream) emit("token", { text: direct.reply });
      return { ...direct, model: null, usage: null };
    }
    this.confirmations.cancel(sessionId);
    this.routing.assertFree();

    const tools = this.tools.list().filter((tool) => tool.enabled);
    emit("tools", {
      count: tools.length,
      names: tools.map((tool) => tool.name),
    });
    const messages: ModelInputMessage[] = await this.context.build(
      sessionId,
      message,
    );
    const style = responseStyle(input.inputMode);
    messages.splice(1, 0, { role: "system", content: style });
    if (input.attachments?.length) {
      const prepared = await attachmentMessage(input.attachments, message);
      for (const notice of prepared.notices)
        emit("attachment_notice", { message: notice });
      // Keep the user's question last, alongside its files, instead of two competing user messages.
      messages[messages.length - 1] = prepared.message;
    }
    const notes = capabilityNotes(tools.map((tool) => tool.name));
    if (notes) messages.splice(1, 0, { role: "system", content: notes });

    const modelTools = this.tools.forModel();
    const mustUseTool =
      modelTools.length > 0 &&
      requiresLiveData(message, !!input.attachments?.length);
    const rounds = this.config.maxToolRounds;
    let emptyRetried = false;

    for (let round = 0; round < rounds; round++) {
      if (signal?.aborted) throw new Error("Request cancelled");
      const last =
        round === 0 && mustUseTool
          ? await this.firstRoundWithTool(messages, {
              stream,
              emit,
              signal,
              sessionId,
            })
          : await this.client.call(messages, {
              stream,
              emit,
              signal,
              sessionId,
              tools: modelTools,
              maxTokens: input.inputMode === "voice" ? 1000 : 2400,
            });
      const assistant = last.assistant;
      // A model that asks for more than eight calls at once gets its first eight run.
      const calls = (assistant.tool_calls ?? []).slice(0, 8);
      if (assistant.tool_calls && assistant.tool_calls.length > calls.length)
        assistant.tool_calls = calls;
      const base = {
        model: last.model,
        usage: last.usage,
        routing: last.metadata,
      };

      if (!calls.length && !String(assistant.content ?? "").trim()) {
        // Free models now and then return nothing at all. Ask once more, then say so.
        if (!emptyRetried) {
          emptyRetried = true;
          continue;
        }
        const reply =
          "Daar kreeg ik even geen antwoord op van mijn taalmodel. Vraag het zo nog eens?";
        if (stream) emit("token", { text: reply });
        return { reply, ...base };
      }
      if (!calls.length) return { reply: assistant.content ?? "", ...base };
      if (round === rounds - 1)
        throw new Error("Maximum tool-call rounds reached");

      messages.push({ ...assistant, role: "assistant" });
      for (const call of calls) {
        if (!call.id || !call.function?.name)
          throw new Error("Malformed tool call");
        const name = call.function.name;
        const args = parseToolArguments(call.function.arguments);
        emit("tool_start", { name });
        const result = await this.tools.execute(name, args, sessionId);
        emit("tool_result", {
          name,
          ok: result.ok,
          verified: result.verified ?? null,
          status: (result.status as string | undefined) ?? null,
        });
        if (result.requiresConfirmation && result.action) {
          const reply = confirmationQuestion(
            result.action,
            /\b(please|restart|reboot|start|stop)\b/i.test(message),
          );
          emit(
            "confirmation",
            result.action as unknown as Record<string, unknown>,
          );
          if (stream) emit("token", { text: reply });
          return { reply, ...base, confirmation: result.action };
        }
        messages.push({
          role: "tool",
          tool_call_id: call.id,
          name,
          content: JSON.stringify(
            result && typeof result === "object"
              ? { ...result, response_style: style }
              : result,
          ),
        });
      }
    }
    throw new Error("Maximum tool-call rounds reached");
  }
}
