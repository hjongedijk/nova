import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { NovaConfig } from "../../src/core/config/nova-config.js";
import { NotesService } from "../../src/notes/notes.service.js";
import { NotesSource } from "../../src/notes/notes.source.js";

const directories: string[] = [];
afterEach(() => {
  for (const directory of directories.splice(0))
    fs.rmSync(directory, { recursive: true, force: true });
});

function service() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "nova-notes-"));
  directories.push(root);
  return {
    root,
    notes: new NotesService({
      dataFile: (name: string) => path.join(root, name),
    } as NovaConfig),
  };
}

describe("private notes", () => {
  it("stores bounded notes in a private directory and finds their text", () => {
    const { root, notes } = service();
    const saved = notes.save("Weekend plan", "Buy paint and repair the shelf.");
    const directory = path.join(root, "notes");
    const file = path.join(directory, `${saved.id}.json`);
    expect(fs.statSync(directory).mode & 0o777).toBe(0o700);
    expect(fs.statSync(file).mode & 0o777).toBe(0o600);
    expect(notes.search("repair shelf")).toMatchObject({
      count: 1,
      notes: [
        {
          id: saved.id,
          title: "Weekend plan",
          excerpt: "Buy paint and repair the shelf.",
        },
      ],
      untrusted: true,
    });
    expect(notes.recent().notes[0]?.id).toBe(saved.id);
  });

  it("rejects secrets, oversized notes, and invalid titles without writing them", () => {
    const { root, notes } = service();
    expect(() => notes.save("Password", "token=abc123secretvalue")).toThrow(
      /geheim/,
    );
    expect(() => notes.save("Title", "x".repeat(12_001))).toThrow(/12.000/);
    expect(() => notes.save("bad\ntitle", "valid content")).toThrow(/titel/);
    expect(
      fs.existsSync(path.join(root, "notes"))
        ? fs.readdirSync(path.join(root, "notes"))
        : [],
    ).toEqual([]);
  });

  it("does not reveal notes outside the bounded matching set", () => {
    const { notes } = service();
    notes.save("Maintenance", "Replace the hallway bulb.");
    expect(notes.search("unrelated topic")).toEqual({
      count: 0,
      notes: [],
      untrusted: true,
    });
    expect(() => notes.search(" ")).toThrow(/zoekterm/);
  });

  it("rejects a symlinked notes directory", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "nova-notes-link-"));
    const outside = fs.mkdtempSync(
      path.join(os.tmpdir(), "nova-notes-outside-"),
    );
    directories.push(root, outside);
    fs.symlinkSync(outside, path.join(root, "notes"), "dir");
    const notes = new NotesService({
      dataFile: (name: string) => path.join(root, name),
    } as NovaConfig);
    expect(() => notes.save("Private", "Do not follow links.")).toThrow(
      /veilig/,
    );
    expect(fs.readdirSync(outside)).toEqual([]);
  });

  it("offers explicit save and read-only retrieval tools", async () => {
    const { notes } = service();
    const source = new NotesSource(notes);
    expect(source.definitions().map(({ name, risk }) => [name, risk])).toEqual([
      ["notes_save", "SAFE"],
      ["notes_search", "READ_ONLY"],
      ["notes_recent", "READ_ONLY"],
      ["notes_delete", "CONFIRM"],
    ]);
    expect(source.definitions()[3]?.allowStandingApproval).toBe(false);
    const saved = await source.execute("notes_save", {
      title: "Trip",
      content: "Pack the rain jacket.",
    });
    expect(saved).toMatchObject({ ok: true });
    expect(
      await source.execute("notes_search", { query: "rain jacket" }),
    ).toMatchObject({ ok: true, result: { count: 1, untrusted: true } });
    expect(
      await source.execute("notes_delete", {
        id: (saved.result as { id: string }).id,
      }),
    ).toMatchObject({ ok: true, result: { removed: true } });
  });

  it("keeps unexpected storage diagnostics out of tool results", async () => {
    const { notes } = service();
    vi.spyOn(notes, "recent").mockImplementationOnce(() => {
      throw new Error("private-storage-diagnostic-8293");
    });
    const result = await new NotesSource(notes).execute("notes_recent", {});
    expect(result).toMatchObject({
      ok: false,
      error: "De notitieactie is mislukt. Probeer het opnieuw.",
    });
    expect(JSON.stringify(result)).not.toContain(
      "private-storage-diagnostic-8293",
    );
  });
});
