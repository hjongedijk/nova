# NOVA for Windows v0.1.5

NOVA for Windows now feels like an application instead of a web page in a window.

- **A real app window.** A normal Windows window with a taskbar entry, Alt+Tab, snap layouts and a dark title bar. It paints NOVA's background before the page loads (no white flash), appears only when ready, and remembers its size, position and maximized state; a position on an unplugged monitor is pulled back on screen. Pages: Overzicht, Weergave, Koppelen, Systeem en updates (Ctrl+1 to Ctrl+4).
- **No browser leftovers.** No reload, print, find, zoom, pinch, swipe, status bar or developer tools, and no browser right-click menu in the app window and wallpaper. Copy and paste still work in the helper chat.
- **A small tray menu.** NOVA openen (also left click), Helper tonen/verbergen, Pauzeren (noodstop) / Hervatten, an update item only when one is ready, and Afsluiten. Screen choice, display mode, wallpaper per screen, start with Windows, setup and update checks moved into the app window.
- **Offline state.** When the NOVA server is unreachable, the helper and wallpaper show "NOVA is niet bereikbaar" and reload by themselves once it is back.
- **Self-recovery.** Starting NOVA again brings the running window forward without a second UAC prompt. After an Explorer restart the helper and wallpaper come back within about five seconds. A busy agent port and a failed first update check retry by themselves.
- **Desktop control fixes.** Arrow, Delete and Windows keys are sent as real extended keys (Shift+Arrow selects), typed line breaks and tabs become Enter and Tab, focusing a window keeps maximized windows maximized, more keys are supported (volume, media, F13 to F24), and process lists are much faster.

Validation: nova-win-core and nova-win-agent tests, clippy for the Windows target with warnings as errors, rustfmt, and API tests for the Windows and desktop contract. Not yet run on a physical Windows PC.
