# Settings workspace

The settings workspace keeps NOVA's navy palette and Sora type. Everyday preferences and service administration have separate navigation groups. Stable section URLs and search continue to reach every editor; mobile adds a native grouped section selector and bounds navigation height so the editor stays reachable.

Palette: background `#081421`, control surface `#112338`, text `#e8f0f8`, secondary text `#a3b7cc`, border `#2c4258`, action accent `#91d7f7`. Status colors distinguish success (`#85d7bb`), pending restart (`#f3cf88`) and failed checks (`#ffa083`). Status labels describe verified checks rather than assuming that stored configuration means a working connection.

The settings page retains existing state, PIN expiry, admin headers, secret replacement, confirmations and save handlers. Buttons keep a 44-pixel minimum target; keyboard focus and reduced motion remain supported. Empty notifications are hidden. Node-RED's existing flow editor now also appears in Automatisering, replacing an obsolete placeholder.

MCP en services provides a direct route to existing stack and MCP status. MCP status loads on opening the section, while activity and history remain explicit read-only requests. The worker table separates Docker process state, worker count and MCP connection. Duplicate workers receive a visible warning; the Git worker is explicitly on demand. Older responses without worker inventory still show MCP server status. YouTube subtitle UI and its frontend OAuth API helpers have been removed.

Verification: `scripts/check-settings.mjs` uses mocked endpoints to verify navigation, responsive overflow, saving, PIN expiry, secret clearing, confirmations and rollback at desktop 1×/2× and mobile. Screenshots in `docs/img/settings-*.png` are synthetic fixture data. No provider credentials or live settings are changed by that browser gate.
