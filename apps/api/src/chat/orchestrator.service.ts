import { Injectable } from "@nestjs/common";
import type { PendingConfirmation } from "@nova/contracts";
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

export const requiresLiveData = (message: string) =>
  LIVE_DATA.test(String(message || ""));

// Travels inside the tool result, where it is read last and every provider accepts it.
const SPOKEN_STYLE =
  "Beantwoord alleen de laatste vraag van de gebruiker en vertel dit zoals je het hardop zou zeggen: gewone zinnen, geen lijst, geen nummers, geen opmaak, hooguit vier zinnen, en alleen wat gevraagd is.";

const REMINDER: ModelMessage = {
  role: "user",
  content:
    "Dit antwoord hangt af van actuele gegevens. Roep nu een tool aan. Antwoord niet uit je geheugen en niet op basis van eerdere antwoorden in dit gesprek.",
};

export type Emit = (event: string, data: Record<string, unknown>) => void;

export interface OrchestrateInput {
  sessionId: string;
  message: string;
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
    messages: ModelMessage[],
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
    const messages = await this.context.build(sessionId, message);
    const notes = capabilityNotes(tools.map((tool) => tool.name));
    if (notes) messages.splice(1, 0, { role: "system", content: notes });

    const modelTools = this.tools.forModel();
    const mustUseTool = modelTools.length > 0 && requiresLiveData(message);
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
            });
      const assistant = last.assistant;
      const calls = assistant.tool_calls ?? [];
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
      if (calls.length > 8) throw new Error("Too many tool calls");
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
              ? { ...result, spoken_style: SPOKEN_STYLE }
              : result,
          ),
        });
      }
    }
    throw new Error("Maximum tool-call rounds reached");
  }
}
