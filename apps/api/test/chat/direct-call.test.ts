import { describe, expect, it } from "vitest";
import { directCallQuery } from "../../src/chat/direct-call.js";

describe("directCallQuery", () => {
  it("understands plain call requests", () => {
    expect(directCallQuery("bel mij")?.to).toBe("me");
    expect(directCallQuery("Kun je me even bellen")).toBeNull();
    expect(directCallQuery("bel me!")?.to).toBe("me");
    expect(directCallQuery("bel Harm")).toMatchObject({ to: "Harm" });
    expect(directCallQuery("bel Harm en zeg dat het eten klaar is.")).toEqual({
      to: "Harm",
      message: "het eten klaar is",
    });
  });
  it("leaves vague or long requests to the model", () => {
    expect(directCallQuery("bel mij en vertel het weer")).toBeNull();
    expect(directCallQuery("wat kost bellen naar Duitsland")).toBeNull();
    expect(directCallQuery("bel de loodgieter morgen om negen uur")).toBeNull();
  });
});
