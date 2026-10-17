/**
 * Navigation and search share one catalogue.
 *
 * Seven groups in plain Dutch; each group holds one or more pages ("parts").
 * Part ids are the stable deep links (`/settings?section=<id>`), so every
 * older link keeps working. Rarely used items sit under "Geavanceerd" on the
 * page itself, but stay searchable through the keywords here.
 */
export const GROUPS = [
  {
    id: "algemeen",
    name: "Algemeen",
    purpose: "Hoe NOVA eruitziet, klinkt en wat ze onthoudt.",
    parts: ["general", "personality", "memory", "documents"],
  },
  {
    id: "stem",
    name: "Stem en gesprekken",
    purpose: "Hoe je met NOVA praat en hoe ze terugpraat.",
    parts: ["voice", "conversation"],
  },
  {
    id: "huis",
    name: "Slimme huis en apparaten",
    purpose: "Koppel je huis, je pc en je telefoon aan NOVA.",
    parts: ["connections", "devices", "desktop"],
  },
  {
    id: "telefoon",
    name: "Telefoon",
    purpose: "Bellen en gebeld worden via NOVA, ook de deurbel.",
    parts: ["telephony"],
  },
  {
    id: "ai",
    name: "Modellen en AI",
    purpose: "Welke AI NOVA gebruikt en wat ze zelf mag doen.",
    parts: ["models", "abilities", "skills", "code"],
  },
  {
    id: "automatisering",
    name: "Automatisering",
    purpose: "Taken en routines die NOVA zelf uitvoert.",
    parts: ["autonomy", "objectives", "automation"],
  },
  {
    id: "beheer",
    name: "Geavanceerd en beheer",
    purpose: "Installatie, veiligheid, back-ups en techniek.",
    parts: ["setup", "safety", "services", "system"],
  },
] as const;

export type SettingsGroup = (typeof GROUPS)[number]["id"];

export const SECTIONS = [
  {
    id: "setup",
    name: "Installatie",
    detail: "Loop na een nieuwe installatie de stappen langs.",
    keywords:
      "installatie starten instellen onboarding sleutel account stem verbinding",
  },
  {
    id: "general",
    name: "Beginscherm",
    detail: "Kies wat je op het beginscherm en in de zijbalk ziet.",
    keywords:
      "algemeen widget panelen sidebar zijbalk snelle opdrachten knoppen zoeken",
  },
  {
    id: "voice",
    name: "Stem en geluid",
    detail: "Kies de stem, het volume en test je microfoon.",
    keywords: "spraak audio luidspreker luisteren microfoon volume",
  },
  {
    id: "personality",
    name: "Persoonlijkheid",
    detail: "Bepaal hoe NOVA tegen je praat.",
    keywords: "gedrag persona toon butler naam karakter gezin profiel stijl",
  },
  {
    id: "models",
    name: "Modellen",
    detail: "Kies welke AI NOVA gebruikt. Gratis modellen staan standaard aan.",
    keywords:
      "ai provider account route combo model gateway limieten omniroute sleutel",
  },
  {
    id: "code",
    name: "Codeprojecten",
    detail: "Maak een project aan en kies welk project actief is.",
    keywords: "code werkruimte workspace projecten aanmaken openen",
  },
  {
    id: "abilities",
    name: "Wat NOVA mag doen",
    detail: "Zet vaardigheden en gereedschappen aan of uit.",
    keywords: "gereedschappen vaardigheden tools risico rechten toestemming",
  },
  {
    id: "skills",
    name: "Eigen vaardigheden",
    detail: "Leer NOVA zelf bedachte instructies en koppelingen.",
    keywords: "skill webhook testen geschiedenis",
  },
  {
    id: "automation",
    name: "Node-RED-flows",
    detail: "Bekijk en beheer de flows achter je automatiseringen.",
    keywords: "flows nodes node-red planning routines editor palet logs",
  },
  {
    id: "services",
    name: "Services en MCP",
    detail: "Zie of de achtergrondservices en MCP-servers draaien.",
    keywords:
      "workers containers broker verbinding services mcp server status herstarten",
  },
  {
    id: "connections",
    name: "Koppelingen",
    detail: "Verbind NOVA met Home Assistant en andere diensten.",
    keywords:
      "home assistant proxmox termix pangolin mqtt qdrant integraties huis domotica",
  },
  {
    id: "devices",
    name: "Apparaten",
    detail: "Beheer de Windows-helper, achtergrond en je telefoon.",
    keywords:
      "windows agent helper wallpaper achtergrond scherm display sneltoets pwa downloaden telefoon",
  },
  {
    id: "desktop",
    name: "Pc bedienen",
    detail: "Laat NOVA meekijken op je scherm en de pc kort bedienen.",
    keywords:
      "bureaublad scherm pc overnemen muis toetsenbord screenshot windows besturen",
  },
  {
    id: "conversation",
    name: "Gesprekken",
    detail: "Praat echt met NOVA, ook via de telefoon (nummer 700).",
    keywords:
      "gesprek bellen telefoon spraak praten stem luisteren onderbreken",
  },
  {
    id: "autonomy",
    name: "Zelfstandige taken",
    detail: "Taken die NOVA zelf doet: op een tijdstip of bij een gebeurtenis.",
    keywords:
      "autonoom taak automatisering gebeurtenis node-red goedkeuren plannen herhalend",
  },
  {
    id: "objectives",
    name: "Doelen",
    detail:
      "Dingen die NOVA blijft controleren en alleen meldt als er iets afwijkt.",
    keywords:
      "doel doelen monitoren in de gaten houden bewaken controle afwijking storing valse alarm servers stille uren pauzeren hervatten",
  },
  {
    id: "telephony",
    name: "Telefoon",
    detail: "Eigen telefooncentrale met Linphone-toestellen en deurbel.",
    keywords:
      "telefonie bellen telefoon asterisk linphone sip deurbel intercom toestel nummer trunk voip sms berichten",
  },
  {
    id: "memory",
    name: "Geheugen en privacy",
    detail: "Zoek in wat NOVA onthoudt, corrigeer het of laat het vergeten.",
    keywords:
      "geheugen onthouden vergeten corrigeren persoonsgegevens privacy herinneringen feit voorkeur besluit aanname episode project eerdere versies gevoelig",
  },
  {
    id: "documents",
    name: "Documenten",
    detail: "Upload privédocumenten en zoek er later in via de chat.",
    keywords:
      "documentbibliotheek pdf docx upload bibliotheek qdrant bestanden",
  },
  {
    id: "safety",
    name: "Toestemmingen",
    detail: "Bekijk en trek blijvende toestemmingen in.",
    keywords:
      "veiligheid altijd goedkeuring confirm pin bevestiging beveiliging",
  },
  {
    id: "system",
    name: "Back-up en updates",
    detail: "Maak een back-up, zet er een terug en bekijk het actielog.",
    keywords:
      "systeem export import backup back-up audit logs status updates versie actielog",
  },
] as const;

export type SettingsSection = (typeof SECTIONS)[number]["id"];

export const GROUP_OF: Record<SettingsSection, SettingsGroup> =
  Object.fromEntries(
    GROUPS.flatMap((group) => group.parts.map((part) => [part, group.id])),
  ) as Record<SettingsSection, SettingsGroup>;

export function sectionInfo(id: SettingsSection) {
  return SECTIONS.find((section) => section.id === id)!;
}

export function groupInfo(id: SettingsGroup) {
  return GROUPS.find((group) => group.id === id)!;
}

export function settingsSection(value: string | null): SettingsSection {
  const legacy: Record<string, SettingsSection> = {
    behavior: "personality",
    sidebar: "general",
    more: "system",
  };
  const id = value ? (legacy[value] ?? value) : "general";
  const group = GROUPS.find((item) => item.id === id);
  if (group) return group.parts[0];
  return SECTIONS.find((section) => section.id === id)?.id ?? "general";
}

export function searchSettings(query: string) {
  const words = query
    .trim()
    .toLocaleLowerCase("nl-NL")
    .split(/\s+/)
    .filter(Boolean);
  const lower = (text: string) => text.toLocaleLowerCase("nl-NL");
  const rank = (section: (typeof SECTIONS)[number]) =>
    words.every((word) => lower(section.name).includes(word)) ? 0 : 1;
  return SECTIONS.filter((section) => {
    const group = groupInfo(GROUP_OF[section.id]);
    const text = lower(
      `${section.name} ${section.detail} ${section.keywords} ${group.name}`,
    );
    return words.every((word) => text.includes(word));
  }).sort((a, b) => rank(a) - rank(b));
}
