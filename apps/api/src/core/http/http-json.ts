import http from "node:http";
import https from "node:https";

export interface JsonResponse<T = unknown> {
  status: number;
  data: T | null;
  headers: http.IncomingHttpHeaders;
}

export interface RequestJsonOptions {
  method?: string;
  headers?: Record<string, string>;
  body?: unknown;
  signal?: AbortSignal;
  /** Accept a self-signed certificate (LAN devices such as Proxmox). */
  insecureTls?: boolean;
  /** Send another Host header than the URL's (reverse proxies). */
  hostHeader?: string;
  timeoutMs?: number;
}

/**
 * Small JSON client for the LAN integrations. Unlike fetch it can override the Host header and
 * accept self-signed certificates. Answers over 2 MB are refused.
 */
export function requestJson<T = unknown>(
  target: string,
  options: RequestJsonOptions = {},
): Promise<JsonResponse<T>> {
  const {
    method = "GET",
    headers = {},
    body,
    signal,
    insecureTls = false,
    hostHeader,
    timeoutMs,
  } = options;
  const url = new URL(target);
  const client = url.protocol === "https:" ? https : http;
  const payload = body === undefined ? undefined : JSON.stringify(body);
  return new Promise((resolve, reject) => {
    const request = client.request(
      url,
      {
        method,
        signal,
        timeout: timeoutMs,
        headers: {
          accept: "application/json",
          ...(payload
            ? {
                "content-type": "application/json",
                "content-length": String(Buffer.byteLength(payload)),
              }
            : {}),
          ...(hostHeader ? { host: hostHeader } : {}),
          ...headers,
        },
        ...(url.protocol === "https:"
          ? {
              rejectUnauthorized: !insecureTls,
              servername: hostHeader || url.hostname,
            }
          : {}),
      },
      (response) => {
        const chunks: Buffer[] = [];
        let size = 0;
        response.on("data", (chunk: Buffer) => {
          size += chunk.length;
          if (size > 2_000_000)
            request.destroy(new Error("Response too large"));
          else chunks.push(chunk);
        });
        response.on("end", () => {
          const text = Buffer.concat(chunks).toString("utf8");
          const data = ((): T | null => {
            try {
              return text ? (JSON.parse(text) as T) : null;
            } catch {
              return null;
            }
          })();
          resolve({
            status: response.statusCode ?? 0,
            data,
            headers: response.headers,
          });
        });
      },
    );
    request.on("timeout", () =>
      request.destroy(new Error("Request timed out")),
    );
    request.on("error", reject);
    if (payload) request.write(payload);
    request.end();
  });
}
