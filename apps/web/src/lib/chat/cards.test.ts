import { describe, expect, it } from "vitest";
import type { PendingConfirmation } from "@nova/contracts";

describe("confirmation labels", () => {
  it("uses the selected language without hiding destructive consequences", async () => {
    const action: PendingConfirmation = {
      confirmationId: "confirm-1",
      sessionId: "session-1",
      tool: "code_file_delete",
      args: { projectId: "nova", path: "src/example.ts" },
      createdAt: 0,
      expiresAt: 60_000,
    };

    Object.assign(globalThis, { $state: (value: unknown) => value });
    const { confirmationLabel } = await import("./cards.svelte.ts");
    expect(confirmationLabel(action, "en")).toContain(
      "Delete file nova/src/example.ts. This cannot be undone.",
    );
    expect(confirmationLabel(action, "en")).toContain(
      "Confirmation expires in 60 seconds.",
    );
    expect(confirmationLabel(action, "nl")).toContain(
      "Dit kan niet ongedaan worden gemaakt.",
    );
  });
});
