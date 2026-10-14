import { describe, expect, it, vi } from "vitest";
import { ConfirmationHandler } from "../../src/chat/confirmation-handler.service.js";
import { OutcomeService } from "../../src/chat/outcome.service.js";
import { ConfirmationsService } from "../../src/confirmations/confirmations.service.js";
import { AuditService } from "../../src/core/audit/audit.service.js";
import { SessionMemoryService } from "../../src/memory/session-memory.service.js";
import { ToolsService } from "../../src/tools/tools.service.js";
import type { ToolResult } from "../../src/tools/tool.types.js";

function fixture() {
  const audit = { record: vi.fn() };
  const confirmations = new ConfirmationsService(
    audit as unknown as AuditService,
  );
  const tools = { execute: vi.fn() };
  const memory = { recent: vi.fn(() => []) };
  const outcome = { describe: vi.fn(async () => "Het resultaat.") };
  const handler = new ConfirmationHandler(
    confirmations,
    tools as unknown as ToolsService,
    audit as unknown as AuditService,
    memory as unknown as SessionMemoryService,
    outcome as unknown as OutcomeService,
  );
  const original = confirmations.create(
    "chat",
    "settings_persona_set",
    { text: "Antwoord kort." },
    "CONFIRM",
    "old-settings-revision",
    false,
  );
  return { audit, confirmations, tools, memory, outcome, handler, original };
}

describe("confirmation changes after approval", () => {
  it.each(["button", "spoken"])(
    "cancels a renewed approval from a %s confirmation and removes the hidden action",
    async (input) => {
      const { audit, confirmations, tools, handler, original } = fixture();
      const cancel = vi.spyOn(confirmations, "cancel");
      tools.execute.mockImplementation(async () => ({
        ok: false,
        requiresConfirmation: true,
        action: confirmations.create(
          "chat",
          original.tool,
          original.args,
          "CONFIRM",
          "new-settings-revision",
          false,
        ),
      }));
      const response = await handler.handle(
        "chat",
        "ja",
        input === "button" ? original.confirmationId : undefined,
      );
      expect(tools.execute).toHaveBeenCalledWith(
        original.tool,
        original.args,
        "chat",
        original,
        false,
      );
      expect(cancel).toHaveBeenCalledWith("chat", "confirmation_changed");
      expect(confirmations.has("chat")).toBe(false);
      expect(response).toMatchObject({
        reply: expect.stringMatching(
          /instellingen zijn gewijzigd.*niets uitgevoerd.*opnieuw/,
        ),
        result: {
          ok: false,
          error: expect.stringMatching(/instellingen zijn gewijzigd/),
        },
      });
      expect(response!.result).not.toHaveProperty("requiresConfirmation");
      expect(response!.result).not.toHaveProperty("action");
      expect(audit.record).toHaveBeenCalledWith(
        expect.objectContaining({
          tool: original.tool,
          confirmation: "confirmation_changed",
        }),
      );
      expect(
        await handler.handle("chat", "ja", original.confirmationId),
      ).toMatchObject({ reply: expect.stringMatching(/niets meer/) });
      expect(tools.execute).toHaveBeenCalledTimes(1);
    },
  );

  it("preserves a newer concurrent pending action when returning an older renewal", async () => {
    const { confirmations, tools, handler, original } = fixture();
    const cancel = vi.spyOn(confirmations, "cancel");
    tools.execute.mockImplementation(async () => {
      const renewed = confirmations.create(
        "chat",
        original.tool,
        original.args,
        "CONFIRM",
        "new-settings-revision",
        false,
      );
      confirmations.create(
        "chat",
        "settings_instruction_create",
        { name: "Ochtend", instructions: "Lees het nieuws." },
        "CONFIRM",
        "later-revision",
        false,
      );
      return { ok: false, requiresConfirmation: true, action: renewed };
    });
    const response = await handler.handle(
      "chat",
      "ja",
      original.confirmationId,
    );
    expect(cancel).not.toHaveBeenCalled();
    expect(confirmations.peek("chat")).toMatchObject({
      tool: "settings_instruction_create",
      schemaFingerprint: "later-revision",
    });
    expect(response!.result).toMatchObject({ ok: false });
    expect(response!.result).not.toHaveProperty("requiresConfirmation");
    expect(response!.result).not.toHaveProperty("action");
  });

  it("keeps a normal confirmed success and passes through Always", async () => {
    const { confirmations, tools, handler, original } = fixture();
    const result: ToolResult = {
      ok: true,
      verified: true,
      result: { persona: "Antwoord kort." },
    };
    tools.execute.mockResolvedValue(result);
    const response = await handler.handle(
      "chat",
      "ja",
      original.confirmationId,
      true,
    );
    expect(response).toEqual({
      reply: "Gelukt, en ik heb het gecontroleerd.",
      result,
    });
    expect(confirmations.has("chat")).toBe(false);
    expect(tools.execute).toHaveBeenCalledWith(
      original.tool,
      original.args,
      "chat",
      original,
      true,
    );
  });

  it("answers direct confirmation results in the selected conversation language", async () => {
    const { confirmations, tools, handler, original } = fixture();
    tools.execute.mockResolvedValue({ ok: true, verified: true });
    const response = await handler.handle(
      "chat",
      "yes",
      original.confirmationId,
      false,
      "en",
    );
    expect(response?.reply).toBe("Done, and I verified it.");
    expect(confirmations.has("chat")).toBe(false);
  });

  it("returns English after a button confirmation in an English conversation", async () => {
    const { tools, handler, original, outcome } = fixture();
    tools.execute.mockResolvedValue({
      ok: true,
      result: { output: "confirmed output" },
    });
    outcome.describe.mockResolvedValue("The result.");

    const response = await handler.handle(
      "chat",
      "yes",
      original.confirmationId,
      false,
      "en",
    );

    expect(response?.reply).toBe("The result.");
    expect(outcome.describe).toHaveBeenCalledWith(
      expect.objectContaining({ language: "en" }),
    );
  });

  it("keeps raw tool diagnostics out of spoken and returned confirmation errors", async () => {
    const { tools, handler, original } = fixture();
    tools.execute.mockResolvedValue({
      ok: false,
      error: "ECONNREFUSED 10.0.0.7:8123 internal stack trace",
    });

    const response = await handler.handle(
      "chat",
      "ja",
      original.confirmationId,
    );

    expect(response?.reply).toBe(
      "Dat is niet gelukt. De actie is niet uitgevoerd.",
    );
    expect(JSON.stringify(response)).not.toContain("ECONNREFUSED");
    expect(JSON.stringify(response)).not.toContain("10.0.0.7");
  });

  describe.each(["nl", "en"] as const)(
    "evidence-bound %s confirmation replies",
    (language) => {
      const replies =
        language === "en"
          ? {
              notExecuted: "The action was not executed.",
              failedCheck:
                "The check did not confirm that the action succeeded.",
              unverified:
                "The action was requested, but I could not verify that it completed.",
              failed: "That did not work. The action was not completed.",
            }
          : {
              notExecuted: "De actie is niet uitgevoerd.",
              failedCheck:
                "De controle heeft niet bevestigd dat de actie is gelukt.",
              unverified:
                "De actie is aangevraagd, maar ik kon niet controleren of die is voltooid.",
              failed: "Dat is niet gelukt. De actie is niet uitgevoerd.",
            };
      const cases: Array<{ name: string; result: ToolResult; reply: string }> =
        [
          {
            name: "not executed despite positive flags",
            result: {
              ok: true,
              executed: false,
              verified: true,
              accepted: true,
            },
            reply: replies.notExecuted,
          },
          {
            name: "not executed despite failed verification",
            result: { ok: false, executed: false, verified: false },
            reply: replies.notExecuted,
          },
          {
            name: "verification failed after accepted execution",
            result: { ok: true, accepted: true, verified: false },
            reply: replies.failedCheck,
          },
          {
            name: "failed execution with failed verification",
            result: { ok: false, verified: false },
            reply: replies.failedCheck,
          },
          {
            name: "explicitly unknown verification",
            result: { ok: true, verified: null },
            reply: replies.unverified,
          },
          {
            name: "accepted without verification",
            result: { ok: true, accepted: true },
            reply: replies.unverified,
          },
          {
            name: "accepted despite unsuccessful status",
            result: { ok: false, accepted: true },
            reply: replies.unverified,
          },
          {
            name: "failed status despite verified flag",
            result: { ok: false, verified: true },
            reply: replies.failed,
          },
        ];
      describe.each([false, true])("with output=%s", (withOutput) => {
        it.each(cases)(
          "reports $name without contradictory model narration",
          async ({ result, reply }) => {
            const { tools, handler, original, outcome } = fixture();
            const raw: ToolResult = {
              ...result,
              error: "ECONNREFUSED private diagnostic 10.0.0.7",
              ...(withOutput
                ? { result: { output: "Contradictory successful output." } }
                : {}),
            };
            const before = structuredClone(raw);
            tools.execute.mockResolvedValue(raw);
            outcome.describe.mockResolvedValue(
              "Done, successfully verified everything.",
            );
            const response = await handler.handle(
              "chat",
              "yes",
              original.confirmationId,
              false,
              language,
            );
            expect(response?.reply).toBe(reply);
            expect(outcome.describe).not.toHaveBeenCalled();
            expect(response?.result).toEqual(
              Object.fromEntries(
                Object.entries(raw).filter(([key]) => key !== "error"),
              ),
            );
            expect(JSON.stringify(response)).not.toContain("ECONNREFUSED");
            expect(raw).toEqual(before);
          },
        );
      });

      it.each([undefined, true])(
        "preserves success for verified=%s with no output",
        async (verified) => {
          const { tools, handler, original, outcome } = fixture();
          tools.execute.mockResolvedValue({
            ok: true,
            ...(verified === true ? { verified } : {}),
          });
          const response = await handler.handle(
            "chat",
            "yes",
            original.confirmationId,
            false,
            language,
          );
          expect(response?.reply).toBe(
            language === "en"
              ? verified
                ? "Done, and I verified it."
                : "Done."
              : verified
                ? "Gelukt, en ik heb het gecontroleerd."
                : "Is gedaan.",
          );
          expect(outcome.describe).not.toHaveBeenCalled();
        },
      );

      it.each([undefined, true])(
        "preserves output narration for verified=%s",
        async (verified) => {
          const { tools, handler, original, outcome } = fixture();
          const result = {
            ok: true,
            ...(verified === true ? { verified } : {}),
            result: { output: "Verified output." },
          };
          tools.execute.mockResolvedValue(result);
          outcome.describe.mockResolvedValue("The actual result.");
          const response = await handler.handle(
            "chat",
            "yes",
            original.confirmationId,
            false,
            language,
          );
          expect(response).toEqual({ reply: "The actual result.", result });
          expect(outcome.describe).toHaveBeenCalledOnce();
          expect(outcome.describe).toHaveBeenCalledWith(
            expect.objectContaining({ result, language }),
          );
        },
      );
    },
  );
});
