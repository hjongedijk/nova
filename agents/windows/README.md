# NOVA Windows agent

Lets NOVA open allow-listed programs (Notepad, Calculator, a browser URL, ...) on your Windows PC.

1. Copy this folder to the PC (for example `C:\JarvisAgent`).
2. In an **elevated** PowerShell: `powershell -ExecutionPolicy Bypass -File .\install.ps1 -JarvisHost 192.168.10.9`
3. Put the two printed lines (`WINDOWS_AGENT_URL`, `WINDOWS_AGENT_TOKEN`) in `/opt/jarvis/.env`, then `docker compose up -d jarvis-api`.

Security: bearer token, firewall and source-IP limited to the NOVA host, and only the programs in `agent.json` can start. Edit `apps` to add or remove programs, then restart the `JarvisAgent` scheduled task. Closing programs and locking the screen need your confirmation in NOVA.

## Living wallpaper (per display)

The agent can show NOVA as a living wallpaper behind the desktop icons, on one display or all of them, using Microsoft Edge (already part of Windows). Set it in NOVA under Instellingen, Meer, or say it: "zet NOVA als achtergrond op scherm 2". The normal wallpaper setting is never changed; choosing "Uit" shows it again.

- Endpoints: `GET /v1/displays` and `POST /v1/wallpaper` with `{ "display": 0|1|2…, "mode": "full"|"sphere"|"off" }` (0 = all displays).
- The NOVA address defaults to the machine that calls the agent, on port 8080 (`novaPort` in `agent.json` changes it). With `NOVA_PUBLIC_URL` set, that address is used.
- What is set is remembered in `wallpaper.json` and restored whenever the agent starts, so it comes back after a restart.
- Updating an existing install: replace `jarvis-agent.ps1` on the PC (NOVA offers the download) and restart the `JarvisAgent` scheduled task.
- The window is placed by recognising how Windows builds the desktop (older layout with a top-level WorkerW, or Windows 11 24H2 and later with a WorkerW inside Progman). If the layout is not recognised the agent refuses and closes the window, instead of leaving a window on top of the screen.
- Choosing "Uit" for a display always closes its wallpaper window, also when something went wrong.
- Sizes are real pixels per display (a 4K screen at 150% scaling is reported and covered as 3840 x 2160, not as the scaled 2560 x 1440).
- The agent runs without a visible window: started from the task, from a terminal or by double-click, it restarts itself hidden. Starting it again ends the older copy, so an update is just: replace the file and run the `JarvisAgent` task again.
- Input on the wallpaper: clicks on the sphere and on the input field area (with the quick buttons above it) are passed on to the wallpaper page, and typing starts after a click on the input field (Esc ends it). Everywhere else the desktop is Windows' own: selecting, dragging and dropping icons and the right-click menu are never touched. If that does not work on a PC, set `"wallpaperInput": "window"` in `agent.json`: a click on the sphere then opens a small NOVA window instead.
- Clicks and keys reach the wallpaper page through Edge's DevTools channel, bound to 127.0.0.1 on a port per display (9331, 9332, ...), so they arrive exactly and the page behaves as focused. Only programs on the PC itself can reach that port, and it only controls the isolated wallpaper profile. If the channel is not available, window messages are used as a fallback.
- Which clicks are passed on is decided by the page itself: it reports where its buttons, fields and open windows are (`window.__novaZones()`), and only clicks on those reach it. Everything in between stays the desktop's. Typing goes to the page after a click on a field or inside an open window.
