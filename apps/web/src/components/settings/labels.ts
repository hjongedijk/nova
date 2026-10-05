export const RISK_LABEL: Record<string, string> = {
  READ_ONLY: "alleen lezen",
  SAFE: "direct uitvoeren",
  CONFIRM: "vraagt bevestiging",
  DANGEROUS: "gevaarlijk",
};

/** CONFIRM and DANGEROUS get the amber badge. */
export const riskTone = (risk: string): "" | "warn" =>
  risk === "CONFIRM" || risk === "DANGEROUS" ? "warn" : "";

import type { WidgetType } from "@nova/contracts";

export const WIDGET_KINDS: [WidgetType, string, string][] = [
  [
    "value",
    "Getal van internet",
    "Bijvoorbeeld het aantal mensen in de ruimte.",
  ],
  ["list", "Lijstje van internet", "Bijvoorbeeld de laatste koppen."],
  ["buttons", "Knoppen", "Snelle knoppen die NOVA iets laten doen."],
  ["note", "Notitie", "Een stukje tekst dat altijd zichtbaar is."],
];
