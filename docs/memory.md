# Memory model (lifecycle)

Extends the long-term memory in `long-term-memory.md`. Code: `apps/api/src/memory/semantic/lifecycle.ts` (pure rules), `qdrant.backend.ts` (store), `memory.source.ts` (tools).

## Record fields

Old records stay readable: missing fields are derived on read (`normalizeRecord`) and only written when the record is next updated.

| Field                                                          | Values                                                                                                  |
| -------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| `kind`                                                         | `fact`, `preference`, `decision`, `assumption`, `episode`, `project` (old records: derived from `type`) |
| `origin`                                                       | `user_stated`, `inferred`, `tool` (new; the older `source` field keeps its meaning)                     |
| `confidence`                                                   | 0..1; `inferred` is capped at 0.4                                                                       |
| `created_at`, `updated_at`, `last_accessed_at`, `access_count` | as before                                                                                               |
| `superseded_by`, `valid_until`                                 | set when a newer record replaced this one, or on an expiry date                                         |
| `sensitive`                                                    | true for IBAN/BSN/health words; never set for secrets because those are rejected                        |

## Writing (`memory_remember`)

1. Secrets, passwords, tokens and card numbers are rejected (existing `sanitize()` plus a card-number pattern). Inferred memories containing sensitive data are rejected too.
2. Near-duplicate (same normalised text, or similarity >= 0.97 with the same related entity and no contradiction) updates the existing record.
3. Contradiction: a deterministic subject/value check (`mijn X is Y`, `mijn X heet Y`, `ik woon in Y`, `ik ben N jaar`, `dat mijn X Y is`). The embedding only finds candidates. A new user-stated value supersedes the old record: the old one is kept with `superseded_by` and `valid_until`, and the result carries a `message` ("Eerder zei je X, nu Y: bijgewerkt.") for the model to relay.
4. `origin=inferred` is stored as an `assumption` with low confidence. It never overrides a `user_stated` record (the result names the conflict) and it is a no-op when the user already said the same thing. A later user statement supersedes an inference.

## Retrieval

score = similarity x recency decay (half-life by kind: episode 30 d ... fact 4 y) x (0.5 + 0.5 confidence) x use-count factor (max +20%) x importance. Exact names, numbers and quoted strings in the query boost matching records and lower the similarity threshold for them (0.55 instead of 0.65). Superseded, expired and archived records are excluded. Assumptions come back with the suffix "(waarschijnlijk, niet bevestigd)". With no match the result is an empty list.

## Consolidation

The existing daily `maintain()` (low-importance archive) also: archives records past `valid_until`, merges exact duplicates (keeps the user-stated/oldest, sums use-count), and replaces episodes older than 30 days by one `Samenvatting <dag>: ...` line per day (written first, originals deleted after). Deterministic, no model call; one embedding call per summary line. Idempotent.

## User control

- `memory_list` (READ_ONLY): filter `kind`/`search`, `limit`, cursor `offset`, `include_history`.
- `memory_correct` (SAFE): replace the text; the old text stays as history.
- `memory_forget` (CONFIRM): deletes the point from Qdrant; `include_history=true` also deletes the superseded chain.
- REST: `GET /api/memories?kind=&q=&history=true`, `POST /api/memories/:id/correct`, `DELETE /api/memories/:id?history=true` (same guard as the other memory routes).

## Limits

- Contradiction detection only knows the sentence shapes above; other rewordings are not flagged (they are stored as separate records or merged as near-duplicates).
- The OmniRoute native backend has no lifecycle logic: no supersede, no `memory_correct`, no consolidation. Lifecycle fields appear only for Qdrant records; listing still normalises old rows.
- `memory_list` filters per backend page, so a page can be shorter than `limit`.
- Audit logging of `memory_correct` is not redacted like `memory_remember` (the audit projection lives in `tools.service.ts`).
- Verified with a mocked Qdrant/embedding server only, not against a production Qdrant.
