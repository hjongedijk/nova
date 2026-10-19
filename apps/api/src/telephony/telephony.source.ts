import {
  schema,
  text,
  ToolSourceProvider,
  type ToolDefinition,
  type ToolPlan,
  type ToolPlanError,
  type ToolResult,
  type ToolSource,
} from "../tools/tool.types.js";
import { TelephonyService } from "./telephony.service.js";
import { TelephonyError } from "./telephony.types.js";

/** Phone tools: status, conversational calls, optional announcements and hanging up. */
@ToolSourceProvider()
export class TelephonySource implements ToolSource {
  readonly source = "telephony";
  constructor(private readonly telephony: TelephonyService) {}

  definitions(): ToolDefinition[] {
    const enabled = this.telephony.enabled;
    return [
      {
        name: "phone_status",
        description:
          "Show the phone system: whether it is on, which extensions are registered (online), active calls and recent call events.",
        parameters: schema(),
        risk: "READ_ONLY",
        enabled,
      },
      {
        name: "phone_call",
        description:
          'Call an internal extension (3-4 digits, e.g. "101"), an external number (digits, optional +, needs a SIP trunk) or a saved contact by name (see phone_status), and speak "message" when they answer. By default NOVA has a two-way spoken conversation that opens with "message" (needs Gesprekken switched on). Set conversation=false only for a one-way announcement that hangs up after speaking.',
        parameters: schema(
          {
            to: text(60),
            message: text(500),
            conversation: {
              type: "boolean",
              default: true,
              description:
                "Keep the call open for a two-way conversation (default). Set false only for a one-way announcement.",
            },
          },
          ["to", "message"],
        ),
        risk: "CONFIRM",
        allowStandingApproval: false,
        timeoutMs: 45_000,
        enabled,
      },
      {
        name: "phone_hangup",
        description:
          "Hang up an active call by its id (see phone_status) when the user asks to end it.",
        parameters: schema({ callId: text(128) }),
        risk: "SAFE",
        enabled,
      },
    ];
  }

  /** Resolve the destination and retain call classification metadata. */
  async prepare(
    name: string,
    args: Record<string, unknown>,
  ): Promise<ToolPlan | ToolPlanError> {
    if (name !== "phone_call") return { args, risk: this.riskOf(name) };
    const target = this.telephony.classify(args.to);
    if (!target) return { error: "Onbekend toestel of ongeldig nummer." };
    const internalOk =
      target.kind === "internal" &&
      this.telephony.allowsInternalWithoutConfirmation();
    // A call to your own phone or a saved contact is routine; a raw external number is not.
    const routine =
      target.kind === "internal" || this.telephony.isContact(target.number);
    return {
      routine,
      args: {
        to: target.number,
        message: args.message,
        conversation: args.conversation !== false,
      },
      risk: internalOk ? "SAFE" : "CONFIRM",
    };
  }

  private riskOf(name: string) {
    return name === "phone_status" ? ("READ_ONLY" as const) : ("SAFE" as const);
  }

  async execute(
    name: string,
    args: Record<string, unknown>,
  ): Promise<ToolResult> {
    try {
      if (name === "phone_status") {
        const [status, calls] = await Promise.all([
          this.telephony.status(),
          this.telephony.enabled
            ? this.telephony.listCalls().catch(() => [])
            : Promise.resolve([]),
        ]);
        return {
          ok: true,
          result: {
            ...status,
            calls,
            events: this.telephony.recentEvents().slice(-10),
          },
        };
      }
      if (name === "phone_call") {
        const result = await this.telephony.call(args.to, args.message, {
          conversation: args.conversation !== false,
        });
        return {
          ok: true,
          verified: null,
          result,
          hint:
            args.conversation !== false
              ? "Het gesprek is gestart; NOVA spreekt de openingsboodschap uit en luistert daarna naar het antwoord."
              : "De aankondiging is gestart; de boodschap wordt uitgesproken zodra er wordt opgenomen, daarna wordt opgehangen.",
        };
      }
      if (name === "phone_hangup") {
        await this.telephony.hangup(args.callId);
        return { ok: true, verified: null };
      }
      return { ok: false, error: "Onbekende telefoontool." };
    } catch (error) {
      return {
        ok: false,
        error:
          error instanceof TelephonyError
            ? error.message
            : "De telefoonactie is mislukt.",
      };
    }
  }
}
