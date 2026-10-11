import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { SessionMemoryService } from "../../src/memory/session-memory.service.js";
import { fakeConfig } from "../integrations/helpers.js";

const directories: string[] = [];

function memory() {
  const directory = fs.mkdtempSync(
    path.join(os.tmpdir(), "nova-session-memory-"),
  );
  directories.push(directory);
  return new SessionMemoryService(
    fakeConfig({ dataFile: (name: string) => path.join(directory, name) }),
  );
}

afterEach(() => {
  for (const directory of directories.splice(0))
    fs.rmSync(directory, { recursive: true, force: true });
});

describe("conversation continuity", () => {
  it("keeps the earlier topic and answer beside short follow-up references", () => {
    const session = memory();
    session.add("same-chat", "user", "Welke afspraak staat er morgen?");
    session.add("same-chat", "assistant", "Om tien uur staat de tandarts.");
    session.add("same-chat", "user", "En morgen?");
    session.add("same-chat", "assistant", "Die staat om tien uur.");
    session.add("same-chat", "user", "Verzet die maar.");

    expect(session.recent("same-chat", 12)).toEqual([
      { role: "user", content: "Welke afspraak staat er morgen?" },
      { role: "assistant", content: "Om tien uur staat de tandarts." },
      { role: "user", content: "En morgen?" },
      { role: "assistant", content: "Die staat om tien uur." },
      { role: "user", content: "Verzet die maar." },
    ]);
  });

  it("keeps each conversation separate and discards earlier refusal noise", () => {
    const session = memory();
    session.add("first", "user", "Zet de lamp in de keuken aan.");
    session.add("first", "assistant", "Ik kan dat niet uitvoeren.");
    session.add("second", "user", "Zet de lamp in de slaapkamer aan.");

    expect(session.recent("first", 12)).toEqual([]);
    expect(session.recent("second", 12)).toEqual([
      { role: "user", content: "Zet de lamp in de slaapkamer aan." },
    ]);
  });
});
