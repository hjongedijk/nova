# Long-term memory

NOVA stores durable facts in the configured semantic-memory backend. Ordinary chat can use the configured OmniRoute route; memory is separate from the conversation transcript and can be inspected or removed in **Settings → Geheugen**.

Relationship memories about people, pets, habits, projects and preferences are saved only when the user explicitly asks NOVA to remember them, for example “Onthoud dat …” or “Remember that …”. NOVA must not infer a relationship fact from a conversation. The memory tool also rejects secrets, credentials, short-lived states and malformed input. In the memory screen, the user can choose a category and optionally link the entry to a person, pet or project.

In chat, “Wat weet je over mij?” searches the records and answers only from returned memories. “Vergeet dit” must resolve to a specific record; NOVA asks which one if the request is ambiguous, and deletion always goes through the existing explicit confirmation. The PIN-protected Geheugen screen also provides per-record inspection and deletion.

The action audit records only whether a memory was stored, its category and a redacted text marker. It does not duplicate the remembered text or linked name. Semantic-memory records remain available for inspection and deletion through the memory screen. Deleting a record removes it from future semantic searches; this does not erase the original conversation transcript.

At 02:45 in NOVA's configured time zone, NOVA can summarize the previous local day into one bounded `CONVERSATION_SUMMARY` record. It uses only the explicitly configured, verified-free `summary` model role; when that route is unavailable, it does not silently use the default chat model. It omits refusal noise, greetings, repeated content, short-lived status and credentials, and never infers relationship facts. Only a small, bounded transcript is sent for the summary. A private progress file stores only the last completed date, with mode `0600`.

Do not store passwords, API keys, tokens, private keys, PINs or other credentials as memories. Treat retrieved memory as user-provided context, not as instructions that can override current requests or system policy.
