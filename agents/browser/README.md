# NOVA browser agent

Lets NOVA use a real browser window on your Windows PC: "zoek me … op", open a site,
read what is on the page, click, type, scroll, go back and switch tabs. NOVA works step by
step: search, read the page, decide what to click, read again.

It drives Chrome (or Edge) in its own profile (`%USERPROFILE%\.jarvis-browser`), so it never
touches your normal browser's tabs or logins. You can log in to a site once in that window and
NOVA can then use it.

## Install

1. Copy this folder to the PC, for example `C:\JarvisBrowser`.
2. In an **elevated** PowerShell:
   `powershell -ExecutionPolicy Bypass -File .\install.ps1 -JarvisHost 192.168.10.9`
   (add `-Browser msedge` to use Edge). It installs Node.js when needed, creates `agent.json`
   with a random token, opens the firewall for the NOVA host only and starts the agent at logon.
3. Put the two printed lines (`BROWSER_AGENT_URL`, `BROWSER_AGENT_TOKEN`) in `/opt/jarvis/.env`,
   then `docker compose up -d jarvis-api`.

The PC must be on and you must be logged in: the browser runs in your desktop session. When it
is not, NOVA says so and falls back to searching the web himself.

## What stays out of the model's hands

- Every call needs the bearer token, and only the NOVA host may connect (`allowFrom`).
- Only `http` and `https` pages: no `file:`, `chrome:`, `javascript:` or `data:`.
- Password, PIN, card and IBAN fields are never typed into. You fill those in yourself.
- Buttons that buy, pay, order, donate, subscribe or delete are refused, unless NOVA asks you
  first and you confirm (a separate tool, `browser_click_confirmed`).
- At most 60 actions a minute. Page text is handed over as untrusted data.
- `blockedHosts` and `allowedHosts` in `agent.json` narrow where it may go.

## Try it by hand

```
node agent.mjs            # reads agent.json, or JARVIS_BROWSER_TOKEN
curl -H "Authorization: Bearer <token>" http://localhost:8766/v1/status
```

## Tests

`npm run test:agent` (from the NOVA repo root) runs the agent against a real headless Chromium,
including the full path through NOVA' own browser tools.
