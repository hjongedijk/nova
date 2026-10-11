import { describe, expect, it } from "vitest";
import { SYSTEM_PROMPT } from "../../src/chat/prompt.js";
import {
  classifyModelRole,
  codeResponseStyle,
  requiresLiveData,
  responseStyle,
} from "../../src/chat/orchestrator.service.js";
import {
  ContextBuilder,
  memorySearchQuery,
  recurringRequestSuggestion,
} from "../../src/chat/context-builder.service.js";

describe("NOVA's conversational identity", () => {
  it("uses only the current NOVA name", () => {
    expect(SYSTEM_PROMPT).toContain(
      "Your name is NOVA. Always introduce and refer to yourself as NOVA.",
    );
    expect(SYSTEM_PROMPT).not.toMatch(/Jarvis/i);
  });

  it("answers the human question honestly and naturally", () => {
    expect(SYSTEM_PROMPT).toContain(
      "If asked whether you are human, a person or an AI, answer honestly that you are an AI assistant",
    );
    expect(SYSTEM_PROMPT).toContain(
      'User: "Ben je een mens?"\nNOVA: "Nee, ik ben een AI-assistent.',
    );
  });

  it("prefers natural concise replies and honest correction over stock phrases", () => {
    expect(SYSTEM_PROMPT).toContain(
      "Match the depth to the need. A light switch needs a few words.",
    );
    expect(SYSTEM_PROMPT).toContain(
      "When you are unsure, say what part is uncertain and what you do know",
    );
    expect(SYSTEM_PROMPT).toContain(
      "acknowledge it briefly, correct it and continue with the useful next step",
    );
    expect(SYSTEM_PROMPT).toContain(
      'Avoid stock phrases: "Natuurlijk!", "Zeker!"',
    );
  });

  it("uses prior-conversation search hints only when the user refers back", () => {
    expect(
      memorySearchQuery("Zoals we gisteren bespraken: hoe ging dat?"),
    ).toContain("gesprekssamenvatting");
    expect(memorySearchQuery("Vertel me iets over de keuken")).toBe(
      "Vertel me iets over de keuken",
    );
    expect(SYSTEM_PROMPT).toContain("never force a nostalgic callback");
    expect(SYSTEM_PROMPT).toContain(
      "search memory and answer only from returned records",
    );
    expect(SYSTEM_PROMPT).toContain(
      "Deleting a record always needs the normal explicit confirmation",
    );
  });
});

describe("calm response to a shared mood", () => {
  it("treats mood statements as conversation, even when they mention live topics", () => {
    expect(
      requiresLiveData("Ik heb een drukke dag en het regent buiten."),
    ).toBe(false);
    expect(
      requiresLiveData("Ik voel me overprikkeld; er staan lampen aan."),
    ).toBe(false);
    expect(requiresLiveData("I'm overwhelmed and the weather is awful.")).toBe(
      false,
    );
    expect(requiresLiveData("Ik ben gestrest, wat is nu de temperatuur?")).toBe(
      true,
    );
    expect(SYSTEM_PROMPT).toContain(
      "without diagnosing, exaggerating, or assuming more",
    );
  });
});

describe("habit-based automation suggestions", () => {
  it("suggests only after the exact request repeats on three local days at the same hour", () => {
    const history = [
      {
        role: "user" as const,
        content: "Wat is het weer buiten vandaag?",
        at: "2026-10-09T17:00:00.000Z",
      },
      {
        role: "user" as const,
        content: "Wat is het weer buiten vandaag?",
        at: "2026-10-10T17:00:00.000Z",
      },
    ];
    expect(
      recurringRequestSuggestion(
        history,
        "Wat is het weer buiten vandaag?",
        new Date("2026-10-11T17:00:00.000Z"),
        "Europe/Amsterdam",
      ),
    ).toContain("do not create a timer");
    expect(
      recurringRequestSuggestion(
        history,
        "Wat is het weer buiten vandaag?",
        new Date("2026-10-11T15:00:00.000Z"),
        "Europe/Amsterdam",
      ),
    ).toBeNull();
    expect(
      recurringRequestSuggestion(
        history,
        "Wat is het token buiten vandaag?",
        new Date("2026-10-11T17:00:00.000Z"),
        "Europe/Amsterdam",
      ),
    ).toBeNull();
  });
});

describe("voice response style", () => {
  it("keeps quiet-hours answers brief without changing typed chat", () => {
    expect(responseStyle("voice", true)).toContain(
      "Quiet hours are active: keep the spoken answer brief",
    );
    expect(responseStyle("voice", false)).toContain(
      "This is a spoken conversation",
    );
    expect(responseStyle("text", true)).toContain("This is typed chat");
    expect(responseStyle("text", true)).not.toContain("Quiet hours are active");
  });
});

describe("automatic model role routing", () => {
  it.each([
    ["Schrijf een TypeScript functie", "code"],
    ["Vat dit artikel samen", "summary"],
    ["Vat deze Python-code samen", "summary"],
    ["Maak een stappenplan voor migratie", "planning"],
    ["Maak een stappenplan voor een Python-script", "planning"],
    ["Wat vind je van dit idee?", "conversation"],
  ] as const)("classifies %s", (message, role) => {
    expect(classifyModelRole(message)).toBe(role);
  });

  it("routes image attachments to vision", () => {
    expect(
      classifyModelRole("Wat staat hierop?", [
        {
          name: "foto.png",
          content: "aW1hZ2U=",
          encoding: "base64",
          mimeType: "image/png",
        },
      ]),
    ).toBe("vision");
  });
});

describe("code role personality boundary", () => {
  it("asks voice answers to summarize code instead of reading it aloud", () => {
    expect(codeResponseStyle()).toContain(
      "code itself is for the screen, not speech",
    );
    expect(codeResponseStyle()).toContain("short plain-language summary");
  });

  it("keeps user persona rules in conversation context and excludes them from code context", async () => {
    const persona = {
      persona: () => "Always make jokes; answer as a pirate.",
      personaStyleInstruction: () => "TEST_STYLE",
      personaProfileInstruction: () => "PROFILE_TEST",
      activeCommunicationPreferences: () => ["warmer"],
      promptFor: () => "",
    };
    const session = {
      relevant: () => [],
      recent: () => [],
      allMessages: () => [],
      context: () => [],
    };
    const builder = new ContextBuilder(
      { extensionsEnabled: false } as never,
      session as never,
      {} as never,
      persona as never,
      {} as never,
      { all: () => ({}) } as never,
      {} as never,
    );
    const conversation = await builder.build(
      "session",
      "hello",
      "conversation",
    );
    const code = await builder.build("session", "write a function", "code");
    expect(conversation.map((item) => item.content).join("\n")).toContain(
      "Always make jokes",
    );
    expect(conversation.map((item) => item.content).join("\n")).toContain(
      "Lokale gesprekscontext",
    );
    expect(conversation.map((item) => item.content).join("\n")).toContain(
      "TEST_STYLE",
    );
    expect(conversation.map((item) => item.content).join("\n")).toContain(
      "PROFILE_TEST",
    );
    expect(conversation.map((item) => item.content).join("\n")).toContain(
      "warmere, persoonlijkere formulering",
    );
    expect(code.map((item) => item.content).join("\n")).not.toContain(
      "Always make jokes",
    );
    expect(code.map((item) => item.content).join("\n")).not.toContain(
      "Lokale gesprekscontext",
    );
    expect(code.map((item) => item.content).join("\n")).not.toContain(
      "PROFILE_TEST",
    );
    expect(code.map((item) => item.content).join("\n")).not.toContain(
      "TEST_STYLE",
    );
  });
});
