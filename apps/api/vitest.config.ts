import swc from "unplugin-swc";
import { defineConfig } from "vitest/config";

// SWC keeps Nest's decorator metadata, which the default esbuild transform drops.
export default defineConfig({
  test: {
    include: ["test/**/*.test.ts", "src/**/*.test.ts"],
    environment: "node",
    setupFiles: ["test/setup.ts"],
    // Leave CPU room for PDF workers, MCP subprocesses and a running local stack.
    maxWorkers: "50%",
  },
  plugins: [swc.vite({ module: { type: "es6" } })],
});
