import { createServer, type Server } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import type { NovaConfig } from "../../src/core/config/nova-config.js";
import type { FeedEvent } from "@nova/contracts";
import { NtfyPushService } from "../../src/dashboard/ntfy-push.service.js";

const servers: Server[] = [];
const alert = (severity: FeedEvent["severity"] = "critical"): FeedEvent => ({
  seq: 1,
  kind: "alert",
  severity,
  title: "Dienst is onbereikbaar",
  detail: "private detail must not be sent",
  key: "service-api",
  at: new Date().toISOString(),
});

async function listen(server: Server): Promise<number> {
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("No test port");
  return address.port;
}

function service(
  url: string,
  topic = "nova_private",
  token = "publish-token-0123456789",
) {
  return new NtfyPushService({
    ntfy: { url, topic, token },
  } as NovaConfig);
}

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

describe("NtfyPushService", () => {
  it("sends only critical alert titles with private bearer auth and deduplicates repeats", async () => {
    let received: {
      url?: string;
      auth?: string;
      priority?: string | string[];
      body?: string;
    } = {};
    const server = createServer((request, response) => {
      const chunks: Buffer[] = [];
      request.on("data", (chunk: Buffer) => chunks.push(chunk));
      request.on("end", () => {
        received = {
          url: request.url,
          auth: request.headers.authorization,
          priority: request.headers.priority,
          body: Buffer.concat(chunks).toString("utf8"),
        };
        response.writeHead(200);
        response.end("ok");
      });
    });
    const push = service(`http://127.0.0.1:${await listen(server)}`);
    expect(push.configured).toBe(true);
    await push.notify(alert());
    await push.notify(alert());
    expect(received).toEqual({
      url: "/nova_private",
      auth: "Bearer publish-token-0123456789",
      priority: "5",
      body: "Dienst is onbereikbaar",
    });
  });

  it("does not send warnings, public HTTP URLs, invalid topics, or missing tokens", async () => {
    let requests = 0;
    const server = createServer((_request, response) => {
      requests++;
      response.writeHead(200);
      response.end();
    });
    const port = await listen(server);
    const warning = service(`http://127.0.0.1:${port}`);
    await warning.notify(alert("warning"));
    expect(warning.configured).toBe(true);

    const publicHttp = service("http://example.com", "topic");
    const invalidTopic = service("https://ntfy.example", "public/topic");
    const missingToken = service("https://ntfy.example", "topic", "short");
    expect(publicHttp.configured).toBe(false);
    expect(invalidTopic.configured).toBe(false);
    expect(missingToken.configured).toBe(false);
    await publicHttp.notify(alert());
    await invalidTopic.notify(alert());
    await missingToken.notify(alert());
    await warning.notify(alert("warning"));
    expect(requests).toBe(0);
    expect(server.listening).toBe(true);
  });
});
