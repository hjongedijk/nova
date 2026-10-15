import { attachmentMessage } from "./attachments.js";
import { directAnswer } from "./direct-answer.js";
import {
  directDefinitionQuery,
  directDefinitionReply,
} from "./direct-definition.js";
import { directCurrencyQuery, directCurrencyReply } from "./direct-currency.js";
import { Injectable } from "@nestjs/common";
import { sanitize } from "../core/security/sanitize.js";
import type {
  ChatAttachment,
  CommunicationPreference,
  ModelRoleId,
  PendingConfirmation,
} from "@nova/contracts";
import { NovaConfig } from "../core/config/nova-config.js";
import { ConfirmationsService } from "../confirmations/confirmations.service.js";
import { confirmationQuestion } from "../confirmations/confirmation-words.js";
import {
  FreeRoutingBlockedError,
  RoutingService,
} from "../routing/routing.service.js";
import { parseToolArguments } from "../tools/tool-arguments.js";
import { ToolsService } from "../tools/tools.service.js";
import { TOOL_DISCOVERY_NAME } from "../tools/tool-selection.js";
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
import type { AssistantMood } from "./assistant-mood.js";

/*
 * Questions whose answer lives outside the model: weather, time, device and server state, news,
 * timers, lists, prices, the web, and anything that acts. A model that has answered such questions
 * from memory before keeps doing so, so for these the first round must call a tool.
 */
const LIVE_DATA =
  /\b(?:weer|temperatuur|regent?|regen|zonnig|wind|buiten|weather|forecast|temperature|raining|calendar|agenda|what time|what day|what date|latest news|news|shopping lists?|to-do lists?|task lists?|remind(?:ers?)?|alarms?|lights?|(?:turn|switch) (?:on|off)|hoe laat|welke dag|welke datum|datum|nieuws|headlines?|timers?|herinner\w*|wekker|lijst\w*|boodschappen|taken|lamp(?:en)?|licht|verlichting|verwarming|thermostaat|iemand thuis|hoe warm|hoe koud|graden|in huis|woonkamer|slaapkamer|keuken|proxmox|vm|vm['’]?s|virtuele|servers?|status|bereikbaar|storing|meldingen?|watchdog|opslag|cpu|belasting|koers|bitcoin|dollar|euro|valuta|luchtkwaliteit|pollen|maan|iss|ruimtestation|zoek\w*|google|wikipedia|internet|inwoners|bereken\w*|open|sluit|herstart|restart|vergrendel\w*|speel|pauzeer|volume|browser|chrome|website|surf|navigeer|scroll|klik|tabblad|ga naar|youtube|amazon|marktplaats)\b/i;

// Sharing a mood is conversation, even if it mentions the weather or the house.
const PERSONAL_CHAT =
  /\b(?:ik ben (?:moe|kapot|verdrietig|blij|gestrest|druk|eenzaam|overprikkeld|overweldigd|opgelucht|boos|gefrustreerd|nerveus|gespannen)|ik heb (?:een )?(?:drukke|zware|lastige|rotte|heftige) dag|ik voel me|het valt me zwaar|ik zit erdoorheen|wat een dag|i(?:'m| am) (?:tired|exhausted|sad|happy|stressed|lonely|overwhelmed|anxious|frustrated)|i feel|it's been a (?:long|rough|busy|hard) day|i(?:'ve| have) had a lot on)\b/i;
const EXPLICIT_REQUEST =
  /\b(?:kun je|kan je|wil je|hoe|wat is|wat zijn|welke|zoek|check|controleer|zet|doe|open|sluit|speel|help|can you|could you|what|when|where|check|turn|switch|play|add|voeg|remind|herinner|schakel|voer|run|execute)\b/i;
const LIVE_WITH_FILES =
  /\b(?:nu|momenteel|actueel|live|current|currently|today|vandaag|check|controleer|zet|schakel|herstart|restart|reboot|turn|switch|open|sluit|speel|play|fetch|search|zoek|run|execute|voer|add|voeg|remind|herinner)\b/i;
const MOOD_STYLE =
  "Before any user-facing answer text, emit exactly one private marker: <!--NOVA_MOOD:happy-->, <!--NOVA_MOOD:thoughtful-->, <!--NOVA_MOOD:concerned-->, <!--NOVA_MOOD:enthusiastic--> or <!--NOVA_MOOD:neutral-->. Choose the tone of your answer, not a diagnosis or a claim about the user's feelings. Do not mention the marker. Do not add it to tool calls.";
const FRESH_REQUEST =
  /\b(?:nu|momenteel|actueel|live|current|currently|today|vandaag|latest|right now)\b/i;
const EXPLAIN_ONLY =
  /^\s*(?:(?:kun je|kan je|wil je|can you|could you)\s+)?(?:leg(?: mij)? uit|uitleggen|verklaar|beschrijf (?:hoe|waarom)|explain|describe (?:how|why)|tell me (?:how|why)|wat betekent|wat is de (?:functie|betekenis|definitie)|what is the (?:purpose|meaning|definition))\b/i;
const CODE_ONLY =
  /^\s*(?:(?:kun je|kan je|wil je|can you|could you|please)\s+)?(?:schrijf|maak|genereer|write|create|generate)\b[^.!?]{0,120}\b(?:code|script|functie|function|simulatie|simulation|voorbeeld|example)\b/i;
const EXECUTE_ALSO =
  /(?:[,;.]|\b(?:and|en)\b)\s*(?:then\s+|daarna\s+)?(?:run|execute|start|restart|reboot|check|turn|play|open|close|stop|voer|herstart|controleer|zet|schakel|speel|sluit)\b/i;
const EXECUTION_REQUEST =
  /(?:^|[,;.]|\b(?:and|en)\b)\s*(?:(?:please|can you|could you|kun je|kan je|wil je)\s+)?(?:then\s+|daarna\s+)?(?:run|execute|fetch|search|look up|zoek|voer)\b/i;
const OWN_DIAGNOSIS =
  /\b(?:mijn|my|our|onze)\b.{0,80}\b(?:down|offline|unreachable|niet|storing|failed|error|kapot|defect)\b/i;
const ATTACHMENT_REFERENCE =
  /\b(?:in (?:dit|het|this|the) (?:bestand|document|file)|this (?:file|document|article)|attached|bijlage)\b/i;
const EXTERNAL_CHECK =
  /\b(?:check|controleer|verify|zoek|search|fetch|run|execute|voer|herstart|restart)\b/i;
// A check inside an attached report is document analysis, unless an outside lookup/action is requested.
const OUTSIDE_ATTACHMENT =
  /\b(?:buiten|outside|online|internet|fetch|search|zoek|run|execute|voer|herstart|restart|reboot|turn|switch|zet|schakel|speel|play|add|voeg|remind|herinner|still accurate|nog actueel)\b/i;
// The amount is supplied as a product description, rather than requested from an outside source.
const PROVIDED_PRICE =
  /^(?:wat kost (?:een|de|het) [^?!;]{1,100}\bvan \d+(?:[.,]\d+)? ?(?:euro|eur|dollars?|usd|pond|gbp)|how much does (?:a|an|the) \d+(?:[.,]\d+)? ?(?:euro|eur|dollar|usd|pound|gbp)[ -][^?!;]{1,100}\bcost)[?.!]?$/i;
const PRICE_QUESTION =
  /^(?:wat (?:kost|kosten)\b|how much (?:does|do)\b[^?!;]{0,120}\bcost\b)/i;
const PRICE_CHECK =
  /\b(?:check|controleer|verify|zoek)\b.{0,80}\b(?:prijs|prijzen|price|prices)\b/i;
const EXCHANGE_REQUEST =
  /\b(?:omreken\w*|convert\w*|exchange|wisselkoers|koers|worth|waard|in dollars?|in euros?|naar dollars?|naar euros?|to usd|to eur)\b/i;
export const requiresLiveData = (
  message: string,
  hasAttachments = false,
): boolean => {
  if (PERSONAL_CHAT.test(message) && !EXPLICIT_REQUEST.test(message))
    return false;
  if (hasAttachments) {
    if (!LIVE_WITH_FILES.test(message)) return false;
    if (ATTACHMENT_REFERENCE.test(message) && !OUTSIDE_ATTACHMENT.test(message))
      return false;
  }
  if (
    PROVIDED_PRICE.test(message) &&
    !FRESH_REQUEST.test(message) &&
    !EXTERNAL_CHECK.test(message) &&
    !EXECUTE_ALSO.test(message) &&
    !EXECUTION_REQUEST.test(message) &&
    !EXCHANGE_REQUEST.test(message)
  )
    return false;
  if (CODE_ONLY.test(message) && !EXECUTE_ALSO.test(message)) return false;
  if (
    EXPLAIN_ONLY.test(message) &&
    !FRESH_REQUEST.test(message) &&
    !OWN_DIAGNOSIS.test(message) &&
    !EXECUTE_ALSO.test(message)
  )
    return false;
  return (
    LIVE_DATA.test(message) ||
    PRICE_QUESTION.test(message) ||
    PRICE_CHECK.test(message) ||
    EXECUTION_REQUEST.test(message) ||
    (EXTERNAL_CHECK.test(message) && FRESH_REQUEST.test(message))
  );
};

export function responseStyle(
  inputMode: "text" | "voice" = "text",
  quietHours = false,
): string {
  const manner =
    "Answer the user's actual request in their language. Be calm, warm and capable, like a trusted personal assistant. Give the useful result, not a tool report. Keep simple answers brief; give enough detail for complex requests. Do not force a joke, an opening catchphrase or a follow-up question.";
  return inputMode === "voice"
    ? manner +
        (quietHours
          ? " Quiet hours are active: keep the spoken answer brief and limited to the essential result. Do not add an optional offer, filler or follow-up question."
          : " This is a spoken conversation: use natural sentences and no markdown. Start with the key point; expand when asked.")
    : manner +
        " This is typed chat: use readable paragraphs, lists, links, tables or code when they help, especially for documents and technical help. Do not arbitrarily stop after four sentences.";
}

export function codeResponseStyle(language: "nl" | "en" = "nl"): string {
  return language === "en"
    ? "Code mode: be direct and technically precise. Do not apply the warm conversation persona or add jokes. Explain the approach briefly in English, then put requested code in fenced blocks. For voice requests, place a short plain-language summary before the code; code itself is for the screen, not speech."
    : "Code mode: be direct and technically precise. Do not apply the warm conversation persona or add jokes. Explain the approach briefly in Dutch, then put requested code in fenced blocks. For voice requests, place a short plain-language summary before the code; code itself is for the screen, not speech.";
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
  quietHours?: boolean;
  communicationPreferences?: CommunicationPreference[];
  responseLanguage?: "nl" | "en";
  modelRole?: Exclude<ModelRoleId, "embedding">;
  /** The confirmation the user is answering, when the interface knows it. */
  confirmationId?: string;
  stream?: boolean;
  emit?: Emit;
  signal?: AbortSignal;
  /** Restricted Node-RED generated flows: expose and execute read-only tools only. */
  readOnlyOnly?: boolean;
}

export interface Reply {
  reply: string;
  model: string | null;
  usage: Record<string, unknown> | null;
  confirmation?: PendingConfirmation;
  routing?: GatewayMetadata;
  result?: unknown;
  role?: ModelRoleId;
  mood?: AssistantMood;
  /** Required external evidence was unavailable; autonomous callers may retry. */
  unavailable?: true;
}

export function classifyModelRole(
  message: string,
  attachments: ChatAttachment[] = [],
): Exclude<ModelRoleId, "embedding"> {
  if (attachments.some((item) => item.mimeType?.startsWith("image/")))
    return "vision";
  // Classify the requested outcome before the subject: "summarize this Python
  // code" needs a summary model, even though it mentions code.
  if (
    /\b(vat|samenvat|samenvatting|kort overzicht|tl;?dr|summari[sz]e)\b/i.test(
      message,
    )
  )
    return "summary";
  if (
    /\b(plan|planning|stappenplan|roadmap|ontwerp|architectuur|aanpak)\b/i.test(
      message,
    )
  )
    return "planning";
  if (
    /\b(code|programmeer|programmeren|script|functie|typescript|javascript|python|powershell|html|css|debug|bugfix)\b/i.test(
      message,
    )
  )
    return "code";
  return "conversation";
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
      maxTokens?: number;
      roleModel?: { role: ModelRoleId; modelId: string };
      tools: ReturnType<ToolsService["forModel"]>;
      includeMood?: boolean;
    },
  ): Promise<ModelAnswer> {
    const quiet: Emit = (event, data) => {
      if (event !== "token" && event !== "mood") options.emit(event, data);
    };
    const tools = options.tools;
    const attempt = (
      toolChoice: "auto" | "required",
      extra: ModelMessage[] = [],
    ) =>
      this.client.call([...messages, ...extra], {
        ...options,
        emit: quiet,
        toolChoice,
        tools,
        maxTokens: options.maxTokens,
        roleModel: options.roleModel,
        includeMood: options.includeMood,
      });
    let result: ModelAnswer;
    try {
      result = await attempt("required");
    } catch (error) {
      if (options.signal?.aborted) throw error;
      result = await attempt("auto", [REMINDER]);
    }
    if (options.signal?.aborted) throw new Error("Request cancelled");
    if (!result.assistant.tool_calls?.length) {
      result = await attempt("required", [REMINDER]).catch((error) => {
        if (options.signal?.aborted) throw error;
        return result;
      });
    }
    return result;
  }

  async run(input: OrchestrateInput): Promise<Reply> {
    const {
      sessionId,
      message,
      confirmationId,
      modelRole,
      responseLanguage,
      stream = false,
      emit = () => {},
      signal,
    } = input;
    const direct = await this.confirmationHandler.handle(
      sessionId,
      message,
      confirmationId,
      false,
      responseLanguage,
    );
    if (direct) {
      if (stream) emit("token", { text: direct.reply });
      return { ...direct, model: null, usage: null };
    }
    if (!input.attachments?.length && !confirmationId) {
      const reply = directAnswer(message, responseLanguage);
      if (reply !== null) {
        this.confirmations.cancel(sessionId);
        const role = modelRole ?? "conversation";
        if (stream) {
          emit("route", { role });
          emit("token", { text: reply });
        }
        return { reply, model: null, usage: null, role };
      }
      const currency = directCurrencyQuery(message, responseLanguage);
      if (currency) {
        this.confirmations.cancel(sessionId);
        const role = modelRole ?? "conversation";
        const result = await this.tools.execute(
          "currency_convert",
          { amount: currency.amount, from: currency.from, to: currency.to },
          sessionId,
          null,
          false,
          { signal, readOnlyOnly: input.readOnlyOnly },
        );
        const currencyReply = directCurrencyReply(
          result.ok ? result.result : null,
          currency.language,
        );
        if (stream) {
          emit("route", { role });
          emit("token", { text: currencyReply });
        }
        return { reply: currencyReply, model: null, usage: null, role };
      }
      const definition = directDefinitionQuery(message, responseLanguage);
      if (definition) {
        this.confirmations.cancel(sessionId);
        const role = modelRole ?? "conversation";
        let reply: string;
        if (sanitize(definition.query) !== definition.query) {
          reply =
            definition.language === "en"
              ? "I can't send a definition request that contains sensitive information to a public source."
              : "Ik stuur geen zoekopdracht met gevoelige gegevens naar een openbare bron.";
        } else {
          const result = await this.tools.execute(
            "wikipedia",
            { query: definition.query, language: definition.language },
            sessionId,
            null,
            false,
            { signal, readOnlyOnly: input.readOnlyOnly },
          );
          reply = directDefinitionReply(
            result.ok ? result.result : null,
            definition.language,
            input.inputMode === "voice",
          );
        }
        if (stream) {
          emit("route", { role });
          emit("token", { text: reply });
        }
        return { reply, model: null, usage: null, role };
      }
    }
    this.confirmations.cancel(sessionId);
    this.routing.assertFree();
    const role = modelRole ?? classifyModelRole(message, input.attachments);
    const preferredModel = this.routing.preferredModelForRole(role);
    if (
      input.attachments?.some((item) => item.mimeType?.startsWith("image/")) &&
      (role !== "vision" || !preferredModel)
    )
      throw new FreeRoutingBlockedError(
        "No verified free vision model is configured for image input",
      );
    const roleModel = preferredModel
      ? { role, modelId: preferredModel }
      : undefined;
    emit("route", { role });

    const allTools = this.tools
      .list()
      .filter(
        (tool) =>
          tool.enabled && (!input.readOnlyOnly || tool.risk === "READ_ONLY"),
      );
    const modelTools = this.tools.forModel(
      { message, role },
      input.readOnlyOnly,
    );
    emit("tools", {
      count: modelTools.length,
      total: allTools.length,
      names: modelTools.map((tool) => tool.function.name),
    });
    const messages: ModelInputMessage[] = await this.context.build(
      sessionId,
      message,
      role,
      input.communicationPreferences,
    );
    if (responseLanguage)
      messages.splice(1, 0, {
        role: "system",
        content:
          responseLanguage === "en"
            ? "For this conversation, answer in English. Keep names and quoted source text unchanged."
            : "Schrijf in dit gesprek in het Nederlands. Laat namen en geciteerde brontekst ongewijzigd.",
      });
    const style = responseStyle(input.inputMode, input.quietHours);
    messages.splice(1, 0, { role: "system", content: style });
    if (role === "conversation")
      messages.splice(1, 0, { role: "system", content: MOOD_STYLE });
    if (role === "code")
      messages.splice(1, 0, {
        role: "system",
        content: codeResponseStyle(responseLanguage),
      });
    if (input.attachments?.length) {
      const prepared = await attachmentMessage(input.attachments, message);
      for (const notice of prepared.notices)
        emit("attachment_notice", { message: notice });
      // Keep the user's question last, alongside its files, instead of two competing user messages.
      messages[messages.length - 1] = prepared.message;
    }
    const notes = capabilityNotes(
      allTools.map((tool) => tool.name),
      message,
      responseLanguage,
    );
    if (notes) messages.splice(1, 0, { role: "system", content: notes });

    const requiredEvidence = requiresLiveData(
      message,
      !!input.attachments?.length,
    );
    const mustUseTool = modelTools.length > 0 && requiredEvidence;
    const rounds = this.config.maxToolRounds;
    let emptyRetried = false;
    let completedSteps = 0;
    let liveToolAttempted = false;
    let requiredReadAttempted = false;
    let requiredEvidenceSucceeded = false;
    const evidenceUnavailable = () => {
      const reply = requiredReadAttempted
        ? responseLanguage === "en"
          ? "I could not verify the current information. Please try again later."
          : "Ik kon de actuele gegevens niet controleren. Probeer het straks nog eens."
        : responseLanguage === "en"
          ? "I could not complete your request right now. Please try again later."
          : "Ik kon je verzoek nu niet afronden. Probeer het straks nog eens.";
      if (stream) emit("token", { text: reply });
      return reply;
    };
    if (signal?.aborted) throw new Error("Request cancelled");
    if (requiredEvidence && !modelTools.length)
      return {
        reply: evidenceUnavailable(),
        model: null,
        usage: null,
        role,
        unavailable: true,
      };

    for (let round = 0; round < rounds; round++) {
      if (signal?.aborted) throw new Error("Request cancelled");
      // Speculative narration after failed live reads cannot reach speech or the interface.
      // A tool-bearing round's preface is discarded; a successful alternate read reopens narration.
      const roundEmit: Emit =
        requiredEvidence && !requiredEvidenceSucceeded
          ? (event, data) => {
              if (event !== "token" && event !== "mood") emit(event, data);
            }
          : emit;
      const last =
        mustUseTool && !liveToolAttempted
          ? await this.firstRoundWithTool(messages, {
              stream,
              emit: roundEmit,
              signal,
              sessionId,
              maxTokens:
                input.inputMode === "voice"
                  ? input.quietHours
                    ? 500
                    : 1000
                  : 2400,
              roleModel,
              tools: modelTools,
              includeMood: role === "conversation",
            })
          : await this.client.call(messages, {
              stream,
              emit: roundEmit,
              signal,
              sessionId,
              tools: modelTools,
              maxTokens:
                input.inputMode === "voice"
                  ? input.quietHours
                    ? 500
                    : 1000
                  : 2400,
              roleModel,
              includeMood: role === "conversation",
            });
      if (signal?.aborted) throw new Error("Request cancelled");
      const assistant = last.assistant;
      // A model that asks for more than eight calls at once gets its first eight run.
      const calls = (assistant.tool_calls ?? []).slice(0, 8);
      if (assistant.tool_calls && assistant.tool_calls.length > calls.length)
        assistant.tool_calls = calls;
      const base = {
        model: last.model,
        usage: last.usage,
        routing: last.metadata,
        role,
      };

      if (!calls.length && requiredEvidence && !requiredEvidenceSucceeded) {
        return { reply: evidenceUnavailable(), ...base, unavailable: true };
      }
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
      if (!calls.length)
        return {
          reply: assistant.content ?? "",
          ...base,
          ...(role === "conversation" ? { mood: last.mood ?? "neutral" } : {}),
        };
      if (round === rounds - 1)
        throw new Error("Maximum tool-call rounds reached");

      messages.push({ ...assistant, role: "assistant" });
      for (const call of calls) {
        if (!call.id || !call.function?.name)
          throw new Error("Malformed tool call");
        const name = call.function.name;
        const args = parseToolArguments(call.function.arguments);
        emit("tool_start", { name, step: completedSteps + 1 });
        const result = await this.tools.execute(
          name,
          args,
          sessionId,
          null,
          false,
          { signal, readOnlyOnly: input.readOnlyOnly },
        );
        if (signal?.aborted) throw new Error("Request cancelled");
        if (
          name === TOOL_DISCOVERY_NAME &&
          result.ok &&
          args &&
          typeof args.query === "string"
        ) {
          const expanded = this.tools.expandModelTools(
            modelTools,
            args.query,
            input.readOnlyOnly,
          );
          modelTools.splice(0, modelTools.length, ...expanded);
          emit("tools", {
            count: modelTools.length,
            total: allTools.length,
            names: modelTools.map((tool) => tool.function.name),
          });
        } else if (name !== TOOL_DISCOVERY_NAME) {
          liveToolAttempted = true;
        }
        completedSteps++;
        const risk =
          this.tools.list().find((tool) => tool.name === name)?.risk ?? null;
        if (requiredEvidence && name !== TOOL_DISCOVERY_NAME && risk !== null) {
          if (risk === "READ_ONLY") requiredReadAttempted = true;
          if (
            result.ok === true &&
            result.executed !== false &&
            result.verified !== false
          )
            requiredEvidenceSucceeded = true;
        }
        emit("tool_result", {
          name,
          risk,
          pendingConfirmation: result.requiresConfirmation === true,
          ok: result.ok,
          standingApproval: result.standingApproval === true,
          accepted: result.accepted === true,
          verified: result.verified ?? null,
          status: (result.status as string | undefined) ?? null,
        });
        if (result.ambiguous && Array.isArray(result.candidates)) {
          const choices = result.candidates
            .flatMap((candidate) => {
              if (!candidate || typeof candidate !== "object") return [];
              const item = candidate as Record<string, unknown>;
              return typeof item.entity_id === "string" &&
                /^[a-z][a-z0-9_]*\.[a-z0-9_]+$/i.test(item.entity_id) &&
                item.entity_id.length <= 200 &&
                typeof item.name === "string"
                ? [{ entityId: item.entity_id, label: item.name }]
                : [];
            })
            .slice(0, 10);
          if (choices.length) emit("choices", { choices });
        }
        if (result.requiresConfirmation && result.action) {
          const reply = confirmationQuestion(
            result.action,
            responseLanguage === "en" ||
              /\b(please|restart|reboot|start|stop)\b/i.test(message),
          );
          emit(
            "confirmation",
            result.action as unknown as Record<string, unknown>,
          );
          if (stream) emit("token", { text: reply });
          return { reply, ...base, confirmation: result.action };
        }
        // Mutation evidence owns the response before another model or batch action can run.
        // Read-only failures remain recoverable through the existing tool loop.
        if (risk === "SAFE" || risk === "CONFIRM" || risk === "DANGEROUS") {
          const english = responseLanguage === "en";
          const reply =
            result.executed === false
              ? english
                ? "The action was not executed."
                : "De actie is niet uitgevoerd."
              : result.verified === false
                ? english
                  ? "The check did not confirm that the action succeeded."
                  : "De controle heeft niet bevestigd dat de actie is gelukt."
                : (result.ok && result.verified === null) ||
                    (result.accepted === true && result.verified !== true)
                  ? english
                    ? "The action was requested, but I could not verify that it completed."
                    : "De actie is aangevraagd, maar ik kon niet controleren of die is voltooid."
                  : result.ok === false
                    ? english
                      ? "The action failed. Check the current state before trying again."
                      : "De actie is niet gelukt. Controleer de huidige toestand voordat je het opnieuw probeert."
                    : null;
          if (reply !== null) {
            if (stream) emit("token", { text: reply });
            return { reply, ...base };
          }
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
