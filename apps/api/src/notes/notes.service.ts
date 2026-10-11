import { Injectable, Logger } from "@nestjs/common";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { NovaConfig } from "../core/config/nova-config.js";
import { sanitize } from "../core/security/sanitize.js";

const MAX_NOTES = 500;
const MAX_CONTENT = 12_000;
const MAX_RESULTS = 5;
const MAX_EXCERPT = 1_200;

interface StoredNote {
  version: 1;
  id: string;
  title: string;
  content: string;
  createdAt: string;
  updatedAt: string;
}

/** Private, bounded notes stored separately from chat history and semantic memory. */
@Injectable()
export class NotesService {
  private readonly directory: string;
  private readonly logger = new Logger(NotesService.name);

  constructor(config: NovaConfig) {
    this.directory = config.dataFile("notes");
  }

  save(titleInput: string, contentInput: string) {
    const title = cleanTitle(titleInput);
    const content = cleanContent(contentInput);
    const notes = this.readAll();
    if (notes.length >= MAX_NOTES)
      throw new Error("Je notitieboek is vol; verwijder eerst oude notities.");
    const now = new Date().toISOString();
    const note: StoredNote = {
      version: 1,
      id: crypto.randomUUID(),
      title,
      content,
      createdAt: now,
      updatedAt: now,
    };
    this.ensureDirectory();
    const target = path.join(this.directory, `${note.id}.json`);
    const temporary = `${target}.${process.pid}.tmp`;
    try {
      fs.writeFileSync(temporary, JSON.stringify(note), {
        flag: "wx",
        mode: 0o600,
      });
      fs.chmodSync(temporary, 0o600);
      fs.renameSync(temporary, target);
      return { id: note.id, title: note.title, createdAt: now };
    } catch {
      fs.rmSync(temporary, { force: true });
      throw new Error("De notitie kon niet veilig worden opgeslagen.");
    }
  }

  recent() {
    const notes = this.readAll()
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
      .slice(0, MAX_RESULTS);
    return {
      count: notes.length,
      notes: notes.map(({ id, title, content, createdAt, updatedAt }) => ({
        id,
        title,
        createdAt,
        updatedAt,
        excerpt: content.slice(0, 240),
      })),
      untrusted: true,
    };
  }

  search(queryInput: string) {
    const query = cleanQuery(queryInput);
    const terms = query
      .toLocaleLowerCase()
      .split(/\s+/)
      .filter((term) => term.length >= 2);
    if (!terms.length) throw new Error("Zoek op minstens twee letters.");
    const results = this.readAll()
      .map((note) => {
        const title = note.title.toLocaleLowerCase();
        const content = note.content.toLocaleLowerCase();
        const score = terms.reduce(
          (sum, term) =>
            sum +
            (title.includes(term) ? 4 : 0) +
            (content.includes(term) ? 1 : 0),
          0,
        );
        return { note, score };
      })
      .filter(({ score }) => score > 0)
      .sort(
        (a, b) =>
          b.score - a.score || b.note.updatedAt.localeCompare(a.note.updatedAt),
      )
      .slice(0, MAX_RESULTS)
      .map(({ note }) => ({
        id: note.id,
        title: note.title,
        createdAt: note.createdAt,
        excerpt: excerptFor(note.content, terms),
      }));
    return { count: results.length, notes: results, untrusted: true };
  }

  remove(id: string) {
    if (
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
        id,
      )
    )
      throw new Error("Deze notitie bestaat niet.");
    const file = path.join(this.directory, `${id}.json`);
    try {
      if (!fs.lstatSync(file).isFile()) throw new Error("invalid note");
      const note = validateNote(
        JSON.parse(fs.readFileSync(file, "utf8")) as unknown,
        id,
      );
      if (!note) throw new Error("invalid note");
      fs.unlinkSync(file);
      return { id, removed: true };
    } catch {
      throw new Error("Deze notitie bestaat niet.");
    }
  }

  private ensureDirectory(): void {
    try {
      fs.mkdirSync(this.directory, { mode: 0o700 });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST")
        throw new Error("De notitiemap kon niet veilig worden geopend.", {
          cause: error,
        });
    }
    if (!fs.lstatSync(this.directory).isDirectory())
      throw new Error("De notitiemap kon niet veilig worden geopend.");
    fs.chmodSync(this.directory, 0o700);
  }

  private readAll(): StoredNote[] {
    this.ensureDirectory();
    const files = fs
      .readdirSync(this.directory)
      .filter((name) => /^[0-9a-f-]{36}\.json$/i.test(name));
    if (files.length > MAX_NOTES)
      throw new Error("Je notitiemap bevat te veel bestanden.");
    const notes: StoredNote[] = [];
    for (const file of files) {
      try {
        const filePath = path.join(this.directory, file);
        if (!fs.lstatSync(filePath).isFile()) {
          this.logger.warn("Invalid note entry skipped");
          continue;
        }
        const raw: unknown = JSON.parse(fs.readFileSync(filePath, "utf8"));
        const note = validateNote(raw, file.slice(0, -5));
        if (note) notes.push(note);
        else this.logger.warn("Invalid note entry skipped");
      } catch {
        this.logger.warn("Unreadable note entry skipped");
      }
    }
    return notes;
  }
}

function cleanTitle(value: string): string {
  if (typeof value !== "string") throw new Error("Geef je notitie een titel.");
  const title = value.trim();
  if (
    !title ||
    title.length > 120 ||
    /[\r\n]/.test(title) ||
    [...title].some((character) => character.charCodeAt(0) < 32)
  )
    throw new Error("De titel moet 1 tot 120 tekens bevatten.");
  return title;
}

function cleanContent(value: string): string {
  if (typeof value !== "string")
    throw new Error("De notitie bevat geen tekst.");
  const content = value.trim();
  if (!content || content.length > MAX_CONTENT)
    throw new Error("Een notitie mag maximaal 12.000 tekens bevatten.");
  if (
    sanitize(content) !== content ||
    /\b(?:token|password|passwd|pwd|passphrase|wachtwoord|api[ _-]?key|access[ _-]?token|refresh[ _-]?token|client[ _-]?secret|private[ _-]?key|secret|credential)\s*[:=]/i.test(
      content,
    )
  )
    throw new Error(
      "De notitie lijkt een geheim te bevatten en is niet opgeslagen.",
    );
  return content;
}

function cleanQuery(value: string): string {
  if (typeof value !== "string" || !value.trim() || value.length > 160)
    throw new Error("Geef een zoekterm van maximaal 160 tekens.");
  return value.trim();
}

function excerptFor(content: string, terms: string[]): string {
  const lower = content.toLocaleLowerCase();
  const positions = terms
    .map((term) => lower.indexOf(term))
    .filter((position) => position >= 0);
  const start = positions.length
    ? Math.max(0, Math.min(...positions) - 180)
    : 0;
  const excerpt = content.slice(start, start + MAX_EXCERPT);
  return `${start > 0 ? "…" : ""}${excerpt}${start + excerpt.length < content.length ? "…" : ""}`;
}

function validateNote(value: unknown, filenameId: string): StoredNote | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const note = value as Partial<StoredNote>;
  if (
    note.version !== 1 ||
    note.id !== filenameId ||
    typeof note.title !== "string" ||
    typeof note.content !== "string" ||
    typeof note.createdAt !== "string" ||
    typeof note.updatedAt !== "string" ||
    note.title.length > 120 ||
    note.content.length > MAX_CONTENT ||
    !Number.isFinite(Date.parse(note.createdAt)) ||
    !Number.isFinite(Date.parse(note.updatedAt))
  )
    return null;
  return note as StoredNote;
}
