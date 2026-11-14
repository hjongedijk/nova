# Avatar rendering

NOVA's default shape is its original procedural orb on the website, wallpaper and helper. It renders locally and uses NOVA's existing voice playback and state palette. It does not use a separate avatar service.

The other shapes in the Gedaante selector ("Gestalte" and "Aura") also render locally in the browser.

## Aura: a real-time 3D figure

Aura is a sculpted feminine bust rendered in 3D in the browser (three.js). Her body and her long hair are one dark sculpt. Light lines lie on her surface, her hair is drawn by strands of light with loose strands moving round it, and her head truly turns. No picture or artwork is shown.

| File                                    | What it is                                                         |
| --------------------------------------- | ------------------------------------------------------------------ |
| `scripts/assets/aura-sculpt.glb`        | The source sculpt, decimated to about 180k triangles (positions)   |
| `apps/web/static/aura/aura-figure.glb`  | The mesh: glTF with `EXT_meshopt_compression`, about 65k triangles |
| `apps/web/static/aura/aura-figure.json` | Landmarks and a distance field of the figure                       |
| `apps/web/static/aura/aura-strands.bin` | The hair's strands: about 1,700 lines over the sculpted hair       |
| `apps/web/static/aura/aura-still.webp`  | A still of the 3D figure, for browsers without WebGL2              |

### Source and licence

- **Source:** our own sculpt. We made a picture of a clay sculpture of a woman's bust with FLUX.1 schnell, and turned that picture into a mesh with Hunyuan3D-2, both on our own machine. No third-party mesh, scan or artwork is part of it.
- **Licence:** the picture and the mesh are our own output. The Hunyuan3D-2 model itself is released under the **Tencent Hunyuan 3D 2.0 Community License**; that licence applies to the model and its use, and should be read before the model is used for anything new (it restricts some territories and uses). FLUX.1 schnell is released under Apache 2.0.
- **The still:** a rendering of our own figure.

### How it is built

`scripts/aura-figure.mjs` builds the mesh and the JSON. Run it as `capped 3G -- node scripts/aura-figure.mjs`. With the path of a raw sculpt as argument it first writes a new `scripts/assets/aura-sculpt.glb` from it.

1. **Size:** the sculpt is simplified to the runtime triangle count, scaled to metres and cut below the waist line (the torso and the arms end there and fade out in the shader).
2. **Hair and body:** skin is smooth, hair is ridged, and the sculpt has a crease where hair lies on skin. The body is grown from the middle of the chest over every edge that bends only a little; it stops at the hair. On the head, the face is the front below the hairline. Each vertex gets a hair weight.
3. **Faceless and abstract:** the face's distance from the middle of the head is smoothed until eyes, nose and lips are gone; skull, cheekbones, jaw and chin stay. The chest and belly are smoothed until no anatomical detail is left.
4. **Bust:** each breast is replaced by a round form (a ball set into the chest, with the join smoothed). `BUST.size` in the script is its radius and the one number to tune.
5. **Weights:** a head weight for the real rotation about the neck (hair near the head goes with it), a breath weight, an arm weight.
6. **Surface fields:** two fields are baked per vertex. Their isolines are the light lines on the body, drawn in the fragment shader at native resolution:
   - field A: a flow that springs from the base of the neck, fans along the collarbones, parts round each breast and runs down the belly;
   - field B: lines along the arms, down the neck and up the sides of the face.
7. **Hair strands:** a root-to-tip field is grown over the hair from the centre parting. Along its smoothed gradient, strands are traced over the hair's surface from evenly spread seeds, up to the parting and down to the tips. Each is resampled, smoothed and lifted a little off the surface.
8. **Distance field:** a signed distance field of the figure at 1 cm resolution, which the loose strands rest on.

The renderer (`apps/web/src/lib/entity/aura*.ts`) handles the rest:

- the weave of lines, with per-line brightness, thickness and colour, travelling pulses and star dust;
- the hair: the baked strands are drawn as thin ribbons of light on the dark, matte sculpted mass; both sway in the wind toward the tips and follow the head a little late, and loose strands (verlet guide strands, with thin strands drawn from them) move round them;
- the glowing silhouette.
