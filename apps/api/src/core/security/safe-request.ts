import http from "node:http";
import https from "node:https";
import net from "node:net";
import {
  guardedLookup,
  isPrivateAddress,
  lookupAllowing,
} from "./net-guard.js";

/*
 * HTTP for user-made webhook skills and custom panels. The owner may point one at something on
 * their own network, so private addresses are allowed when it says so, but never the places that
 * would turn it into a way around the safeguards: this machine itself, the cloud metadata address,
 * and NOVA's own internal services.
 */
const INTERNAL_HOSTS = new Set([
  "localhost",
  "nova",
  "jarvis-api",
  "jarvis-web",
  "jarvis-tts",
  "jarvis-node-red",
  "jarvis-omniroute",
  "node-red",
  "mqtt",
  "omniroute",
  "qdrant",
]);

export function forbiddenAddress(address: string): boolean {
  const family = net.isIP(address);
  if (family === 4) {
    const first = Number(address.split(".")[0]);
    return (
      first === 0 ||
      first === 127 ||
      address.startsWith("169.254.") ||
      first >= 224
    );
  }
  if (family === 6) {
    const lower = address.toLowerCase();
    if (
      lower === "::" ||
      lower === "::1" ||
      /^fe[89ab]/.test(lower) ||
      lower.startsWith("ff")
    )
      return true;
    const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(lower);
    return mapped?.[1] ? forbiddenAddress(mapped[1]) : false;
  }
  return true;
}

const lanLookup = lookupAllowing(
  forbiddenAddress,
  "Blocked: address is not allowed",
);

export function assertSkillTarget(
  value: string,
  { allowPrivate = false } = {},
): URL {
  const url = new URL(value);
  if (!["http:", "https:"].includes(url.protocol))
    throw new Error("Alleen http en https zijn toegestaan.");
  if (url.username || url.password)
    throw new Error(
      "Een URL met gebruikersnaam of wachtwoord is niet toegestaan.",
    );
  const host = url.hostname.replace(/^\[|\]$/g, "").toLowerCase();
  if (INTERNAL_HOSTS.has(host) || host.endsWith(".localhost"))
    throw new Error(
      "Dit adres hoort bij NOVA zelf en is geblokkeerd voor vaardigheden.",
    );
  if (net.isIP(host) && forbiddenAddress(host))
    throw new Error(
      "Dit adres (loopback, link-local of metadata) is geblokkeerd.",
    );
  if (!allowPrivate) {
    const port = url.port || (url.protocol === "https:" ? "443" : "80");
    if (!["80", "443"].includes(port))
      throw new Error(
        "Zonder “lokaal netwerk toestaan” zijn alleen de gewone webpoorten (80 en 443) toegestaan.",
      );
    if (!host.includes(".") && !net.isIP(host))
      throw new Error(
        "Dit is een lokale naam. Zet “lokaal netwerk toestaan” aan als dit bewust is.",
      );
    if (net.isIP(host) && isPrivateAddress(host))
      throw new Error(
        "Dit is een adres op een lokaal netwerk. Zet “lokaal netwerk toestaan” aan als dit bewust is.",
      );
  }
  return url;
}

export interface SafeResponse {
  status: number;
  contentType: string;
  location?: string;
  text: string;
  truncated: boolean;
}

export interface SafeRequestOptions {
  method?: string;
  headers?: Record<string, string>;
  body?: string;
  timeoutMs?: number;
  maxBytes?: number;
  allowPrivate?: boolean;
  signal?: AbortSignal;
}

export async function sendRequest(
  target: string,
  options: SafeRequestOptions = {},
): Promise<SafeResponse> {
  const {
    method = "GET",
    headers = {},
    body,
    timeoutMs = 10000,
    maxBytes = 200_000,
    allowPrivate = false,
    signal,
  } = options;
  const url = assertSkillTarget(target, { allowPrivate });
  const client = url.protocol === "https:" ? https : http;
  const payload = body === undefined ? undefined : Buffer.from(body);
  return new Promise((resolve, reject) => {
    const request = client.request(
      url,
      {
        method,
        signal,
        timeout: timeoutMs,
        lookup: (allowPrivate ? lanLookup : guardedLookup) as never,
        headers: {
          "user-agent": "NOVA/1.0",
          accept: "application/json, text/plain;q=0.9, */*;q=0.5",
          ...headers,
          ...(payload ? { "content-length": String(payload.length) } : {}),
        },
      },
      (response) => {
        const chunks: Buffer[] = [];
        let size = 0;
        let truncated = false;
        response.on("data", (chunk: Buffer) => {
          if (size >= maxBytes) {
            truncated = true;
            return;
          }
          size += chunk.length;
          chunks.push(chunk);
        });
        response.on("end", () =>
          resolve({
            status: response.statusCode ?? 0,
            contentType: String(response.headers["content-type"] ?? ""),
            location: response.headers.location,
            text: Buffer.concat(chunks).toString("utf8").slice(0, maxBytes),
            truncated,
          }),
        );
        response.on("error", reject);
      },
    );
    request.on("timeout", () =>
      request.destroy(new Error("De aanroep duurde te lang.")),
    );
    request.on("error", reject);
    if (payload) request.write(payload);
    request.end();
  });
}
