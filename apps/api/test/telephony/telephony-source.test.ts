import { describe, expect, it, vi } from "vitest";
import { TelephonyService } from "../../src/telephony/telephony.service.js";
import { TelephonySource } from "../../src/telephony/telephony.source.js";

function setup() {
  const call = vi.fn(async () => ({ callId: "test-call" }));
  const service = {
    enabled: true,
    classify: () => ({ kind: "internal", number: "101" }),
    allowsInternalWithoutConfirmation: () => true,
    call,
  } as unknown as TelephonyService;
  return { source: new TelephonySource(service), call };
}

describe("phone call conversation default", () => {
  it.each([
    { supplied: undefined, expected: true },
    { supplied: true, expected: true },
    { supplied: false, expected: false },
  ])(
    "preserves $supplied through preparation and execution",
    async ({ supplied, expected }) => {
      const { source, call } = setup();
      const args = {
        to: "my phone",
        message: "Het is twaalf uur.",
        ...(supplied === undefined ? {} : { conversation: supplied }),
      };
      const prepared = await source.prepare("phone_call", args);
      expect(prepared).not.toHaveProperty("error");
      if ("error" in prepared) throw new Error(prepared.error);
      expect(prepared.args).toEqual({
        to: "101",
        message: args.message,
        conversation: expected,
      });
      expect(await source.execute("phone_call", prepared.args)).toMatchObject({
        ok: true,
      });
      expect(call).toHaveBeenCalledExactlyOnceWith("101", args.message, {
        conversation: expected,
      });
    },
  );

  it("also defaults direct execution to conversation", async () => {
    const { source, call } = setup();
    await source.execute("phone_call", { to: "101", message: "Hallo." });
    expect(call).toHaveBeenCalledExactlyOnceWith("101", "Hallo.", {
      conversation: true,
    });
  });

  it("declares the conversational schema default", () => {
    const { source } = setup();
    const definition = source
      .definitions()
      .find((tool) => tool.name === "phone_call");
    expect(definition?.parameters).toMatchObject({
      properties: { conversation: { type: "boolean", default: true } },
    });
    expect(definition?.description).toContain("one-way announcement");
    expect(definition?.description).not.toContain("confirm external");
    expect(definition?.description).not.toContain("only read-only");
  });
});
