# NOVA for Windows

The Windows agent now lives in `apps/windows/`: one Rust/Tauri application, `nova.exe`, with one tray icon. It owns the authenticated HTTP service, native helper and living wallpaper. It does not launch PowerShell or require a separate NOVA Desk executable.

The native agent includes screenshots, desktop input and a visible automated browser. NOVA has no restrictions on the PC: the only lock is the token that pairs this PC with NOVA, and the only off switch is the owner's emergency stop. A prior version built successfully on GitHub Windows CI; the expanded native features, elevation, installer behavior, monitor DPI and wallpaper parenting still require a Windows acceptance run. No production deployment is implied by source changes.

## Installation and pairing

The release workflow builds `NOVA-Setup-<version>.exe` and `nova-windows.zip`. The portable zip contains only `nova.exe`. The installer runs for the current user and bundles WebView2 bootstrap installation through Tauri when needed.

1. Install NOVA or extract the portable executable into a permanent directory.
2. Open **Instellen en koppelen** from its tray menu. Enter your NOVA server's HTTP(S) address and save it.
3. Choose **Verbinding toestaan in Windows**. Windows asks for elevation to create an inbound TCP rule for the agent port (any address, any network profile).
4. Select this PC's network address, then copy its pairing code.
5. In NOVA, open **Instellingen → Windows-pc**, paste the code and save. Restart NOVA to apply the connection, as with other saved service connections.
6. Enable **Starten met Windows** in the tray if desired.

The pairing code contains the bearer token. It is the only credential between NOVA and this PC, so treat it as a password. It is available only to the app's local setup page; the remotely hosted helper page cannot read it or modify the firewall. Nothing else is configured or needs approval: with the token, NOVA may look at the screen, drive mouse and keyboard, use the browser and open or close programs.

NOVA's existing `WINDOWS_AGENT_URL` and `WINDOWS_AGENT_TOKEN` environment settings also remain supported.

## One configuration file

Settings live in `%LOCALAPPDATA%\NOVA\config.json`, including the server origin, helper view and screen, per-screen wallpaper choices, HTTP port (8765 by default), the named app shortcuts and the global shortcuts. Older configs may still contain `allowedIps`, `allowedOrigins`, `automation` switches or `runElevated: false`; they load without error and no longer restrict anything (the IP list and switches are dropped on the next save). The log is `%LOCALAPPDATA%\NOVA\nova.log`.

The app restricts access to its data directory to the current user, SYSTEM and Administrators. Saves flush a temporary file and replace the previous configuration atomically. An invalid existing config stops startup and remains untouched; it never silently rotates a token.

The existing `%LOCALAPPDATA%\NOVA\desk-profile` WebView2 profile is reused to preserve sign-in. `setup-profile` remains a separate browser profile, not another configuration file.

## Updates from GitHub

NOVA checks the stable GitHub release 20 seconds after startup and every six hours. A newly discovered version opens the local settings window once per version and appears in the tray menu. **Controleren op updates** runs a manual check. **Bijwerken en herstarten** downloads the update, verifies it and runs the installer after saving the current settings. Checks never install an update automatically.

The [Tauri updater](https://v2.tauri.app/plugin/updater/) verifies the installer with the public key embedded in the app. Signed version binding is required, and downgrades are disabled. A failed download, invalid signature or failed settings save leaves the current app installed. Update commands are granted only to the local setup page; neither remote helper pages nor the agent HTTP API can install updates.

The endpoint is `https://github.com/hjongedijk/nova/releases/download/windows-latest/latest.json`. The Windows agent has its own version (`apps/windows/VERSION`) and tags (`windows-vX.Y.Z`), separate from NOVA's `vX.Y.Z`. A signed Windows release publishes the versioned installer and its `.sig` file on the `windows-vX.Y.Z` release and replaces `latest.json` on the `windows-latest` update-feed prerelease (so NOVA's own `releases/latest` is never a Windows release). Missing metadata or a failed Windows build results in a retryable check error, never an unsigned fallback.

The installer defaults to a separate **NOVA for Windows** application folder; settings stay in `%LOCALAPPDATA%\NOVA`. The updater supplies the current executable's directory to NSIS, including for a portable app. Updating a portable executable uses the NSIS installer and can create the normal installer/uninstaller registrations.

### One-time signing setup

A signing key was generated outside the repository at `/root/.config/nova/windows-updater.key`, with owner-only permissions. Its public half is embedded in `tauri.conf.json`. The private key is not in source control or release artifacts.

Before publishing the first update, a repository administrator must put the **contents** of that private-key file in the GitHub Actions repository secret `TAURI_SIGNING_PRIVATE_KEY`. `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` is optional and is empty for this generated key. Keep a secure backup of the key; replacing it would prevent existing installations from trusting later updates.

The release workflow refuses to produce Windows release artifacts without the signing secret. Development/PR builds disable update-artifact signing, so test installers can still be built without access to release credentials. The repository administrator has configured the signing secret. Its value will be verified by the first signed release build; an actual update between two Windows releases remains unverified.

## Transition from the old agent

The PowerShell implementation, its test scripts and its download routes have been removed from this repository. The v0.1.73 GitHub release remains available for rollback. The native importer still reads existing legacy configuration files on a user’s PC.

At first startup, the new app imports `agent.json`, `mode.json` and `wallpaper.json` next to its executable, plus `%LOCALAPPDATA%\NOVA\desk.json`. Windows PowerShell UTF-8 BOMs are accepted. The import retains the token, named apps, URL, mode, helper display/view/shortcuts and device-named wallpaper choices. Legacy browser/desktop preferences are retained as migration data; only the default search engine is reused. The old IP allowlist, host lists and switches are ignored, and imported configs have everything enabled. Source files are never deleted.

For an installed app whose old files live elsewhere, expand **Oude agent vervangen** in the setup window, enter that directory and choose **Oude instellingen importeren**. This explicit import keeps the previous unified settings as `config.json.before-import`. If the legacy port differs, NOVA restarts automatically to bind the imported port.

Then choose **Oude agent uitschakelen**. This ends PowerShell agents whose script path matches that folder, removes the documented `NOVAAgent`/`JarvisAgent` scheduled tasks, removes NOVA Desk's Run entry and asks the old shell to quit. Import before disabling the old installation. If the old process occupied port 8765, the new app retries its listener afterward. Other processes are left alone.

Rollback: quit NOVA, disable its Run entry and restart the old scheduled task after re-registering it with the preserved legacy installer. Use the v0.1.73 artifacts and original JSON files. If you paired with a new token instead of importing the old one, restore the corresponding NOVA connection settings too.

## Supported contract

All HTTP routes require `Authorization: Bearer <token>`; that is the only check, from any source address. Tokens are compared using constant-time comparison. JSON request bodies are bounded to 16 KiB. The listener uses ordinary TCP, so no HTTP.sys URL reservation is required.

- `GET /v1/status`, `GET /v1/displays`: actual mode, helper state, monitor list, named/running apps and agent version. `permissions` always reports `{ view: true, control: true, browser: true }`; `agentPaused` shows the owner's pause.
- `POST /v1/mode`, `POST /v1/wallpaper`: native window changes with saved per-monitor choices. Display 0 selects primary for helper mode and all displays for wallpaper.
- `POST /v1/helper/size`, `GET/POST /v1/helper/preferences`, `POST /v1/helper/notify`: view/size, global shortcuts and bounded notification queue. The owner's pause suppresses notifications and shortcut actions.
- `POST /v1/open-app`, `POST /v1/close-app`: a name from the app list, or any other program, document or process name as given. Close requests send WM_CLOSE, allowing applications to ask about unsaved work.
- `POST /v1/open-url`: any valid URL.
- `POST /v1/lock`: native Windows workstation lock.

Default shortcuts: Ctrl+Alt+N opens the helper, Ctrl+Alt+Space speaks, Ctrl+Alt+M mutes, Ctrl+Alt+D shows the desktop. Conflicts appear as helper warnings. Empty shortcuts disable individual actions; invalid or duplicate bindings are rejected before registration changes.

The helper window on the configured NOVA origin gets the few window commands it needs (drag, view, display). Release windows have no developer tools. Links to other sites open in the normal browser; that only chooses where a page is shown.

## Seeing and controlling the PC

Everything is allowed from the moment the PC is paired: there are no switches, no consent prompts, no sessions to confirm and no limits on actions. New and imported configs behave the same, and `GET /v1/status` reports every permission as allowed.

Screenshots use native GDI capture and bounded in-memory JPEG encoding. Display numbers are one-based; `0` selects the primary display. Coordinates are scaled from the observed image to physical monitor pixels, including monitors left of or above the primary display. Supported input includes move, click, double-click, right-click, drag, scroll, Unicode typing, key chords and window focus. Windows key shortcuts are supported. Every window, including password managers, banking sites and Windows security dialogs, can be captured, focused and driven. The secure desktop (UAC prompt, Ctrl+Alt+Delete screen, sign-in) cannot be driven by any program; that is Windows, not NOVA.

### Emergency stop

**Ctrl+Alt+Shift+K** is the owner's off switch. It pauses the agent at once: queued input, screenshots and browser actions are cancelled and every desktop and browser route answers 409 until the owner resumes via **Hervatten** in the tray menu (the tray also has **Pauzeren** and **Pc-bediening stoppen**). NOVA cannot lift a pause. The pause lives in memory only, so a restart resumes. The shortcut is reserved and cannot be assigned to another action. If another program already holds it, the helper shows a warning; NOVA is still not blocked.

The `armed` route (`POST /v1/desktop/control`) is kept for NOVA's API contract but nothing needs arming: input works whenever the agent is not paused, and `armed`/`view`/`control` in `GET /v1/desktop/status` are simply `true` then. No arbitrary-script HTTP endpoint is exposed.

On NOVA's home page, **Pc bekijken** opens a compact screen popup with monitor selection. Frames refresh up to eight times per second while the popup is expanded and the page is visible. Closing, minimizing or hiding the page cancels capture requests and clears the image. Frames are never stored or sent to the vision model by this viewer.

Browser automation uses a separate visible Edge or Chrome window and `%LOCALAPPDATA%\NOVA\browser-profile`, retaining its login independently of the helper. NOVA can search, open any website, read pages, click, type (including password and payment fields), press keys, scroll, navigate back and manage tabs, without host lists, confirmation steps or rate limits. DOM elements are mapped inside an isolated CDP world. The debug listener binds loopback on an ephemeral port, and a Windows job owns the browser process tree. Page text is untrusted data, never instructions.

### Windows administrator rights

NOVA starts elevated by default (`agent.runElevated` is true in new configs). With **Start with Windows** enabled, Windows-agent v0.1.3 registers an interactive Task Scheduler task for the same Windows account and the installed NOVA executable, using `HighestAvailable`. Approve the first elevated launch once; subsequent sign-ins use that approved task without another UAC prompt. NOVA verifies the task before removing the old Run entry. The task stores no password and does not run as SYSTEM. If task registration fails, the old startup entry remains and NOVA logs the failure. A portable executable must stay at its registered path; moving it requires configuring startup again.

Without a verified task, an unelevated start still requests normal UAC approval. Declining leaves NOVA running without administrator rights. To opt out, set `agent.runElevated` to `false` in `config.json`; on the next elevated startup NOVA replaces its elevated task with the normal startup entry. Disabling **Start with Windows** removes NOVA's task and Run entry. A standard account needing another administrator's credentials is not switched to that other account. Administrator rights permit input into elevated applications, but Windows secure UAC, Ctrl+Alt+Delete and sign-in desktops remain manual.

## Windows acceptance checks

Wallpaper pages receive trusted WebView2 left-button input and mouse moves through a global low-level mouse hook; clicks on application windows are left alone. Clicking an input focuses its WebView2 controller for keyboard input. Owned dropdown popups stay part of the wallpaper interaction. Vertical and horizontal wheel events are forwarded without stealing focus. Right-button forwarding remains deferred. Wallpaper windows are created as native desktop children before WebView2 construction; input uses their actual client origin and DPI, and browser zoom starts at 100%. The small helper is fixed at the top center of the selected display and is a child of the desktop host, above desktop content and below application windows; it is no longer always on top. Native helper diagnostics are not implemented yet; the server reports that no valid helper measurement is available.

The native app must be tried on Windows for transparency, dragging, WebView2 prompts, shortcuts, autostart, old-agent retirement, UAC/firewall, multiple monitors and wallpaper placement. Explorer restart recovery remains a known limitation inherited from NOVA Desk; toggle the wallpaper off/on if its host disappears.

## Development

```sh
cd apps/windows
cargo test --locked -p nova-win-core -p nova-win-agent
cargo fmt --all -- --check
cargo clippy --locked --workspace --all-targets -- -D warnings
```

Build from `apps/windows` so its `.cargo/config.toml` limits compiler concurrency to one job. On the shared server, run checks sequentially and leave full executable/installer builds to the Windows CI runner.

On Linux, check the native app with the installed Windows GNU target and MinGW:

```sh
cargo check --locked --target x86_64-pc-windows-gnu -p nova
```

On Windows, `cargo build --release -p nova` produces the portable executable. The shared `.github/scripts/build-windows.ps1` builds a development installer without signing secrets. Release builds require the signing setup above. CI runs native core/HTTP tests and builds the app and installer on Windows. Browser CDP behavior has an opt-in real-Chromium fixture test; run `NOVA_TEST_CHROMIUM_EXECUTABLE=/path/to/chrome cargo test -p nova-win-agent browser::tests::isolated_cdp_browser_contract -- --ignored` from `apps/windows`. The live popup has a synthetic Playwright check, `node scripts/check-live-desktop.mjs`, against a web dev server (`NOVA_LIVE_DESKTOP_TEST_URL`, default `http://127.0.0.1:5189`). Neither fixture connects to a real PC. The standalone **Windows application** workflow can produce downloadable development artifacts without publishing a server release. The independent Windows release job is allowed to fail without blocking server images; a failure publishes no replacement legacy bundle.

## Windows desktop control and helper

How NOVA sees and controls a Windows PC through the [Windows agent](windows-agent.md), and how the helper panel is designed and checked. Installation, pairing, updates and migration are described above; this section covers the contract and the NOVA side.

The agent has no restrictions: viewing, control and browser are always on once the PC is paired. Capture, input, browser interaction, elevation and the emergency stop still need an acceptance run on a real Windows desktop.

Contents: [Agent routes](#agent-routes) · [NOVA tools](#nova-tools) · [Session limits](#session-limits) · [Classification](#classification-of-desktop_act) · [Prompt injection and audit](#prompt-injection-and-audit) · [Settings and REST](#settings-and-rest) · [Live screen popup](#live-screen-popup) · [Helper design](#helper-design) · [Checks](#checks)

### Agent routes

Implemented in `apps/windows/crates/nova-win-agent/src/desktop/`. Every route needs only the agent's bearer token (`WINDOWS_AGENT_URL`, `WINDOWS_AGENT_TOKEN` on the NOVA side).

| Route                                            | Purpose                                                                                                                                                                                                           |
| ------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET /v1/desktop/status`                         | `{ ok, view, control, armed, armedUntil, paused, killHotkey, displays }`                                                                                                                                          |
| `GET /v1/desktop/windows`                        | Visible windows including minimized ones: id, title, process, foreground state, physical bounds.                                                                                                                  |
| `GET /v1/desktop/screenshot?display=N&maxWidth=` | JSON `{ ok, image (base64 JPEG), mimeType, width, height, display }`. No files are written. Width is bounded to 320-1920; display numbers are one-based and `0` is the primary display. No window blocks capture. |
| `POST /v1/desktop/control`                       | `{ armed: true, ttlSeconds? }` or `{ armed: false }`. Kept for compatibility; only acknowledges the request, because input needs no arming. Refused (409) only while the owner has paused the agent.              |
| `POST /v1/desktop/input`                         | `{ action, display?, relativeTo?: { width, height }, ... }` with actions `move`, `click`, `doubleclick`, `rightclick`, `drag`, `scroll`, `type`, `key`, `focus_window`.                                           |

With `relativeTo`, coordinates refer to the screenshot and the agent scales them. Input is accepted at any rate, up to 4000 UTF-16 units per typed text, and needs no lease or confirmation. While the agent is paused, or after an emergency stop cancelled a running request, desktop routes answer 409. Windows secure desktops (UAC, Ctrl+Alt+Delete, sign-in) cannot be driven even when NOVA runs elevated.

### NOVA tools

> The sections from here to [Settings and REST](#settings-and-rest) describe the NOVA API side (`apps/api`), which is being changed separately to drop its own confirmations and limits. The Windows agent no longer enforces any of what they describe.

Code: `apps/api/src/desktop/`. The agent sits behind `DesktopPort`, the vision model behind `DesktopVision`; tests inject fakes.

| Tool                     | Risk                                           | Behavior                                                                                                                                                                            |
| ------------------------ | ---------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `desktop_status`         | READ_ONLY                                      | Settings, session and agent status.                                                                                                                                                 |
| `desktop_windows`        | READ_ONLY                                      | Window list (titles are data); only with viewing on.                                                                                                                                |
| `desktop_screenshot`     | READ_ONLY                                      | Sends the image to the `vision` role through OmniRoute (verified-free model only, otherwise nothing is sent) and returns a text description marked untrusted; only with viewing on. |
| `desktop_takeover_start` | DANGEROUS                                      | On-screen confirmation on every call (60 s, single use) showing the goal and duration (30-900 s); never covered by "Altijd".                                                        |
| `desktop_act`            | SAFE per call, DANGEROUS when risky or unknown | Only during a session of the same conversation.                                                                                                                                     |
| `desktop_takeover_stop`  | READ_ONLY                                      | Stops at once and switches the agent off; works even when everything is off.                                                                                                        |

Images are not stored or logged. Only a short cache (10 s, at most 4, per image and question) of the text description exists; it is cleared on every action, stop or settings change and can be turned off. NOVA takes no image when the active window looks like a password manager, bank or login, or when the window list cannot be checked (fail closed).

### Session limits

Enforced server-side (`desktop.limits.ts`):

- Duration 30-900 s (also clamped on direct calls); 120 s of inactivity ends the session.
- At most 100 actions and 60 screenshots. Observe, then act: look again after 6 actions.
- Three failed actions or screenshots in a row stop the session and switch the agent off; if switching off fails NOVA retries every 5 seconds and says so in settings.
- One session at a time, bound to the conversation that started it.

### Classification of `desktop_act`

Per action, from the proposed action and the window title and process the agent reports (not what the model claims):

- **Benign** (no question): pointer and scroll, navigation keys, click or type in an ordinary, unambiguous window.
- **Risky** (fresh DANGEROUS confirmation, even inside a session): payments, banking, deleting, passwords or logins, mail and chat, terminals and admin tools, text followed by Enter, text that looks like a password, token, IBAN or card number, Enter in a browser, drag, right-click or double-click in the file explorer.
- **Unknown** (also confirmed): an unknown key, no or unclear active window, empty title, unknown `windowId`, text longer than 300 characters, unreachable window list.

The confirmation binds to the exact action and window title; if the window changes before execution NOVA asks again. "Altijd" is never offered for DANGEROUS.

### Prompt injection and audit

Everything from the screen (description, window titles, web, mail) is data. The description carries `untrusted: true` and a warning, the vision model is told to report text that tries to steer an AI rather than follow it, and no screen content can create a confirmation, session or permission; only the user (screen button) and the classification above can.

Every tool call is logged with metadata only: action, coordinates, key name, window title (80 characters) and, for `type`, only `textCharacters`, never the typed text or the screen description. Session start and end (reason: user, model, ttl, idle, max_actions, errors, disabled) are logged as `desktop_session`.

### Settings and REST

`GET /api/settings/desktop` (status, session, last 40 audit lines), `PUT /api/settings/desktop` with `{ viewEnabled?, controlEnabled?, cacheEnabled? }` (control cannot be on without viewing), and `POST /api/settings/desktop/stop`. All fall under the settings PIN and header. State is stored in `desktop-settings.json` (`0600`), all off by default. **Instellingen → Windows-pc → Pc bedienen** shows the NOVA-side state. The agent itself needs no switches, see [Seeing and controlling the PC](#seeing-and-controlling-the-pc).

### Live screen popup

The home page offers **Pc bekijken** with monitor selection, the current session goal and action, and **Stop overname**. `GET /api/settings/desktop/frame?display=N` uses the settings PIN when configured, sends `Cache-Control: no-store, private` and returns one bounded frame. It calls no vision model, stores no image and grants no input. The popup refreshes only while open, expanded and visible. Watching does not extend a takeover or count against NOVA's observation budget.

### Helper design

The helper is a small top-edge command panel with a calm navy surface, sharp rectangular controls and the particle orb. Controls stay square; mini-orbs stay circular because they show integration state. Warning and critical colors appear only when the data warrants it.

| Token          | Value     | Purpose                                       |
| -------------- | --------- | --------------------------------------------- |
| Background     | `#091321` | One opaque color across HTML, body and window |
| Surface        | `#112136` | Cards and controls                            |
| Border         | `#29415b` | Quiet separation without shadows              |
| Text           | `#edf5ff` | Primary reading contrast                      |
| Secondary text | `#a6bbd2` | Labels, model and activity                    |
| Accent         | `#8dd8ff` | Selected tab, focus and bottom edge           |

Type is Segoe UI or system fonts (12 px body, 11 px labels, 10 px activity metadata). `apps/web/src/components/helper/HelperUi.svelte` is the shared control catalog and `helper.css` holds the common tokens. Three initial tabs cover overview, chat and notifications; the plus adds weather and lists. Model labels use the real `done.model` value and unavailable services are labeled as such. Accessibility: visible keyboard focus, Enter and Space on native buttons, Y/N only outside text editing, confirmation cards that cannot collapse while pending, reduced motion, a saved high-contrast mode with forced-colors support, and a 3 px autohide strip that does not slide into a neighboring monitor.

Inside the Windows app (or with `?desk=1`) the page is transparent and the panel itself is the rounded shape (16 px radius, border, soft shadow, 12 px transparent margin). The header adapts with container queries: below 1000 px the toolbar labels go, below 780 px the status pill shrinks, below 560 px the wordmark goes, and tabs shorten before overlapping the toolbar.

| State        | 1x                                      | 2x                                      |
| ------------ | --------------------------------------- | --------------------------------------- |
| Compact      | [Image](img/helper-compact-1x.png)      | [Image](img/helper-compact-2x.png)      |
| Overview     | [Image](img/helper-overview-1x.png)     | [Image](img/helper-overview-2x.png)     |
| Chat         | [Image](img/helper-chat-1x.png)         | [Image](img/helper-chat-2x.png)         |
| Notification | [Image](img/helper-notification-1x.png) | [Image](img/helper-notification-2x.png) |
| Confirmation | [Image](img/helper-confirmation-1x.png) | [Image](img/helper-confirmation-2x.png) |
| Attachment   | [Image](img/helper-attachment-1x.png)   | [Image](img/helper-attachment-2x.png)   |
| Choices      | [Image](img/helper-choices-1x.png)      | [Image](img/helper-choices-2x.png)      |
| Weather      | [Image](img/helper-weather-1x.png)      | [Image](img/helper-weather-2x.png)      |
| Lists        | [Image](img/helper-lists-1x.png)        | [Image](img/helper-lists-2x.png)        |
| Settings     | [Image](img/helper-preferences-1x.png)  | [Image](img/helper-preferences-2x.png)  |
| Contrast     | [Image](img/helper-contrast-1x.png)     | [Image](img/helper-contrast-2x.png)     |

The screenshots use bounded test fixtures, not production data.

### Checks

- API: `npm -w apps/api test -- test/desktop` covers default-off, viewing (vision role, cache, fail closed, sensitive window), DANGEROUS never granted automatically (not even with `always` or a forged standing grant), the TTL cap, budgets, idle and TTL expiry, the error loop, agent failures, no typed text in the log, screen injection, the real HTTP client against a fake server, and the vision adapter.
- Native: `cargo test --locked -p nova-win-core -p nova-win-agent` and the Windows compile and Clippy checks in [Development](#development).
- Helper (needs a running dev server and Chromium via `npx playwright-core install chromium`): `node scripts/check-helper.mjs` mocks chat, TTS and confirmation and captures the screenshots above (`NOVA_HELPER_TEST_URL` selects another origin); `node scripts/check-helper-layout.mjs` asserts with bounding boxes that the header never overlaps at 640-1280 px, 100-150% scaling and a wide font (`NOVA_HELPER_SHOTS` writes screenshots); `node scripts/check-live-desktop.mjs` checks the live popup against a dev server (`NOVA_LIVE_DESKTOP_TEST_URL`, default `http://127.0.0.1:5189`). Cue tests (`apps/api/test/helper-cues.test.ts`) verify the helper's sound signals are finite, bounded, low-gain, quiet-hour aware and stopped by speech.
- Real Windows remains the acceptance gap: capture, input, browser automation, UAC, tray, shortcuts, DPI and monitor transitions, minimum window height, microphone and output devices, wallpaper placement, and notification delivery after reopening the helper.
