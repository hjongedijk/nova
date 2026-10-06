# NOVA Windows agent

A small PowerShell service that runs in your desktop session on a Windows PC. It lets NOVA open allow-listed programs, show NOVA as living wallpaper per display or as a small helper overlay, and use a browser of its own.

Quick install, in an elevated PowerShell in this folder:

```powershell
powershell -ExecutionPolicy Bypass -File .\install.ps1 -JarvisHost <nova-host-ip>
```

Then put the two printed lines (`WINDOWS_AGENT_URL`, `WINDOWS_AGENT_TOKEN`) in the `.env` of your NOVA install and recreate the container.

Everything else (configuration, modes, browser endpoints, security, limits) is in [docs/windows-agent.md](../../docs/windows-agent.md).

Files: `jarvis-agent.ps1` (the agent), `install.ps1` (installer), `agent.example.json` (configuration template), `test/check.ps1` (syntax and C# check, also run in CI).
