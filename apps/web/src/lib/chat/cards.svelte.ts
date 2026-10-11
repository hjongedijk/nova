import type { PendingConfirmation } from "@nova/contracts";
import { chat } from "#lib/stores/chat.svelte.ts";
import { confirmAction } from "#lib/api/chat.ts";
import { getSessionId } from "./session.ts";

export interface Card {
  id: string;
  tool?: string;
  risk?: PendingConfirmation["risk"];
  allowAlways?: boolean;
  label: string;
  /** Buttons are locked (answered, or the time ran out). */
  locked: boolean;
  /** Answered or expired: shown for a few more seconds without the countdown bar. */
  done: boolean;
  /** Milliseconds the countdown bar takes. */
  ttl: number;
}

/** Confirmation cards in the dock, oldest first. */
export const cards = $state<Card[]>([]);

const CONFIRM_REPLY =
  /^(ja|ja graag|ja hoor|ja doe maar|jazeker|graag|doe maar|oké|oke|ok|okay|prima|akkoord|zeker|ga je gang|bevestig|yes|yes please|confirm|nee|nee hoor|nee dank je|nee bedankt|laat maar|niet doen|annuleer|cancel|no)$/;

/** "ja" / "nee" and friends: an answer to a confirmation card, spoken or typed. */
export const isConfirmReply = (text: string): boolean =>
  CONFIRM_REPLY.test(
    text
      .trim()
      .toLowerCase()
      .replace(/[.!?,]+$/g, ""),
  );

/** The sentence on a card: what is about to happen. */
export function confirmationLabel(action: PendingConfirmation): string {
  const args = action.args as Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any -- free-form tool arguments
  const expiry = "Bevestiging verloopt na 60 seconden.";
  if (action.tool === "node_red_flow_create")
    return args.kind === "daily_reminder"
      ? `Node-RED: maak dagelijks om ${args.time} de melding “${String(args.message || "").slice(0, 240)}” in ${args.label || args.tabId}. De flow bewaart deze tekst en stuurt hem via NOVA. ${expiry}`
      : args.kind === "morning_briefing"
        ? `Node-RED: stel de ochtendbriefing dagelijks in op ${args.time} in ${args.label || args.tabId}. Een actief NOVA-scherm spreekt de korte samenvatting uit. ${expiry}`
        : `Node-RED: voeg een foutenmelding toe aan ${args.label || args.tabId}. Dit meldt alleen foutmeldingen die deze flow opvangt. ${expiry}`;
  if (action.tool === "node_red_flow_state")
    return `Node-RED: ${args.enabled ? "schakel in" : "schakel uit"} tab ${args.tabId}. ${expiry}`;
  if (action.tool === "code_file_write")
    return `Wijzig bestand ${args.projectId ? `${args.projectId}/` : ""}${args.path}.\n\n${String(args.diffPreview || "Verschil niet beschikbaar.").slice(0, 4000)}\n\n${expiry}`;
  if (action.tool === "code_self_test")
    return `Test ${args.path} eerst in de afgesloten sandbox met ${(Array.isArray(args.testCommand) ? args.testCommand : []).join(" ")}. Het voorstel wordt nog niet opgeslagen.\n\n${String(args.diffPreview || "Verschil niet beschikbaar.").slice(0, 4000)}\n\n${expiry}`;
  if (action.tool === "code_self_save")
    return `Sla het succesvol geteste script op in ${args.projectId}/${args.path}.\n\n${String(args.diffPreview || "Verschil niet beschikbaar.").slice(0, 4000)}\n\n${expiry}`;
  if (action.tool === "code_file_delete")
    return `Verwijder bestand ${args.projectId}/${args.path}. Dit kan niet ongedaan worden gemaakt. ${expiry}`;
  if (action.tool === "code_run_tests")
    return `Voer ${(Array.isArray(args.command) ? args.command : []).join(" ") || "testcommando"} uit in de afgesloten project-sandbox. ${expiry}`;
  if (action.tool === "settings_persona_set")
    return `Eigen regels vervangen: ${args.text || "(regels wissen)"}. ${expiry}`;
  if (action.tool === "settings_instruction_create")
    return `Instructie “${args.name}” toevoegen: ${args.instructions}${args.description ? `\nBeschrijving: ${args.description}` : ""}${args.examples?.length ? `\nVoorbeelden: ${args.examples.join("; ")}` : ""}. ${expiry}`;
  if (action.tool === "settings_skill_toggle")
    return `Instructie “${args.id}” ${args.enabled ? "aanzetten" : "uitzetten"}. ${expiry}`;
  if (action.tool === "settings_model_visibility")
    return `Model ${args.provider}/${args.modelId} ${args.hidden ? "verbergen" : "tonen"} in de OmniRoute-catalogus. Dit blokkeert directe modelaanroepen niet; verbergen kan modelaliassen wijzigen. ${expiry}`;
  const values = { ...args, ...args?.data };
  const changes = [
    values.temperature !== undefined ? `${values.temperature} °C` : null,
    values.volume_level !== undefined
      ? `${Math.round(values.volume_level * 100)}% volume`
      : null,
    values.group_members?.join(", "),
    values.message || values.text || values.media_id || values.media_content_id,
  ]
    .filter(Boolean)
    .join("; ");
  const services: Record<string, string> = {
    turn_on: "Aanzetten",
    turn_off: "Uitzetten",
    restart: "Herstarten",
    reboot: "Herstarten",
    stop: "Stoppen",
    start: "Starten",
    set_temperature: "Temperatuur instellen",
    volume_set: "Volume instellen",
  };
  return `${services[String(args?.service)] || action.tool.replaceAll("_", " ")}: ${args?.entity_id || args?.entity_ids?.join(", ") || args?.vmid || args?.id || ""}${changes ? "; " + changes : ""}. Bevestiging verloopt na 60 seconden.`;
}

/** Cards still waiting for an answer, oldest first. */
export const openCardIds = (): string[] =>
  cards.filter((card) => !card.done).map((card) => card.id);

function settle(id: string): void {
  const card = cards.find((item) => item.id === id);
  if (!card || card.done) return;
  card.done = true;
  card.locked = true;
  const open = chat.confirmations.findIndex((c) => c.confirmationId === id);
  if (open >= 0) chat.confirmations.splice(open, 1);
  setTimeout(() => {
    const index = cards.findIndex((item) => item.id === id);
    if (index >= 0) cards.splice(index, 1);
  }, 8000);
}

/** A confirmation event arrived: put its card in the dock. */
export function addCard(action: PendingConfirmation | null | undefined): void {
  if (!action?.confirmationId) return;
  const id = action.confirmationId;
  const wait = Math.max(0, action.expiresAt - Date.now());
  cards.push({
    id,
    tool: action.tool,
    risk: action.risk,
    allowAlways: action.allowAlways,
    label: confirmationLabel(action),
    locked: false,
    done: false,
    ttl: wait,
  });
  chat.confirmations.push(action);
  setTimeout(() => {
    const card = cards.find((item) => item.id === id);
    if (!card) return;
    card.locked = true;
    if (!card.done) {
      card.label =
        "Bevestiging verlopen. Vraag het opnieuw als je wilt doorgaan.";
      settle(id);
    }
  }, wait);
}

/** The Bevestigen / Annuleren buttons. */
export async function answerCard(
  id: string,
  approve: boolean,
  always = false,
): Promise<void> {
  const card = cards.find((item) => item.id === id);
  if (!card) return;
  card.locked = true;
  try {
    const data = await confirmAction(getSessionId(), id, approve, always);
    card.label = data.reply;
    chat.toolResult = data.reply;
    chat.history.push({ role: "assistant", text: data.reply });
    window.dispatchEvent(
      new CustomEvent("nova-helper-confirmed", { detail: approve }),
    );
  } catch (error) {
    card.label = (error as Error).message;
    chat.toolResult = card.label;
    chat.history.push({
      role: "assistant",
      text: `Bevestiging mislukt: ${card.label}`,
    });
  }
  settle(id);
}

/** Close a card with a sentence: the answer to a spoken "ja", or "Niet uitgevoerd ..." for another question. */
export function finishCard(id: string, text: string): void {
  const card = cards.find((item) => item.id === id);
  if (!card) return;
  card.label = text;
  card.locked = true;
  settle(id);
}
