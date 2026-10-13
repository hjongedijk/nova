import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { NovaConfig } from "../../src/core/config/nova-config.js";
import { NotesService } from "../../src/notes/notes.service.js";
import { QuickNoteController } from "../../src/notes/quick-note.controller.js";

const roots: string[] = [];
afterEach(() => {
  vi.useRealTimers();
  for (const root of roots.splice(0))
    fs.rmSync(root, { recursive: true, force: true });
});

describe("direct quick note", () => {
  it("saves exactly one phrase through E3 with the server creation date", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-10-13T21:35:00.000Z"));
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "nova-quick-note-"));
    roots.push(root);
    const notes = new NotesService({
      dataFile: (name: string) => path.join(root, name),
    } as NovaConfig);
    const quick = new QuickNoteController(notes);
    const saved = quick.save({ content: "Koop morgen tomaten." });
    expect(saved).toMatchObject({
      title: "Snelle notitie",
      createdAt: "2026-10-13T21:35:00.000Z",
    });
    expect(notes.recent().notes[0]).toMatchObject({
      id: saved.id,
      excerpt: "Koop morgen tomaten.",
      createdAt: saved.createdAt,
    });
    expect(() => quick.save({ content: "regel een\nregel twee" })).toThrow();
    expect(() => quick.save({ content: "token=abc123" })).toThrow(
      "De notitie is niet opgeslagen.",
    );
    expect(notes.recent().count).toBe(1);
  });
});
