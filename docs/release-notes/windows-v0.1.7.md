# NOVA for Windows v0.1.7

- **No UAC prompt at sign-in.** Startup entries now carry `--hide`. A logon start runs the approved elevated task when it is valid. If the task is missing or stale, for example after the executable moved, NOVA starts unelevated instead of asking for UAC, and `nova.log` says which check failed. Starting NOVA once by hand, with one UAC approval, registers the task again. An outdated Run entry is updated automatically, with no admin rights needed.
- **Starts minimized.** A logon start stays in the tray: no helper and no app window, even while the agent port is still busy right after sign-in (the agent retries by itself). A start by hand that goes through the elevated task still opens normally.
- **Wallpaper click diagnostics.** The first presses after start are logged with the routing decision: wallpaper hit, over desktop, known zones, forwarded or swallowed. No page content is logged. This is to trace PCs where wallpaper clicks still do nothing.

Use with NOVA v0.2.4. Validation: nova-win-core tests (125) and clippy for the Windows target; not yet run on a physical Windows PC.
