import { describe, expect, it } from "vitest";
import { novaVersionLabel } from "./version.ts";

describe("novaVersionLabel", () => {
  it.each([
    ["0.1.73", "NOVA v0.1.73"],
    ["v0.2.0", "NOVA v0.2.0"],
    ["dev", "NOVA (ontwikkelbuild)"],
    ["", "NOVA"],
    [undefined, "NOVA"],
  ])("labels %s", (input, expected) => {
    expect(novaVersionLabel(input)).toBe(expected);
  });
});
