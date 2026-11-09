# NOVA for Windows v0.1.6

- **Clickable wallpaper.** Clicks on NOVA's controls go only to the wallpaper page, so Explorer no longer steals focus; clicks on empty desktop and icons behave normally. The page reports its interactive areas, which the app maps to screen pixels (DPI, zoom and monitors left of or above the primary display included). Text fields on the wallpaper accept typing, including accent keys, AltGr, Backspace, Enter and Ctrl+A/C/V/X/Z/Y; Esc, Alt and Windows keys stay with Windows. Hover, scroll and drag work, and the hooks reinstall themselves if Windows drops them.
- **Browser search.** A robot check on Google (also its `/sorry/` page and Dutch captcha text) falls back to DuckDuckGo, and DuckDuckGo to Bing.

Use with NOVA v0.2.0. Validation: nova-win-core and nova-win-agent tests and clippy for the Windows target; not yet run on a physical Windows PC.
