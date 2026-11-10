# NOVA for Windows v0.1.8

- **Live streams for NOVA's windows.**
  - `GET /v1/stream/browser` gives a CDP `Page.startScreencast` of NOVA's working tab, over its own DevTools connection with ack backpressure.
  - `GET /v1/stream/desktop` gives GDI desktop capture at 2 to 15 fps adaptive, skips unchanged frames and sends a heartbeat every 2 s.
  - Both keep only the latest frame, allow at most 4 streams, cap frames at 1.5 MB and streams at 6 MB/s, and end a connection after 15 minutes.
  - Pause and the emergency stop end every stream.
- **Input feedback.** Browser click and type probes report the point and viewport, and `desktop_act` reports a normalized pointer, so the windows can draw click ripples and a caret.

Includes v0.1.7 (no UAC prompt at sign-in, starts in the tray, wallpaper click logging). Use with NOVA v0.2.5. Validation: nova-win-core and nova-win-agent tests, clippy for the Windows target; not yet run on a physical Windows PC.
