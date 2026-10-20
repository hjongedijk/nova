# Third-party avatar assets

NOVA's humanoid helper uses [TalkingHead](https://github.com/met4citizen/TalkingHead), by Mika Suominen, under the MIT license. Its copyright and license are included in the installed package.

`apps/web/static/avatars/nova-human.glb` is derived from TalkingHead's `avatars/mpfb.glb`, created with Blender and MPFB. The upstream README identifies this model as **CC0**. The model keeps its skeleton, ARKit expressions and Oculus visemes. NOVA keeps the skin, eye and hair textures, the rigged eyebrow and eyelash fibers, and a ponytail; removes clothing and unused assets; applies its own holographic material; and frames only the head and shoulders.

- Source: https://github.com/met4citizen/TalkingHead/blob/main/avatars/mpfb.glb
- License declaration: https://github.com/met4citizen/TalkingHead#readme (test app asset licenses)
- Source SHA256: `63c645a2a863b9972e9a9c2ed576a1de4c390b8475508e1473e69c87a3ee299c`
- Derived SHA256: `471f9c493120e479fd8a60f8fbb093f2fc6da3740a5fc1f49f642e478cee9409`
- Rebuild: `python3 scripts/prepare-nova-avatar.py mpfb.glb apps/web/static/avatars/nova-human.glb`

All avatar assets and code are served by NOVA. Displaying the avatar does not request a microphone, use a separate TTS voice, or send speech or model data to another service. The initial integration drives mouth opening from NOVA's existing voice level; it does not claim phoneme-accurate lip sync. TalkingHead's optional cloud speech services are not configured.

The portrait uses the live facial rig for its cyan filament overlay. The face itself is the energy field: surface light points and connections respond to the same NOVA audio level and status colors as the compact orb. No second orb is displayed. A transparent projection of light arcs and data points sits behind the head. Reduced-motion preferences disable moving scan bands and idle head drift. Hidden portraits stop rendering and release their GPU resources.
