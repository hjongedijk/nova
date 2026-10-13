import crypto from "node:crypto";
import type { AddressInfo } from "node:net";
import { Server, utils } from "ssh2";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { sameHostKey } from "../../src/integrations/termix/direct-ssh.js";
import { TermixService } from "../../src/integrations/termix/termix.service.js";
import { call, fakeConfig, listen } from "./helpers.js";

const keys = utils.generateKeyPairSync("ed25519");
const blob = (
  utils.parseKey(keys.public) as { getPublicSSH(): Buffer }
).getPublicSSH();
const ran: string[] = [];
let snippetWorks = false;
let executeFails = false;
let hostName = "vm-test";
let fingerprint = blob.toString("hex");
let sshServer: Server;
let fake: Awaited<ReturnType<typeof listen>>;
let termix: TermixService;

beforeAll(async () => {
  // A real SSH server that only lets root in with the password Termix holds.
  sshServer = new Server({ hostKeys: [keys.private] }, (client) => {
    client.on("error", () => {}); // a refused client hangs up mid-handshake
    client.on("authentication", (ctx) =>
      ctx.method === "password" &&
      ctx.username === "root" &&
      ctx.password === "termix-pw"
        ? ctx.accept()
        : ctx.reject(["password"]),
    );
    client.on("ready", () =>
      client.on("session", (accept) =>
        accept().on("exec", (acceptExec, _reject, info) => {
          ran.push(info.command);
          const stream = acceptExec();
          stream.write(`ran: ${info.command}\n`);
          stream.stderr.write("a warning\n");
          stream.exit(0);
          stream.end();
        }),
      ),
    );
  });
  await new Promise<void>((resolve) =>
    sshServer.listen(0, "127.0.0.1", resolve),
  );
  const sshPort = (sshServer.address() as AddressInfo).port;
  fake = await listen((seen, send) => {
    const { url = "", method } = seen;
    if (seen.headers.authorization !== "Bearer tmx") return send(401, {});
    if (url === "/host/db/host")
      return send(200, [
        {
          id: 5,
          name: hostName,
          ip: "127.0.0.1",
          port: sshPort,
          username: "root",
          hostKeyFingerprint: fingerprint,
        },
      ]);
    if (url === "/host/db/host/5/export")
      return send(200, {
        connectionType: "ssh",
        ip: "127.0.0.1",
        port: sshPort,
        username: "root",
        password: "termix-pw",
        authType: "password",
        jumpHosts: [],
        useSocks5: false,
      });
    if (url === "/plugin-api/snippets" && method === "POST")
      return snippetWorks
        ? send(201, { id: 9 })
        : send(503, { error: "Snippet plugin unavailable" });
    if (url === "/plugin-api/snippets/execute")
      return executeFails
        ? send(500, { error: "Failed to execute snippet" })
        : send(200, { success: true, output: "via termix\n" });
    if (url.startsWith("/audit-logs"))
      return send(200, {
        logs: [
          {
            action: "plugin_ssh_connect",
            details: "host 5",
            success: false,
            errorMessage: "All configured authentication methods failed",
          },
        ],
      });
    if (method === "DELETE") return send(200, {});
    send(404, {});
  });
  termix = new TermixService(
    fakeConfig({ termix: { url: fake.url, apiKey: "tmx" } }),
  );
});
afterAll(() => {
  sshServer.close();
  fake.close();
});

const run = (command: string) =>
  termix.execute("termix_run_command", { host: "vm-test", command }, call());

describe("Termix direct SSH fallback", () => {
  it("when Termix cannot run it, NOVA runs the command over SSH with the login Termix holds", async () => {
    snippetWorks = false;
    const result = await run("uptime");
    expect(result.ok, JSON.stringify(result)).toBe(true);
    expect(result.result).toMatchObject({
      via: "ssh",
      output: "ran: uptime\n",
      error: "a warning\n",
      exitCode: 0,
    });
    expect((result.result as { note: string }).note).toBe(
      "Termix kon het zelf niet uitvoeren; NOVA deed het rechtstreeks over SSH.",
    );
    expect(JSON.stringify(result)).not.toContain("termix-pw");
    expect(ran.at(-1)).toBe("uptime");
  });

  it("Termix itself is used first when it works", async () => {
    snippetWorks = true;
    const before = ran.length;
    const result = await run("id");
    expect((result.result as { via: string }).via).toBe("termix");
    expect(ran.length).toBe(before);
    snippetWorks = false;
  });

  it("never retries over SSH after sending a snippet for execution", async () => {
    snippetWorks = true;
    executeFails = true;
    const before = ran.length;
    try {
      const result = await run("uptime");
      expect(result.ok).toBe(false);
      expect(ran).toHaveLength(before);
    } finally {
      executeFails = false;
      snippetWorks = false;
    }
  });

  it("does not echo an upstream host label in a failed command error", async () => {
    hostName = "vm-test bearer sensitive-host-label";
    snippetWorks = true;
    executeFails = true;
    try {
      const result = await termix.execute(
        "termix_run_command",
        { host: hostName, command: "uptime" },
        call(),
      );
      expect(result.ok).toBe(false);
      expect(JSON.stringify(result)).not.toContain(hostName);
      expect(result.error).toMatch(/server weigerde de login/);
    } finally {
      hostName = "vm-test";
      snippetWorks = false;
      executeFails = false;
    }
  });

  it("a server whose key does not match what Termix knows is never logged into", async () => {
    fingerprint = "00".repeat(51);
    const before = ran.length;
    const result = await run("uptime");
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/sleutel van de server klopt niet/);
    expect(ran.length).toBe(before);
    fingerprint = "";
    expect((await run("uptime")).error).toMatch(
      /kent de sleutel van deze server nog niet/,
    );
    fingerprint = blob.toString("hex");
  });

  it("the server key compares as Termix stores it: raw hex, SHA-256 hex or SHA256: base64", () => {
    const hash = crypto.createHash("sha256").update(blob).digest();
    expect(sameHostKey(blob, blob.toString("hex"))).toBe(true);
    expect(sameHostKey(blob, hash.toString("hex"))).toBe(true);
    expect(
      sameHostKey(blob, `SHA256:${hash.toString("base64").replace(/=+$/, "")}`),
    ).toBe(true);
    expect(sameHostKey(blob, "00ff")).toBe(false);
  });
});
