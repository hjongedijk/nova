# Private notes and diary

NOVA saves a note only after you explicitly ask, for example “bewaar dit als notitie” or by dictating text and asking to save it. `notes_search` finds matching notes, and `notes_recent` lists the latest five; NOVA can summarize those excerpts in its reply. Notes themselves live separately from chat history and long-term semantic memory. The conversation used to dictate a note can still appear in ordinary recent chat history.

For a quick note on the main screen, press **F9** or choose **Menu → Snelle notitie** and speak one short sentence. NOVA stores that sentence directly through the same private notes service, without a model request or a chat message. The note is titled “Snelle notitie”; its `createdAt` timestamp comes from the server. NOVA shows the save date in your browser's local time, without repeating the private text in the notification. This needs browser speech recognition, microphone permission and HTTPS. F9 does nothing while you are typing in a text field; no note is saved on silence, a failed request or rejected secret-like text. A quick note is at most 500 characters and cannot contain a line break.

Notes live in `NOVA_DATA_DIR/notes` as individual JSON files. The folder is mode `0700`, each file is `0600`, writes use an atomic rename, and the store is capped at 500 notes of up to 12,000 characters each. Secret-like text is rejected. Note titles, contents and search terms are omitted from action logs. Search results are marked untrusted; instructions written inside a note do not authorize actions.

Deleting one note requires a fresh confirmation. NOVA does not sync or send notes to another service. Back up the NOVA data directory using the normal private data-backup process.
