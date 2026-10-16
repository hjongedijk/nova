import type { VisualizationRegistry } from "./visualization.registry.js";

const fold = (value: string): string =>
  value
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLocaleLowerCase("nl-NL");

/** Words that ask to SEE something, as opposed to asking a question about it. */
const DISPLAY =
  /\b(toon|toont|tonen|laat\b.*\bzien|laat\b.*\bmaar zien|visualiseer|visualiseren|visualisatie|hologram|holografisch|holo|teken|teken\b.*\bop|geef\b.*\bweer|open\b.*\b(overzicht|weergave|kaart|graaf)|show|display|visuali[sz]e|draw|diagram|3d|2d|topologie|topology)\b/;

/**
 * Does the user ask to be shown a visual (holographic) view? "Toon mijn Proxmox" and "laat
 * het netwerk zien" do; "Welke VM's draaien er?" and "Hoe is de status van de servers?" do not.
 */
export function isDisplayRequest(message: string): boolean {
  const text = fold(message).trim();
  if (!text) return false;
  // A plain question ("hoeveel VM's draaien er?") has none of these words and gets a text answer.
  return DISPLAY.test(text);
}

/** "proxmox", "proxmox:load" or a natural topic ("mijn netwerk") to a provider:type reference. */
export function resolveTopic(
  topic: string,
  registry: VisualizationRegistry,
): string | null {
  const wanted = topic.trim();
  if (registry.resolve(wanted)) {
    const [providerId, typeId] = wanted.split(":");
    const provider = registry.get(providerId!);
    return `${providerId}:${typeId ?? provider!.types[0]!.id}`;
  }
  const words = new Set(
    fold(topic)
      .split(/[^a-z0-9']+/)
      .filter(Boolean),
  );
  const text = fold(topic);
  let best: { ref: string; score: number } | null = null;
  for (const provider of registry.list()) {
    for (const [index, type] of provider.types.entries()) {
      let score = 0;
      if (words.has(provider.id) || text.includes(fold(provider.label)))
        score += index === 0 ? 4 : 3;
      for (const keyword of type.keywords) {
        const key = fold(keyword);
        if (words.has(key) || (key.includes(" ") && text.includes(key)))
          score += 2;
      }
      if (score > 0 && (!best || score > best.score))
        best = { ref: `${provider.id}:${type.id}`, score };
    }
  }
  return best?.ref ?? null;
}
