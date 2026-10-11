import { createServer, type Server } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import type { NovaConfig } from "../../src/core/config/nova-config.js";
import { NodeRedManagement } from "../../src/settings/node-red-management.service.js";

const servers: Server[] = [];
const token = "node-red-admin-token-0123456789-abcdef";

async function manager(
  handler: (
    request: import("node:http").IncomingMessage,
    response: import("node:http").ServerResponse,
  ) => void,
) {
  const server = createServer(handler);
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string")
    throw new Error("No fixture port");
  return new NodeRedManagement({
    nodeRedUrl: `http://127.0.0.1:${address.port}`,
    nodeRedAdminToken: token,
    nodeRedEditorUrl: "",
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

describe("Node-RED flow backup API", () => {
  it("reads bounded v2 snapshots and writes with a fresh compare-and-swap revision", async () => {
    let revision = "rev-1";
    let flows: Record<string, unknown>[] = [
      { id: "tab-a", type: "tab", label: "Home" },
      { id: "inject-a", type: "inject", z: "tab-a", wires: [[]] },
    ];
    const management = await manager((request, response) => {
      response.setHeader("content-type", "application/json");
      if (request.url !== "/flows") {
        response.writeHead(404).end();
        return;
      }
      if (request.method === "GET") {
        expect(request.headers["node-red-api-version"]).toBe("v2");
        expect(request.headers.authorization).toBe(`Bearer ${token}`);
        response.end(JSON.stringify({ rev: revision, flows }));
        return;
      }
      const chunks: Buffer[] = [];
      request.on("data", (chunk: Buffer) => chunks.push(chunk));
      request.on("end", () => {
        const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as {
          rev: string;
          flows: Record<string, unknown>[];
        };
        expect(request.headers["node-red-api-version"]).toBe("v2");
        expect(request.headers["node-red-deployment-type"]).toBe("flows");
        if (body.rev !== revision) {
          response
            .writeHead(409)
            .end(JSON.stringify({ error: "revision mismatch" }));
          return;
        }
        flows = body.flows;
        revision = "rev-2";
        response.end(JSON.stringify({ rev: revision }));
      });
    });

    const snapshot = await management.flowSnapshot();
    expect(snapshot).toEqual({ revision: "rev-1", flows });
    const nextFlows = [{ id: "tab-b", type: "tab", label: "New" }];
    await expect(
      management.writeFlowSnapshot(snapshot.revision, nextFlows),
    ).resolves.toEqual({ ok: true, revision: "rev-2" });
    await expect(management.flowSnapshot()).resolves.toEqual({
      revision: "rev-2",
      flows: nextFlows,
    });
  });

  it("refuses stale revisions without posting and rejects credentials or secret fields", async () => {
    let writes = 0;
    const management = await manager((request, response) => {
      response.setHeader("content-type", "application/json");
      if (request.method === "GET") {
        response.end(
          JSON.stringify({
            rev: "current",
            flows: [{ id: "tab", type: "tab" }],
          }),
        );
      } else {
        writes++;
        response.writeHead(409).end(JSON.stringify({ error: "conflict" }));
      }
    });
    await expect(
      management.writeFlowSnapshot("stale", [{ id: "tab-new", type: "tab" }]),
    ).resolves.toMatchObject({ ok: false });
    expect(writes).toBe(0);
    for (const sensitive of [
      { credentials: { password: "private" } },
      { config: { apiKey: "private" } },
      { func: "const value = 'Bearer abcdefghijklmnop';" },
    ])
      await expect(
        management.writeFlowSnapshot("current", [
          { id: "node", type: "function", ...sensitive },
        ]),
      ).resolves.toMatchObject({ ok: false });
    expect(writes).toBe(0);
  });

  it("refuses malformed, duplicate, and oversized flow snapshots", async () => {
    const management = await manager((_request, response) => {
      response.setHeader("content-type", "application/json");
      response.end(
        JSON.stringify({
          rev: "rev-1",
          flows: [
            { id: "same", type: "tab" },
            { id: "same", type: "inject" },
          ],
        }),
      );
    });
    await expect(management.flowSnapshot()).rejects.toThrow(
      /ongeldige of dubbele/,
    );
  });
});
