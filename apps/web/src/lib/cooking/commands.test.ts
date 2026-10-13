import { describe, expect, it } from "vitest";
import { cookingCommand, parseRecipe } from "./commands.ts";

describe("kookmodus", () => {
  it("reads numbered recipe lines and rejects unbounded input", () => {
    expect(
      parseRecipe("1. Oven aan\n2) Meng het deeg\nStap 3: Bak 20 minuten"),
    ).toEqual(["Oven aan", "Meng het deeg", "Bak 20 minuten"]);
    expect(parseRecipe("a\n".repeat(31))).toEqual([]);
    expect(parseRecipe("x".repeat(12_001))).toEqual([]);
  });

  it("only recognizes explicit step commands", () => {
    expect(cookingCommand("volgende stap")).toBe("next");
    expect(cookingCommand("herhaal de stap.")).toBe("repeat");
    expect(cookingCommand("vorige stap")).toBe("previous");
    expect(cookingCommand("stop kookmodus")).toBe("stop");
    expect(cookingCommand("zet timer voor tien minuten")).toBeNull();
    expect(cookingCommand("volgende stap is de oven")).toBeNull();
  });
});
