import { describe, expect, it } from "vitest";
import { directGoalQuery } from "../../src/chat/direct-goal.js";

const agent = (message: string) => directGoalQuery(message)?.kind === "agent";
const objective = (message: string) =>
  directGoalQuery(message)?.kind === "objective";

describe("directGoalQuery: explicit delegation starts a background goal", () => {
  it.each([
    "regel dat voor me",
    "Regel de verzekering voor mijn nieuwe auto",
    "regel een afspraak bij de tandarts voor volgende week",
    "zoek uit waarom mijn wifi zo traag is",
    "Zoek het verschil tussen deze twee abonnementen uit",
    "zoek een goede loodgieter in de buurt uit",
    "onderzoek de oorzaak van de storing in de garage",
    "Onderzoek welke router het beste past bij mijn huis",
    "werk de offerte voor Jansen af",
    "werk mijn takenlijst voor vandaag af",
    "plan en voer de back-up van vannacht uit",
    "plan en voer deze migratie uit zodra het kan",
    "handel de factuur van de energieleverancier af",
    "handel dit voor me af alsjeblieft",
    "kun je dit voor me regelen",
    "kun je het verschil tussen die abonnementen uitzoeken?",
    "wil je de planning van volgende week afhandelen",
    "Nova, regel de boodschappen voor zaterdag",
    "sort this out for me please",
    "sort out my calendar for next week",
    "figure out why the server restarts at night",
    "figure this out before tomorrow morning",
    "could you figure out which plan is cheaper",
    "can you sort out the invoices for me",
  ])("starts a goal: %s", (message) => {
    expect(agent(message)).toBe(true);
  });

  it("passes the wording on as the goal, without the polite prefix", () => {
    expect(directGoalQuery("kun je dit voor me regelen?")).toEqual({
      kind: "agent",
      goal: "dit voor me regelen",
    });
    expect(directGoalQuery("zoek uit waarom mijn wifi traag is.")).toEqual({
      kind: "agent",
      goal: "zoek uit waarom mijn wifi traag is",
    });
  });
});

describe("directGoalQuery: everything else goes to the model", () => {
  it.each([
    "wat is het regelen van een lening",
    "hoe regel ik een parkeervergunning",
    "waarom moet ik dit uitzoeken",
    "regel is een lijn op papier",
    "onderzoek naar de oorzaak van kanker is moeilijk",
    "het onderzoek is gisteren afgerond door het team",
    "zoek een film uit de jaren tachtig",
    "zoek een recept voor pannenkoeken",
    "regel dit",
    "zoek het uit",
    "sort it out",
    "figure it out",
    "kun je me helpen met mijn huiswerk?",
    "kun je regelen dat het licht uit gaat?",
    "is het gelukt om de verzekering te regelen?",
    "wat moet ik regelen voor mijn verhuizing?",
    "how do I sort this out with my landlord?",
    "werk aan het rapport van vorige week",
    "plan een afspraak voor morgen met de dokter",
    "handel is belangrijk voor onze economie",
    "ik moet nog veel regelen deze week",
    "bel mij en zeg dat het eten klaar is",
    "",
    "   ",
  ])("leaves it alone: %j", (message) => {
    expect(directGoalQuery(message)).toBeNull();
  });

  it("ignores absurdly long input", () => {
    expect(directGoalQuery(`regel ${"dit en dat ".repeat(80)}`)).toBeNull();
  });
});

describe("directGoalQuery: standing objectives", () => {
  it("recognises the clear templates", () => {
    expect(directGoalQuery("houd mijn servers in de gaten")).toMatchObject({
      kind: "objective",
      template: "servers_gezond",
    });
    expect(
      directGoalQuery("zorg dat mijn servers gezond blijven"),
    ).toMatchObject({ kind: "objective", template: "servers_gezond" });
    expect(
      directGoalQuery("laat me weten als de proxmox node uitvalt"),
    ).toMatchObject({ kind: "objective", template: "servers_gezond" });
    expect(
      directGoalQuery("laat me weten als mijn agenda leeg is"),
    ).toMatchObject({ kind: "objective", template: "agenda_leeg" });
    expect(
      directGoalQuery("laat me weten als cover.garage open is"),
    ).toMatchObject({
      kind: "objective",
      template: "ha_waarde",
      params: { entity: "cover.garage", operator: "==", value: "open" },
    });
    expect(directGoalQuery("keep an eye on my servers please")).toMatchObject({
      kind: "objective",
      template: "servers_gezond",
    });
  });

  it("falls through to the model when no template clearly fits", () => {
    expect(directGoalQuery("houd de buurman in de gaten")).toBeNull();
    expect(directGoalQuery("laat me weten als het gaat regenen")).toBeNull();
    expect(directGoalQuery("laat me weten als cover.garage")).toBeNull();
    expect(objective("houd het weer in de gaten voor zaterdag")).toBe(false);
  });

  it("does not treat a question as a watch request", () => {
    expect(
      directGoalQuery("moet ik mijn servers in de gaten houden?"),
    ).toBeNull();
    expect(directGoalQuery("wie houdt mijn servers in de gaten?")).toBeNull();
  });
});
