# Avatar rendering

NOVA's default shape is its original procedural orb on the website, wallpaper and helper. It renders locally and uses NOVA's existing voice playback and state palette. It does not use a separate avatar service.

The other shapes in the Gedaante selector ("Gestalte" and "Aura") also render locally in the browser. Only Aura uses an image asset.

## Aura artwork

| File                                  | What it is                                      | Size         |
| ------------------------------------- | ----------------------------------------------- | ------------ |
| `apps/web/static/aura/aura-2560.webp` | The artwork for desktop (2560x1440, WebP q90)   | about 270 KB |
| `apps/web/static/aura/aura-1280.webp` | The same for the low tier and phones (1280x720) | about 110 KB |
| `apps/web/static/aura/aura-data.png`  | A data atlas built from it (see below)          | about 330 KB |
| `apps/web/static/aura/aura-lines.png` | The light lines drawn over the figure           | about 900 KB |

- **Origin:** generated with **FLUX.1 schnell** on the owner's own PC. The owner approved it as Aura's figure ("ja b5-7").
- **Licence:** FLUX.1 schnell is released under **Apache-2.0**. Its outputs carry no extra restriction, so the artwork is ours to ship.
- **Content:** a front-facing feminine bust with a short natural neck and a dark indigo body outlined by a thin rim of light. The head is blank and smooth, with no face. She has full, flowing hair of violet light strands, and violet ribbons drift behind her.
- **Source file:** the 3840x2160 original (`aura-base5-4k.png`) is kept outside the repository, with the owner's previews.
- **Style reference:** the look of the light lines was matched by eye to a commercial reference (MIRA). That reference is never used as a texture, sampled or traced; the lines, their paths and the figure are our own.

`scripts/aura-assets.mjs` builds all four files from the original: `capped 2G -- node scripts/aura-assets.mjs path/to/aura-base5-4k.png`. The WebP files come from the browser's own encoder, because the host has no native image tools.

The data atlas has three 960x540 RGB tiles stacked vertically. Every value in it is derived from the artwork itself:

1. **Masks:**
   - the form: the head plus the body (neck, torso, arms), flood-filled over the dark skin and bounded by its rim lines;
   - the head: the dark blank face, bounded by its rim and the hair;
   - "bright": what the artwork already lights, which is the hair, the rims and the ribbons.
2. **Hair weight, height and figure:**
   - the hair weight: 0 at the scalp (roots, parting, crown), rising toward the tips; the wind and the hair's lag behind the head scale with it, so the roots never move;
   - the height is the silhouette inflated into a rounded form (the solution of a Poisson equation), with round breasts added;
   - the figure mask marks what the particles build at birth.
3. **Normal x and normal y** of that rounded form, and the position across each arm (for the sheen down its length and the dark gap between arm and torso).

The lines raster has four 1920x1080 RGBA layers in a 2x2 sheet. Each layer holds some of the light lines: per pixel, the distance to its nearest line, the place along that line, and the line's weight and flags (warm, on the face). Lines that cross or run close lie in different layers. The alpha holds the soft halo of all lines summed, so it never cuts off. A tEXt chunk records the counts.

The lines are about 100 Catmull-Rom curves of our own composition, generated per side with their own random draw: fine strands down the neck, one smooth deltoid curve over each shoulder, a few quiet lines along each arm with a rim on both edges, long sweeps from the collarbones and shoulders down over and around each breast with fine companion strands, open contour arcs at different radii (the undersides brightest, some warm), bundles that gather at the sternum and part toward the ribs, and a few strands from the parting down into the long hair. The face has about nine faint lines that follow the head's form (temples over the cheeks to the jaw, along the jaw into the neck, one arc under the hairline). None of them forms a feature or runs down the centre.

The renderer (`apps/web/src/lib/entity/aura*.ts`) grades the picture deep violet and draws those lines as neon light over it. It also samples the picture into particles for the birth. The face is never given features.
