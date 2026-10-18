import fs from "node:fs";
import { StringDecoder } from "node:string_decoder";
import { reportDbProblem, type NovaDb } from "./nova-db.js";

/** Sets a file aside under `<file><suffix>`, never overwriting an earlier one. */
function setAside(file: string, suffix: string): void {
  let target = `${file}${suffix}`;
  if (fs.existsSync(target)) target = `${target}.${Date.now()}`;
  fs.renameSync(file, target);
}

/**
 * One-time import of a legacy JSON file into the database.
 *
 * - no file: nothing happens;
 * - unreadable or corrupt JSON: the file is renamed `*.corrupt`, a problem is
 *   logged and startup carries on without it (nothing throws, nothing is deleted);
 * - otherwise `apply` runs inside one transaction together with the
 *   `legacy_imports` marker, and only after the commit is the source renamed
 *   `*.migrated`. The marker makes a repeat harmless: if the rename failed, or
 *   the old file reappears, it is renamed again instead of imported twice.
 *
 * `apply` returns how many rows it stored (informational).
 */
export function importLegacyJson(
  db: NovaDb,
  name: string,
  file: string,
  apply: (parsed: unknown) => number,
): void {
  if (!fs.existsSync(file)) return;
  if (!db.wasImported(name)) {
    let parsed: unknown;
    try {
      const stat = fs.statSync(file);
      if (!stat.isFile()) return;
      parsed = JSON.parse(fs.readFileSync(file, "utf8"));
    } catch (error) {
      reportDbProblem(
        `legacy file ${name} is unreadable, set aside as .corrupt: ${error instanceof Error ? error.message : String(error)}`,
      );
      try {
        setAside(file, ".corrupt");
      } catch {
        /* leave it in place; it is never trusted again */
        db.markImported(name, 0);
      }
      return;
    }
    db.transaction(() => {
      db.markImported(name, apply(parsed));
    });
  }
  try {
    setAside(file, ".migrated");
  } catch (error) {
    reportDbProblem(
      `could not rename migrated file ${name}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

/**
 * Like importLegacyJson for an append-only JSON-lines file (the audit log):
 * lines are streamed in chunks, bad lines are skipped, and a non-empty file
 * without a single valid line is set aside as `*.corrupt`.
 */
export function importLegacyLines(
  db: NovaDb,
  name: string,
  file: string,
  apply: (value: unknown) => boolean,
): void {
  if (!fs.existsSync(file)) return;
  if (!db.wasImported(name)) {
    let total = 0;
    let stored = 0;
    try {
      db.transaction(() => {
        const fd = fs.openSync(file, "r");
        try {
          const buffer = Buffer.alloc(1 << 20);
          let rest = "";
          const decoder = new StringDecoder("utf8");
          for (;;) {
            const count = fs.readSync(fd, buffer, 0, buffer.length, null);
            if (!count) break;
            const lines = (
              rest + decoder.write(buffer.subarray(0, count))
            ).split("\n");
            rest = lines.pop() ?? "";
            for (const line of lines) {
              if (!line.trim()) continue;
              total++;
              try {
                if (apply(JSON.parse(line))) stored++;
              } catch {
                /* a damaged line is skipped */
              }
            }
          }
          rest += decoder.end();
          if (rest.trim()) {
            total++;
            try {
              if (apply(JSON.parse(rest))) stored++;
            } catch {
              /* a torn last line is skipped */
            }
          }
        } finally {
          fs.closeSync(fd);
        }
        if (total > 0 && stored === 0) throw new Error("no valid lines");
        db.markImported(name, stored);
      });
    } catch (error) {
      reportDbProblem(
        `legacy log ${name} is unreadable, set aside as .corrupt: ${error instanceof Error ? error.message : String(error)}`,
      );
      try {
        setAside(file, ".corrupt");
      } catch {
        /* keep going */
      }
      return;
    }
  }
  try {
    setAside(file, ".migrated");
  } catch (error) {
    reportDbProblem(
      `could not rename migrated file ${name}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}
