/** Navigation and search share one catalogue. IDs are stable deep links. */
export const SECTIONS = [
  {
    id: "setup",
    name: "Installatie",
    detail: "Controleer NOVA stap voor stap na een nieuwe installatie.",
    keywords:
      "installatie starten instellen onboarding sleutel account stem verbinding",
  },
  {
    id: "general",
    name: "Algemeen",
    detail: "Beginscherm, snelle opdrachten en zijbalk.",
    keywords: "widget panelen sidebar knoppen zoeken",
  },
  {
    id: "voice",
    name: "Stem en geluid",
    detail: "Volume en microfoon op dit apparaat.",
    keywords: "spraak audio luidspreker luisteren",
  },
  {
    id: "personality",
    name: "Persoonlijkheid",
    detail: "Eigen regels voor hoe NOVA met je praat.",
    keywords: "gedrag persona toon butler naam",
  },
  {
    id: "models",
    name: "Modellen",
    detail: "Gratis AI en de geverifieerde OmniRoute-verbinding.",
    keywords: "provider account route combo model gateway limieten",
  },
  {
    id: "code",
    name: "Codeprojecten",
    detail: "Maak een lokaal project aan en kies welk project actief is.",
    keywords: "code werkruimte workspace projecten aanmaken openen",
  },
  {
    id: "abilities",
    name: "Gereedschappen",
    detail: "Wat NOVA mag doen en de beschikbare tools.",
    keywords: "vaardigheden tools risico rechten",
  },
  {
    id: "skills",
    name: "Eigen vaardigheden",
    detail: "Instructies en koppelingen die je zelf maakt.",
    keywords: "skill webhook testen geschiedenis",
  },
  {
    id: "automation",
    name: "Automatisering",
    detail: "Node-RED wordt hier beheerd zodra de nieuwe koppeling klaar is.",
    keywords: "flows nodes node-red planning routines",
  },
  {
    id: "connections",
    name: "Koppelingen",
    detail: "Bekijk welke diensten bereikbaar zijn.",
    keywords: "home assistant proxmox termix pangolin mqtt qdrant integraties",
  },
  {
    id: "devices",
    name: "Apparaten",
    detail: "Windows-agent, helper, achtergrond en telefoon.",
    keywords: "wallpaper scherm display sneltoets pwa downloaden",
  },
  {
    id: "memory",
    name: "Geheugen en privacy",
    detail: "Bekijk wat NOVA onthoudt en verwijder het met bevestiging.",
    keywords: "onthouden vergeten persoonsgegevens",
  },
  {
    id: "safety",
    name: "Veiligheid",
    detail: "Bekijk en trek blijvende toestemmingen in.",
    keywords: "altijd goedkeuring confirm pin bevestiging beveiliging",
  },
  {
    id: "system",
    name: "Systeem",
    detail: "Back-up, importeren en het actielog.",
    keywords: "export import backup back-up audit logs status updates versie",
  },
] as const;

export type SettingsSection = (typeof SECTIONS)[number]["id"];

export function settingsSection(value: string | null): SettingsSection {
  const legacy: Record<string, SettingsSection> = {
    behavior: "personality",
    sidebar: "general",
    more: "system",
  };
  const id = value ? (legacy[value] ?? value) : "general";
  return SECTIONS.find((section) => section.id === id)?.id ?? "general";
}

export function searchSettings(query: string) {
  const words = query
    .trim()
    .toLocaleLowerCase("nl-NL")
    .split(/\s+/)
    .filter(Boolean);
  return SECTIONS.filter((section) => {
    const text =
      `${section.name} ${section.detail} ${section.keywords}`.toLocaleLowerCase(
        "nl-NL",
      );
    return words.every((word) => text.includes(word));
  });
}
