# NOVA for Windows

The Windows agent now lives in `apps/windows/`: one Rust/Tauri application, `nova.exe`, with one tray icon. It owns the authenticated HTTP service, native helper and living wallpaper. It does not launch PowerShell or require a separate NOVA Desk executable.

The native agent includes screenshots, desktop input and a visible automated browser. A prior version built successfully on GitHub Windows CI; the expanded native features, elevation, installer behavior, monitor DPI and wallpaper parenting still require a Windows acceptance run. No production deployment is implied by source changes.

## Installation and pairing

The release workflow builds `NOVA-Setup-<version>.exe` and `nova-windows.zip`. The portable zip contains only `nova.exe`. The installer runs for the current user and bundles WebView2 bootstrap installation through Tauri when needed.

1. Install NOVA or extract the portable executable into a permanent directory.
2. Open **Instellen en koppelen** from its tray menu. Enter your NOVA server's HTTP(S) address and save it.
3. Enter the NOVA server's IP address and choose **Verbinding toestaan in Windows**. Windows asks for elevation to create an inbound TCP rule, restricted to this address and private/domain network profiles. The app itself continues without administrator rights.
4. Select this PC's network address, then copy its pairing code.
5. In NOVA, open **Instellingen → Koppelingen → Windows-agent**, paste the code and save. Restart NOVA to apply the connection, as with other saved service connections.
6. Enable **Starten met Windows** in the tray if desired.

The pairing code contains the bearer credential. Treat it as a password. It is available only to the app's local setup page. The remotely hosted helper page cannot read it or modify the firewall.

NOVA's existing `WINDOWS_AGENT_URL` and `WINDOWS_AGENT_TOKEN` environment settings also remain supported.

## One configuration file

Settings live in `%LOCALAPPDATA%\NOVA\config.json`, including the server origin, helper view and screen, per-screen wallpaper choices, HTTP port (8765 by default), source-IP allowlist, app allowlist and shortcuts. The log is `%LOCALAPPDATA%\NOVA\nova.log`.

The app restricts access to its data directory to the current user, SYSTEM and Administrators. Saves flush a temporary file and replace the previous configuration atomically. An invalid existing config stops startup and remains untouched; it never silently rotates a token.

The existing `%LOCALAPPDATA%\NOVA\desk-profile` WebView2 profile is reused to preserve sign-in. `setup-profile` remains a separate browser profile, not another configuration file.

## Updates from GitHub

NOVA checks the stable GitHub release 20 seconds after startup and every six hours. A newly discovered version opens the local settings window once per version and appears in the tray menu. **Controleren op updates** runs a manual check. **Bijwerken en herstarten** downloads the update, verifies it and runs the installer after saving the current settings. Checks never install an update automatically.

The [Tauri updater](https://v2.tauri.app/plugin/updater/) verifies the installer with the public key embedded in the app. Signed version binding is required, and downgrades are disabled. A failed download, invalid signature or failed settings save leaves the current app installed. Update commands are granted only to the local setup page; neither remote helper pages nor the agent HTTP API can install updates.

The endpoint is `https://github.com/hjongedijk/nova/releases/latest/download/latest.json`. A signed release publishes the versioned installer, its `.sig` file and that manifest. Missing metadata or a failed Windows build results in a retryable check error, never an unsigned fallback.

The installer defaults to a separate **NOVA for Windows** application folder; settings stay in `%LOCALAPPDATA%\NOVA`. The updater supplies the current executable's directory to NSIS, including for a portable app. Updating a portable executable uses the NSIS installer and can create the normal installer/uninstaller registrations.

### One-time signing setup

A signing key was generated outside the repository at `/root/.config/nova/windows-updater.key`, with owner-only permissions. Its public half is embedded in `tauri.conf.json`. The private key is not in source control or release artifacts.

Before publishing the first update, a repository administrator must put the **contents** of that private-key file in the GitHub Actions repository secret `TAURI_SIGNING_PRIVATE_KEY`. `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` is optional and is empty for this generated key. Keep a secure backup of the key; replacing it would prevent existing installations from trusting later updates.

The release workflow refuses to produce Windows release artifacts without the signing secret. Development/PR builds disable update-artifact signing, so test installers can still be built without access to release credentials. The repository administrator has configured the signing secret. Its value will be verified by the first signed release build; an actual update between two Windows releases remains unverified.

## Transition from the old agent

The PowerShell implementation, its test scripts and its download routes have been removed from this repository. The v0.1.73 GitHub release remains available for rollback. The native importer still reads existing legacy configuration files on a user’s PC.

At first startup, the new app imports `agent.json`, `mode.json` and `wallpaper.json` next to its executable, plus `%LOCALAPPDATA%\NOVA\desk.json`. Windows PowerShell UTF-8 BOMs are accepted. The import retains the token, app/source allowlists, URL, mode, helper display/view/shortcuts and device-named wallpaper choices. Legacy browser/desktop preferences are retained as migration data. Browser host and search preferences are reused; enable desktop access explicitly in the local setup window. Source files are never deleted.

For an installed app whose old files live elsewhere, expand **Oude agent vervangen** in the setup window, enter that directory and choose **Oude instellingen importeren**. This explicit import keeps the previous unified settings as `config.json.before-import`. If the legacy port differs, NOVA restarts automatically to bind the imported port.

Then choose **Oude agent uitschakelen**. This ends PowerShell agents whose script path matches that folder, removes the documented `NOVAAgent`/`JarvisAgent` scheduled tasks, removes NOVA Desk's Run entry and asks the old shell to quit. Import before disabling the old installation. If the old process occupied port 8765, the new app retries its listener afterward. Other processes are left alone.

Rollback: quit NOVA, disable its Run entry and restart the old scheduled task after re-registering it with the preserved legacy installer. Use the v0.1.73 artifacts and original JSON files. If you paired with a new token instead of importing the old one, restore the corresponding NOVA connection settings too.

## Supported contract

All HTTP routes require `Authorization: Bearer <token>` and enforce the source allowlist when configured. Tokens are compared using constant-time comparison. JSON request bodies are bounded to 16 KiB. The listener uses ordinary TCP, so no HTTP.sys URL reservation is required.

- `GET /v1/status`, `GET /v1/displays`: actual mode, helper state, monitor list, available/running allowlisted apps and agent version.
- `POST /v1/mode`, `POST /v1/wallpaper`: native window changes with saved per-monitor choices. Display 0 selects primary for helper mode and all displays for wallpaper.
- `POST /v1/helper/size`, `GET/POST /v1/helper/preferences`, `POST /v1/helper/notify`: view/size, global shortcuts and bounded notification queue. Pause suppresses notifications and shortcut actions.
- `POST /v1/open-app`, `POST /v1/close-app`: only configured applications. Close requests send WM_CLOSE, allowing applications to ask about unsaved work.
- `POST /v1/open-url`: HTTP(S) URLs only; no embedded credentials.
- `POST /v1/lock`: native Windows workstation lock.

Default shortcuts: Ctrl+Alt+N opens the helper, Ctrl+Alt+Space speaks, Ctrl+Alt+M mutes, Ctrl+Alt+D shows the desktop. Conflicts appear as helper warnings. Empty shortcuts disable individual actions; invalid or duplicate bindings are rejected before registration changes.

Only the helper window on the configured NOVA origin receives its window commands. Login origins can be added explicitly through `allowedOrigins`; they never receive helper commands. Release windows have no developer tools. External links open in the normal browser.

## Seeing and controlling the PC

Open **Instellen en koppelen → Toegang tot deze pc**. Enable screen viewing and, if desired, mouse/keyboard control. Also enable the corresponding switches in NOVA’s **Bureaublad** settings. Desktop access defaults off, including when upgrading an older unified config. NOVA’s existing tools use vision to inspect the display before acting; takeover sessions require confirmation and expire after at most 15 minutes.

Screenshots use native GDI capture and bounded in-memory JPEG encoding. Display numbers are one-based; `0` selects the primary display. Coordinates are scaled from the observed image to physical monitor pixels, including monitors left of or above the primary display. Supported input includes move, click, double-click, right-click, drag, scroll, Unicode typing, key chords and window focus. Windows key shortcuts are supported; Ctrl+Alt+Delete is reserved by Windows. Input and screenshots respect the local pause switch; protected visible windows block screenshots on their monitor.

**Ctrl+Alt+Shift+K** pauses automation and disarms control. The tray also has **Pc-bediening stoppen**. Arming is refused if the emergency shortcut could not be registered. An armed session exists only in memory; restart always disarms it. Agent requests keep the existing bearer-token and source-IP checks. No arbitrary-script HTTP endpoint is exposed.

On NOVA’s home page, **Pc bekijken** opens a compact screen popup. It opens automatically when it detects a new desktop takeover, shows monitor selection, the session goal/recent action and **Stop overname**. Frames refresh about once per second while the popup is expanded and the page is visible. Closing, minimizing or hiding the page cancels capture requests and clears the image. Frames use the guarded settings API and are never stored or sent to the vision model by this viewer; watching does not consume NOVA’s observation budget or keep a takeover alive.

Browser automation uses a separate visible Edge or Chrome window and `%LOCALAPPDATA%\NOVA\browser-profile`, retaining its login independently of the helper. NOVA can search, open/read pages, click, type, press keys, scroll, navigate back and manage tabs. Password/PIN/payment fields remain manual; risky click labels require the existing confirmed browser tool. DOM elements are mapped inside an isolated CDP world. The debug listener binds loopback on an ephemeral port, and a Windows job owns the browser process tree. Disabling browser permission closes that owned browser. Pages remain untrusted data.

### Windows administrator permissions

In the local Windows setup window, enable **NOVA starten als beheerder** and choose **Toepassen**. Windows shows its normal UAC consent prompt; accepting it restarts NOVA with the same account’s elevated token. Cancelling leaves the existing app running. This preference is saved as `agent.runElevated`; Windows asks again on later unelevated starts. Remote pages and agent API clients cannot enable it.

This option supports an administrator account with a filtered token. A standard account requiring another administrator’s credentials is rejected, avoiding a switch to another user’s configuration and browser profiles. Disabling the preference applies after closing NOVA and launching it normally from Windows. Running elevated permits input into elevated applications; it does not permit capturing or driving the secure UAC desktop, Ctrl+Alt+Delete screen or Windows sign-in. Approve those prompts personally.

## Windows acceptance checks

Wallpaper mouse/keyboard forwarding is still deferred. Native helper diagnostics are not implemented yet; the server reports that no valid helper measurement is available.

The native app must be tried on Windows for transparency, dragging, WebView2 permission prompts, shortcuts, autostart, old-agent retirement, UAC/firewall, multiple monitors and wallpaper placement. Explorer restart recovery remains a known limitation inherited from NOVA Desk; toggle the wallpaper off/on if its host disappears.

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
