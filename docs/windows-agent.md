# Windows agent

The Windows agent (`agents/windows/jarvis-agent.ps1`, agent version `2026-10-06.5`) is a small authenticated HTTP service written in PowerShell with embedded C#. It runs in your own desktop session on a Windows PC and lets NOVA:

- open (and, with confirmation, close) programs from an allow-list, open `http(s)` URLs and lock the screen,
- show NOVA as a **living wallpaper** behind the desktop icons, per display,
- show NOVA as a small always-on-top **helper pill** at the top of a display,
- drive a **browser of its own** (a separate Microsoft Edge window) for search, reading, clicking and typing.

It is the only agent; there is no separate browser agent. The (Dutch) texts inside the agent and the NOVA interface are in Dutch.

> The agent uses only what ships with Windows (PowerShell, Microsoft Edge, Win32 through embedded C#). It cannot be run or tested on Linux; see [What is unverified](#what-is-unverified).

## Install

1. Get the agent files: download `nova-windows-agent.zip` from a GitHub release (it holds `agents/windows` without its tests), or copy the folder `agents/windows` from the repository. Put it somewhere permanent on the PC, for example `C:\NovaAgent`.
2. Open an **elevated** PowerShell in that folder and run:

   ```powershell
   powershell -ExecutionPolicy Bypass -File .\install.ps1 -JarvisHost <nova-host-ip>
   ```

   `<nova-host-ip>` is the IP address of the machine that runs NOVA, as the PC sees it. The parameter is still called `-JarvisHost` for historical reasons. An optional `-Port` (default `8765`) changes the agent port.

3. The script prints two lines. Put them in the `.env` of your NOVA install and recreate the container (`docker compose up -d nova`):

   ```dotenv
   WINDOWS_AGENT_URL=http://<pc-ip>:8765
   WINDOWS_AGENT_TOKEN=<printed token>
   ```

What `install.ps1` does:

- creates `agent.json` from `agent.example.json` with a random 64-character hex token and `allowedIps` set to the NOVA host (only when `agent.json` does not exist yet), and restricts read access to the file to you and Administrators,
- registers a URL reservation for the port,
- creates the firewall rule `Jarvis agent` that only allows the NOVA host to reach the port,
- registers the scheduled task `JarvisAgent` (at logon, current user, limited rights, so it runs in your desktop session) and starts it.

The names `Jarvis agent` and `JarvisAgent` are historical and are kept so that existing installs keep working.

The agent refuses to start if the token in `agent.json` is shorter than 24 characters. It restarts itself without a visible window; starting it again ends the older copy, so an update is: replace `jarvis-agent.ps1` (NOVA offers the current file at **Settings, More**, or at `/windows-agent/jarvis-agent.ps1`) and run the `JarvisAgent` task again.

## Security

- Every request needs `Authorization: Bearer <token>` (compared in constant time).
- If `allowedIps` in `agent.json` is not empty, requests from other addresses get 403. The installer fills it and creates a matching firewall rule.
- Programs: only the entries in `apps` of `agent.json` can be started. There is no endpoint for arbitrary commands. Closing programs and locking the screen are `CONFIRM` tools in NOVA, see [Tools and safety](tools-and-safety.md).
- The agent speaks plain HTTP, so keep it on a trusted LAN.

## `agent.json`

| Key              | Default                  | Meaning                                                                                                                                                   |
| ---------------- | ------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `token`          | set by `install.ps1`     | Bearer token, at least 24 characters.                                                                                                                     |
| `allowedIps`     | set by `install.ps1`     | Source addresses that may call the agent; empty means any.                                                                                                |
| `apps`           | see `agent.example.json` | Map of app name to `{ "path": ..., "process": ... }`. `process` is needed for closing the app and for the "running" list. Edit it, then restart the task. |
| `mode`           | `wallpaper`              | Default mode: `wallpaper`, `helper` or `both`. NOVA changes it at runtime; the runtime choice is kept in `mode.json` and wins.                            |
| `helperDisplay`  | `0`                      | Display for the helper (0 = primary).                                                                                                                     |
| `novaUrl`        | none                     | `http(s)://host[:port]` of NOVA, only needed when the agent must open the helper before NOVA ever set a mode.                                             |
| `novaPort`       | `8080`                   | Port used to build NOVA's address from the caller's IP when no address is passed.                                                                         |
| `wallpaperInput` | forwarded                | Set to `"window"` to open a small NOVA window on click instead of forwarding clicks to the wallpaper.                                                     |
| `browser`        | see below                | Settings of the browser, with `port` (9322), `defaultEngine` (`google`), `maxActionsPerMinute` (60), `blockedHosts`, `allowedHosts` and `enabled`.        |

NOVA passes its own address to the agent when you pick a wallpaper or mode: with `NOVA_PUBLIC_URL` set that address is used, otherwise the agent builds `http://<caller ip>:<novaPort>`.

## Living wallpaper

Microsoft Edge shows the NOVA page in a window that is parented to the desktop, behind the icons, on one display or all of them. The real wallpaper setting is never changed; choosing "Uit" (off) shows it again. Set it in NOVA under **Instellingen, Meer** or say "zet NOVA als achtergrond op scherm 2".

- Endpoints: `GET /v1/displays` and `POST /v1/wallpaper` with `{ "display": 0|1|2..., "mode": "full"|"sphere"|"off" }` (0 = all displays).
- What is set is remembered in `wallpaper.json` and restored when the agent starts.
- The window is placed by recognising how Windows builds the desktop (a top-level WorkerW, or, on Windows 11 24H2 and later, a WorkerW inside Progman). If the layout is not recognised the agent refuses and closes the window instead of leaving a window on top of the screen. "Uit" always closes the window.
- Sizes are real pixels per display (a 4K screen at 150% scaling is covered as 3840 x 2160).
- Input: clicks on the sphere and on the input field area are passed on to the wallpaper page, and typing starts after a click on the input field (Esc ends it). Everywhere else the desktop stays Windows' own: icon selection, drag and drop and the right-click menu are not touched. Which clicks are passed on is decided by the page, which reports where its buttons, fields and open windows are (`window.__novaZones()`).
- Clicks and keys reach the page through Edge's DevTools channel, bound to `127.0.0.1` on one port per display (9331, 9332, ...). If that channel is unavailable, window messages are used as a fallback. The agent also keeps its own key hook to track Shift, Ctrl, Alt and Caps.

## Modes: wallpaper, helper, both

| Mode        | What the PC shows                                                                                        |
| ----------- | -------------------------------------------------------------------------------------------------------- |
| `wallpaper` | The living wallpaper (default).                                                                          |
| `helper`    | No wallpaper (the per-display choices stay remembered), only the helper pill.                            |
| `both`      | Quiet wallpaper windows (no input or voice) with the helper on top, which does the listening and typing. |

Change it in NOVA under **Instellingen, Meer, "NOVA op je Windows-pc"**; no reinstall is needed. Endpoints: `POST /v1/mode` with `{ "mode": ..., "display": ... }`, `GET /v1/status` and `GET /v1/displays` (both report `mode` and `helperDisplay`), and `POST /v1/helper/size` with `{ "expanded": true|false }`.

### The helper pill

The helper is an Edge `--app` window that shows the page `<NOVA>/helper`, floating 8 px below the top edge of the chosen display as a rounded pill in NOVA's navy. Collapsed it shows the NOVA orb, a status dot with text and a microphone button (about 340 x 100). A click, or an incoming answer or confirmation question, expands it (about 420 x 360) with the last answer, a text field and the confirmation card (Bevestigen / Annuleren, or press Y / N). It collapses after 12 s of quiet or on Esc. "Hey NOVA" works there, and confirmations are the normal 60 s single-use ones.

How it is built:

- The window is positioned, made topmost and hidden from the taskbar with Win32 calls in the embedded C#, and clipped to a rounded rectangle with `SetWindowRgn` (an Edge window cannot be transparent, so the glass look is painted gradients).
- Edge draws its own title bar in an app window. The agent measures it through DevTools (port 9340 on `127.0.0.1`, 32 px at 100% scale if that fails), makes the window taller by that amount and clips the caption away, so it is neither drawn nor clickable.
- Windows adds an invisible border of about 7 to 8 px; the region is computed from the visible frame bounds. The agent checks twice a second that region and rectangle are as intended and restores them if Chromium or DWM reset them. `GET /v1/helper-debug` shows what Windows reports.
- The helper has its own Edge profile (`helper-profile` next to the script), starts with microphone and sound allowed for NOVA's address and is restored whenever the agent starts. If you close it yourself, choose the mode again in NOVA.
- The page cannot hold the agent's token, so a resize goes page, `POST /api/settings/helper/size` (open: it can only resize this window), the NOVA API, agent `POST /v1/helper/size`.
- When NOVA's address is plain `http://`, Edge needs `--unsafely-treat-insecure-origin-as-secure` for the microphone and `--test-type` to hide the warning bar. With `https://` neither flag is passed. The same applies to the wallpaper windows.

## Browser

NOVA can search the web, read pages and click through them in a visible Edge window of its own (the `browser_*` tools). It uses the same `WINDOWS_AGENT_URL` and `WINDOWS_AGENT_TOKEN`.

- Endpoints: `GET /v1/browser/status` and `POST /v1/browser/{open,search,read,click,type,press,scroll,back,forward,tab}`.
- The window is separate from the wallpaper and from your normal Edge: its own profile (`browser-profile`), its own DevTools port (`9322` by default, `127.0.0.1` only). It starts on the first browser action and stays open; log in to a site once in that window and NOVA can use it.
- The agent drives it through Edge's DevTools channel: page navigation, a page script that numbers links, buttons and fields (`read` returns the text plus those numbers), real mouse clicks and key events.
- Search engines: `google` (default), `duckduckgo`, `bing`, `youtube`, `wikipedia`, `maps`, `amazon`, `bol`. When Google or Bing shows a robot check the search is repeated on DuckDuckGo, and the reply says so.
- Enforced in the agent, not left to the model: only `http` and `https` pages; no typing into password, PIN, card, IBAN, one-time-code or similar fields; buttons that buy, pay, order, donate, subscribe or delete are refused unless NOVA asks you first (`browser_click_confirmed`, a `CONFIRM` tool); at most `maxActionsPerMinute` actions (60) per minute; `blockedHosts` and `allowedHosts` are applied. Page text is returned as untrusted data.
- Without an agent configured the `browser_*` tools do not exist (NOVA says so and suggests `windows_search` or `web_search`).

## HTTP API summary

All endpoints need the token and the allowed source address.

| Endpoint                                          | Does                                                                       |
| ------------------------------------------------- | -------------------------------------------------------------------------- |
| `GET /v1/status`                                  | host name, user, uptime, features, mode, agent version, apps, running apps |
| `POST /v1/open-app`, `POST /v1/close-app`         | start / close an allow-listed program (`{ "app": "notepad" }`)             |
| `POST /v1/open-url`                               | open an `http(s)` URL in the default browser                               |
| `POST /v1/lock`                                   | lock the workstation                                                       |
| `GET /v1/displays`, `POST /v1/wallpaper`          | displays and per-display wallpaper                                         |
| `POST /v1/mode`, `POST /v1/helper/size`           | mode and helper size                                                       |
| `GET /v1/wallpaper-debug`, `GET /v1/helper-debug` | diagnostics                                                                |
| `GET /v1/browser/status`, `POST /v1/browser/*`    | the browser                                                                |

## Checks

`agents/windows/test/check.ps1` parses both scripts and compiles the embedded C#. It runs in CI on Linux with PowerShell 7 (`pwsh -NoProfile -File agents/windows/test/check.ps1`).

## What is unverified

- The agent's behaviour on real Windows machines (wallpaper placement on different Windows builds, DPI scaling, multi-monitor layouts, helper clipping, DevTools input) cannot be tested in CI or on Linux. CI only checks syntax and that the C# compiles.
- Windows 10 versus Windows 11 differences are handled in code but have no automated test.
- The agent depends on Microsoft Edge being installed (it ships with Windows).
