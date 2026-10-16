# Desktop view and control (Windows agent)

The Windows agent can show NOVA the screen and, in a time-boxed session, move the pointer and type. NOVA's side (tools,
confirmations, limits) is described in [desktop-control-api.md](desktop-control-api.md). Everything here is off by default.

## Switches (`agent.json` → `desktop`)

| Key            | Default             | Meaning                                                                          |
| -------------- | ------------------- | -------------------------------------------------------------------------------- |
| `enabled`      | `false`             | Allows status, window list and screenshots.                                      |
| `control`      | `false`             | Also allows arming and input. Requires `enabled`.                                |
| `killHotkey`   | `Ctrl+Alt+Shift+K`  | Global kill switch. Must not clash with the agent's own shortcuts.               |
| `maxTypeChars` | `500`               | Longest text per `type` call (hard cap 500).                                     |
| `denyList`     | see `agent.example` | Case-insensitive substrings matched against the foreground window title/process. |

You do not have to edit the file: the tray menu has **Bureaublad: meekijken aan/uit** and **Bureaublad: bedienen aan/uit** (agent 2026-10-16.4 and later). They flip these switches at runtime and save them to `agent.json`. Turning view off also turns control off.

## Endpoints (bearer token, same as the rest of the agent)

- `GET /v1/desktop/status` → `{ ok, view, control, armed, armedUntil (epoch ms | null), paused, killHotkey, version, displays[] }`
- `GET /v1/desktop/windows` → `{ ok, windows: [{ id, title, process, foreground, x, y, width, height }] }`
- `GET /v1/desktop/screenshot?display=N&maxWidth=1280[&window=id]` → `image/png`, headers `x-nova-width`, `x-nova-height`, `x-nova-display`. `display` is 1-based, omitted or 0 means the main display. Refused while the foreground window is on the deny-list.
- `POST /v1/desktop/control` `{ armed: true, ttlSeconds }` (1–900, capped) or `{ armed: false }` (always works).
- `POST /v1/desktop/input` `{ action, display?, relativeTo?: { width, height }, ... }` with `move | click | doubleclick | rightclick | drag | scroll | type | key | focus_window`. Coordinates are pixels of the screenshot that `relativeTo` describes; without it they are real pixels of the display.

Refusals: `403` off or protected window, `409` not armed or paused, `429` more than 10 actions per second, `404` unknown window.

## Safety

- Armed state is held in memory only: a restart is always disarmed, and arming always expires (900 s at most).
- The kill hotkey disarms on its own thread without waiting for the request loop. The tray item and `{ armed: false }` do the same.
- A red bar across the top of the main display and a red tray dot show while NOVA may drive.
- Keys come from an allow-list (named keys, F1–F12, letters, digits, with Ctrl/Alt/Shift). `Win` combos and `Ctrl+Alt+Delete` are refused. Windows' secure desktop (UAC, Ctrl+Alt+Del screen) can neither be captured nor driven.
- `desktop-actions.log` next to the agent records action, coordinates, text length and the foreground process; never typed text or screen content.
- Screenshots are not secret-scanned: a visible secret in an allowed window goes to the vision model. Keep sensitive apps on the deny-list.

## Tests

`pwsh -NoProfile -File agents/windows/test/desktop.ps1` compiles the embedded C# and checks scaling, deny-list, key allow-list, TTL, rate limit, arm/expire/kill and the default-off configuration. SendInput, screenshots, the red bar and the hotkey need a real Windows desktop and are **not** covered; they still need an acceptance run on the PC.
