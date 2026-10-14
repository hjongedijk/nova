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
  const prepare = async (install: boolean) => {
    const state = await app.api.get(route).set(headers);
    expect(state.status).toBe(200);
    return app.api
      .post(`${route}/prepare`)
      .set(headers)
      .send({ module: name, install, revision: state.body.revision });
  };
  const confirm = (
    action: { sessionId: string; confirmationId: string },
    approve = true,
  ) =>
    app.api.post(`${route}/confirm`).set(headers).send({
      sessionId: action.sessionId,
      confirmationId: action.confirmationId,
      approve,
    });
  return {
    ...app,
    writes,
    prepare,
    confirm,
    restart: () => {
      if (pendingVersion) version = pendingVersion;
      pendingVersion = null;
    },
  };
}

describe("confirmed exact-version Node-RED palette changes", () => {
  it("binds the server pin to confirmation, HTTP write, readback and audit", async () => {
    const f = await fixture();
    try {
      const staged = await f.prepare(true);
      expect(staged.status).toBe(200);
      expect(staged.body.warning).toContain(`${name}@${pin}`);
      expect(staged.body.action).toMatchObject({
        risk: "DANGEROUS",
        args: { targetVersion: pin },
      });
      expect(f.writes).toHaveLength(0);
      const result = await f.confirm(staged.body.action);
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
          confirmation: "approved_admin_ui",
          arguments: { module: name, install: true, targetVersion: pin },
          result: expect.objectContaining({ ok: true, verified: true }),
        }),
      );
      expect((await f.confirm(staged.body.action)).body.ok).toBe(false);
      expect(f.writes).toHaveLength(1);
      expect((await f.prepare(true)).status).toBe(400);
      const removal = await f.prepare(false);
      expect(removal.body.action.args.targetVersion).toBeNull();
      expect((await f.confirm(removal.body.action)).body.ok).toBe(true);
      expect(f.writes[1]).toEqual({ method: "DELETE", body: null });
    } finally {
      await f.app.close();
    }
  });
  it("offers a confirmed upgrade when the installed version differs", async () => {
    const f = await fixture("0.9.0");
    try {
      const staged = await f.prepare(true);
      expect(staged.status).toBe(200);
      expect(staged.body.warning).toContain("0.9.0");
      expect(staged.body.warning).toContain(pin);
      const accepted = await f.confirm(staged.body.action);
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
      expect((await f.prepare(true)).status).toBe(400);
      f.restart();
      const active = await f.api.get(route).set(headers);
      expect(active.body.modules[0]).toMatchObject({
        version: pin,
        pendingVersion: null,
        restartRequired: false,
      });
      expect((await f.prepare(true)).status).toBe(400);
      expect(f.writes).toEqual([
        { method: "POST", body: { module: name, version: pin } },
      ]);
    } finally {
      await f.app.close();
    }
  });
  it("does not claim verification when the installed version differs from the approved pin", async () => {
    const f = await fixture(null, true);
    try {
      const staged = await f.prepare(true);
      const result = await f.confirm(staged.body.action);
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
  it("rejects an approval after the server-owned pin changes and requires a new approval", async () => {
    const f = await fixture();
    try {
      const staged = await f.prepare(true);
      Object.defineProperty(f.app.get(NovaConfig), "nodeRedPaletteAllowlist", {
        value: JSON.stringify([{ name, version: "2.0.0" }]),
        configurable: true,
      });
      expect((await f.confirm(staged.body.action)).status).toBe(503);
      expect(f.writes).toHaveLength(0);
      const next = await f.prepare(true);
      expect(next.body.action.args.targetVersion).toBe("2.0.0");
      expect((await f.confirm(next.body.action)).body.ok).toBe(true);
      expect(f.writes).toEqual([
        { method: "POST", body: { module: name, version: "2.0.0" } },
      ]);
    } finally {
      await f.app.close();
    }
  });
  it("cancels a pinned change without a package write", async () => {
    const f = await fixture();
    try {
      const staged = await f.prepare(true);
      expect((await f.confirm(staged.body.action, false)).body.cancelled).toBe(
        true,
      );
      expect(f.writes).toHaveLength(0);
    } finally {
      await f.app.close();
    }
  });
});
