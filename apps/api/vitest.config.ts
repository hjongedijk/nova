import swc from "unplugin-swc";
import { defineConfig } from "vitest/config";

// SWC keeps Nest's decorator metadata, which the default esbuild transform drops.
export default defineConfig({
  test: {
    include: ["test/**/*.test.ts", "src/**/*.test.ts"],
    environment: "node",
    setupFiles: ["test/setup.ts"],
  },
  plugins: [swc.vite({ module: { type: "es6" } })],
});
