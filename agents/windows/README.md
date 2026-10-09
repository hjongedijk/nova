# NOVA Windows agent

A small PowerShell service that runs in your desktop session on a Windows PC. It lets NOVA open allow-listed programs, show NOVA as living wallpaper per display or as a small helper overlay, and use a browser of its own.

Quick install, in an elevated PowerShell in this folder:

```powershell
powershell -ExecutionPolicy Bypass -File .\install.ps1 -JarvisHost <nova-host-ip>
```

Then put the two printed lines (`WINDOWS_AGENT_URL`, `WINDOWS_AGENT_TOKEN`) in the `.env` of your NOVA install and recreate the container.

Everything else (configuration, modes, browser endpoints, security, limits) is in [docs/windows-agent.md](../../docs/windows-agent.md).

Files: `jarvis-agent.ps1` (the agent), `install.ps1` (installer), `agent.example.json` (configuration template), `test/check.ps1` (syntax and C# check, also run in CI).

## Rectangular helper

The helper uses Edge fullscreen kiosk mode, without rounded window regions. Views are compact (360×44), overview/notifications/weather/lists (640×180), chat (640×340) and confirmation (640×170), in CSS pixels. Native view/display/hotkeys persist in `mode.json`; NOVA stores appearance and sound settings. Autohide keeps a 3 CSS-pixel top strip. The tray and global shortcuts can reopen a closed helper. Default shortcuts: Ctrl+Alt+N (open), Ctrl+Alt+Space (speak), Ctrl+Alt+M (mute), Ctrl+Alt+D (desktop).

Configure the helper with its gear. Native shortcut conflicts are reported. Pausing suppresses helper speech/listening and native notifications. Calendar and conversational mood features depend on later phases. Browser SpeechRecognition uses the Windows default microphone; output selection requires browser sink support.

See [the full helper reference](../../docs/windows-agent.md#the-rectangular-helper) and [design/screenshots](../../docs/helper-design.md). Docker checks cover parsing, C# compilation, Win32 message layouts, geometry/DPI, saved preferences and shortcut validation. Actual kiosk bounds, hotkeys, tray, device audio and closed-window recovery require a Windows desktop test.
