import type { Ability } from "@nova/contracts";

interface AbilityDefinition {
  id: string;
  name: string;
  description: string;
  example: string;
  changes?: boolean;
  match: RegExp;
}

/**
 * The ~110 individual tools, grouped into things a person understands. The settings screen
 * shows these; switching one switches all of its tools. The tool names stay for those who want details.
 */
export const ABILITIES: AbilityDefinition[] = [
  {
    id: "weer",
    name: "Weer en omgeving",
    description:
      "Het weer overal ter wereld, de luchtkwaliteit, de maan en waar het ISS nu is.",
    example: "Wat is het weer in Parijs?",
    match: /^(?:weather_forecast|air_quality|moon_phase|iss_position)$/,
  },
  {
    id: "opzoeken",
    name: "Opzoeken en nieuws",
    description:
      "Zoeken op het web, Wikipedia, het laatste nieuws, koersen en rekenen.",
    example: "Wat is het laatste nieuws?",
    match:
      /^(?:web_search|web_read|wikipedia|news_headlines|currency_convert|market_rates|calculate)$/,
  },
  {
    id: "planning",
    name: "Timers en lijstjes",
    description:
      "Timers en herinneringen, boodschappenlijstjes en een dagoverzicht.",
    example: "Zet een timer van 10 minuten voor de pasta",
    match: /^(?:timer_|list_|daily_briefing$)/,
  },
  {
    id: "huis",
    name: "Slim huis",
    description:
      "Lampen, schakelaars, de thermostaat en wie er thuis is, via Home Assistant.",
    example: "Welke lampen staan er aan?",
    changes: true,
    match: /^(?:ha_|home_status$)/,
  },
  {
    id: "muziek",
    name: "Muziek en afspelen",
    description: "Muziek en media op je speakers bedienen.",
    example: "Zet de muziek in de keuken zachter",
    changes: true,
    match: /^(?:media_|sonos_|music_)/,
  },
  {
    id: "servers",
    name: "Servers en netwerk",
    description:
      "Proxmox en je virtuele machines, opslag, bereikbaarheid en meldingen. Starten en stoppen vraagt altijd eerst bevestiging.",
    example: "Welke virtuele machines draaien er?",
    changes: true,
    match: /^(?:proxmox_|termix_|pangolin_|network_check$|alerts_list$)/,
  },
  {
    id: "pc",
    name: "Je Windows-pc",
    description: "Programma's openen, zoeken en video's starten op je pc.",
    example: "Speel muziek van Queen op YouTube",
    changes: true,
    match: /^windows_/,
  },
  {
    id: "browser",
    name: "Browser op je pc",
    description:
      "Zelf zoeken, lezen en klikken in de browser op je pc. Werkt zodra de browser-agent is geïnstalleerd.",
    example: "Zoek op Google naar de beste pizza in de buurt en open de eerste",
    changes: true,
    match: /^browser_/,
  },
  {
    id: "geheugen",
    name: "Geheugen",
    description: "Dingen onthouden die jij vertelt, en ze later weer weten.",
    example: "Onthoud dat ik mijn koffie zwart drink",
    match: /^memory_/,
  },
  {
    id: "bestanden",
    name: "Bestanden en extensies",
    description:
      "Extra gereedschappen van buiten NOVA, zoals bestanden lezen en schrijven.",
    example: "Welke bestanden staan er in de werkmap?",
    changes: true,
    match: /^mcp_/,
  },
  {
    id: "systeem",
    name: "Systeem",
    description:
      "De tijd, een overzicht van de koppelingen en de status van NOVA zelf.",
    example: "Hoe laat is het?",
    match: /^(?:system_|echo$|omniroute_)/,
  },
];

/** Tools the user made themselves live in "Mijn vaardigheden", not here. */
export function groupTools(
  tools: { name: string; enabled: boolean }[],
): Ability[] {
  const groups = ABILITIES.map((ability) => ({
    ...ability,
    tools: [] as string[],
    enabled: 0,
  }));
  const other = {
    id: "overig",
    name: "Overig",
    description: "Gereedschappen die nergens anders bij horen.",
    example: null as string | null,
    changes: false,
    match: /^$/,
    tools: [] as string[],
    enabled: 0,
  };
  for (const tool of tools) {
    if (tool.name.startsWith("skill_")) continue;
    const group = groups.find((item) => item.match.test(tool.name)) ?? other;
    group.tools.push(tool.name);
    if (tool.enabled) group.enabled++;
  }
  return [...groups, other]
    .filter((group) => group.tools.length)
    .map((group) => ({
      id: group.id,
      name: group.name,
      description: group.description,
      example: group.example,
      ...(group.changes === undefined ? {} : { changes: group.changes }),
      tools: group.tools,
      total: group.tools.length,
      enabledCount: group.enabled,
      state:
        group.enabled === 0
          ? ("off" as const)
          : group.enabled === group.tools.length
            ? ("on" as const)
            : ("partial" as const),
    }));
}
