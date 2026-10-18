/**
 * Navigation and search share one catalogue.
 *
 * Service pages and task pages plus one expert area ("Geavanceerd"). Every setting
 * lives in exactly one place. A "topic" is one searchable block on a page and
 * keeps its old section id, so every older link (`/settings?section=voice`,
 * `?section=system#actielog`, ...) still resolves to the page and anchor that
 * now holds it.
 */
export const PAGES = [
  {
    id: "gesprek",
    name: "Gesprek en stem",
    detail: "Hoe je met NOVA praat, en hoe zij terugpraat.",
  },
  {
    id: "huis",
    name: "Koppelingen",
    detail: "Home Assistant, Node-RED en je andere verbonden diensten.",
  },
  {
    id: "windows",
    name: "Windows-pc",
    detail: "Koppelen, toegang, meekijken, helper en achtergrond op één plek.",
  },
  {
    id: "telefoon",
    name: "Telefoon",
    detail: "Bellen en gebeld worden via NOVA, ook de deurbel.",
  },
  {
    id: "modellen",
    name: "Slimme modellen",
    detail: "AI-accounts, gratis gebruik, modelkeuze en beschikbaarheid.",
  },
  {
    id: "zelf",
    name: "Taken en functies",
    detail: "Lopende taken, functies en doelen.",
  },
  {
    id: "geheugen",
    name: "Geheugen en privacy",
    detail: "Wat NOVA onthoudt, je documenten en je back-up.",
  },
  {
    id: "geavanceerd",
    name: "Geavanceerd",
    detail: "Gereedschappen, uitbreidingen, onderhoud en diagnostiek.",
  },
] as const;

export type SettingsPage = (typeof PAGES)[number]["id"];

/** The pages in the main navigation; "Geavanceerd" is reachable but set apart. */
export const MAIN_PAGES = PAGES.filter((page) => page.id !== "geavanceerd");

export const TOPICS = [
  {
    id: "general",
    page: "gesprek",
    anchor: "snelle-opdrachten",
    name: "Snelle opdrachten",
    detail: "De knoppen op het beginscherm.",
    keywords: "beginscherm knoppen widget zoeken algemeen",
  },
  {
    id: "voice",
    page: "gesprek",
    anchor: "stem",
    name: "Stem en geluid",
    detail: "Kies de stem, het volume en test je microfoon.",
    keywords:
      "spraak audio luidspreker luisteren microfoon volume snelheid wake word uitspraak",
  },
  {
    id: "conversation",
    page: "gesprek",
    anchor: "gesprekken",
    name: "Praten met NOVA",
    detail: "Praat gewoon met NOVA, ook via de telefoon (nummer 700).",
    keywords: "gesprek bellen telefoon spraak praten luisteren onderbreken 700",
  },
  {
    id: "personality",
    page: "gesprek",
    anchor: "persoonlijkheid",
    name: "Persoonlijkheid",
    detail: "Bepaal hoe NOVA tegen je praat.",
    keywords:
      "gedrag persona toon butler naam karakter gezin profiel stijl regels aanspreekvorm",
  },
  {
    id: "connections",
    page: "huis",
    anchor: "home-assistant",
    name: "Home Assistant",
    detail: "Verbind NOVA met je slimme huis.",
    keywords: "home assistant domotica lampen huis koppelen token toegang",
  },
  {
    id: "devices",
    page: "windows",
    anchor: "pc",
    name: "Windows-pc verbinden en instellen",
    detail: "Koppelcode, pc-toegang, helper en achtergrond bij elkaar.",
    keywords:
      "windows helper wallpaper achtergrond scherm display app installeren koppelen koppelcode beheerrechten uac downloaden",
  },
  {
    id: "desktop",
    page: "windows",
    anchor: "pc-bedienen",
    name: "Pc bedienen",
    detail: "Laat NOVA meekijken op je scherm en de pc kort bedienen.",
    keywords:
      "bureaublad scherm pc overnemen muis toetsenbord screenshot windows besturen",
  },
  {
    id: "app",
    page: "gesprek",
    anchor: "app-installeren",
    name: "NOVA installeren op dit apparaat",
    detail: "De webapp op je telefoon, tablet of computer installeren.",
    keywords: "pwa app installeren telefoon iphone android beginscherm",
  },
  {
    id: "telephony",
    page: "telefoon",
    anchor: null,
    name: "Telefoon",
    detail: "Eigen telefooncentrale met toestellen en deurbel.",
    keywords:
      "telefonie bellen telefoon asterisk linphone sip deurbel intercom toestel nummer trunk voip sms berichten",
  },
  {
    id: "models",
    page: "modellen",
    anchor: null,
    name: "Slimme modellen",
    detail: "Verbonden diensten, een gratis dienst toevoegen.",
    keywords:
      "ai model modellen dienst provider account sleutel api gratis groq openrouter antwoorden geblokkeerd omniroute",
  },
  {
    id: "autonomy",
    page: "zelf",
    anchor: "taken",
    name: "Zelfstandige taken",
    detail: "Hoe zelfstandig NOVA is en welke taken ze zelf doet.",
    keywords:
      "autonoom taak automatisering gebeurtenis goedkeuren plannen herhalend voorzichtig zelfstandig",
  },
  {
    id: "abilities",
    page: "zelf",
    anchor: "wat-mag",
    name: "Wat NOVA mag doen",
    detail: "Zet vaardigheden en gereedschappen aan of uit.",
    keywords: "gereedschappen vaardigheden tools risico rechten toestemming",
  },
  {
    id: "safety",
    page: "zelf",
    anchor: "toestemmingen",
    name: "Uitvoering en actielog",
    detail: "NOVA handelt direct; bekijk en controleer de uitgevoerde acties.",
    keywords:
      "veiligheid altijd goedkeuring confirm pin bevestiging beveiliging toestemmingen intrekken",
  },
  {
    id: "objectives",
    page: "zelf",
    anchor: "doelen",
    name: "Doelen",
    detail: "Dingen die NOVA in de gaten houdt en alleen meldt bij problemen.",
    keywords:
      "doel doelen monitoren in de gaten houden bewaken controle afwijking storing valse alarm servers stille uren pauzeren hervatten",
  },
  {
    id: "memory",
    page: "geheugen",
    anchor: null,
    name: "Wat NOVA onthoudt",
    detail: "Zoek in wat NOVA onthoudt, corrigeer het of laat het vergeten.",
    keywords:
      "geheugen onthouden vergeten corrigeren persoonsgegevens privacy herinneringen feit voorkeur besluit gevoelig",
  },
  {
    id: "documents",
    page: "geheugen",
    anchor: "documenten",
    name: "Documenten",
    detail: "Upload privédocumenten en zoek er later in via de chat.",
    keywords: "documentbibliotheek pdf docx upload bibliotheek bestanden",
  },
  {
    id: "backup",
    page: "geheugen",
    anchor: "backup",
    name: "Back-up maken en terugzetten",
    detail: "Bewaar je instellingen en zet ze later terug.",
    keywords: "backup back-up export import exporteren importeren bewaren",
  },
  {
    id: "integrations",
    page: "huis",
    anchor: "koppelingen",
    name: "Overige koppelingen",
    detail: "Proxmox, Qdrant, MQTT, Node-RED, Termix en Pangolin.",
    keywords:
      "proxmox termix pangolin mqtt qdrant integraties servers vm beheer node-red url token",
  },
  {
    id: "automation",
    page: "huis",
    anchor: "connection-node-red",
    name: "Node-RED-flows",
    detail: "Flows, palet en logs achter je automatiseringen.",
    keywords: "flows nodes node-red planning routines editor palet logs",
  },
  {
    id: "services",
    page: "huis",
    anchor: "services",
    name: "Services en MCP",
    detail: "Zie of de achtergrondservices en MCP-servers draaien.",
    keywords:
      "workers containers broker verbinding services mcp server status herstarten stack",
  },
  {
    id: "modelexpert",
    page: "modellen",
    anchor: "modellen-expert",
    name: "Modellen en accounts (expert)",
    detail: "Accounts, routes, metingen, native gateway en gratis-beleid.",
    keywords:
      "provider account route combo model gateway limieten omniroute sleutel native beleid metingen rollen model per taak",
  },
  {
    id: "windowsagent",
    page: "windows",
    anchor: "windows-agent",
    name: "Windows-agent en helper",
    detail: "Status, sneltoetsen en geschiedenis van de Windows-agent.",
    keywords: "windows agent helper sneltoets hotkey versie debug",
  },
  {
    id: "apis",
    page: "geavanceerd",
    anchor: "api-koppelingen",
    name: "API's koppelen",
    detail: "Geef NOVA een adres en token; ze leert de API zelf.",
    keywords:
      "api rest graphql soap json-rpc endpoint token sleutel koppelen integreren openapi swagger",
  },
  {
    id: "tools",
    page: "geavanceerd",
    anchor: "gereedschappen",
    name: "Alle gereedschappen",
    detail: "Elk gereedschap met risico, beschrijving en gebruik.",
    keywords: "tools gereedschappen risico gebruik beschrijving",
  },
  {
    id: "skills",
    page: "geavanceerd",
    anchor: "vaardigheden",
    name: "Eigen vaardigheden",
    detail: "Leer NOVA zelf bedachte instructies en koppelingen.",
    keywords: "skill vaardigheid webhook testen geschiedenis instructies",
  },
  {
    id: "code",
    page: "geavanceerd",
    anchor: "codeprojecten",
    name: "Codeprojecten",
    detail: "Maak een project aan en kies welk project actief is.",
    keywords: "code werkruimte workspace projecten aanmaken openen",
  },
  {
    id: "sidebar",
    page: "geavanceerd",
    anchor: "zijbalk",
    name: "Zijbalk en panelen",
    detail: "Kies welke informatiepanelen je ziet en waar.",
    keywords: "sidebar zijbalk panelen widgets notitie",
  },
  {
    id: "runtime",
    page: "geavanceerd",
    anchor: "voorkeuren",
    name: "Spraak, nieuws en meldingen",
    detail:
      "Spraak naar tekst, embeddings, nieuwsbronnen, ntfy, controledoelen en thuislocatie.",
    keywords:
      "stt whisper transcriptie embeddings dimensies nieuws rss feeds ntfy push controle doelen thuis locatie breedtegraad lengtegraad env",
  },
  {
    id: "updates",
    page: "geavanceerd",
    anchor: "updates",
    name: "Updates",
    detail: "Welke versie draait er en is er een nieuwe?",
    keywords: "updates versie bijwerken release",
  },
  {
    id: "audit",
    page: "geavanceerd",
    anchor: "actielog",
    name: "Actielog",
    detail: "Alles wat NOVA heeft gedaan, voor controle.",
    keywords: "audit logs actielog geschiedenis controle",
  },
  {
    id: "setup",
    page: "geavanceerd",
    anchor: "installatie",
    name: "Installatie opnieuw doorlopen",
    detail: "Loop de installatiestappen nog eens langs.",
    keywords: "installatie starten instellen onboarding aan de slag",
  },
] as const;

export type SettingsTopic = (typeof TOPICS)[number]["id"];
export type Topic = (typeof TOPICS)[number];

/** Old section ids that no longer have a page of their own. */
const LEGACY: Record<string, { page: SettingsPage; anchor: string | null }> = {
  system: { page: "geavanceerd", anchor: "updates" },
  behavior: { page: "gesprek", anchor: "persoonlijkheid" },
  more: { page: "geavanceerd", anchor: "updates" },
  // Old group ids from the first redesign.
  algemeen: { page: "gesprek", anchor: null },
  stem: { page: "gesprek", anchor: null },
  ai: { page: "modellen", anchor: null },
  automatisering: { page: "zelf", anchor: null },
  beheer: { page: "geavanceerd", anchor: null },
};

/** Histories and logs that moved: an old `#hash` decides the page. */
const HASH_HOME: Record<string, SettingsPage> = {
  ...Object.fromEntries(
    TOPICS.filter((topic) => topic.anchor).map((topic) => [
      topic.anchor as string,
      topic.page,
    ]),
  ),
  "modellen-expert": "modellen",
  "node-red-flows": "huis",
  "windows-access": "windows",
  "windows-appearance": "windows",
  "sidebar-history": "geavanceerd",
  "tool-switch-history": "geavanceerd",
  "model-role-history-title": "modellen",
  modelrollen: "modellen",
  actielog: "geavanceerd",
  "persona-history": "gesprek",
  "persona-preferences-history": "gesprek",
  "quick-actions-history": "gesprek",
};

export interface SettingsTarget {
  page: SettingsPage;
  anchor: string | null;
}

export function isPage(value: string | null): value is SettingsPage {
  return PAGES.some((page) => page.id === value);
}

/**
 * Any old or new `?section=` value (and optional `#hash`) to the page that
 * holds it. A hash that already names an anchor is kept by the caller.
 */
export function resolveSettingsTarget(
  value: string | null,
  hash = "",
): SettingsTarget {
  const wanted = hash.replace(/^#/, "");
  const home = wanted ? HASH_HOME[wanted] : undefined;
  if (home) return { page: home, anchor: wanted };
  if (isPage(value)) return { page: value, anchor: null };
  if (value && LEGACY[value]) return LEGACY[value];
  const topic = TOPICS.find((item) => item.id === value);
  if (topic) return { page: topic.page, anchor: topic.anchor };
  return { page: "gesprek", anchor: null };
}

export function settingsSection(value: string | null): SettingsPage {
  return resolveSettingsTarget(value).page;
}

export function pageInfo(id: SettingsPage) {
  return PAGES.find((page) => page.id === id)!;
}

export function topicHref(topic: {
  page: string;
  anchor: string | null;
}): string {
  return `/settings?section=${topic.page}${topic.anchor ? `#${topic.anchor}` : ""}`;
}

export function searchSettings(query: string) {
  const words = query
    .trim()
    .toLocaleLowerCase("nl-NL")
    .split(/\s+/)
    .filter(Boolean);
  const lower = (text: string) => text.toLocaleLowerCase("nl-NL");
  const rank = (topic: Topic) =>
    words.every((word) => lower(topic.name).includes(word)) ? 0 : 1;
  return TOPICS.filter((topic) => {
    const text = lower(
      `${topic.name} ${topic.detail} ${topic.keywords} ${pageInfo(topic.page).name}`,
    );
    return words.every((word) => text.includes(word));
  }).sort((a, b) => rank(a) - rank(b));
}
