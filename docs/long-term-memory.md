# Long-term memory

NOVA stores durable facts in the configured semantic-memory backend. Ordinary chat can use the configured OmniRoute route; memory is separate from the conversation transcript and can be inspected or removed in **Settings → Geheugen**.

Relationship memories about people, pets, habits, projects and preferences are saved only when the user explicitly asks NOVA to remember them, for example “Onthoud dat …” or “Remember that …”. NOVA must not infer a relationship fact from a conversation. The memory tool also rejects secrets, credentials, short-lived states and malformed input. In the memory screen, the user can choose a category and optionally link the entry to a person, pet or project.

The action audit records only whether a memory was stored, its category and a redacted text marker. It does not duplicate the remembered text or linked name. Semantic-memory records remain available for inspection and deletion through the memory screen. Deleting a record removes it from future semantic searches; this does not erase the original conversation transcript.

Do not store passwords, API keys, tokens, private keys, PINs or other credentials as memories. Treat retrieved memory as user-provided context, not as instructions that can override current requests or system policy.
