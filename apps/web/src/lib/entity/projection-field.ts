import * as THREE from "three";

/** Reconstruct the reference artwork as colored splats with a shallow head volume. */
export function sampleProjection(
  pixels: Uint8ClampedArray,
  width: number,
  height: number,
) {
  let stride = Math.max(2, Math.ceil(Math.sqrt((width * height) / 720_000)));
  const countVisible = () => {
    let count = 0;
    for (let y = 0; y < height; y += stride)
      for (let x = 0; x < width; x += stride)
        if ((pixels[(y * width + x) * 4 + 3] ?? 0) >= 7) count++;
    return count;
  };
  while (countVisible() > 360_000) stride++;
  const positions: number[] = [],
    colors: number[] = [],
    signals: number[] = [];
  const color = new THREE.Color();
  for (let y = 0; y < height; y += stride) {
    for (let x = 0; x < width; x += stride) {
      const index = (y * width + x) * 4;
      const alpha = (pixels[index + 3] ?? 0) / 255;
      if (alpha < 0.025) continue;
      const u = x / width,
        v = y / height;
      const head = Math.exp(
        -Math.pow((u - 0.5) / 0.2, 4) - Math.pow((v - 0.36) / 0.3, 4),
      );
      const dome = Math.sqrt(Math.max(0, 1 - Math.pow((u - 0.5) / 0.2, 2)));
      positions.push(
        ((u - 0.5) * width) / height,
        0.5 - v,
        head * dome * 0.12 - (1 - head) * 0.035,
      );
      const red = (pixels[index] ?? 0) / 255;
      const green = (pixels[index + 1] ?? 0) / 255;
      const blue = (pixels[index + 2] ?? 0) / 255;
      color.setRGB(red, green, blue, THREE.SRGBColorSpace);
      colors.push(color.r, color.g, color.b);
      const warm = Math.max(0, red - blue) * head;
      signals.push(alpha, warm, ((x * 73 + y * 149) % 997) / 997);
    }
  }
  return {
    positions: new Float32Array(positions),
    colors: new Float32Array(colors),
    signals: new Float32Array(signals),
    stride,
  };
}

export async function loadProjection(url: string, cancelled: () => boolean) {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`NOVA projection: HTTP ${response.status}`);
  const bitmap = await createImageBitmap(await response.blob());
  try {
    if (cancelled()) return;
    const canvas = document.createElement("canvas");
    canvas.width = bitmap.width;
    canvas.height = bitmap.height;
    const context = canvas.getContext("2d", { willReadFrequently: true });
    if (!context)
      throw new Error("NOVA projection: image sampling unavailable");
    context.drawImage(bitmap, 0, 0);
    const field = sampleProjection(
      context.getImageData(0, 0, canvas.width, canvas.height).data,
      canvas.width,
      canvas.height,
    );
    return { ...field, sourceHeight: canvas.height };
  } finally {
    bitmap.close();
  }
}
