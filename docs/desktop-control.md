# Desktop view and control (native Windows agent)

The implementation lives in `apps/windows/crates/nova-win-agent/src/desktop/` and `desktop.rs`. Enable local viewing/control in **Instellen en koppelen**, then enable the corresponding NOVA settings. See [Windows agent](windows-agent.md#seeing-and-controlling-the-pc) for setup, emergency stop and administrator permissions, and [desktop control API](desktop-control-api.md) for NOVA’s confirmation and session limits.

## Agent contract

All routes require the existing bearer token and source-IP policy.

- `GET /v1/desktop/status`: `{ ok, view, control, armed, armedUntil, paused, killHotkey, displays }`.
- `GET /v1/desktop/windows`: visible windows, including minimized windows for focus/restore; IDs, titles, process names, foreground state and physical bounds.
- `GET /v1/desktop/screenshot?display=N&maxWidth=1280`: JSON `{ ok, image, mimeType, width, height, display }`, where `image` is base64 JPEG. No files are written. Width is bounded to 320–1920 pixels; protected visible windows on the selected monitor block capture. Display numbers are one-based; `0` means primary.
- `POST /v1/desktop/control`: `{ armed: true, ttlSeconds }` for 1–900 seconds, or `{ armed: false }`. Disarming works even with viewing disabled or the agent paused.
- `POST /v1/desktop/input`: `{ action, display?, relativeTo?: { width, height }, ... }`. Actions: `move`, `click`, `doubleclick`, `rightclick`, `drag`, `scroll`, `type`, `key`, `focus_window`. Coordinates refer to the screenshot when `relativeTo` is present. Input requires a live lease and is bounded to ten actions per second and 500 UTF-16 units per typed text.

Viewing and control default off. Control leases are volatile and expire independently of NOVA. The emergency shortcut is **Ctrl+Alt+Shift+K**; registration failure prevents arming. Pause and permission changes cancel queued browser effects and desktop input. Windows secure desktops remain manual even when NOVA runs elevated.

## Live screen popup

NOVA’s home page offers **Pc bekijken**, with monitor selection, current session/action and **Stop overname**. `GET /api/settings/desktop/frame?display=N` uses the settings PIN when configured, emits `Cache-Control: no-store, private` and returns a bounded frame. It invokes no vision model, stores no image and grants no input permission. The popup refreshes only while open, expanded and visible. Watching does not extend a takeover or count as an observation for NOVA’s action budget.

## Verification

Run the native core/agent tests and Windows compilation checks described in [Windows agent development](windows-agent.md#development), plus the API desktop tests. Capture, input, browser interaction, elevation and emergency stop still require an acceptance run on a real Windows desktop. The old PowerShell implementation has been removed; v0.1.73 remains available on GitHub for rollback.
