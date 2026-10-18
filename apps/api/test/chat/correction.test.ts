import { describe, expect, it, vi } from "vitest";
import { detectCorrection } from "../../src/chat/correction.js";
import { CorrectionLearner } from "../../src/chat/correction-learner.service.js";

describe("detectCorrection", () => {
  it.each([
    ["nee, mijn hond heet Max", "mijn hond heet Max"],
    [
      "Dat klopt niet, mijn favoriete kleur is rood",
      "mijn favoriete kleur is rood",
    ],
    ["Fout. Ik woon in Utrecht", "Ik woon in Utrecht"],
    [
      "dat bedoelde ik niet, ik wil liever warm licht",
      "ik wil liever warm licht",
    ],
    ["No, my office is in Delft", "my office is in Delft"],
    ["That's wrong, I prefer tea", "I prefer tea"],
  ])("%s", (message, statement) => {
    const signal = detectCorrection(message);
    expect(signal?.statement).toBe(statement);
  });

  it("ignores plain answers, questions and long text", () => {
    expect(detectCorrection("nee")).toBeNull();
    expect(detectCorrection("nee, wil je dat?")).toBeNull();
    expect(detectCorrection("zet het licht aan")).toBeNull();
    expect(detectCorrection(`nee, ${"x".repeat(500)}`)).toBeNull();
  });

  it("teaches an alias from an entity correction", () => {
    const signal = detectCorrection("nee, de grote lamp is light.woonkamer");
    expect(signal?.alias).toEqual({
      name: "grote lamp",
      entity: "light.woonkamer",
    });
    expect(signal?.type).toBe("LEARNED_ALIAS");
    expect(
      detectCorrection("met de grote lamp bedoel ik light.woonkamer")?.alias,
    ).toEqual({ name: "grote lamp", entity: "light.woonkamer" });
  });

  it("recognises a stop rule", () => {
    const signal = detectCorrection("doe dat niet meer");
    expect(signal).toMatchObject({ stop: true, type: "PROCEDURE" });
    expect(signal?.statement).toBeNull();
    expect(
      detectCorrection("stop daarmee, geen meldingen 's nachts")?.stop,
    ).toBe(true);
  });
});

function harness(search: unknown[] = []) {
  const semantic = {
    search: vi.fn(async () => search),
    write: vi.fn(async () => ({ ok: true })),
    correct: vi.fn(async () => ({ ok: true })),
  };
  const audit = { record: vi.fn() };
  const learner = new CorrectionLearner(
    { autoExecuteSafe: true } as never,
    semantic as never,
    audit as never,
  );
  return { semantic, audit, learner };
}

describe("CorrectionLearner", () => {
  it("writes an inferred, tagged memory and audits it", async () => {
    const { semantic, audit, learner } = harness();
    const out = await learner.learn({
      sessionId: "s",
      message: "nee, mijn hond heet Max",
    });
    expect(out?.learned).toBe(true);
    expect(semantic.write).toHaveBeenCalledWith(
      "mijn hond heet Max",
      expect.objectContaining({
        origin: "inferred",
        tags: ["learned", "owner-correction"],
      }),
    );
    expect(audit.record).toHaveBeenCalledOnce();
  });

  it("supersedes the contradicting memory through correct()", async () => {
    const { semantic, learner } = harness([
      { id: "old-id", text: "mijn hond Bram heet", superseded_by: null },
    ]);
    const out = await learner.learn({
      sessionId: "s",
      message: "nee, mijn hond heet Max",
    });
    expect(semantic.correct).toHaveBeenCalledWith(
      "old-id",
      "mijn hond heet Max",
      {
        origin: "inferred",
        tags: ["learned", "owner-correction"],
      },
    );
    expect(semantic.write).not.toHaveBeenCalled();
    expect(out?.superseded).toBe("old-id");
  });

  it("writes a LEARNED_ALIAS with the entity", async () => {
    const { semantic, learner } = harness();
    await learner.learn({
      sessionId: "s",
      message: "nee, de grote lamp is light.woonkamer",
    });
    expect(semantic.write).toHaveBeenCalledWith(
      "grote lamp is light.woonkamer",
      expect.objectContaining({
        type: "LEARNED_ALIAS",
        related_entity: "light.woonkamer",
      }),
    );
  });

  it("never learns secrets, sensitive data or untrusted turns", async () => {
    const { semantic, learner } = harness();
    await learner.learn({
      sessionId: "s",
      message: "nee, mijn IBAN is NL91ABNA0417164300",
    });
    await learner.learn({
      sessionId: "s",
      message: "nee, mijn hond heet Max",
      untrusted: true,
    });
    expect(semantic.write).not.toHaveBeenCalled();
    expect(semantic.correct).not.toHaveBeenCalled();
  });

  it("notifies listeners about stop corrections without storing", async () => {
    const { semantic, learner } = harness();
    const heard = vi.fn();
    learner.onCorrection(heard);
    await learner.learn({
      sessionId: "s",
      message: "doe dat niet meer",
      previousAssistant: "Ik stuur je een melding",
    });
    expect(heard).toHaveBeenCalledOnce();
    expect(semantic.write).not.toHaveBeenCalled();
  });
});
