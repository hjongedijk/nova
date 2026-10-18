# Legacy NOVA Windows agent

This folder is preserved for rollback and compatibility downloads. New installations use [NOVA for Windows](../../docs/windows-agent.md) in `apps/windows`; release packages do not include these scripts.

A small PowerShell service that runs in your desktop session on a Windows PC. It lets NOVA open allow-listed programs, show NOVA as living wallpaper per display or as a small helper overlay, and use a browser of its own.

Quick install, in an elevated PowerShell in this folder:

```powershell
powershell -ExecutionPolicy Bypass -File .\install.ps1 -NovaHost <nova-host-ip>
```

Then put the two printed lines (`WINDOWS_AGENT_URL`, `WINDOWS_AGENT_TOKEN`) in the `.env` of your NOVA install and recreate the container.

Everything else (configuration, modes, browser endpoints, security, limits) is in [docs/windows-agent.md](../../docs/windows-agent.md).

Files: `nova-agent.ps1` (the legacy agent), `jarvis-agent.ps1` (compatibility launcher for older scheduled tasks), `install.ps1` (installer; `-JarvisHost` remains an alias), `agent.example.json` (configuration template), `test/check.ps1` (syntax and C# check, also run in CI).

## Rectangular helper

The helper uses a bounded Edge app window, without rounded window regions. Its dedicated normal browser profile preserves microphone permissions and selections when the helper closes; kiosk mode previously used InPrivate storage. Fullscreen requires the explicit fullscreen control. Views are compact (360×44), overview/notifications/weather/lists (640×180), chat (640×340) and confirmation (640×170), in CSS pixels. Native view/display/hotkeys persist in `mode.json`; NOVA stores appearance and sound settings. Autohide keeps a 3 CSS-pixel top strip. The tray and global shortcuts can reopen a closed helper. Default shortcuts: Ctrl+Alt+N (open), Ctrl+Alt+Space (speak), Ctrl+Alt+M (mute), Ctrl+Alt+D (desktop).

Configure the helper with its gear. Native shortcut conflicts are reported. Pausing suppresses helper speech/listening and native notifications. Calendar and conversational mood features depend on later phases. Chromium 135+ SpeechRecognition can use the microphone selected in the helper settings for both tap-to-talk and Hey NOVA; older browsers use the Windows default microphone. Temporary device loss preserves the selection and wake preference, and reconnect events restart listening. Microphone permission remains controlled by the browser; output selection requires browser sink support.

See [the full helper reference](../../docs/windows-agent.md#the-rectangular-helper) and [design/screenshots](../../docs/helper-design.md). Docker checks cover parsing, C# compilation, Win32 message layouts, geometry/DPI, saved preferences and shortcut validation. Headless browser checks cover compact and fullscreen sizing, hide/reveal, reload persistence, missing-device recovery, and selected-track cleanup at 1×/2×. Actual Edge app caption removal, native bounds, hotkeys, tray, physical microphone audio and closed-window recovery require a Windows desktop test. Bundled agent version: `2026-10-13.1`.

## Desktop view and control (off by default)

NOVA can look at the screen and, in a short confirmed session, move the mouse and type. Both are disabled until you set them in `agent.json`:

```json
"desktop": { "enabled": true, "control": true, "killHotkey": "Ctrl+Alt+Shift+K" }
```

`enabled` allows `GET /v1/desktop/status`, `/windows` and `/screenshot`. `control` additionally allows `POST /v1/desktop/control` (arm for 1–900 s) and `POST /v1/desktop/input`. Control is never armed after a start, expires on its own, and stops at once on the kill-switch hotkey, on the tray item **Besturing stoppen**, or on `{ "armed": false }`. While armed, a red bar shows on top of the main display and the tray dot turns red. Windows whose title or process matches `desktop.denyList` (password managers, Windows Security, credential prompts by default) are never captured or driven. Details and limits: [docs/desktop-control.md](../../docs/desktop-control.md).
