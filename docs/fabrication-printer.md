# Bambu Lab P2S

**Status: not linked.** The default `PrinterPort` answers "no printer linked". `NOVA_PRINTER_DRIVER=simulated` selects a
deterministic simulator for development.

## What a real driver needs

- P2S in **LAN Only** and **Developer Mode** (third-party clients cannot start prints otherwise; telemetry may work with LAN Only alone).
- The printer's IP, serial and access code, kept as secrets (never in tool arguments, chat or git).
- NOVA's network must reach the printer (MQTT over TLS on 8883, FTPS for uploads). The production MCP sandbox has no LAN egress; a reviewed, narrow rule is needed.
- A driver maps the printer's reports to `PrinterStatus` and throws `PrinterRefused` (nothing started) or `PrinterUncertain` (may have started).

The vetted candidate is `akashnaren/bambu-mcp` (see [fabrication-mcp-vetting.md](fabrication-mcp-vetting.md)). Do not enable it unattended: the first real print needs you at the printer.
