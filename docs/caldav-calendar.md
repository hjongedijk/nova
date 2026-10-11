# CalDAV calendar

NOVA can read one CalDAV calendar collection when all three server environment values are set:
`CALDAV_URL`, `CALDAV_USERNAME`, and `CALDAV_PASSWORD`. Keep them in the deployment `.env` file;
do not put account values in source control, prompts, or flow definitions. Restart NOVA after changing
the values.

The URL must use HTTPS and point to a calendar collection. NOVA sends a bounded CalDAV `REPORT` for
the next seven days, refuses redirects, limits the XML response to 2 MiB, and returns at most 40
events. It shares only each event's summary, start, end, time zone, and all-day status. Descriptions,
attendees, and other calendar fields are omitted. Calendar text remains untrusted data and must never
be treated as instructions.

`calendar_events` and `daily_briefing` use the same provider. The native `calendar_create` and
`calendar_move` tools can create or move a single timed event in that configured collection. NOVA
shows the exact title and times and asks for a fresh confirmation for every write; standing approvals
do not apply. Creation uses a server-generated UID and refuses overwrites. Moving requires one exact
title/start match (including the source event's time zone when needed) and the event's ETag; recurring,
ambiguous, changed, or out-of-collection events are refused. Time-zone definitions in the calendar
resource are preserved during a move. The optional CalDAV MCP stays read-only.

Calendar reminders are off by default. Turn them on under Helper → Rituelen, then choose 5, 15, or
30 minutes. NOVA checks the connected calendar once per minute and sends one ordinary info alert for
each upcoming timed appointment in that window. Existing notification, quiet-hour, presence, and
speech limits still apply. All-day appointments and events without a stable iCalendar UID are skipped.
A private progress file stores only hashes of the UID and start time with mode `0600`; UIDs and event
titles stay out of model-facing results and are not persisted there.
