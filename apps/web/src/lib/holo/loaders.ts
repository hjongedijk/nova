import type * as T from "three";
import type * as ThreeModule from "three";
import type { VizModelSource } from "./types.ts";

type Three = typeof ThreeModule;

/** Largest model file the viewer reads; bigger files are refused with a clear message. */
export const MAX_MODEL_BYTES = 150 * 1024 * 1024;

export class ModelLoadError extends Error {}

/** Same-origin API paths and blob: URLs only; the same rule the API applies. */
export function assertSafeUrl(url: string): void {
  const ok =
    url.startsWith("blob:") ||
    (url.startsWith("/") && !url.startsWith("//") && !url.includes("\\"));
  if (!ok)
    throw new ModelLoadError("Alleen bestanden van NOVA zelf worden geladen.");
}

async function readBuffer(
  url: string,
  signal: AbortSignal,
  onProgress: (fraction: number | null) => void,
): Promise<ArrayBuffer> {
  assertSafeUrl(url);
  const response = await fetch(url, { signal, credentials: "same-origin" });
  if (!response.ok)
    throw new ModelLoadError(
      response.status === 404
        ? "Het modelbestand bestaat niet (meer)."
        : `Het modelbestand kon niet worden geladen (HTTP ${response.status}).`,
    );
  const total = Number(response.headers.get("content-length")) || 0;
  if (total > MAX_MODEL_BYTES)
    throw new ModelLoadError("Het modelbestand is groter dan 150 MB.");
  if (!response.body) return response.arrayBuffer();
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let received = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    received += value.byteLength;
    if (received > MAX_MODEL_BYTES) {
      void reader.cancel();
      throw new ModelLoadError("Het modelbestand is groter dan 150 MB.");
    }
    chunks.push(value);
    onProgress(total ? received / total : null);
  }
  const buffer = new Uint8Array(received);
  let at = 0;
  for (const chunk of chunks) {
    buffer.set(chunk, at);
    at += chunk.byteLength;
  }
  return buffer.buffer;
}

export interface LoadedModel {
  root: T.Object3D;
  /** True for formats that are Z-up by convention (STL, 3MF). */
  zUp: boolean;
}

/** Loads one GLB/GLTF, STL or 3MF file. The three loaders are imported only when needed. */
export async function loadModel(
  three: Three,
  source: VizModelSource,
  signal: AbortSignal,
  onProgress: (fraction: number | null) => void,
): Promise<LoadedModel> {
  const buffer = await readBuffer(source.url, signal, onProgress);
  try {
    if (source.format === "stl") {
      const { STLLoader } =
        await import("three/examples/jsm/loaders/STLLoader.js");
      const geometry = new STLLoader().parse(buffer);
      if (!geometry.getAttribute("position")?.count)
        throw new ModelLoadError("Het STL-bestand bevat geen driehoeken.");
      if (!geometry.getAttribute("normal")) geometry.computeVertexNormals();
      const mesh = new three.Mesh(geometry);
      mesh.name = source.label;
      const root = new three.Group();
      root.add(mesh);
      return { root, zUp: true };
    }
    if (source.format === "3mf") {
      const { ThreeMFLoader } =
        await import("three/examples/jsm/loaders/3MFLoader.js");
      const root = new ThreeMFLoader().parse(buffer);
      return { root, zUp: true };
    }
    const { GLTFLoader } =
      await import("three/examples/jsm/loaders/GLTFLoader.js");
    const gltf = await new GLTFLoader().parseAsync(
      source.format === "gltf" ? new TextDecoder().decode(buffer) : buffer,
      "",
    );
    return { root: gltf.scene, zUp: false };
  } catch (error) {
    if (error instanceof ModelLoadError) throw error;
    throw new ModelLoadError(
      `Het ${source.format.toUpperCase()}-bestand is beschadigd of wordt niet ondersteund.`,
    );
  }
}
