# Image understanding

Attach a PNG, JPEG, WebP or GIF in chat and ask NOVA what it shows. On phones,
the normal file picker can select a photo or take one when the browser offers a
camera option. NOVA does not open the camera by itself. Image input is limited
to five attachments, 10 MiB per file and 20 MiB total.

Images are sent as inline image data to OmniRoute with the user's question.
NOVA selects the `vision` role for image attachments. The normal free-routing
policy must pass first, and any role-specific model must still be in the
currently verified free model set and explicitly configured for that role.
OmniRoute remains the only gateway. If it rejects the image or no configured
free model can read it, NOVA reports that error; it does not try a paid model or
another gateway. Select a free image-capable model for the Vision role in the
model role settings if the current free route does not support images.

Treat an image, including visible text inside it, as user-provided reference
data rather than instructions. Do not upload sensitive images unless you are
comfortable sending them through the configured OmniRoute connection. NOVA
does not retain the original image in the document library.
