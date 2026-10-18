# Storage and project cleanup

## Findings, 18 October 2026

This audit covers repository sources and the local `dev-data` directory. It does not claim to inventory the production filesystem.

GraphQL is an API query language, not a storage engine. Adding it would leave the JSON files in place unless their persistence were separately migrated. See [GraphQL's introduction](https://graphql.org/learn/) and [SQLite's application-storage guidance](https://www.sqlite.org/whentouse.html).

NOVA already uses SQLite to read the separately owned OmniRoute database. That database must not become a catch-all for NOVA settings or histories. A NOVA-owned database would be separate.

There are 21 source files using `new HistoryFile(...)`, the shared bounded revision-file abstraction in `apps/api/src/settings/history-file.ts`. Other settings services also own JSON histories directly. Their rollback APIs, validation, retention and durability behavior matter more than the number of files.

The tracked JSON under `docs/code-evaluation-runs/` and `docs/persona-evaluation-runs/` is evaluation evidence. Package manifests, lockfiles, Tauri permissions/config and editor settings are also intentional project files. None is disposable merely because it ends in `.json`.

## Recommended boundaries

| Data                                                            | Direction                                                                                                          |
| --------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| Small hand-edited config, manifests, deployment descriptions    | Keep as JSON/YAML where appropriate.                                                                               |
| NOVA revision histories and frequently updated structured state | Candidate for a NOVA-owned SQLite database, with explicit schema versions and transactions.                        |
| `services.json` and credential-bearing settings                 | Keep current owner-only protection until a migration preserves redaction, backup exclusions and file access rules. |
| Action/audit JSONL                                              | Treat as audit data; preserve ordering, retention and forensic requirements before choosing another store.         |
| Evaluation JSON and release evidence                            | Keep in the repository or an intentional artifact archive.                                                         |
| `.before-*`, `.bak`, journals and temporary files               | Inspect their owner and recovery role; do not delete while a migration or rollback may need them.                  |
| OmniRoute storage                                               | Leave under OmniRoute ownership.                                                                                   |

## Completed project cleanup

The native Windows application is consolidated under `apps/windows`. New packaging contains one executable and an installer; PowerShell is archived under `agents/windows-legacy` for compatibility and rollback. `docs/windows-agent.md` is the installation/migration reference; `docs/nova-desk.md` points there rather than maintaining a conflicting second setup guide. Build paths, downloads and CI now follow those boundaries.

## Next storage migration

Start with the shared `HistoryFile` implementation, preserving its service-specific row validation, revision IDs, newest-first listing, retention limits and rollback lookup. Before implementing:

1. Inventory the actual production data volume using filenames and sizes, without printing credentials.
2. Map readers, writers, exports, restore code and any scripts that read these files directly.
3. Back up and test restoration. Add a schema and idempotent import with per-store provenance.
4. Import each history in a transaction. Compare accepted revision IDs, ordering, content and retention against the old reader.
5. Switch reads and writes at a controlled application restart. Prevent older and newer versions from writing competing copies.
6. Keep the original JSON files for a defined rollback period. A rollback after new writes needs an export back to the old format; old source files alone are insufficient.
7. Remove old persistence paths only after verification and the rollback period.

Keep the existing REST endpoints during this migration. GraphQL should be considered separately only if actual client-query needs justify it.

## Read-only inventory

```sh
node scripts/audit-data-storage.mjs /path/to/nova-data
```

The script lists only top-level regular files in recognized categories, reporting names and sizes. It does not read contents, follow directory entries recursively, delete anything or connect to production. The categories are filename heuristics, not proof that a file is obsolete.
