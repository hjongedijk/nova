import { buildAssets, transferables } from "./gestalte-build.ts";

type WorkerScope = {
  onmessage: (() => void) | null;
  postMessage(message: unknown, transfer: Transferable[]): void;
};

/** Builds the figure's geometry off the main thread, so chat stays responsive while the figure is born. */
const scope = self as unknown as WorkerScope;
scope.onmessage = () => {
  const assets = buildAssets();
  scope.postMessage(assets, transferables(assets));
};
