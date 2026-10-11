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

The read-only `calendar_events` tool and `daily_briefing` use the same provider. Appointment creation,
rescheduling, and advance reminders are not implemented yet.
