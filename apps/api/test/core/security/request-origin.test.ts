import express from "express";
import request from "supertest";
import { describe, expect, it } from "vitest";
import {
  hostAllowed,
  originAllowed,
  requestGuard,
  type RequestGuardOptions,
} from "../../../src/core/security/request-origin.js";

const options: RequestGuardOptions = {
  publicUrl: "https://nova.example.com",
  allowedHosts: ["nova.proxy.example", "*.tailnet.example"],
  hostnames: ["nova-box"],
};

/** The same order as main.ts: guard on /api, form parser only for the Asterisk route, then JSON. */
function app() {
  const calls: { path: string; body: unknown }[] = [];
  const server = express();
  server.use("/api", requestGuard(options));
  server.use(
    "/api/integrations/asterisk/message",
    express.urlencoded({ extended: false }),
  );
  server.use(express.json());
  server.all(/^\/api\/.*/, (req, res) => {
    calls.push({ path: req.path, body: req.body });
    res.status(201).json({ ok: true });
  });
  return { server, calls };
}

describe("cross-site request guard", () => {
  it("refuses a cross-site form POST to the tool route and runs nothing", async () => {
    const { server, calls } = app();
    const response = await request(server)
      .post("/api/actions/execute")
      .set("Host", "192.168.10.9:8080")
      .set("Origin", "https://evil.example")
      .set("Sec-Fetch-Site", "cross-site")
      .type("form")
      .send("tool=termix_run_command&args%5Bcommand%5D=id");
    expect(response.status).toBe(403);
    expect(calls).toEqual([]);
  });

  it("refuses a cross-site no-cors POST without a body and a sandboxed (null) origin", async () => {
    const { server, calls } = app();
    await request(server)
      .post("/api/agent/runs")
      .set("Host", "192.168.10.9:8080")
      .set("Origin", "https://evil.example")
      .expect(403);
    await request(server)
      .post("/api/agent/runs")
      .set("Host", "192.168.10.9:8080")
      .set("Origin", "null")
      .send({ goal: "x" })
      .expect(403);
    await request(server)
      .post("/api/agent/runs")
      .set("Host", "192.168.10.9:8080")
      .set("Sec-Fetch-Site", "same-site")
      .send({ goal: "x" })
      .expect(403);
    expect(calls).toEqual([]);
  });

  it("refuses a same-origin form or text body unless x-nova-admin is set", async () => {
    const { server, calls } = app();
    await request(server)
      .post("/api/settings/services/termix/test")
      .set("Host", "192.168.10.9:8080")
      .set("Origin", "http://192.168.10.9:8080")
      .type("form")
      .send("values%5Burl%5D=https%3A%2F%2Fcollector.example")
      .expect(415);
    await request(server)
      .post("/api/chat")
      .set("Host", "192.168.10.9:8080")
      .set("Content-Type", "text/plain")
      .send("hoi")
      .expect(415);
    expect(calls).toEqual([]);
    await request(server)
      .post("/api/chat")
      .set("Host", "192.168.10.9:8080")
      .set("Content-Type", "text/plain")
      .set("x-nova-admin", "1")
      .send("hoi")
      .expect(201);
  });

  it("lets the NOVA web UI (same origin, JSON) and the reverse proxy origin through", async () => {
    const { server, calls } = app();
    await request(server)
      .post("/api/actions/execute")
      .set("Host", "192.168.10.9:8080")
      .set("Origin", "http://192.168.10.9:8080")
      .set("Sec-Fetch-Site", "same-origin")
      .send({ tool: "system_time", args: {} })
      .expect(201);
    await request(server)
      .put("/api/settings/runtime")
      .set("Host", "nova.example.com")
      .set("Origin", "https://nova.example.com")
      .send({ a: 1 })
      .expect(201);
    // A proxy that forwards to the LAN address keeps the public origin.
    await request(server)
      .delete("/api/notes/1")
      .set("Host", "192.168.10.9:8080")
      .set("Origin", "https://nova.proxy.example")
      .send({})
      .expect(201);
    expect(calls).toHaveLength(3);
    expect(calls[0]!.body).toEqual({ tool: "system_time", args: {} });
  });

  it("lets non-browser clients (Node-RED, chat bridge) and the Asterisk form through", async () => {
    const { server, calls } = app();
    await request(server)
      .post("/api/integrations/node-red/events")
      .set("Host", "nova:8080")
      .send({ event: "x" })
      .expect(201);
    await request(server)
      .post("/api/integrations/asterisk/message")
      .set("Host", "nova:8080")
      .type("form")
      .send("token=t&from=sip%3Aa%40b&type=text%2Fplain&body=hoi")
      .expect(201);
    expect(calls[1]!.body).toEqual({
      token: "t",
      from: "sip:a@b",
      type: "text/plain",
      body: "hoi",
    });
  });

  it("refuses a rebound public host name, also for reads", async () => {
    const { server, calls } = app();
    await request(server)
      .get("/api/settings/services")
      .set("Host", "attacker.example:8080")
      .expect(403);
    await request(server)
      .post("/api/actions/execute")
      .set("Host", "attacker.example")
      .set("Origin", "http://attacker.example")
      .send({ tool: "x" })
      .expect(403);
    expect(calls).toEqual([]);
    await request(server)
      .get("/api/nova/health")
      .set("Host", "192.168.10.9:8080")
      .expect(201);
  });
});

describe("allowed hosts", () => {
  it("accepts IP literals, local names, this machine, the public URL and configured names", () => {
    for (const host of [
      "192.168.10.9:8080",
      "127.0.0.1",
      "[::1]:8443",
      "localhost:5173",
      "nova:8080",
      "nova-box",
      "nas.local",
      "nova.lan",
      "nova.home.arpa",
      "nova.example.com",
      "NOVA.EXAMPLE.COM.",
      "nova.proxy.example",
      "pc.tailnet.example",
    ])
      expect(hostAllowed(host, options), host).toBe(true);
  });

  it("refuses public names that are not configured", () => {
    for (const host of [
      "attacker.example",
      "nova.example.com.attacker.example",
      "tailnet.example.evil",
    ])
      expect(hostAllowed(host, options), host).toBe(false);
    expect(hostAllowed("anything.example", { allowedHosts: ["*"] })).toBe(true);
  });

  it("binds a browser origin to the request host, the public URL or a configured name", () => {
    expect(originAllowed("http://nas.local:8080", "nas.local:8080", {})).toBe(
      true,
    );
    expect(originAllowed("http://nas.local:5173", "nas.local:8080", {})).toBe(
      false,
    );
    expect(originAllowed("https://nova.example.com", "10.0.0.2", options)).toBe(
      true,
    );
    expect(originAllowed("https://x.example", "x.example", options)).toBe(true);
    expect(originAllowed("https://evil.example", "10.0.0.2", options)).toBe(
      false,
    );
    expect(
      originAllowed("https://evil.example", "10.0.0.2", {
        allowedHosts: ["*"],
      }),
    ).toBe(false);
    expect(originAllowed("null", "10.0.0.2", options)).toBe(false);
  });
});
