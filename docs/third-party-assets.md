# Avatar rendering

NOVA's default shape is its original procedural orb on the website, wallpaper and helper. It renders locally and uses NOVA's existing voice playback and state palette. It does not use a separate avatar service.

The other shapes in the Gedaante selector ("Gestalte" and "Aura") also render locally in the browser.

## Aura: a real-time 3D figure

Aura is a sculpted feminine bust rendered in 3D in the browser (three.js). Her body is dark, glossy violet glass. Light lines lie on her surface, and her hair is made of thousands of light strands moved by a small physics simulation. Her head truly turns. No picture or artwork is shown.

| File                                    | What it is                                                         |
| --------------------------------------- | ------------------------------------------------------------------ |
| `apps/web/static/aura/aura-figure.glb`  | The mesh: glTF with `EXT_meshopt_compression`, about 42k triangles |
| `apps/web/static/aura/aura-figure.json` | Landmarks, the light lines on the surface, and a distance field    |
| `apps/web/static/aura/aura-still.webp`  | A still of the 3D figure, for browsers without WebGL2              |

### Source and licence

- **Source:** the MakeHuman base mesh (`makehuman/data/3dobjs/base.obj`) and four of its targets, from the `makehumancommunity/makehuman` repository:
  - `macrodetails/caucasian-female-young.target`;
  - `macrodetails/universal-female-young-averagemuscle-minweight.target`;
  - `breast/female-young-averagemuscle-averageweight-maxcup-averagefirmness.target`;
  - `breast/female-young-averagemuscle-averageweight-averagecup-maxfirmness.target`.
- **Licence:** the MakeHuman assets (the base mesh, proxies, targets and modifiers) are released under **CC0 1.0 Universal**. This is stated in the repository's `LICENSE.md` (section C) and `LICENSE.ASSETS.md`, and each target file repeats it ("This asset was explicitly released as CC0 in september 2020"). MakeHuman also states that it claims nothing over output made from these assets.
- **The still:** a rendering of our own figure.

### How it is built

`scripts/aura-figure.mjs` builds the mesh and the JSON from those files. Run it as `capped 2G -- node scripts/aura-figure.mjs <folder with base.obj and the targets>`.

1. **Shape:** the targets make a young adult woman, slim, with a full bust; a sculpted offset makes the bust round. The arms are lowered from the A pose, and the shoulders are a little narrower.
2. **Faceless head:** her real head shape is kept (skull, forehead, cheekbones, jaw, chin, neck). A smooth radial surface is fitted to it with low-order polynomials. Nose, lips and ears stick out of that fit and are trimmed away; eye sockets and the mouth lie inside it and are bridged. Folded faces are removed, their holes filled, and the head smoothed (Taubin). What remains is a soft, blank face plane.
3. **Cut:** the figure is cut at the waist and at the elbows.
4. **Subdivision and weights:** one Catmull-Clark step smooths the surface. Each vertex gets a head weight, for the real rotation about the neck, and a breath weight.
5. **Surface fields:** two fields are baked per vertex. Their isolines are the light lines, drawn in the fragment shader at native resolution:
   - field A: the distance over the surface from the front midline, merged with the distance from each breast's apex (lines beside the midline, rings round each breast, long arcs round the bust);
   - field B: the angle round each upper arm (lines along the arm).
6. **Accent lines:** a few hand-laid curves (the collarbones) are laid on the surface and drawn as ribbons.
7. **Distance field:** a signed distance field of the body at 1 cm resolution, which the hair rests on.

The renderer (`apps/web/src/lib/entity/aura*.ts`) handles the rest:

- the weave of lines, with per-line brightness, thickness and colour, travelling pulses and star dust;
- the hair, grown from the scalp with a centre parting and simulated as verlet guide strands, with thousands of thin strands drawn from those guides;
- the glowing silhouette.
