# Proactive speech policy

Alerts stay visible in the feed even when NOVA does not speak them. In Helper settings, choose a delivery mode separately for information, warnings, critical alerts, and timers: screen only, helper notice with a short sound, or spoken announcement. Defaults preserve existing behavior: info goes to the helper, while warnings, critical alerts, and timers are spoken. The API allows at most five spoken announcements per rolling hour. Once the budget is reached, later items remain visible and are marked silent until an earlier announcement leaves the hour window.

Presence can suppress speech when Home Assistant confirms the owner is away and the Windows helper is closed. Unknown presence keeps existing delivery behavior. The configured quiet hours apply in both the helper and main browser; neither interrupts an active conversation or audio playback. These checks suppress speech, not the feed; critical ntfy push remains separate. A busy or offline helper does not queue skipped speech for later.

## Optional daily rituals

In the helper's settings, morning greeting, bedtime greeting, and a silence check-in are separate switches and all default off. Greeting times use NOVA's configured time zone. A check-in can wait 3, 4, or 6 hours after the last user chat; it only runs from 10:00 to 20:00 and at most once per local day. Rituals are ordinary info alerts, so the selected info delivery mode, quiet hours, confirmed-away check, active-chat/audio suppression, and spoken-hour cap still apply. The helper stores only the local day and which rituals ran in a private `0600` progress file.

## Repeated requests

If the exact same non-secret request appears on three separate local days within a week and in the same hour, NOVA may offer to schedule or automate it. This is a one-time conversational suggestion on the third matching day; it does not create a timer, flow, or recurring action. The user must explicitly ask before NOVA sets anything up.

## Scheduled Node-RED briefings

NOVA-generated morning and evening briefing templates set the `NOVA vraag` node to proactive mode. That mode sends requests to the bearer-protected `/api/proactive/ask` endpoint using `NODE_RED_EVENT_TOKEN`. The endpoint gives the model only enabled `READ_ONLY` tools, and the tool executor rejects any prepared action whose effective risk is higher. It accepts no attachments, keeps no conversation history, and allows at most ten requests per minute. The fixed flow then formats the short result and sends it through `NOVA melding`. Ordinary user-created `NOVA vraag` nodes keep the regular chat route unless proactive mode is enabled.

Proactive routines may read data and publish a bounded notification. They cannot approve, create, or execute a device action. If Node-RED or another external service has already accepted an action before cancellation, NOVA cannot undo it.
