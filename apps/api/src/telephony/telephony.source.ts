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

/** Phone tools: status, an announcement call and hanging up. Calls are never auto-approved for external numbers. */
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
          'Call an internal extension (3-4 digits, e.g. "101") or an external number (digits, optional +, needs a SIP trunk) and speak "message" to the person when they answer. NOVA only speaks; it cannot hold a conversation over the phone yet. The user is always asked to confirm external numbers.',
        parameters: schema({ to: text(20), message: text(500) }),
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

  /** External numbers always need a fresh confirmation; internal extensions only when the user allows skipping it. */
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
    return {
      args: { to: target.number, message: args.message },
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
        const result = await this.telephony.call(args.to, args.message);
        return {
          ok: true,
          verified: null,
          result,
          hint: "Het gesprek is gestart; de boodschap wordt uitgesproken zodra er wordt opgenomen.",
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
