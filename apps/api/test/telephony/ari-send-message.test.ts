import http from "node:http";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { AriHttpClient } from "../../src/telephony/ari.client.js";

describe("AriHttpClient.sendMessage", () => {
  let server: http.Server;
  let url: URL;
  const seen: { method?: string; path?: string }[] = [];

  beforeAll(async () => {
    server = http.createServer((request, response) => {
      seen.push({ method: request.method, path: request.url });
      response.statusCode = request.method === "PUT" ? 202 : 405;
      response.end();
    });
    await new Promise<void>((resolve) =>
      server.listen(0, "127.0.0.1", resolve),
    );
    url = new URL(
      `http://127.0.0.1:${(server.address() as { port: number }).port}`,
    );
  });
  afterAll(() => server.close());

  it("uses PUT, which is the only method Asterisk accepts for endpoints/sendMessage", async () => {
    const client = new AriHttpClient(url, () => "secret");
    await client.sendMessage({
      to: "pjsip:trunk/sip:user@example.org",
      from: "sip:nova@example.org",
      body: "Hallo",
    });
    expect(seen[0]?.method).toBe("PUT");
    expect(seen[0]?.path).toContain("/ari/endpoints/sendMessage?");
    expect(seen[0]?.path).toContain("body=Hallo");
  });
});
