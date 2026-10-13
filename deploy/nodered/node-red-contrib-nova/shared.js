"use strict";

const { createHash } = require("node:crypto");

const MAX_EVENT_BYTES = 4096;
const MAX_AUDIO_BYTES = 20_000_000;
const MAX_CHAT_RESPONSE_BYTES = 1024 * 1024;

function apiBase() {
  let url;
  try {
    url = new URL(process.env.NOVA_API_URL || "http://nova:8080");
  } catch {
    throw new Error("NOVA_API_URL is invalid");
  }
  if (
    !["http:", "https:"].includes(url.protocol) ||
    url.username ||
    url.password ||
    !["nova", "localhost", "127.0.0.1", "host.docker.internal"].includes(
      url.hostname.toLowerCase(),
    )
  )
    throw new Error("NOVA_API_URL must point to the local NOVA service");
  return url.origin;
}

let appSession;
let appLogin;

async function sessionCookie(base, token, rejectedCookie) {
  const scope = `${base}:${createHash("sha256").update(token).digest("hex")}`;
  if (rejectedCookie && appSession?.cookie === rejectedCookie)
    appSession = undefined;
  if (appSession?.scope === scope && appSession.expiresAt > Date.now())
    return appSession.cookie;
  if (appLogin?.scope === scope) return appLogin.promise;
  const login = { scope, promise: null };
  login.promise = (async () => {
    const response = await fetch(`${base}/api/access/unlock`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ token }),
      signal: AbortSignal.timeout(12000),
    });
    const cookie = /(?:^|,\s*)nova_access=([A-Za-z0-9_-]{32,128})(?:;|$)/.exec(
      response.headers.get("set-cookie") || "",
    )?.[1];
    await response.body?.cancel().catch(() => {});
    if (!response.ok || !cookie)
      throw new Error("NOVA app access could not be established");
    const value = `nova_access=${cookie}`;
    appSession = {
      scope,
      cookie: value,
      expiresAt: Date.now() + 11 * 60 * 60 * 1000,
    };
    return value;
  })();
  appLogin = login;
  try {
    return await login.promise;
  } finally {
    if (appLogin === login) appLogin = undefined;
  }
}

async function request(path, body, options = {}) {
  const base = apiBase();
  const headers = {};
  if (body !== undefined) headers["content-type"] = "application/json";
  if (options.token) headers.authorization = `Bearer ${options.token}`;
  // Event/proactive bearer credentials keep their narrower independent scope.
  const appToken = options.token ? "" : process.env.NOVA_APP_TOKEN || "";
  if (appToken) {
    headers.cookie = await sessionCookie(base, appToken);
    if (body !== undefined) headers.origin = base.replace(/^http:/, "https:");
  }
  const send = () =>
    fetch(`${base}${path}`, {
      method: body === undefined ? "GET" : "POST",
      headers,
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(options.timeoutMs || 12000),
    });
  let response = await send();
  if (
    appToken &&
    response.status === 403 &&
    response.headers.get("x-nova-app-access") === "required"
  ) {
    // The API guard guarantees the original action never reached its controller.
    await response.body?.cancel().catch(() => {});
    headers.cookie = await sessionCookie(base, appToken, headers.cookie);
    response = await send();
  }
  if (!response.ok) {
    await response.body?.cancel().catch(() => {});
    throw new Error(`NOVA returned HTTP ${response.status}`);
  }
  const maxBytes = options.maxBytes || MAX_EVENT_BYTES;
  const length = Number(response.headers.get("content-length") || 0);
  if (length > maxBytes) {
    await response.body?.cancel().catch(() => {});
    throw new Error("NOVA response is too large");
  }
  const chunks = [];
  let size = 0;
  if (response.body) {
    for await (const chunk of response.body) {
      size += chunk.length;
      if (size > maxBytes) throw new Error("NOVA response is too large");
      chunks.push(chunk);
    }
  }
  const bytes = Buffer.concat(chunks, size);
  if (options.audio) {
    if (!options.audioMetadata) return bytes;
    const contentType = (response.headers.get("content-type") || "audio/mpeg")
      .split(";", 1)[0]
      .trim()
      .toLowerCase();
    if (!["audio/mpeg", "audio/wav"].includes(contentType))
      throw new Error("NOVA returned an unsupported audio format");
    return { audio: bytes, contentType };
  }
  try {
    return JSON.parse(bytes.toString("utf8"));
  } catch {
    throw new Error("NOVA returned an invalid response");
  }
}

function eventToken() {
  const token = process.env.NODE_RED_EVENT_TOKEN || "";
  if (token.length < 32) throw new Error("NOVA event token is not configured");
  return token;
}

function eventPayload(type, input) {
  const row =
    input && typeof input === "object" && !Array.isArray(input) ? input : {};
  const payload =
    type === "alert"
      ? {
          type,
          title: String(row.title || "").slice(0, 120),
          detail: String(row.detail || "").slice(0, 240),
          severity: row.severity || "info",
          ...(row.category === "briefing" ? { category: "briefing" } : {}),
        }
      : {
          type,
          detail: String(row.detail || input || "").slice(0, 240),
          ...(row.flowId ? { flowId: String(row.flowId) } : {}),
        };
  if (!payload.title && type === "alert")
    throw new Error("Alert title is required");
  if (
    type === "runtime_error" &&
    payload.flowId !== undefined &&
    !/^[A-Za-z0-9._:-]{1,128}$/.test(payload.flowId)
  )
    throw new Error("Flow ID is invalid");
  if (Buffer.byteLength(JSON.stringify(payload), "utf8") > MAX_EVENT_BYTES)
    throw new Error("NOVA event is too large");
  return payload;
}

module.exports = {
  MAX_AUDIO_BYTES,
  MAX_CHAT_RESPONSE_BYTES,
  eventPayload,
  eventToken,
  request,
};
