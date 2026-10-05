import adapter from "@sveltejs/adapter-static";
import fs from "node:fs";
import path from "node:path";
import { sveltekit } from "@sveltejs/kit/vite";
import { defineConfig } from "vite";

// HTTPS in development when a certificate is present (dev-data/certs, or NOVA_DEV_CERT_DIR):
// browsers only allow the microphone ("Hey NOVA") on a secure page.
const certDir = path.resolve(
  process.env.NOVA_DEV_CERT_DIR ??
    path.join(import.meta.dirname, "../../dev-data/certs"),
);
const https =
  fs.existsSync(path.join(certDir, "cert.pem")) &&
  fs.existsSync(path.join(certDir, "key.pem"))
    ? {
        cert: fs.readFileSync(path.join(certDir, "cert.pem")),
        key: fs.readFileSync(path.join(certDir, "key.pem")),
      }
    : undefined;

export default defineConfig({
  plugins: [
    sveltekit({
      // Static files only: the NestJS API serves them in production.
      adapter: adapter({
        pages: "build",
        assets: "build",
        fallback: "index.html",
      }),
      // The service worker is a plain file in static/, registered by the page itself.
      serviceWorker: { register: false },
    }),
  ],
  server: {
    // Reachable from other machines on the LAN (http://<server>:5173), always on this port.
    host: true,
    port: 5173,
    strictPort: true,
    https,
    // While developing, API calls go to the NestJS dev server, which stays on this machine.
    proxy: { "/api": "http://localhost:3000" },
  },
});
