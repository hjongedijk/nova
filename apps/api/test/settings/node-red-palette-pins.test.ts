import http from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import { NovaConfig } from "../../src/core/config/nova-config.js";
import { ADMIN, createApp } from "./helpers.js";

const servers: http.Server[] = [];
afterEach(async () => {
  await Promise.all(
    servers
      .splice(0)
      .map(
        (server) =>
          new Promise<void>((resolve) => server.close(() => resolve())),
      ),
  );
});
const name = "node-red-node-suncalc";
const pin = "1.2.3";
const route = "/api/settings/node-red/palette";
const headers = { ...ADMIN, "x-nova-pin": "synthetic-pin" };

async function fixture(initial: string | null = null, wrongReadback = false) {
  let version = initial;
  let pendingVersion: string | null = null;
  const writes: { method: string; body: unknown }[] = [];
  const server = http.createServer((request, response) => {
    response.setHeader("content-type", "application/json");
    if (request.method === "GET" && request.url === "/nodes") {
      response.end(
        JSON.stringify(
          version
            ? [
                {
                  module: name,
                  version,
                  ...(pendingVersion
                    ? { pending_version: pendingVersion }
                    : {}),
                  types: ["suncalc"],
                  enabled: true,
                  loaded: true,
                  id: `${name}/suncalc`,
                  name: "suncalc",
                },
              ]
            : [],
        ),
      );
    } else if (request.method === "POST" && request.url === "/nodes") {
      let body = "";
      request.on("data", (chunk) => {
        body += String(chunk);
      });
      request.on("end", () => {
        const parsed = JSON.parse(body);
        writes.push({ method: "POST", body: parsed });
        if (wrongReadback) version = "9.9.9";
        else if (version !== null) pendingVersion = parsed.version;
        else version = parsed.version;
        response.end(JSON.stringify({ name }));
      });
    } else if (
      request.method === "DELETE" &&
      request.url === `/nodes/${name}`
    ) {
      writes.push({ method: "DELETE", body: null });
      version = null;
      pendingVersion = null;
      response.statusCode = 204;
      response.end();
    } else {
      response.statusCode = 404;
      response.end("{}");
    }
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  servers.push(server);
  const address = server.address();
  if (!address || typeof address === "string")
    throw new Error("Fixture not listening");
  const app = await createApp({
    env: {
      NODE_RED_URL: `http://127.0.0.1:${address.port}`,
      NODE_RED_ADMIN_TOKEN: "",
      NODE_RED_PALETTE_ALLOWLIST: JSON.stringify([{ name, version: pin }]),
      NOVA_ADMIN_PIN: "synthetic-pin",
    },
  });
  const change = (install: boolean) =>
    app.api
      .post(`${route}/change`)
      .set(headers)
      .send({ module: name, install });
  return {
    ...app,
    writes,
    change,
    restart: () => {
      if (pendingVersion) version = pendingVersion;
      pendingVersion = null;
    },
  };
}

describe("exact-version Node-RED palette changes in one step", () => {
  it("installs the server pin immediately with HTTP write, readback and audit", async () => {
    const f = await fixture();
    try {
      const result = await f.change(true);
      expect(result.status).toBe(200);
      expect(result.body).toMatchObject({
        ok: true,
        state: {
          modules: [
            { name, installed: true, version: pin, targetVersion: pin },
          ],
        },
      });
      expect(f.writes).toEqual([
        { method: "POST", body: { module: name, version: pin } },
      ]);
      expect(f.audits).toContainEqual(
        expect.objectContaining({
          tool: "node_red_palette",
          arguments: { module: name, install: true, targetVersion: pin },
          result: expect.objectContaining({ ok: true, verified: true }),
        }),
      );
      expect((await f.change(true)).status).toBe(400);
      expect(f.writes).toHaveLength(1);
      expect((await f.change(false)).body.ok).toBe(true);
      expect(f.writes[1]).toEqual({ method: "DELETE", body: null });
      expect((await f.change(false)).status).toBe(400);
    } finally {
      await f.app.close();
    }
  });
  it("rejects unknown modules and extra body fields", async () => {
    const f = await fixture();
    try {
      expect(
        (
          await f.api
            .post(`${route}/change`)
            .set(headers)
            .send({ module: "node-red-node-other", install: true })
        ).status,
      ).toBe(400);
      expect(
        (
          await f.api
            .post(`${route}/change`)
            .set(headers)
            .send({ module: name, install: true, sessionId: "x" })
        ).status,
      ).toBe(400);
      expect(f.writes).toHaveLength(0);
    } finally {
      await f.app.close();
    }
  });
  it("upgrades when the installed version differs and reports a pending restart", async () => {
    const f = await fixture("0.9.0");
    try {
      const accepted = await f.change(true);
      expect(accepted.body).toMatchObject({
        ok: true,
        verified: false,
        pendingRestart: true,
        state: {
          modules: [
            { version: "0.9.0", pendingVersion: pin, restartRequired: true },
          ],
        },
      });
      expect(f.audits).toContainEqual(
        expect.objectContaining({
          tool: "node_red_palette",
          result: expect.objectContaining({
            ok: true,
            verified: false,
            status: "restart_required",
          }),
        }),
      );
      expect((await f.change(true)).status).toBe(400);
      f.restart();
      const active = await f.api.get(route).set(headers);
      expect(active.body.modules[0]).toMatchObject({
        version: pin,
        pendingVersion: null,
        restartRequired: false,
      });
      expect((await f.change(true)).status).toBe(400);
      expect(f.writes).toEqual([
        { method: "POST", body: { module: name, version: pin } },
      ]);
    } finally {
      await f.app.close();
    }
  });
  it("does not claim verification when the installed version differs from the pin", async () => {
    const f = await fixture(null, true);
    try {
      const result = await f.change(true);
      expect(result.status).toBe(503);
      expect(result.body.ok).not.toBe(true);
      expect(f.writes).toHaveLength(1);
      expect(f.audits).toContainEqual(
        expect.objectContaining({
          tool: "node_red_palette",
          result: { ok: false },
        }),
      );
    } finally {
      await f.app.close();
    }
  });
  it("uses the server-owned pin that is current at request time", async () => {
    const f = await fixture();
    try {
      Object.defineProperty(f.app.get(NovaConfig), "nodeRedPaletteAllowlist", {
        value: JSON.stringify([{ name, version: "2.0.0" }]),
        configurable: true,
      });
      expect((await f.change(true)).body.ok).toBe(true);
      expect(f.writes).toEqual([
        { method: "POST", body: { module: name, version: "2.0.0" } },
      ]);
    } finally {
      await f.app.close();
    }
  });
});
