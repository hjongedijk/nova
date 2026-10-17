import http from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import {
  ApiHttpClient,
  ApiHttpError,
  addressAllowed,
  isMetadataOrUnroutable,
  MAX_RESPONSE_BYTES,
} from "../../src/apis/safe-http.js";
import { startFakeApi, type FakeApi } from "./fake-api.js";

const servers: FakeApi[] = [];
const fake = async (handler: Parameters<typeof startFakeApi>[0]) => {
  const api = await startFakeApi(handler);
  servers.push(api);
  return api;
};
afterEach(async () => {
  await Promise.all(servers.splice(0).map((s) => s.close()));
});

const code = async (promise: Promise<unknown>) => {
  try {
    await promise;
  } catch (error) {
    return error instanceof ApiHttpError
      ? error.code
      : `other:${String(error)}`;
  }
  return "no error";
};
const base = { method: "GET", integrationId: "t" } as const;

describe("address rules", () => {
  it("table", () => {
    const rows: [string, boolean, boolean][] = [
      // address, allowed without local flag, allowed with local flag
      ["93.184.216.34", true, true],
      ["169.254.169.254", false, false],
      ["169.254.1.1", false, false],
      ["::ffff:169.254.169.254", false, false],
      ["fe80::1", false, false],
      ["fd00:ec2::254", false, false],
      ["100.100.100.200", false, false],
      ["0.0.0.0", false, false],
      ["224.0.0.1", false, false],
      ["127.0.0.1", false, true],
      ["::1", false, true],
      ["10.1.2.3", false, true],
      ["192.168.1.10", false, true],
      ["172.16.5.5", false, true],
      ["fd12:3456::1", false, true],
    ];
    for (const [address, plain, local] of rows) {
      expect(addressAllowed(address, false), `${address} plain`).toBe(plain);
      expect(addressAllowed(address, true), `${address} local`).toBe(local);
    }
    expect(isMetadataOrUnroutable("169.254.169.254")).toBe(true);
    expect(isMetadataOrUnroutable("10.0.0.1")).toBe(false);
  });
});

describe("ApiHttpClient", () => {
  it("blocks the metadata address even for local-network integrations", async () => {
    const client = new ApiHttpClient();
    expect(
      await code(
        client.request({
          ...base,
          url: "http://169.254.169.254/latest/meta-data",
          local: true,
        }),
      ),
    ).toBe("blocked_address");
  });

  it("blocks private and loopback addresses unless the integration is marked local", async () => {
    const api = await fake(() => ({ body: { ok: 1 } }));
    const client = new ApiHttpClient();
    expect(
      await code(
        client.request({ ...base, url: `${api.url}/x`, local: false }),
      ),
    ).toBe("blocked_scheme");
    const resolving = new ApiHttpClient({ resolve: async () => ["10.0.0.5"] });
    expect(
      await code(
        resolving.request({
          ...base,
          url: "https://printer.example/x",
          local: false,
        }),
      ),
    ).toBe("blocked_address");
    expect(api.hits).toHaveLength(0);
    const ok = await client.request({
      ...base,
      url: `${api.url}/x`,
      local: true,
    });
    expect(ok.status).toBe(200);
  });

  it("allows https only for public integrations, never credentials in the URL", async () => {
    const client = new ApiHttpClient({
      resolve: async () => ["93.184.216.34"],
    });
    expect(
      await code(
        client.request({
          ...base,
          url: "http://api.example.com/x",
          local: false,
        }),
      ),
    ).toBe("blocked_scheme");
    expect(
      await code(
        client.request({
          ...base,
          url: "https://user:pw@api.example.com/x",
          local: false,
        }),
      ),
    ).toBe("blocked_scheme");
  });

  it("pins the resolved address: a changed DNS answer cannot redirect the connection", async () => {
    const api = await fake(() => ({ body: { ok: 1 } }));
    let calls = 0;
    const client = new ApiHttpClient({
      resolve: async () =>
        ++calls === 1 ? ["127.0.0.1"] : ["169.254.169.254"],
    });
    const response = await client.request({
      ...base,
      url: `http://rebind.example:${api.port}/x`,
      local: true,
    });
    expect(response.pinnedIp).toBe("127.0.0.1");
    expect(response.status).toBe(200);
    expect(calls).toBe(1);
    expect(api.hits[0]!.headers.host).toBe(`rebind.example:${api.port}`);
  });

  it("refuses a hostname with any blocked answer (mixed public/private records)", async () => {
    const client = new ApiHttpClient({
      resolve: async () => ["93.184.216.34", "127.0.0.1"],
    });
    expect(
      await code(
        client.request({
          ...base,
          url: "https://mixed.example/x",
          local: false,
        }),
      ),
    ).toBe("blocked_address");
  });

  it("blocks NOVA's own services and port", async () => {
    const client = new ApiHttpClient({ ownPort: 4321 });
    expect(
      await code(
        client.request({
          ...base,
          url: "http://omniroute:20128/v1",
          local: true,
        }),
      ),
    ).toBe("blocked_host");
    expect(
      await code(
        client.request({ ...base, url: "http://localhost:80/", local: true }),
      ),
    ).toBe("blocked_host");
    expect(
      await code(
        client.request({
          ...base,
          url: "http://127.0.0.1:4321/api",
          local: true,
        }),
      ),
    ).toBe("blocked_host");
  });

  it("does not follow a redirect to another host and never sends credentials there", async () => {
    const other = await fake(() => ({ body: { stolen: true } }));
    const api = await fake(() => ({
      status: 302,
      headers: { location: `http://localhost.test:${other.port}/steal` },
      body: "",
    }));
    const client = new ApiHttpClient({ resolve: async () => ["127.0.0.1"] });
    const failure = await code(
      client.request({
        ...base,
        url: `http://api.test:${api.port}/x`,
        local: true,
        credentials: { headers: { authorization: "Bearer sk-test-0000" } },
      }),
    );
    expect(failure).toBe("redirect_blocked");
    expect(other.hits).toHaveLength(0);
  });

  it("follows same-host redirects for GET (and reports the new path) but not for POST", async () => {
    const api = await fake((hit) =>
      hit.url === "/old"
        ? { status: 301, headers: { location: "/new" }, body: "" }
        : hit.url === "/new"
          ? { body: { moved: true } }
          : undefined,
    );
    const client = new ApiHttpClient();
    const response = await client.request({
      ...base,
      url: `${api.url}/old`,
      local: true,
    });
    expect(response.status).toBe(200);
    expect(response.redirectedTo).toBe("/new");
    const post = await client.request({
      ...base,
      method: "POST",
      url: `${api.url}/old`,
      body: "{}",
      local: true,
    });
    expect(post.status).toBe(301);
  });

  it("truncates responses over 1 MB with a marker", async () => {
    const api = await fake(() => ({
      type: "text/plain",
      body: "x".repeat(2_000_000),
    }));
    const response = await new ApiHttpClient().request({
      ...base,
      url: `${api.url}/big`,
      local: true,
    });
    expect(response.truncated).toBe(true);
    expect(response.body.length).toBeLessThan(MAX_RESPONSE_BYTES + 200);
    expect(response.body).toContain("truncated by NOVA");
  });

  it("only accepts JSON, XML and text responses", async () => {
    const api = await fake(() => ({
      type: "application/octet-stream",
      body: "BIN",
    }));
    expect(
      await code(
        new ApiHttpClient().request({
          ...base,
          url: `${api.url}/x`,
          local: true,
        }),
      ),
    ).toBe("content_type");
  });

  it("times out", async () => {
    const server = http.createServer(() => undefined);
    await new Promise<void>((resolve) =>
      server.listen(0, "127.0.0.1", resolve),
    );
    const port = (server.address() as { port: number }).port;
    try {
      expect(
        await code(
          new ApiHttpClient().request({
            ...base,
            url: `http://127.0.0.1:${port}/`,
            local: true,
            timeoutMs: 150,
          }),
        ),
      ).toBe("timeout");
    } finally {
      server.closeAllConnections();
      server.close();
    }
  });

  it("rate-limits per integration and caps concurrency", async () => {
    const api = await fake(() => ({ body: {} }));
    const client = new ApiHttpClient();
    const req = { ...base, url: `${api.url}/x`, local: true, rateLimit: 3 };
    await client.request(req);
    await client.request(req);
    await client.request(req);
    expect(await code(client.request(req))).toBe("rate_limited");
    // another integration has its own budget
    await client.request({ ...req, integrationId: "other" });

    const slow = http.createServer((_req, res) =>
      setTimeout(() => res.end("{}", () => undefined), 120),
    );
    await new Promise<void>((resolve) => slow.listen(0, "127.0.0.1", resolve));
    const port = (slow.address() as { port: number }).port;
    try {
      const limited = new ApiHttpClient({ maxConcurrent: 1 });
      const first = limited.request({
        ...base,
        url: `http://127.0.0.1:${port}/`,
        local: true,
      });
      expect(
        await code(
          limited.request({
            ...base,
            url: `http://127.0.0.1:${port}/`,
            local: true,
          }),
        ),
      ).toBe("rate_limited");
      await first.catch(() => undefined);
    } finally {
      slow.closeAllConnections();
      slow.close();
    }
  });

  it("keeps credential query parameters out of the URL it reports", async () => {
    const api = await fake(() => ({ body: {} }));
    const response = await new ApiHttpClient().request({
      ...base,
      url: `${api.url}/x?a=1`,
      local: true,
      credentials: { query: { api_key: "sk-test-0000" } },
    });
    expect(api.hits[0]!.url).toContain("api_key=sk-test-0000");
    expect(response.url).not.toContain("sk-test-0000");
    expect(response.url).toContain("a=1");
  });
});
