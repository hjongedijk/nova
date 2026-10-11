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
  /** Refuse larger JSON responses; defaults to the client-wide 2 MiB cap. */
  maxResponseBytes?: number;
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
    maxResponseBytes = 2_000_000,
  } = options;
  const url = new URL(target);
  const client = url.protocol === "https:" ? https : http;
  const payload = body === undefined ? undefined : JSON.stringify(body);
  const responseLimit = Math.max(1, Math.min(2_000_000, maxResponseBytes));
  return new Promise((resolve, reject) => {
    let settled = false;
    const fail = (error: Error) => {
      if (settled) return;
      settled = true;
      reject(error);
    };
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
          if (size > responseLimit) {
            fail(new Error("Response too large"));
            response.destroy();
            request.destroy();
            return;
          }
          chunks.push(chunk);
        });
        response.on("error", fail);
        response.on("end", () => {
          if (settled) return;
          const text = Buffer.concat(chunks).toString("utf8");
          const data = ((): T | null => {
            try {
              return text ? (JSON.parse(text) as T) : null;
            } catch {
              return null;
            }
          })();
          settled = true;
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
    request.on("error", fail);
    if (payload) request.write(payload);
    request.end();
  });
}
