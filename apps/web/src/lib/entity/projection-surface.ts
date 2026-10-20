import * as THREE from "three";

/** Keep the artwork continuous as it turns; independent splats alias its fine contours. */
export async function loadProjectionSurface(
  url: string,
  cancelled: () => boolean,
) {
  const texture = await new THREE.TextureLoader().loadAsync(url);
  if (cancelled()) {
    texture.dispose();
    return;
  }
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.minFilter = THREE.LinearMipmapLinearFilter;
  texture.magFilter = THREE.LinearFilter;
  texture.generateMipmaps = true;
  const image = texture.image as HTMLImageElement;
  const geometry = new THREE.PlaneGeometry(
    image.width / image.height,
    1,
    128,
    128,
  );
  const positions = geometry.getAttribute("position");
  for (let index = 0; index < positions.count; index++) {
    const x = positions.getX(index);
    const y = positions.getY(index);
    const head = Math.exp(
      -Math.pow(x / 0.2, 4) - Math.pow((0.14 - y) / 0.3, 4),
    );
    const dome = Math.sqrt(Math.max(0, 1 - Math.pow(x / 0.2, 2)));
    positions.setZ(index, head * dome * 0.1 - (1 - head) * 0.035);
  }
  positions.needsUpdate = true;
  return { texture, geometry };
}
