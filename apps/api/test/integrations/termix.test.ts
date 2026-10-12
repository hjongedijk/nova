import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { TermixService } from "../../src/integrations/termix/termix.service.js";
import { call, fakeConfig, listen } from "./helpers.js";

let fake: Awaited<ReturnType<typeof listen>>;
const service = (url: string, apiKey: string) =>
  new TermixService(fakeConfig({ termix: { url, apiKey } }));

beforeAll(async () => {
  fake = await listen((seen, send) => {
    const { url = "", method } = seen;
    if (url === "/users/me") return send(200, { username: "jarvis" });
    if (url === "/health") return send(200, { status: "ok" });
    if (url === "/host/db/host")
      return seen.headers.authorization === "Bearer tmx_key"
        ? send(200, [
            {
              id: 1,
              name: "debian-x - NAS100",
              ip: "10.0.0.2",
              port: 22,
              username: "root",
              password: "secret",
            },
          ])
        : send(401, {});
    if (url === "/plugin-api/snippets" && method === "POST")
      return send(201, { id: 7 });
    if (url === "/plugin-api/snippets/execute")
      return send(200, {
        success: true,
        output: JSON.parse(seen.body).hostId === 1 ? "nas-host\n" : "?",
        exitCode: 0,
      });
    if (method === "DELETE") return send(200, {});
    send(404, {});
  });
});
afterAll(() => fake.close());

describe("TermixService", () => {
  it("is disabled until configured", () => {
    expect(service("", "").configured).toBe(false);
    for (const tool of service("", "").definitions())
      expect(tool.enabled).toBe(false);
    expect(service(fake.url, "k").definitions()[0]?.enabled).toBe(true);
  });

  it("lists hosts with the API key and never returns credentials", async () => {
    const termix = service(fake.url, "tmx_key");
    const hosts = await termix.execute("termix_hosts", {}, call());
    expect(hosts.ok).toBe(true);
    expect((hosts.result as { name: string }[])[0]?.name).toBe(
      "debian-x - NAS100",
    );
    expect(JSON.stringify(hosts)).not.toContain("secret");
    expect((await termix.execute("termix_status", {}, call())).ok).toBe(true);
    expect(
      (await service(fake.url, "bad").execute("termix_hosts", {}, call())).ok,
    ).toBe(false);
  });

  it("runs a command through a throwaway snippet and deletes it", async () => {
    const termix = service(fake.url, "tmx_key");
    expect(
      termix.definitions().find((item) => item.name === "termix_run_command")
        ?.risk,
    ).toBe("CONFIRM");
    const result = await termix.execute(
      "termix_run_command",
      { host: "nas100", command: "hostname" },
      call(),
    );
    expect(result.ok).toBe(true);
    expect((result.result as { output: string }).output).toBe("nas-host\n");
    const create = fake.requests
      .filter((item) => item.url === "/plugin-api/snippets")
      .at(-1)!;
    expect(JSON.parse(create.body).content).toBe("hostname");
    expect(
      fake.requests.some(
        (item) =>
          item.method === "DELETE" && item.url === "/plugin-api/snippets/7",
      ),
    ).toBe(true);
    expect(
      (
        await termix.execute(
          "termix_run_command",
          { host: "missing", command: "id" },
          call(),
        )
      ).ok,
    ).toBe(false);
  });

  it("does not return upstream connection diagnostics from failed snippets", async () => {
    let includeAudit = true;
    const failed = await listen((seen, send) => {
      if (seen.url === "/host/db/host")
        return send(200, [{ id: 1, name: "fixture-host" }]);
      if (seen.url === "/plugin-api/snippets" && seen.method === "POST")
        return send(201, { id: 7 });
      if (seen.url === "/plugin-api/snippets/execute")
        return send(502, { error: "upstream-diagnostic-9281" });
      if (seen.url === "/audit-logs?limit=20")
        return send(200, {
          logs: includeAudit
            ? [
                {
                  action: "ssh_connect",
                  details: "host 1",
                  success: false,
                  errorMessage: "private-host?trace=9281",
                },
              ]
            : [],
        });
      if (seen.method === "DELETE") return send(200, {});
      send(404, {});
    });
    try {
      const termix = service(failed.url, "tmx_key");
      for (const useAudit of [true, false]) {
        includeAudit = useAudit;
        const result = await termix.execute(
          "termix_run_command",
          { host: "fixture-host", command: "hostname" },
          call(),
        );
        expect(result.ok).toBe(false);
        expect(JSON.stringify(result)).not.toContain("9281");
      }
      const create = failed.requests.find(
        (item) => item.url === "/plugin-api/snippets",
      )!;
      expect(JSON.parse(create.body).name).toMatch(/^nova-/);
    } finally {
      await failed.close();
    }
  });

  it("hides and refuses hosts outside the saved allowlist", async () => {
    const targetAccess = {
      allows: () => false,
    };
    const gated = new TermixService(
      fakeConfig({ termix: { url: fake.url, apiKey: "tmx_key" } }),
      targetAccess as never,
    );
    expect(await gated.execute("termix_hosts", {}, call())).toMatchObject({
      ok: true,
      result: [],
    });
    const snippetsBefore = fake.requests.filter(
      (item) => item.url === "/plugin-api/snippets",
    ).length;
    expect(
      await gated.execute(
        "termix_run_command",
        { host: "nas100", command: "hostname" },
        call(),
      ),
    ).toMatchObject({ ok: false, error: "Unknown Termix host" });
    expect(
      fake.requests.filter((item) => item.url === "/plugin-api/snippets"),
    ).toHaveLength(snippetsBefore);
  });
});
