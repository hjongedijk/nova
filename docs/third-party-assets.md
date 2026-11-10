# Avatar rendering

NOVA's default shape is its original procedural orb on the website, wallpaper and helper. It renders locally and uses NOVA's existing voice playback and state palette. It does not use a separate avatar service.

The other shapes in the Gedaante selector ("Gestalte" and "Aura") also render locally in the browser. Only Aura uses an image asset.

## Aura artwork

| File                                  | What it is                                      | Size         |
| ------------------------------------- | ----------------------------------------------- | ------------ |
| `apps/web/static/aura/aura-2560.webp` | The artwork for desktop (2560x1440, WebP q90)   | about 190 KB |
| `apps/web/static/aura/aura-1280.webp` | The same for the low tier and phones (1280x720) | about 75 KB  |
| `apps/web/static/aura/aura-data.png`  | A data atlas built from it (see below)          | about 300 KB |

- **Origin:** generated with **FLUX.1 schnell** on the owner's own PC. The owner approved it as Aura's figure.
- **Licence:** FLUX.1 schnell is released under **Apache-2.0**. Its outputs carry no extra restriction, so the artwork is ours to ship.
- **Content:** a front-facing feminine bust with a glossy near-black violet body and a blank, smooth head with no face. She has long glowing violet hair of light strands. Behind her are glowing ribbons, and a cyan neon line runs across her chest.
- **Source file:** the 3840x2160 original (`aura-base-4k.png`) is kept outside the repository, with the owner's previews.

`scripts/aura-assets.mjs` builds all three files from the original: `capped 2G -- node scripts/aura-assets.mjs path/to/aura-base-4k.png`. The WebP files come from the browser's own encoder, because the host has no native image tools.

The data atlas has three 960x540 RGB tiles stacked vertically. Every value in it is derived from the artwork itself:

1. **Masks:**
   - the form: the head plus the body;
   - the head: the dark blank face, flood-filled from its centre and bounded by the hair;
   - "bright": what the artwork already lights, which is the hair, the ribbons and the cyan line.
2. **Stripe coordinate, height and figure:**
   - the stripe coordinate is stored as an offset in 16 bits: the high byte here, the low byte in tile 3;
   - the height is the silhouette inflated into a rounded form, the solution of a Poisson equation;
   - the figure mask marks what the particles build at birth.
3. **Normal x, normal y,** and the low byte of the stripe offset.

The renderer (`apps/web/src/lib/entity/aura*.ts`) shows the picture as it is. It adds neon stripes over the head and body that follow that rounded form. It also samples the picture into particles for the birth. The face is never given features.
