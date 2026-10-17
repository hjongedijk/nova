import { describe, expect, it } from "vitest";
import {
  classifyTurn,
  isConversational,
  topicHint,
  type TurnKind,
} from "../../src/chat/conversation-style.js";
import {
  buildSystemPrompt,
  GESPREK_SECTION,
  GESPREK_SHORT,
  promptSections,
  SYSTEM_PROMPT,
} from "../../src/chat/prompt.js";

const tokens = (text: string) => Math.round(text.length / 3.6);

const CASES: [string, TurnKind][] = [
  // commands
  ["zet het licht aan", "command"],
  ["Zet het licht in de keuken uit", "command"],
  ["kun je het licht aan zetten?", "command"],
  ["kan je de verwarming hoger zetten", "command"],
  ["speel wat rustige muziek", "command"],
  ["bel mij en vertel het weer", "command"],
  ["zet een timer van tien minuten", "command"],
  ["voeg melk toe aan de boodschappen", "command"],
  ["turn off the lights", "command"],
  ["can you play some jazz", "command"],
  ["please set a timer for 5 minutes", "command"],
  ["onthoud dat ik donderdag tandarts heb", "command"],
  // questions
  ["hoe laat is het", "question"],
  ["wat is de hoofdstad van Frankrijk", "question"],
  ["hoe is het weer morgen?", "question"],
  ["welke VM's draaien er", "question"],
  ["waarom is de lucht blauw", "question"],
  ["wie was Einstein", "question"],
  ["what is the capital of France", "question"],
  ["how many days are in a leap year?", "question"],
  ["is de wasmachine klaar?", "question"],
  ["wat kun je allemaal", "question"],
  // discussion
  ["wat vind je ervan", "discussion"],
  ["Wat vind je daarvan?", "discussion"],
  ["wat denk jij, moet ik een nieuwe laptop kopen", "discussion"],
  ["is het slim om nu al mijn auto te verkopen", "discussion"],
  ["ik denk dat we te veel geld uitgeven aan abonnementen", "discussion"],
  ["volgens mij is Linux beter dan Windows", "discussion"],
  ["ik twijfel tussen een hond en een kat", "discussion"],
  ["do you think remote work is better?", "discussion"],
  ["should i learn rust or go", "discussion"],
  ["ben je het met me eens", "discussion"],
  [
    "Ik ben gisteren naar een concert geweest en het was geweldig",
    "discussion",
  ],
  // brainstorm
  ["laten we brainstormen over een naam voor mijn project", "brainstorm"],
  ["geef me wat ideeën voor het weekend", "brainstorm"],
  ["bedenk samen met me een verjaardagscadeau", "brainstorm"],
  ["let's brainstorm app names", "brainstorm"],
  ["give me some ideas for dinner", "brainstorm"],
  ["heb je ideeën voor een verjaardagsfeestje?", "brainstorm"],
  // small talk
  ["hoi", "smalltalk"],
  ["goedemorgen", "smalltalk"],
  ["hoe gaat het met je?", "smalltalk"],
  ["ik ben moe", "smalltalk"],
  ["wat een dag", "smalltalk"],
  ["bedankt!", "smalltalk"],
  ["haha grappig", "smalltalk"],
  ["vertel een mop", "smalltalk"],
  ["thanks", "smalltalk"],
  ["how are you", "smalltalk"],
  ["oke", "smalltalk"],
];

describe("classifyTurn", () => {
  it("has a broad table", () => {
    expect(CASES.length).toBeGreaterThanOrEqual(40);
  });

  it.each(CASES)("%s -> %s", (message, expected) => {
    expect(classifyTurn(message, [])).toBe(expected);
  });

  it("treats empty input as a question (lean)", () => {
    expect(classifyTurn("   ")).toBe("question");
  });

  it("reads a bare yes as a go-ahead only after NOVA asked something", () => {
    const asked = [{ role: "assistant", content: "Zal ik de lampen dimmen?" }];
    expect(classifyTurn("ja doe maar", asked)).toBe("command");
    expect(classifyTurn("ja", asked)).toBe("command");
    expect(classifyTurn("ja", [])).toBe("smalltalk");
  });

  it("treats a short answer to NOVA's own question as conversation", () => {
    const asked = [
      { role: "assistant", content: "Waar zou je het liefst heen gaan?" },
    ];
    expect(classifyTurn("liever de bergen", asked)).toBe("discussion");
    expect(classifyTurn("liever de bergen", [])).toBe("smalltalk");
  });

  it("does not let a discussion phrase hide behind a command verb", () => {
    expect(
      classifyTurn("zet ik het licht beter aan of uit, wat vind je?"),
    ).toBe("discussion");
  });

  it("is deterministic", () => {
    for (const [message] of CASES)
      expect(classifyTurn(message, [])).toBe(classifyTurn(message, []));
  });

  it("knows which kinds are conversational", () => {
    expect(isConversational("discussion")).toBe(true);
    expect(isConversational("brainstorm")).toBe(true);
    expect(isConversational("smalltalk")).toBe(true);
    expect(isConversational("command")).toBe(false);
    expect(isConversational("question")).toBe(false);
  });
});

describe("topicHint", () => {
  it("names the repeated topic of the last turns", () => {
    const hint = topicHint([
      {
        role: "user",
        content: "Ik twijfel over een nieuwe fiets voor woon-werkverkeer",
      },
      {
        role: "assistant",
        content: "Een elektrische fiets is handig bij lange afstanden.",
      },
      { role: "user", content: "Een elektrische fiets is wel duur" },
    ]);
    expect(hint).toContain("We hadden het eerder");
    expect(hint).toContain("fiets");
    expect(hint?.split("\n")).toHaveLength(1);
  });

  it("returns null without history or without a recurring topic", () => {
    expect(topicHint([])).toBeNull();
    expect(
      topicHint([
        { role: "user", content: "hoi" },
        { role: "assistant", content: "Hoi!" },
      ]),
    ).toBeNull();
  });

  it("ignores system and tool turns and old turns", () => {
    const turns = [
      { role: "user", content: "pizza pizza pizza" },
      ...Array.from({ length: 8 }, () => ({ role: "user", content: "hoi" })),
    ];
    expect(topicHint(turns)).toBeNull();
    expect(
      topicHint([
        { role: "system", content: "fiets fiets fiets" },
        { role: "tool", content: "fiets fiets fiets" },
      ]),
    ).toBeNull();
  });
});

describe("conversation prompt wiring", () => {
  const build = (
    message: string,
    toolNames: string[] = [],
    extra: Record<string, unknown> = {},
  ) => buildSystemPrompt({ message, toolNames, ...extra });

  it("keeps the core prompt inside the token budget", () => {
    const sections = promptSections();
    // Baseline of the core section before the gesprek work was ~2,000 tokens; the budget leaves at most 250 more.
    expect(tokens(sections.core)).toBeLessThan(2400);
    expect(tokens(GESPREK_SECTION)).toBeLessThanOrEqual(250);
    expect(tokens(GESPREK_SHORT)).toBeLessThanOrEqual(40);
    // The core must not contain the gesprek text: it is added per turn kind.
    expect(sections.core).not.toContain("GESPREK");
  });

  it("gives discussion, brainstorm and small-talk turns the full gesprek section", () => {
    for (const message of [
      "wat vind je ervan",
      "laten we brainstormen over een naam",
      "hoi",
    ]) {
      const prompt = build(message);
      expect(prompt).toContain(GESPREK_SECTION);
      expect(prompt).toContain("één vervolgvraag");
      expect(prompt).toContain("echte mening");
      expect(prompt).not.toContain("KLAAR");
    }
  });

  it("keeps command turns lean and question turns to one line", () => {
    const command = build("zet het licht aan", ["ha_toggle"]);
    expect(command).not.toContain("GESPREK");
    expect(command).not.toContain(GESPREK_SHORT);
    const question = build("hoe laat is het", ["system_time"]);
    expect(question).not.toContain("GESPREK");
    expect(question).toContain(GESPREK_SHORT);
  });

  it("does not pull tool rules into a talking turn by keywords alone", () => {
    const prompt = build("ik denk dat de verwarming uit moet, wat vind je");
    expect(prompt).not.toContain("Home Assistant is the primary");
    expect(prompt).toContain(GESPREK_SECTION);
    // ...but a tool that is actually offered still brings its rules.
    expect(build("wat vind je ervan", ["ha_toggle"])).toContain(
      "Home Assistant is the primary",
    );
  });

  it("adds the topic hint only on talking turns", () => {
    const topic = "We hadden het eerder in dit gesprek over: fiets.";
    expect(build("wat vind je ervan", [], { topic })).toContain(topic);
    expect(build("zet het licht aan", ["ha_toggle"], { topic })).not.toContain(
      topic,
    );
  });

  it("respects an explicit turn from the caller", () => {
    expect(build("hoi", [], { turn: "command" })).not.toContain("GESPREK");
    expect(build("zet het licht aan", [], { turn: "discussion" })).toContain(
      GESPREK_SECTION,
    );
  });

  it("stays well below the full prompt on a talking turn", () => {
    const full = tokens(SYSTEM_PROMPT);
    expect(tokens(build("wat vind je ervan"))).toBeLessThan(full * 0.7);
  });

  it("never asks the model to push options or write a completion marker", () => {
    expect(GESPREK_SECTION).not.toMatch(/KLAAR|HULP|tool/i);
    expect(GESPREK_SECTION).toMatch(/Geen menu/);
  });
});
