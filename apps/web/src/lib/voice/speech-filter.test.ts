import { describe, expect, it } from "vitest";
import {
  applyPronunciations,
  speechChunkBoundary,
  speechText,
} from "./speech-filter.ts";

describe("speechText", () => {
  it.each([
    ["**Goedemorgen, NOVA!**", "Goedemorgen, Nova!"],
    ["# Agenda", "Agenda"],
    ["## Vandaag", "Vandaag"],
    ["- Eerste punt", "Eerste punt."],
    ["1. Eerste stap", "Eerste stap."],
    ["> Een citaat", "Een citaat"],
    ["[document](https://example.test/a?q=1)", "document"],
    ["![foto](https://example.test/foto.png)", "foto"],
    ["Ga naar https://example.test/pad.", "Ga naar"],
    ["Ga naar www.example.test/pad", "Ga naar"],
    ["`npm test`", "npm test"],
    ["~~oud~~ en __nieuw__", "oud en nieuw"],
    ["**vet** en *cursief*", "vet en cursief"],
    [
      "| Naam | Status |\n| --- | --- |\n| API | klaar |",
      "Naam: aa pee ie; Status: klaar.",
    ],
    ["Het is 08:30 uur.", "Het is acht uur dertig."],
    ["Dat kost € 12,50.", "Dat kost twaalf euro en vijftig cent."],
    ["Server 192.168.1.20 is online.", "Server 192.168.1.20 is online."],
    [
      "Gebruik o.a. de API en bijv. MQTT.",
      "Gebruik onder andere de aa pee ie en bijvoorbeeld MQTT.",
    ],
    ["Fout 😕, maar opgelost ✅.", "Fout, maar opgelost."],
    ["Hartelijk dank ❤️", "Hartelijk dank"],
    ["De map is /data/nova.", "De map is /data/nova."],
    ["Versie v0.1.9 is klaar.", "Versie v0.1.9 is klaar."],
    ["- Eén\n- Twee", "Eén. Twee."],
    ["[NOVA][nova]", "Nova"],
    ["[nova]: https://example.test\nNOVA is klaar.", "Nova is klaar."],
    ["<b>Belangrijk</b>: nu klaar.", "Belangrijk: nu klaar."],
    ["A\u00a0B", "A B"],
    [
      "**€ 1.234,56**",
      "duizend tweehonderdvierendertig euro en zesenvijftig cent",
    ],
    [
      "Afspraak op 2026-10-11.",
      "Afspraak op elf oktober tweeduizend zesentwintig.",
    ],
    [
      "11/10/2026 is de datum.",
      "elf oktober tweeduizend zesentwintig is de datum.",
    ],
    ["Ongeldig: 31-02-2026.", "Ongeldig: 31-02-2026."],
    [
      "Afstand 5 km, gebruik 2 kWh, 18 °C.",
      "Afstand vijf kilometer, gebruik twee kilowattuur, achttien graden Celsius.",
    ],
    ["Het doel is 5% lager.", "Het doel is vijf procent lager."],
    [
      "Er zijn 42 meldingen, 61 lampen en 128 seconden.",
      "Er zijn tweeënveertig meldingen, eenenzestig lampen en honderdachtentwintig seconden.",
    ],
    [
      "API, URL, AI, CPU, DNS, HTTP, HTTPS, IP en USB.",
      "aa pee ie, uu er el, aa ie, cee pee uu, dee en es, haa tee tee pee, haa tee tee pee es, ie pee en uu es bee.",
    ],
    ["Waarde 1000 blijft staan.", "Waarde duizend blijft staan."],
    [
      "Er zijn 1.234.567 items.",
      "Er zijn een miljoen tweehonderdvierendertigduizend vijfhonderdzevenenzestig items.",
    ],
    [
      "De omzet is 1200000000 euro.",
      "De omzet is een miljard tweehonderd miljoen euro.",
    ],
    [
      "Referentie 1000000000000 blijft staan.",
      "Referentie 1000000000000 blijft staan.",
    ],
    [
      "Versie v0.1.9 en IP 192.168.1.20.",
      "Versie v0.1.9 en ie pee 192.168.1.20.",
    ],
    [
      "Rond 21:15 is het klaar.",
      "Rond eenentwintig uur vijftien is het klaar.",
    ],
    [
      "IP-adres: 10.0.0.1; poort: 3000.",
      "ie pee-adres: 10.0.0.1; poort: drieduizend.",
    ],
  ])("converts %j to plain speech", (input, expected) => {
    expect(speechText(input)).toBe(expected);
  });

  it("speaks an exact clock time naturally without rewriting IPs or versions", () => {
    expect(speechText("Het begint om 6:54.")).toBe(
      "Het begint om zes uur vierenvijftig.",
    );
    expect(speechText("10.0.0.1 en versie 1.2.3 blijven staan.")).toBe(
      "10.0.0.1 en versie 1.2.3 blijven staan.",
    );
  });

  it("turns multirow tables into separate spoken value sentences", () => {
    expect(
      speechText(
        "| Dienst | Status |\n| --- | --- |\n| API | klaar |\n| Web | bezig |",
      ),
    ).toBe("Dienst: aa pee ie; Status: klaar. Dienst: Web; Status: bezig.");
  });
});

describe("speechChunkBoundary", () => {
  it("waits for complete short sentences", () => {
    expect(speechChunkBoundary("Goedemorgen. Hoe gaat het? ", 180, 12)).toBe(
      13,
    );
    expect(speechChunkBoundary("Dit is nog niet af")).toBe(-1);
  });

  it("splits a long streaming sentence at a natural clause boundary", () => {
    const text = `${"Een lange uitleg met woorden ".repeat(5)}, daarna volgt de rest.`;
    const cut = speechChunkBoundary(text, 150);
    expect(text.slice(0, cut).trimEnd()).toMatch(/,$/);
    expect(text.slice(cut).trimStart()).toMatch(/^daarna/);
  });

  it("bounds long sentences without rewriting or cutting inside a word", () => {
    const text = "een twee drie vier vijf zes zeven acht negen tien ".repeat(8);
    const cut = speechChunkBoundary(text, 150);
    expect(cut).toBeGreaterThan(80);
    expect(text[cut - 1]).toBe(" ");
    expect(cut).toBeLessThanOrEqual(151);
  });
});

describe("applyPronunciations", () => {
  it("replaces exact case-insensitive names and longer phrases first", () => {
    expect(
      applyPronunciations("NOVA belt Nova", [
        { term: "Nova", say: "No-va" },
        { term: "NOVA belt", say: "No-va-belt" },
      ]),
    ).toBe("No-va-belt No-va");
  });

  it("does not replace a name inside a larger word", () => {
    expect(
      applyPronunciations("Jan is thuis; Jansen is onderweg.", [
        { term: "Jan", say: "Djan" },
      ]),
    ).toBe("Djan is thuis; Jansen is onderweg.");
  });

  it("treats pronunciation entries as literal text", () => {
    expect(
      applyPronunciations("Gebruik (MQTT)+.", [
        { term: "(MQTT)+", say: "em-cue-tee-tee plus" },
      ]),
    ).toBe("Gebruik em-cue-tee-tee plus.");
  });
});
