# Slicing

NOVA does not ship a slicer. Slicing runs on your **Windows PC** through the agent: `slice_3d_model` sends the validated STL and the
settings to `POST /v1/fab/slice`, and the agent starts the slicer named in its own `agent.json`:

```json
"fabrication": {
  "enabled": true,
  "openscad": "C:\\Program Files\\OpenSCAD\\openscad.exe",
  "slicer": {
    "path": "C:\\Program Files\\Bambu Studio\\bambu-studio.exe",
    "profile": "Bambu Lab P2S 0.4 nozzle",
    "timeoutSeconds": 120,
    "args": ["<your verified Bambu Studio CLI arguments>", "{input}", "{output}"]
  }
}
```

Placeholders in `args`: `{input} {output} {outdir} {profile} {material} {nozzle} {layer} {infill} {walls} {supports}`. An unknown placeholder
stops the run. Values are validated (materials of the P2S set, numeric ranges) and arguments are quoted, never passed through a shell.
`profile` must contain `P2S`; the request can only confirm it, not choose another printer's profile.

Bambu Studio's CLI flags differ per version and were **not** verified here: run one slice by hand, then put the exact arguments in `args`.
The result must be a `.gcode.3mf` (or `.gcode`); time and filament estimates are read from the G-code header and shown as "onbekend" when absent.
A slice must finish within 120 s (the agent handles one task at a time). A server-side fallback exists (`NOVA_SLICER_COMMAND` JSON array +
`NOVA_SLICER_PRINTER_PROFILE`) for a slicer installed next to the API.
