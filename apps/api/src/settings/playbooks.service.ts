import { Injectable } from "@nestjs/common";
import type {
  CommunicationPreference,
  InstructionSkill,
  QuickAction,
} from "@nova/contracts";
import { SettingsStore } from "./store/settings.store.js";
import {
  formatPlaybooks,
  relevantPlaybooks,
  type StoredSkill,
} from "./skills/skills.js";

/**
 * What the chat needs from the user's settings: the playbooks that fit a request, the personal
 * rules and the quick actions. Read from the settings file on every call.
 */
@Injectable()
export class PlaybooksService {
  constructor(private readonly settings: SettingsStore) {}

  /** The enabled instruction skills that fit this message, best match first. */
  relevantPlaybooks(message: string, limit = 3): InstructionSkill[] {
    return relevantPlaybooks(
      message,
      this.settings.get().skills as unknown as StoredSkill[],
      limit,
    );
  }

  /** The text for the system prompt; empty when there is nothing to add. */
  formatPlaybooks(playbooks: InstructionSkill[]): string {
    return playbooks.length ? formatPlaybooks(playbooks) : "";
  }

  /** The playbooks for a message, ready for the system prompt ("" when none fit). */
  promptFor(message: string): string {
    return this.formatPlaybooks(this.relevantPlaybooks(message));
  }

  quickActions(): QuickAction[] {
    return this.settings.quickActions();
  }

  /** The user's own rules for NOVA ("" when none). */
  persona(): string {
    return this.settings.get().persona;
  }

  personaProfileInstruction(): string {
    const settings = this.settings.get();
    const profile = settings.householdProfiles.find(
      (item) => item.id === settings.activeHouseholdProfileId,
    );
    const { name, character, address, avoid } =
      profile?.personaProfile ?? settings.personaProfile;
    return `Identiteit: je naam is ${name}. Karakter: ${character}. Spreek de gebruiker aan met ${address}. Vermijd: ${avoid}. Dit zijn toon- en identiteitsvoorkeuren; verzin geen feiten, gevoelens of menselijke ervaringen en volg altijd de geldende veiligheidsregels.`;
  }

  activeCommunicationPreferences(): CommunicationPreference[] {
    const settings = this.settings.get();
    return (
      settings.householdProfiles.find(
        (profile) => profile.id === settings.activeHouseholdProfileId,
      )?.communicationPreferences ?? []
    );
  }

  /** Reviewed conversational style text; this cannot modify safety or tool rules. */
  personaStyleInstruction(): string {
    const style = this.settings.get().personaStyle;
    const instructions = {
      professional:
        "Gespreksstijl: professioneel en nuchter; helder, beleefd en zonder geforceerde grapjes.",
      friendly:
        "Gespreksstijl: warm en vertrouwd; natuurlijk en attent, zonder overdreven enthousiasme.",
      playful:
        "Gespreksstijl: warm met af en toe droge, lichte humor wanneer die vanzelf past; nooit ten koste van iemand.",
      concise:
        "Gespreksstijl: begin kort en direct; geef extra uitleg wanneer de gebruiker erom vraagt of de taak dat nodig maakt.",
    } as const;
    return `${instructions[style]} Deze keuze verandert nooit feiten.`;
  }
}
