import {
  loadPixels,
  particleTransferables,
  sampleParticles,
} from "./aura-particles.ts";

type WorkerScope = {
  onmessage:
    | ((
        e: MessageEvent<{ image: string; data: string; count: number }>,
      ) => void)
    | null;
  postMessage(message: unknown, transfer?: Transferable[]): void;
};

/** Samples the artwork into particles off the main thread, so chat stays responsive while the figure loads. */
const scope = self as unknown as WorkerScope;
scope.onmessage = (e) => {
  const { image, data, count } = e.data;
  Promise.all([loadPixels(image), loadPixels(data)])
    .then(([img, atlas]) => {
      const p = sampleParticles(img, atlas, count);
      scope.postMessage(p, particleTransferables(p));
    })
    .catch((err: unknown) => scope.postMessage({ error: String(err) }));
};
