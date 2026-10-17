/**
 * Every sentence the autopilot says is built here from fixed templates: Dutch, short, human, always with one concrete next
 * step. No model is involved, so a routine check never costs free-model quota.
 */

/** Untrusted text (calendar titles, names) is shortened and stripped of control characters before it is quoted. */
export function quote(text: string, max = 60): string {
  const clean = text
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return clean.length > max ? `${clean.slice(0, max - 1).trim()}…` : clean;
}

const minutes = (n: number) => `${n} ${n === 1 ? "minuut" : "minuten"}`;

export const T = {
  calendar: (summary: string, left: number) => ({
    title: `Straks: ${quote(summary)}`,
    detail: `Dit begint over ${minutes(left)}. Zeg 'wanneer moet ik vertrekken?' en ik reken de reistijd voor je uit.`,
  }),
  homeDevice: (name: string) => ({
    title: `${quote(name, 50)} reageert niet meer`,
    detail: `Home Assistant ziet dit apparaat al een tijdje niet. Kijk of het stroom of wifi heeft; lukt dat niet, vraag me dan 'wat is er met ${quote(name, 30)}?'.`,
  }),
  homeMany: (count: number) => ({
    title: `${count} apparaten reageren niet meer`,
    detail:
      "Dat zijn er veel tegelijk, dus waarschijnlijk ligt het aan een hub, router of de koppeling zelf. Controleer eerst de wifi of de Zigbee-hub en herstart die als dat nodig is.",
  }),
  routingBlocked: (status: string) => {
    const cause =
      status === "POLICY_CHANGE_PENDING"
        ? "er is een wijziging aan de modelroutering die nog gecontroleerd moet worden"
        : status === "GATEWAY_PROVENANCE_UNVERIFIED"
          ? "het OmniRoute-adres is nog niet bevestigd"
          : status === "POLICY_UNAVAILABLE"
            ? "ik kan de gratis-modelinstellingen niet controleren"
            : "de modelroutering is niet klaar";
    return {
      title: "Ik mag nu geen modellen gebruiken",
      detail: `Ik kan niet meer met je praten via een model omdat ${cause}. Open Instellingen, pagina Modellen, en bevestig of herstel de routering.`,
    };
  },
  modelsFailing: (count: number) => ({
    title: "Bijna alle gratis modellen falen",
    detail: `${count} modellen gaven het laatste etmaal vooral fouten. Meestal is de gratis limiet op of ligt een aanbieder eruit. Wacht een uur, of kijk op de pagina Modellen welke nog werken.`,
  }),
  trunkOffline: () => ({
    title: "Mijn telefoonlijn is niet verbonden",
    detail:
      "De SIP-trunk meldt zich niet aan, dus bellen en berichten via Linphone werken niet. Controleer bij de telefonie-instellingen of server, gebruikersnaam en wachtwoord kloppen.",
  }),
  mcpDown: (server: string) => ({
    title: `Hulpprogramma ${quote(server, 30)} draait niet`,
    detail: `Ik heb geprobeerd het opnieuw te starten, maar dat lukte niet. Tools die daarvan afhangen werken nu niet. Kijk bij de MCP-instellingen of de server nog goed is ingesteld.`,
  }),
  diskLow: (freePercent: number) => ({
    title: "De schijf van NOVA raakt vol",
    detail: `Er is nog ${freePercent}% vrij. Ruim oude back-ups of downloads op, of vergroot de schijf, voordat NOVA niets meer kan opslaan.`,
  }),
  memoryLow: (freePercent: number) => ({
    title: "Het geheugen van NOVA is bijna op",
    detail: `Nog maar ${freePercent}% werkgeheugen vrij. Start de NOVA-container opnieuw of geef de machine meer geheugen.`,
  }),
  haOffline: () => ({
    title: "Home Assistant reageert niet",
    detail:
      "Ik krijg al een tijdje geen antwoord van Home Assistant, ook niet na opnieuw verbinden. Kijk of Home Assistant draait en of het toegangstoken nog klopt.",
  }),
  runWaiting: (goal: string, waitedMinutes: number, approval: boolean) => ({
    title: "Een taak wacht op jou",
    detail: `'${quote(goal)}' wacht al ${minutes(waitedMinutes)} op ${approval ? "jouw goedkeuring" : "een antwoord van jou"}. Zeg 'ga verder met die taak' om te antwoorden, of 'annuleer de taak'.`,
  }),
  runInterrupted: (goal: string) => ({
    title: "Een taak is onderbroken",
    detail: `'${quote(goal)}' stopte toen NOVA herstartte. Zeg 'ga verder met die taak' om hem te hervatten.`,
  }),
  objectiveOpen: (title: string, sinceMinutes: number) => ({
    title: `Nog niet opgelost: ${quote(title, 60)}`,
    detail: `Dit speelt al ${minutes(sinceMinutes)}. Vraag 'wat is er aan de hand met ${quote(title, 30)}?' voor details, of zeg dat het een vals alarm is dan houd ik me stil.`,
  }),
  today: (items: number, timers: number) => {
    const parts: string[] = [];
    if (items > 0)
      parts.push(`${items} ${items === 1 ? "open taak" : "open taken"}`);
    if (timers > 0)
      parts.push(
        `${timers} ${timers === 1 ? "lopende timer" : "lopende timers"}`,
      );
    return {
      title: "Vandaag nog open",
      detail: `Je hebt ${parts.join(" en ")}. Zeg 'lees mijn taken voor' en ik loop ze met je door.`,
    };
  },
  call: (title: string) =>
    `Hallo, met Nova. Dringend: ${quote(title, 100)}. Kijk even op je scherm voor details.`,
  text: (title: string, detail: string) => `NOVA: ${title}. ${detail}`,
};
