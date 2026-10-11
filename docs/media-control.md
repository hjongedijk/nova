# Music and media

NOVA controls the actual Home Assistant media-player entities that are visible under its access
policy. It can play, pause, stop, skip tracks, set or mute volume, play an exposed Sonos favorite,
and announce through an installed Home Assistant TTS source. The tools use the exact player resolved
from Home Assistant; NOVA does not invent devices or media identifiers.

When Music Assistant is installed and exposes its `play_media` action, `music_play` accepts a
library name, provider URI, or short search phrase. For requests such as “zet iets rustigs op”, NOVA
can send a descriptive query such as `rustige jazz` with type `radio`; Music Assistant resolves the
catalog item. This behavior depends on the providers configured in Music Assistant. If it is not
installed, NOVA reports that and does not claim playback started.

Small volume changes are safe. Large increases require the normal fresh confirmation. Sonos grouping,
announcements and bulk pause also require confirmation. The ordinary play/pause controls do not
require a confirmation. Playback results are checked against the media-player state when Home
Assistant exposes enough state to verify them.

No live player was controlled while implementing this feature. See [tools and safety](tools-and-safety.md)
for the general tool gate and audit behavior.
