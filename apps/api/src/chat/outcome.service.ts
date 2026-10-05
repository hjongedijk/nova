import { Injectable } from "@nestjs/common";
import type { PendingConfirmation } from "@nova/contracts";
import {
  OmniRouteClient,
  type ModelMessage,
} from "./omniroute-client.service.js";

/*
 * After a confirmed action that returned something to read (the output of a command, for example),
 * NOVA tells what came out instead of only "Is gedaan". The model phrases it; if that fails the output
 * itself is shown.
 */
const SYSTEM =
  "Je bent NOVA. De gebruiker vroeg om een actie, bevestigde die, en die is uitgevoerd. Vertel in het Nederlands, kort en natuurlijk (zoals je het hardop zou zeggen), wat eruit kwam: de belangrijkste getallen of bevindingen, en wat opvalt (bijvoorbeeld een schijf die bijna vol is of een foutmelding). Geen tabellen of codeblokken. Verzin niets dat niet in het resultaat staat.";

interface Outcome {
  ok: boolean;
  result?: unknown;
}

const filled = (value: unknown): value is string =>
  typeof value === "string" && value.trim() !== "";

export function hasOutput(outcome: Outcome): boolean {
  const data = outcome.result as Record<string, unknown> | undefined;
  if (!data || typeof data !== "object") return false;
  return filled(data.output) || filled(data.error) || filled(data.stdout);
}

export function plainOutcome(outcome: Outcome): string {
  const data = (outcome.result ?? {}) as Record<string, unknown>;
  const output = String(data.output ?? data.stdout ?? "").trim();
  if (output)
    return `Dit kwam eruit${data.host ? ` op ${data.host}` : ""}:\n${output.slice(0, 1500)}`;
  if (String(data.error ?? "").trim())
    return `Het gaf deze melding: ${String(data.error).trim().slice(0, 500)}`;
  return "Is gedaan.";
}

@Injectable()
export class OutcomeService {
  /** Replaceable in tests. */
  constructor(private readonly client: OmniRouteClient) {}

  async describe(
    input: {
      action: Pick<PendingConfirmation, "tool" | "args">;
      result: Outcome;
      history?: ModelMessage[];
    },
    complete: (messages: ModelMessage[]) => Promise<string> = (messages) =>
      this.client.complete(messages),
  ): Promise<string> {
    try {
      const text = (
        await complete([
          { role: "system", content: SYSTEM },
          ...(input.history ?? []),
          {
            role: "user",
            content: `Uitgevoerd: ${input.action.tool} ${JSON.stringify(input.action.args)}\nResultaat:\n${JSON.stringify(input.result.result).slice(0, 6000)}`,
          },
        ])
      ).trim();
      return text || plainOutcome(input.result);
    } catch {
      return plainOutcome(input.result);
    }
  }
}
