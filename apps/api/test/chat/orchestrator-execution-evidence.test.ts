import { describe, expect, it, vi } from "vitest";
import type { PendingConfirmation, Risk } from "@nova/contracts";
import { OrchestratorService } from "../../src/chat/orchestrator.service.js";
import type { ToolResult } from "../../src/tools/tool.types.js";

const toolCall = (name: string) => ({
  id: name,
  type: "function" as const,
  function: { name, arguments: "{}" },
});

function fixture(risk: Risk, result: ToolResult, batch = false) {
  const name = "fixture_change";
  const definitions = [name, "fixture_followup"].map((name) => ({
    name,
    function: { name },
    enabled: true,
    risk,
  }));
  const call = vi
    .fn()
    .mockResolvedValueOnce({
      assistant: {
        role: "assistant",
        tool_calls: [
          toolCall(name),
          ...(batch ? [toolCall("fixture_followup")] : []),
        ],
      },
      model: "fixture",
      usage: null,
    })
    .mockImplementationOnce(async (_messages, options) => {
      const content = "Contradictory model claim: completed and verified.";
      if (options.stream) options.emit("token", { text: content });
      return {
        assistant: { role: "assistant", content },
        model: "fixture",
        usage: null,
      };
    });
  const execute = vi.fn().mockResolvedValue(result);
  const service = new OrchestratorService(
    { maxToolRounds: 4 } as never,
    { call } as never,
    {
      assertFree: () => ({ ready: true }),
      preferredModelForRole: () => undefined,
    } as never,
    {
      list: () => definitions,
      forModel: () => definitions,
      execute,
    } as never,
    { cancel: vi.fn() } as never,
    { handle: vi.fn().mockResolvedValue(null) } as never,
    {
      build: async () => [
        { role: "system", content: "Synthetic fixture." },
        { role: "user", content: "Synthetic change." },
      ],
    } as never,
  );
  const events: Array<{ event: string; data: Record<string, unknown> }> = [];
  const run = (language: "nl" | "en", stream: boolean) =>
    service.run({
      sessionId: "evidence-fixture",
      message: "Synthetic change.",
      responseLanguage: language,
      stream,
      emit: (event, data) => events.push({ event, data }),
    });
  return { call, execute, events, run };
}

describe.each(["nl", "en"] as const)(
  "ordinary %s execution evidence",
  (language) => {
    const copy =
      language === "en"
        ? {
            notExecuted: "The action was not executed.",
            failedCheck: "The check did not confirm that the action succeeded.",
            unverified:
              "The action was requested, but I could not verify that it completed.",
            failed:
              "The action failed. Check the current state before trying again.",
          }
        : {
            notExecuted: "De actie is niet uitgevoerd.",
            failedCheck:
              "De controle heeft niet bevestigd dat de actie is gelukt.",
            unverified:
              "De actie is aangevraagd, maar ik kon niet controleren of die is voltooid.",
            failed:
              "De actie is niet gelukt. Controleer de huidige toestand voordat je het opnieuw probeert.",
          };
    const cases: Array<{ label: string; result: ToolResult; reply: string }> = [
      {
        label: "not executed despite positive flags",
        result: { ok: true, executed: false, verified: true, accepted: true },
        reply: copy.notExecuted,
      },
      {
        label: "failed verification despite positive status",
        result: { ok: true, verified: false },
        reply: copy.failedCheck,
      },
      {
        label: "failure despite verified flag",
        result: { ok: false, verified: true },
        reply: copy.failed,
      },
      {
        label: "accepted without verified effect",
        result: { ok: false, accepted: true, verified: null },
        reply: copy.unverified,
      },
      {
        label: "accepted without verification field",
        result: { ok: true, accepted: true },
        reply: copy.unverified,
      },
      {
        label: "explicitly unknown verification",
        result: { ok: true, verified: null },
        reply: copy.unverified,
      },
    ];

    describe.each(["SAFE", "CONFIRM", "DANGEROUS"] as const)(
      "%s mutation",
      (risk) => {
        describe.each([false, true])("stream=%s", (stream) => {
          it.each(cases)(
            "stops at $label before narration or another mutation",
            async ({ result, reply }) => {
              const input = {
                ...result,
                ...(risk === "CONFIRM" ? { standingApproval: true } : {}),
                error: "private upstream diagnostic /private/path",
                result: { output: "Contradictory successful output." },
              };
              const test = fixture(risk, input, true);
              const response = await test.run(language, stream);
              expect(response.reply).toBe(reply);
              expect(response.model).toBe("fixture");
              expect(test.call).toHaveBeenCalledOnce();
              expect(test.execute).toHaveBeenCalledOnce();
              expect(
                test.events
                  .filter(({ event }) => event === "token")
                  .map(({ data }) => data.text)
                  .join(""),
              ).toBe(stream ? reply : "");
              expect(
                test.events.find(({ event }) => event === "tool_result")?.data,
              ).toMatchObject({
                risk,
                ok: result.ok,
                accepted: result.accepted === true,
                verified: result.verified ?? null,
                standingApproval: risk === "CONFIRM",
              });
              expect(JSON.stringify(response)).not.toContain(
                "private upstream",
              );
              expect(JSON.stringify(test.events)).not.toContain(
                "private upstream",
              );
            },
          );
        });
      },
    );

    it("keeps read-only failure recovery in the model loop", async () => {
      const test = fixture("READ_ONLY", {
        ok: false,
        executed: false,
        verified: false,
      });
      await test.run(language, true);
      expect(test.call).toHaveBeenCalledTimes(2);
      expect(test.execute).toHaveBeenCalledOnce();
    });

    it("does not deny possible partial effects after an unsuccessful mutation", async () => {
      const test = fixture("SAFE", {
        ok: false,
        status: "partial_failure",
        result: { completedTargets: 1 },
        error: "private partial-effect diagnostic",
      });
      const response = await test.run(language, true);
      expect(response.reply).toBe(copy.failed);
      expect(test.call).toHaveBeenCalledOnce();
      expect(JSON.stringify(response)).not.toContain("private");
      expect(
        test.events.find(({ event }) => event === "tool_result")?.data,
      ).toMatchObject({ ok: false, status: "partial_failure" });
    });

    it.each([undefined, true])(
      "preserves ordinary successful mutation with verified=%s",
      async (verified) => {
        const test = fixture("SAFE", {
          ok: true,
          ...(verified === true ? { verified } : {}),
        });
        const response = await test.run(language, true);
        expect(response.reply).toBe(
          "Contradictory model claim: completed and verified.",
        );
        expect(test.call).toHaveBeenCalledTimes(2);
      },
    );

    it("preserves a pending confirmation before interpreting its unsuccessful result", async () => {
      const action: PendingConfirmation = {
        tool: "fixture_change",
        args: {},
        risk: "DANGEROUS",
        confirmationId: "fixture-confirmation",
        sessionId: "evidence-fixture",
        createdAt: Date.now(),
        expiresAt: Date.now() + 60_000,
      };
      const test = fixture("DANGEROUS", {
        ok: false,
        executed: false,
        requiresConfirmation: true,
        action,
      });
      const response = await test.run(language, true);
      expect(response.confirmation).toEqual(action);
      expect(test.events.some(({ event }) => event === "confirmation")).toBe(
        true,
      );
      expect(test.call).toHaveBeenCalledOnce();
    });

    it("emits available ambiguity choices before stopping a failed mutation", async () => {
      const test = fixture("SAFE", {
        ok: false,
        ambiguous: true,
        candidates: [{ entity_id: "light.fixture", name: "Fixture light" }],
      });
      const response = await test.run(language, true);
      expect(response.reply).toBe(copy.failed);
      expect(
        test.events.findIndex(({ event }) => event === "choices"),
      ).toBeLessThan(test.events.findIndex(({ event }) => event === "token"));
      expect(test.call).toHaveBeenCalledOnce();
    });
  },
);
