# Slicing

NOVA does not ship a slicer. `slice_3d_model` runs the command in `NOVA_SLICER_COMMAND`, a JSON array without a shell,
with placeholders `{input} {output} {outdir} {profile} {material} {nozzle} {layer} {infill} {walls} {supports}`.
`NOVA_SLICER_PRINTER_PROFILE` must name the P2S, for example `Bambu Lab P2S 0.4 nozzle`; any other profile is refused.

Bambu Studio's CLI flags differ per version and this was not verified here, so whoever installs the slicer sets the exact
line and checks one slice by hand. The result must be a `.gcode.3mf` or `.gcode`; time and filament estimates come from G-code header
comments and are shown as "onbekend" when absent. The slicer must run on the machine where the API runs and finish within the 60 s tool limit.
