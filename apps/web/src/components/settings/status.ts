import { getConversation } from "#lib/api/conversation.ts";
import { getAutonomyTasks } from "#lib/api/autonomy.ts";
import { getObjectives } from "#lib/api/objectives.ts";
import { getDesktop } from "#lib/api/desktop.ts";
import { getServiceConnections } from "#lib/api/settings.ts";
import { getTelephony } from "#lib/api/telephony.ts";
import type { SettingsOverview } from "@nova/contracts";
import type { SettingsTopic } from "./sections.ts";

export type StatusTone = "ok" | "warn" | "bad" | "neutral";
export interface PartStatus {
  tone: StatusTone;
  label: string;
}

const count = (n: number, one: string, many: string) =>
  `${n} ${n === 1 ? one : many}`;

/**
 * The state of the thing a page controls, in words. Only what the API can
 * confirm gets green; everything else is amber or neutral rather than a
 * comforting guess. Never throws: an unreachable API is a status too.
 */
export async function partStatus(
  id: SettingsTopic,
  data: SettingsOverview | null,
): Promise<PartStatus> {
  try {
    switch (id) {
      case "general": {
        const actions = data?.quickActions.length ?? 0;
        return {
          tone: "ok",
          label: `${count(actions, "snelle opdracht", "snelle opdrachten")} op het beginscherm`,
        };
      }
      case "voice": {
        const mic =
          typeof navigator !== "undefined" && !!navigator.mediaDevices;
        return mic
          ? { tone: "ok", label: "Microfoon beschikbaar in deze browser" }
          : { tone: "warn", label: "Microfoon werkt hier niet (https nodig)" };
      }
      case "personality":
        return { tone: "ok", label: "NOVA volgt je gekozen stijl" };
      case "abilities": {
        const tools = data?.tools ?? [];
        const on = tools.filter((tool) => tool.enabled !== false).length;
        return tools.length
          ? {
              tone: "ok",
              label: `${on} van ${tools.length} gereedschappen aan`,
            }
          : { tone: "neutral", label: "Gereedschappen worden geladen" };
      }
      case "skills": {
        const on = (data?.skills ?? []).filter((s) => s.enabled).length;
        return on
          ? {
              tone: "ok",
              label: count(on, "vaardigheid aan", "vaardigheden aan"),
            }
          : { tone: "neutral", label: "Nog geen eigen vaardigheden" };
      }
      case "safety": {
        const grants = data?.standingApprovals?.length ?? 0;
        return grants
          ? {
              tone: "warn",
              label: count(
                grants,
                "blijvende toestemming",
                "blijvende toestemmingen",
              ),
            }
          : { tone: "ok", label: "NOVA vraagt altijd eerst" };
      }
      case "conversation": {
        const { settings, status } = await getConversation();
        if (!settings.enabled) return { tone: "warn", label: "Uit" };
        return status.speechToText.ready
          ? { tone: "ok", label: "Aan en klaar om te luisteren" }
          : { tone: "bad", label: "Aan, maar spraakherkenning is niet klaar" };
      }
      case "telephony": {
        const phone = await getTelephony();
        if (!phone.enabled) return { tone: "warn", label: "Uit" };
        return phone.connected
          ? { tone: "ok", label: "Aan en verbonden" }
          : {
              tone: "bad",
              label: "Aan, maar de telefooncentrale is niet bereikbaar",
            };
      }
      case "models": {
        const { services } = await getServiceConnections();
        const gateway = services.find((s) => s.id === "omniroute");
        const key = gateway?.fields.find((f) => f.kind === "secret");
        return key?.set
          ? { tone: "ok", label: "AI-verbinding ingesteld" }
          : { tone: "warn", label: "Nog geen sleutel voor de AI-verbinding" };
      }
      case "connections":
      case "devices": {
        const { services } = await getServiceConnections();
        const wanted = services.filter((s) =>
          id === "devices" ? s.id === "windows" : s.id === "home-assistant",
        );
        const ready = wanted.filter((s) =>
          s.fields.every((f) =>
            f.kind === "secret" ? f.set : !!f.value || f.kind === "boolean",
          ),
        ).length;
        const name = id === "devices" ? "Windows-pc" : "Home Assistant";
        return ready
          ? { tone: "ok", label: `${name} is gekoppeld` }
          : { tone: "warn", label: `${name} is nog niet gekoppeld` };
      }
      case "desktop": {
        const desktop = await getDesktop();
        if (!desktop.configured)
          return { tone: "warn", label: "Windows-helper niet gekoppeld" };
        return desktop.settings.viewEnabled || desktop.settings.controlEnabled
          ? {
              tone: "ok",
              label: desktop.settings.controlEnabled
                ? "Meekijken en bedienen aan"
                : "Meekijken aan",
            }
          : { tone: "neutral", label: "Uit: NOVA kijkt niet mee" };
      }
      case "autonomy": {
        const { tasks } = await getAutonomyTasks();
        const waiting = tasks.filter((t) => t.waitingForApproval.length).length;
        if (waiting)
          return {
            tone: "warn",
            label: `${waiting} wacht op jouw goedkeuring`,
          };
        return tasks.length
          ? {
              tone: "ok",
              label: count(tasks.length, "taak actief", "taken actief"),
            }
          : { tone: "neutral", label: "Nog geen taken" };
      }
      case "objectives": {
        const { objectives } = await getObjectives();
        const deviating = objectives.filter(
          (o) => o.enabled && o.activeAnomaly && !o.activeAnomaly.dismissed,
        ).length;
        if (deviating)
          return { tone: "warn", label: `${deviating} met een afwijking` };
        const active = objectives.filter((o) => o.enabled).length;
        return active
          ? {
              tone: "ok",
              label: count(active, "doel actief", "doelen actief"),
            }
          : { tone: "neutral", label: "Nog geen doelen" };
      }
      case "automation": {
        const { services } = await getServiceConnections();
        const flows = services.find((s) => s.id === "node-red");
        return flows?.fields.some((f) => !!f.value)
          ? { tone: "ok", label: "Node-RED ingesteld" }
          : { tone: "warn", label: "Node-RED nog niet ingesteld" };
      }
      default:
        return { tone: "neutral", label: "Altijd beschikbaar" };
    }
  } catch {
    return { tone: "neutral", label: "Status nu niet op te halen" };
  }
}
