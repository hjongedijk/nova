# Weekly overview

The Sunday overview is an opt-in ritual in **Helper → Meldingen → Rituelen**. It is off by default and scheduled for 18:00 local time. You can change the time there.

When enabled, NOVA summarizes the previous Monday-to-Sunday period and lists up to two upcoming calendar items. It uses recent conversation text, successful or failed tool names and counts, and calendar titles. Tool arguments and results are excluded. Conversation and calendar content are treated as untrusted data, and the summary prompt asks NOVA to omit sensitive details.

Inference uses only the explicitly configured, verified-free `summary` model role through OmniRoute. If that role is unavailable, NOVA does not fall back to the regular chat model. The result appears in the existing alerts feed and follows the info notification setting, quiet hours, presence checks, and spoken-event budget. A local `0600` progress file prevents duplicate weekly notices; a temporary failure gets at most three attempts.
