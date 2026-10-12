import { describe, expect, it } from "vitest";
import type { FeedEvent } from "@nova/contracts";
import { readHelperSnoozes, writeHelperSnoozes } from "./helper-snoozes.ts";

const notice: FeedEvent = {
  seq: 42,
  kind: "alert",
  severity: "warning",
  title: "Server opnieuw gestart",
  detail: "Controleer de dienst.",
  at: "2026-10-12T08:00:00Z",
  speakAllowed: true,
};

describe("helper snoozes", () => {
  it("restores a pending reminder after helper restart without repeating speech", () => {
    const now = Date.parse("2026-10-12T08:00:00Z");
    const restored = readHelperSnoozes(
      writeHelperSnoozes([{ event: notice, until: now + 10 * 60_000 }]),
      now + 60_000,
    );
    expect(restored).toHaveLength(1);
    expect(restored[0]).toMatchObject({
      until: now + 10 * 60_000,
      event: { title: notice.title, seq: -1, speakAllowed: false },
    });
  });

  it("recovers a due reminder after restart and rejects stale or malformed storage", () => {
    const now = Date.parse("2026-10-12T08:20:00Z");
    const due = readHelperSnoozes(
      writeHelperSnoozes([{ event: notice, until: now - 60_000 }]),
      now,
    );
    expect(due[0]?.event.title).toBe(notice.title);
    expect(
      readHelperSnoozes(
        writeHelperSnoozes([
          {
            event: { ...notice, deliveryMode: "screen" },
            until: now - 60_000,
          },
        ]),
        now,
      )[0]?.event.deliveryMode,
    ).toBe("screen");
    expect(
      readHelperSnoozes(
        writeHelperSnoozes([{ event: notice, until: now - 2 * 60 * 60_000 }]),
        now,
      ),
    ).toEqual([]);
    expect(readHelperSnoozes("not json", now)).toEqual([]);
    expect(
      readHelperSnoozes(
        JSON.stringify([
          { event: { ...notice, title: "x".repeat(500) }, until: now },
        ]),
        now,
      ),
    ).toEqual([]);
  });
});
