import http from "node:http";
import type { AddressInfo } from "node:net";
import type { NovaConfig } from "../../src/core/config/nova-config.js";

export interface Seen {
  method?: string;
  url?: string;
  headers: http.IncomingHttpHeaders;
  body: string;
}

/** A real local HTTP server; `handler` answers each request. */
export async function listen(
  handler: (seen: Seen, send: (status: number, data: unknown) => void) => void,
) {
  const requests: Seen[] = [];
  const server = http.createServer((request, response) => {
    let body = "";
    request.on("data", (chunk) => (body += chunk));
    request.on("end", () => {
      const seen = {
        method: request.method,
        url: request.url,
        headers: request.headers,
        body,
      };
      requests.push(seen);
      handler(seen, (status, data) => {
        response.writeHead(status, { "content-type": "application/json" });
        response.end(JSON.stringify(data));
      });
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return {
    server,
    requests,
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    close: () => {
      server.closeAllConnections();
      server.close();
    },
  };
}

/** Just the config sections a service reads. */
export const fakeConfig = (parts: Record<string, unknown>) =>
  parts as unknown as NovaConfig;

export const call = (signal: AbortSignal = new AbortController().signal) => ({
  sessionId: "test",
  signal,
});
