# Avatar artwork and rendering

`apps/web/static/avatars/nova-projection.png` is generated reconstruction artwork based on the visual reference supplied by the user: the cyan contour humanoid with orange facial energy shown in [this reel](https://www.instagram.com/reel/Dd95nEZig-V/), credited to A.P.E.X Intelligence and Reznikov Engineering. Imagegen produced a clean transparent source artwork from the reference cover, preserving the requested faceless silhouette, horizontal filaments, neck conduits and shoulder field.

This is a reconstructed visual, not the original APEX source package. No code or assets from the paid source kit are bundled. Reference information: [Reznikov Engineering](https://reznikov-engineering.com/apex/humanoid).

- Artwork SHA256: `cd34ec381fbae0e8b87cf9eefb1d5850d0644478443278868f111d67a85a8edd`
- Served attribution: `/credits/nova-avatar.txt`
- The complete source PNG is checked in; rebuilding does not call an image service.

NOVA maps the artwork onto a continuous, shallow surface with mipmap and anisotropic filtering to keep its fine contours stable during turns. Its front-facing silhouette and cyan/gold palette come from the image. A shallow inferred depth supports head turns around the neck, nods and pointer tracking. Source crop edges dissolve into a viewport-wide procedural filament field. Shoulder breathing, head gestures, small contour displacements and facial energy respond to the existing speech player and NOVA state. The depiction is deliberately faceless; it does not use a human skin mesh, eyes or a skeletal mouth animation. Speech energy is not phoneme lip sync.

All assets are served by NOVA. Displaying the portrait does not request a microphone or use a separate voice or external avatar service. The same face/orb selection applies to website, mobile, wallpaper and helper. Reduced-motion preferences stop autonomous movement and pointer parallax. Hidden portraits release geometry, GPU resources, observers and event listeners. The previous GLB avatar, TalkingHead dependency and its preparation tools are no longer shipped.
