import http from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { AriHttpClient } from "../../src/telephony/ari.client.js";

const servers: http.Server[] = [];
afterEach(async () => {
  for (const s of servers.splice(0))
    await new Promise<void>((r) => s.close(() => r()));
});

async function client(routes: Record<string, [number, unknown]>) {
  const seen: string[] = [];
  const server = http.createServer((req, res) => {
    seen.push(`${req.url}`);
    const [status, body] = routes[(req.url ?? "").split("?")[0]!] ?? [
      404,
      { message: "not found" },
    ];
    res.writeHead(status, { "content-type": "application/json" });
    res.end(JSON.stringify(body));
  });
  servers.push(server);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as AddressInfo).port;
  return {
    ari: new AriHttpClient(new URL(`http://127.0.0.1:${port}`), () => "secret"),
    seen,
  };
}

describe("ARI client", () => {
  it("treats a missing PJSIP technology (no endpoints configured yet) as an empty list", async () => {
    const { ari } = await client({
      "/ari/asterisk/info": [200, { system: { version: "22.11.0" } }],
      "/ari/channels": [200, []],
    });
    expect(await ari.endpoints()).toEqual([]);
    expect(await ari.info()).toEqual({ version: "22.11.0" });
    expect(await ari.channels()).toEqual([]);
  });

  it("still reports other failures, such as a rejected login", async () => {
    const { ari } = await client({ "/ari/endpoints/PJSIP": [401, {}] });
    await expect(ari.endpoints()).rejects.toThrow(/401/);
    await expect(ari.channels()).rejects.toThrow(/404/);
  });

  it("returns real endpoints when there are some", async () => {
    const { ari } = await client({
      "/ari/endpoints/PJSIP": [
        200,
        [{ technology: "PJSIP", resource: "101", state: "online" }],
      ],
    });
    expect(await ari.endpoints()).toHaveLength(1);
  });
});
