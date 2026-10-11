# Proactive speech policy

Alerts stay visible in the feed even when NOVA does not speak them. Informational alerts are silent; warnings, critical alerts, and fired timers can be announced. The API allows at most five such announcements per rolling hour. Once the budget is reached, later items remain visible and are marked silent until an earlier announcement leaves the hour window.

Presence can suppress speech when Home Assistant confirms the owner is away and the Windows helper is closed. Unknown presence keeps existing delivery behavior. The helper applies its configured quiet hours, while the browser does not interrupt an active chat or audio playback. These checks suppress speech, not the feed; critical ntfy push remains separate. A busy or offline helper does not queue skipped speech for later.
