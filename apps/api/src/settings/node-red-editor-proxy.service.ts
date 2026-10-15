import {
  Injectable,
  ServiceUnavailableException,
  type OnModuleDestroy,
} from "@nestjs/common";
import type { Request, Response, NextFunction } from "express";
import http from "node:http";
import https from "node:https";
import { Transform } from "node:stream";
import { NovaConfig } from "../core/config/nova-config.js";
import { requestJson } from "../core/http/http-json.js";
import { NodeRedManagement } from "./node-red-management.service.js";
import {
  NodeRedEditorAccess,
  NODE_RED_EDITOR_PREFIX,
} from "./node-red-editor-access.service.js";
import { nodeRedEditorRoute } from "./node-red-editor-policy.js";
import { NodeRedEditorWebSocket } from "./node-red-editor-websocket.js";

const MAX_BODY = 42 * 1024 * 1024;
const REQUEST_HEADERS = new Set([
  "accept",
  "accept-language",
  "accept-encoding",
  "content-type",
  "content-length",
  "node-red-api-version",
  "node-red-deployment-type",
]);
const RESPONSE_HEADERS = [
  "content-type",
  "content-encoding",
  "content-length",
  "content-disposition",
  "etag",
  "last-modified",
  "node-red-api-version",
];

/** Fixed local editor transport. Browser credentials never reach the runtime. */
@Injectable()
export class NodeRedEditorProxy implements OnModuleDestroy {
  readonly sockets: NodeRedEditorWebSocket;

  constructor(
    private readonly config: NovaConfig,
    private readonly management: NodeRedManagement,
    private readonly access: NodeRedEditorAccess,
  ) {
    this.sockets = new NodeRedEditorWebSocket(
      access,
      () => management.editorBaseUrl(),
      () => config.nodeRedAdminToken,
    );
  }

  async ready(): Promise<boolean> {
    try {
      const result = await requestJson<Record<string, unknown>>(
        new URL("settings", this.management.editorBaseUrl()).href,
        {
          headers: this.config.nodeRedAdminToken
            ? { authorization: `Bearer ${this.config.nodeRedAdminToken}` }
            : {},
          timeoutMs: 4000,
          signal: AbortSignal.timeout(5000),
          maxResponseBytes: 1_000_000,
        },
      );
      if (
        result.status !== 200 ||
        !result.data ||
        typeof result.data.version !== "string"
      )
        throw new Error("unavailable");
      const user = result.data.user;
      return Boolean(
        this.config.nodeRedAdminToken &&
        user &&
        typeof user === "object" &&
        !(user as { anonymous?: unknown }).anonymous,
      );
    } catch {
      throw new ServiceUnavailableException(
        "Node-RED-editor is niet beschikbaar.",
      );
    }
  }

  closeSession(key: string): void {
    this.sockets.closeSession(key);
  }

  onModuleDestroy(): void {
    this.sockets.close();
  }

  middleware = (
    request: Request,
    response: Response,
    next: NextFunction,
  ): void => {
    // Nest owns only the capability endpoints. All editor traffic uses raw bodies.
    if (/^\/_nova(?:\/|$)/.test(request.url)) {
      next();
      return;
    }
    response.setHeader("cache-control", "no-store");
    const fail = (status: number): void => {
      if (response.destroyed || response.writableEnded) return;
      if (response.headersSent) {
        response.destroy();
        return;
      }
      response
        .status(status)
        .type("text/plain")
        .send(
          status === 409
            ? "Flows zijn gewijzigd. Laad de editor opnieuw."
            : "Node-RED-editor is niet beschikbaar. Open de editor opnieuw.",
        );
    };
    if (!this.access.authorize(request)) {
      fail(403);
      return;
    }
    if (request.originalUrl === NODE_RED_EDITOR_PREFIX.slice(0, -1)) {
      response.redirect(307, NODE_RED_EDITOR_PREFIX);
      return;
    }
    const route = nodeRedEditorRoute(request.url, request.method);
    if (!route) {
      fail(404);
      return;
    }
    let base: URL;
    try {
      base = this.management.editorBaseUrl();
    } catch {
      fail(503);
      return;
    }
    const length = request.headers["content-length"];
    if (
      length !== undefined &&
      (!/^\d+$/.test(length) || Number(length) > MAX_BODY)
    ) {
      fail(413);
      return;
    }
    const headers: http.OutgoingHttpHeaders = {};
    for (const [name, value] of Object.entries(request.headers)) {
      if (REQUEST_HEADERS.has(name) && typeof value === "string")
        headers[name] = value;
    }
    if (route.authenticated && this.config.nodeRedAdminToken)
      headers.authorization = `Bearer ${this.config.nodeRedAdminToken}`;
    const client = base.protocol === "https:" ? https : http;
    const upstream = client.request(new URL(route.path, base), {
      method: request.method,
      headers,
      timeout: 15_000,
    });
    let bytes = 0;
    const body = new Transform({
      transform(chunk: Buffer, _encoding, callback) {
        bytes += chunk.length;
        callback(bytes > MAX_BODY ? new Error("body limit") : null, chunk);
      },
    });
    const timeout = setTimeout(() => {
      fail(504);
      upstream.destroy();
    }, 60_000);
    timeout.unref();
    const cleanup = (): void => {
      clearTimeout(timeout);
    };
    response.once("close", () => {
      cleanup();
      upstream.destroy();
      request.unpipe(body);
      body.destroy();
    });
    request.once("aborted", () => upstream.destroy());
    body.once("error", () => {
      fail(413);
      upstream.destroy();
    });
    upstream.once("timeout", () => {
      fail(504);
      upstream.destroy();
    });
    upstream.once("error", () => {
      cleanup();
      fail(502);
    });
    upstream.once("response", (incoming) => {
      const status = incoming.statusCode ?? 502;
      if (status >= 400) {
        incoming.destroy();
        fail(status === 401 ? 502 : status);
        return;
      }
      if (status >= 300 && status < 400 && status !== 304) {
        try {
          if (!incoming.headers.location) throw new Error("missing location");
          const location = new URL(
            incoming.headers.location,
            new URL(route.path, base),
          );
          if (
            location.origin !== base.origin ||
            !nodeRedEditorRoute(location.pathname + location.search, "GET")
          )
            throw new Error("invalid location");
          response.setHeader(
            "location",
            NODE_RED_EDITOR_PREFIX.slice(0, -1) +
              location.pathname +
              location.search,
          );
        } catch {
          incoming.destroy();
          fail(502);
          return;
        }
      }
      for (const name of RESPONSE_HEADERS) {
        const value = incoming.headers[name];
        if (value !== undefined) response.setHeader(name, value);
      }
      response.setHeader("x-frame-options", "SAMEORIGIN");
      response.setHeader("content-security-policy", "frame-ancestors 'self'");
      response.status(status);
      incoming.once("error", () => {
        cleanup();
        fail(502);
      });
      incoming.once("end", cleanup);
      incoming.pipe(response);
    });
    request.pipe(body).pipe(upstream);
  };
}
