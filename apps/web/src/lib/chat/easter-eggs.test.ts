import { describe, expect, it } from "vitest";
import { easterEgg } from "./easter-eggs.ts";

describe("small local orb reactions", () => {
  it("recognizes three explicit phrases", () => {
    expect(easterEgg("Nova, high five!")).toEqual({
      reply: "High five!",
      event: "check",
    });
    expect(easterEgg("feestmodus")).toEqual({
      reply: "Een klein feestje voor jou!",
      event: "heart",
    });
    expect(easterEgg("Slaap lekker.")).toEqual({
      reply: "Slaap lekker. Ik houd het rustig.",
      event: "sleep",
    });
  });

  it("does not hijack ordinary questions or similar commands", () => {
    expect(easterEgg("Kan Nova de feestmodus inschakelen?")).toBeNull();
    expect(easterEgg("Nova, start feestmodus")).toBeNull();
    expect(easterEgg("Slaap lekker en zet het alarm aan")).toBeNull();
  });
});
