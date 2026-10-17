import { describe, expect, it } from "vitest";
import {
  MAIN_PAGES,
  PAGES,
  TOPICS,
  resolveSettingsTarget,
  searchSettings,
  settingsSection,
  topicHref,
} from "./sections.ts";

describe("settings structure", () => {
  it("has at most six everyday pages and one set-apart expert page", () => {
    expect(MAIN_PAGES.length).toBeLessThanOrEqual(6);
    expect(PAGES.at(-1)?.id).toBe("geavanceerd");
    expect(MAIN_PAGES.map((page) => page.id)).not.toContain("geavanceerd");
  });

  it("puts every topic on a real page, once", () => {
    const ids = TOPICS.map((topic) => topic.id);
    expect(new Set(ids).size).toBe(ids.length);
    const pages = new Set(PAGES.map((page) => page.id as string));
    for (const topic of TOPICS) expect(pages.has(topic.page)).toBe(true);
  });
});

describe("old links", () => {
  it.each([
    ["voice", "", "gesprek", "stem"],
    ["general", "", "gesprek", "snelle-opdrachten"],
    ["models", "", "modellen", null],
    ["connections", "", "huis", "home-assistant"],
    ["devices", "", "huis", "pc"],
    ["safety", "", "zelf", "toestemmingen"],
    ["objectives", "", "zelf", "doelen"],
    ["documents", "", "geheugen", "documenten"],
    ["system", "", "geavanceerd", "updates"],
    ["system", "#actielog", "geavanceerd", "actielog"],
    ["system", "#tool-switch-history", "geavanceerd", "tool-switch-history"],
    [
      "models",
      "#model-role-history-title",
      "geavanceerd",
      "model-role-history-title",
    ],
    ["personality", "#persona-history", "gesprek", "persona-history"],
    ["setup", "", "geavanceerd", "installatie"],
    ["beheer", "", "geavanceerd", null],
    ["huis", "", "huis", null],
    ["telefoon", "", "telefoon", null],
  ])("?section=%s%s resolves to %s (%s)", (old, hash, page, anchor) => {
    expect(resolveSettingsTarget(old, hash)).toEqual({ page, anchor });
  });

  it("falls back to the first page for nonsense", () => {
    expect(settingsSection("nope")).toBe("gesprek");
    expect(settingsSection(null)).toBe("gesprek");
  });
});

describe("search", () => {
  it("finds expert items and links to the expert page", () => {
    const [first] = searchSettings("mcp");
    expect(first?.id).toBe("services");
    expect(topicHref(first!)).toBe("/settings?section=geavanceerd#services");
  });

  it("finds everyday items by plain words", () => {
    expect(searchSettings("microfoon")[0]?.id).toBe("voice");
    expect(searchSettings("gratis dienst")[0]?.id).toBe("models");
    expect(searchSettings("back-up")[0]?.page).toBe("geheugen");
  });
});
