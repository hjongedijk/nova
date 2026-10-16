# 3D design and printing (fabrication)

NOVA can search 3D repositories, design parametric parts in a sandbox, validate them, preview them in the holographic
viewer, slice for the Bambu Lab P2S and print after explicit approval. Code: `apps/api/src/fabrication/`. Everything
physical sits behind a printer port and an approval gate.

## What works today

| Capability                                                                                                         | Status                                                                                                                                             |
| ------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| Parametric CAD (wall bracket, plate, enclosure, headset stand) via OpenSCAD in the sandbox                         | **Operational.** Real renders compared with the promised size and checked watertight (12 tests).                                                   |
| Custom OpenSCAD code (no include/use/import/surface)                                                               | **Operational** in the same sandbox.                                                                                                               |
| Revisions, undo/redo, editable source, restart-safe library                                                        | **Operational.**                                                                                                                                   |
| Geometry validation (build volume, watertight, non-manifold, degenerate, bed contact, overhang) and bounded repair | **Operational.** It is a geometry check, not a guarantee of strength or safety.                                                                    |
| Holographic preview (STL, real geometry only)                                                                      | **Operational** through `load_holographic_preview`.                                                                                                |
| Print-job state machine with approval, idempotency, uncertain-outcome handling, restart recovery                   | **Operational** against the simulated printer.                                                                                                     |
| Repository search                                                                                                  | **Partial.** Thingiverse (official API, needs your `THINGIVERSE_TOKEN`). Printables and MakerWorld: **blocked**, no documented public API.         |
| Slicing                                                                                                            | **Partial.** The port and profile guard exist; no slicer ships. Needs `NOVA_SLICER_COMMAND`, see [fabrication-slicing.md](fabrication-slicing.md). |
| Real Bambu P2S                                                                                                     | **Blocked** on hardware. The default driver reports "no printer linked". See [fabrication-printer.md](fabrication-printer.md).                     |
| Blender, FreeCAD, Fusion engines                                                                                   | **Not integrated**; vetted in [fabrication-mcp-vetting.md](fabrication-mcp-vetting.md).                                                            |
| 3MF/STEP import, 3D workspace page                                                                                 | **Open.**                                                                                                                                          |

## Flow

search → (download | generate) → validate → preview → modify → slice → prepare (readiness) → approve → submit → monitor → history.
Searching, generating, modifying, validating and slicing run without asking. Starting a print needs two explicit steps:
`approve_print_job` (CONFIRM, never a standing approval) and `submit_print_job` (DANGEROUS, a fresh screen confirmation).
Pause/resume need a confirmation, cancel a fresh one.

## Safety rules enforced in code

- A job is submitted at most once: the state is saved as `submitting` before anything is sent. A start with an unknown
  outcome, or a restart in that moment, makes the job `unknown`; it is never retried. `monitor_print_job` resolves it only
  when the printer shows this job (`nova-<jobId>`).
- The approval is bound to the model hash, slice hash, printer, material and nozzle; a changed slice invalidates it.
- Only one active job at a time. Readiness checks nozzle, loaded material, printer state and errors, and lists what cannot
  be verified remotely (clean plate, free bed).
- The slicer profile must name the P2S; no other printer's profile is substituted. Materials and nozzles are limited to the P2S set.
- Downloaded files are only parsed as meshes (STL), never executed; licence and creator are stored. Redirects stay on allow-listed hosts.
- CAD runs in a one-shot container (`deploy/fabrication/Dockerfile`, started by stack-control `/cad/render`): no network,
  read-only root, no capabilities, 768 MB, 64 pids, 60 s, 96 MB tmpfs. Custom OpenSCAD cannot read files.
- The simulated printer is only used with `NOVA_PRINTER_DRIVER=simulated`; results say when data is simulated.

## Setup

1. `docker build -t nova-cad:openscad deploy/fabrication` on the Docker host that runs stack-control (production: not done yet).
2. Optional: `THINGIVERSE_TOKEN`, `NOVA_SLICER_COMMAND`, `NOVA_SLICER_PRINTER_PROFILE`, `NOVA_PRINTER_BUILD_VOLUME` (default 256x256x256).
3. Tests: `npm -w apps/api test -- test/fabrication` (47 tests); `NOVA_TEST_DOCKER_CAD=1` adds the real OpenSCAD renders; `npm run test:mcp-sandbox` covers the CAD sandbox.

## Extending

- **Another CAD engine:** implement `CadWorkerPort` (`render(source) → STL`) and add a template or an `engine` branch in `FabricationService.generate`.
- **Another printer:** implement `PrinterPort` (`status/start/pause/resume/cancel`, throwing `PrinterRefused` or `PrinterUncertain`) and select it in `PrinterProvider`.
- **Another repository:** implement `DiscoveryProvider` and add it to `DISCOVERY_PROVIDERS`; official APIs only.

## Limits

A tool call lasts at most 60 s, so a slow slice is cancelled. Estimates are only shown when the slicer reports them. A geometry check cannot see thin walls or material behaviour.
