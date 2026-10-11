# Presence-aware unsolicited speech

The alert feed remains visible and keeps its normal toasts, but it marks events as not speakable
when both current signals establish that nobody is available: the only visible Home Assistant
`person` entity is `not_home`, and the Windows helper is closed. An open helper permits speech even
when Home Assistant says the person is away. A single `person` entity is used only when exactly one
is visible under NOVA's Home Assistant access policy; multiple people are reported internally as
ambiguous and NOVA does not choose one. Unknown or stale presence preserves existing delivery.

NOVA refreshes this cached decision every 30 seconds. Home Assistant state follows its existing
one-minute entity cache. No person name or location is added to the alert feed or audit log. This is
only a signal for unsolicited helper speech; it does not disable user-requested replies, and it does
not prove that someone is literally going outdoors.

On a confirmed `home` → `away` transition, NOVA checks the next three local forecast hours. It adds
an alert when rain probability reaches 65%, or the forecast names onweer, hagel, ijzel, or heavy
rain/showers/snow. This is a weather hint attached to leaving home, not proof that anyone is going
outside. Unknown presence, a missing forecast, or ordinary weather produces no alert. The feed
keeps it visible; automatic speech still follows the presence rule, and phone push is tracked as
C4.7.
