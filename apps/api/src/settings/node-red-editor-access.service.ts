import { ForbiddenException, Injectable } from "@nestjs/common";
import crypto from "node:crypto";
import type { IncomingMessage } from "node:http";
import type { Request, Response } from "express";

export const NODE_RED_EDITOR_PREFIX = "/api/node-red-editor/";
export type Session = {
  key: string;
  origin: string;
  expiresAt: number;
  upstreamAuth: boolean;
};

const COOKIE = "nova_node_red_editor";
const TTL_MS = 30 * 60 * 1000;
const MAX_SESSIONS = 64;
const COOKIE_OPTIONS = {
  httpOnly: true,
  secure: true,
  sameSite: "strict" as const,
  path: NODE_RED_EDITOR_PREFIX,
};

function cookieToken(request: IncomingMessage): string | null {
  let value: string | null = null;
  for (const part of (request.headers.cookie ?? "").split(";")) {
    const separator = part.indexOf("=");
    if (separator < 0 || part.slice(0, separator).trim() !== COOKIE) continue;
    if (value !== null) return null;
    try {
      value = decodeURIComponent(part.slice(separator + 1).trim());
    } catch {
      return null;
    }
    if (!/^[A-Za-z0-9_-]{43}$/.test(value)) return null;
  }
  return value;
}

function keyOf(token: string): string {
  return crypto.createHash("sha256").update(token).digest("hex");
}

/** Origin is a browser origin, never a URL carrying credentials or a path. */
function requestOrigin(request: IncomingMessage): string | null {
  const raw = request.headers.origin;
  const host = request.headers.host;
  if (typeof raw !== "string" || typeof host !== "string") return null;
  try {
    const origin = new URL(raw);
    if (
      raw !== origin.origin ||
      origin.host !== host ||
      origin.username ||
      origin.password ||
      (origin.protocol !== "https:" &&
        !(
          origin.protocol === "http:" &&
          ["localhost", "127.0.0.1"].includes(origin.hostname)
        ))
    )
      return null;
    return origin.origin;
  } catch {
    return null;
  }
}

/** Browser capability for the editor only; the Node-RED bearer stays on the server. */
@Injectable()
export class NodeRedEditorAccess {
  private readonly sessions = new Map<string, Session>();

  private prune(): void {
    const now = Date.now();
    for (const [key, session] of this.sessions) {
      if (session.expiresAt <= now) this.sessions.delete(key);
    }
  }

  open(
    request: Request,
    response: Response,
    upstreamAuth: boolean,
  ): { url: string; expiresAt: string } {
    const origin = requestOrigin(request);
    if (!origin)
      throw new ForbiddenException("Ongeldige oorsprong voor Node-RED-editor.");
    this.prune();
    const existing = this.authorize(request, true);
    const token = existing
      ? cookieToken(request)!
      : crypto.randomBytes(32).toString("base64url");
    const key = existing?.key ?? keyOf(token);
    const expiresAt = Date.now() + TTL_MS;
    // Refreshing moves this session to the end, retaining the least-recently
    // refreshed sessions only while there is room.
    this.sessions.delete(key);
    while (this.sessions.size >= MAX_SESSIONS) {
      const oldest = this.sessions.keys().next().value;
      if (oldest !== undefined) this.sessions.delete(oldest);
    }
    this.sessions.set(key, { key, origin, expiresAt, upstreamAuth });
    response.cookie(COOKIE, token, { ...COOKIE_OPTIONS, maxAge: TTL_MS });
    return {
      url: NODE_RED_EDITOR_PREFIX,
      expiresAt: new Date(expiresAt).toISOString(),
    };
  }

  authorize(request: IncomingMessage, requireOrigin = false): Session | null {
    this.prune();
    const token = cookieToken(request);
    const session = token ? this.sessions.get(keyOf(token)) : null;
    if (!session || new URL(session.origin).host !== request.headers.host)
      return null;
    const method = request.method ?? "GET";
    if (
      method === "GET" &&
      ["cross-site", "same-site"].includes(
        String(request.headers["sec-fetch-site"]),
      )
    )
      return null;
    if (
      requireOrigin ||
      !["GET", "HEAD"].includes(method) ||
      request.headers.origin !== undefined
    ) {
      if (requestOrigin(request) !== session.origin) return null;
    }
    return { ...session };
  }

  close(request: Request, response: Response): void {
    const origin = requestOrigin(request);
    if (!origin)
      throw new ForbiddenException("Ongeldige oorsprong voor Node-RED-editor.");
    const session = this.authorize(request, true);
    if (session) this.sessions.delete(session.key);
    response.clearCookie(COOKIE, COOKIE_OPTIONS);
  }
}
