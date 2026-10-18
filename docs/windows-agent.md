# NOVA for Windows

The Windows agent now lives in `apps/windows/`: one Rust/Tauri application, `nova.exe`, with one tray icon. It owns the authenticated HTTP service, native helper and living wallpaper. It does not launch PowerShell or require a separate NOVA Desk executable.

This is stage one of the native rewrite. It has been cross-checked for Windows compilation on Linux; installer behavior, window transparency, monitor DPI, firewall elevation and wallpaper parenting still require a Windows acceptance run. No release or production deployment is implied by the source changes.

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

The release workflow refuses to produce Windows release artifacts without the signing secret. Development/PR builds disable update-artifact signing, so test installers can still be built without access to release credentials. Signing-secret provisioning and an actual update between two Windows releases remain unverified.

## Transition from the old agent

The old implementation is retained in `agents/windows-legacy/` for rollback and compatibility downloads. New release artifacts exclude it.

At first startup, the new app imports `agent.json`, `mode.json` and `wallpaper.json` next to its executable, plus `%LOCALAPPDATA%\NOVA\desk.json`. Windows PowerShell UTF-8 BOMs are accepted. The import retains the token, app/source allowlists, URL, mode, helper display/view/shortcuts and device-named wallpaper choices. Legacy browser/desktop preferences are retained as inactive data for later stages. Source files are never deleted.

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

## Deferred functionality and Windows checks

Screenshots, mouse/keyboard desktop control and browser automation return 501 for actions in this stage. Their status routes report disabled. Wallpaper mouse/keyboard forwarding is also deferred. Native helper diagnostics are not implemented yet; the server reports that no valid helper measurement is available.

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

On Windows, `cargo build --release -p nova` produces the portable executable. The shared `.github/scripts/build-windows.ps1` builds a development installer without signing secrets. Release builds require the signing setup above. CI runs native core/HTTP tests and builds the app and installer on Windows. The standalone **Windows application** workflow can produce downloadable development artifacts without publishing a server release. The independent Windows release job is allowed to fail without blocking server images; a failure publishes no replacement legacy bundle.
