import { afterAll, beforeAll, expect, it } from "vitest";
import { PangolinService } from "../../src/integrations/pangolin/pangolin.service.js";
import { call, fakeConfig, listen } from "./helpers.js";

let fake: Awaited<ReturnType<typeof listen>>;
let errorReply = false;
beforeAll(async () => {
  fake = await listen((seen, send) =>
    errorReply
      ? send(503, { message: "private-upstream-diagnostic-8293" })
      : seen.url === "/org/home/sites"
        ? send(200, {
            data: {
              sites: [
                { id: "site-1", name: "vps", online: true },
                { id: "site-2", name: "hidden", online: false },
              ],
            },
          })
        : send(404, {}),
  );
});

it("does not expose upstream error details through tool results", async () => {
  const pangolin = new PangolinService(
    fakeConfig({
      pangolin: { url: fake.url, apiKey: "pk", orgId: "home" },
    }),
  );
  errorReply = true;
  try {
    const sites = await pangolin.execute("pangolin_sites", {}, call());
    const orgs = await pangolin.execute("pangolin_orgs", {}, call());
    expect(sites).toMatchObject({
      ok: false,
      error: "Pangolin request failed. Check the connection and configuration.",
    });
    expect(orgs).toMatchObject({ ok: false, error: "Pangolin error (503)" });
    expect(JSON.stringify([sites, orgs])).not.toContain(
      "private-upstream-diagnostic-8293",
    );
  } finally {
    errorReply = false;
  }
});
afterAll(() => fake.close());

it("sends the API key and Host override", async () => {
  fake.requests.length = 0;
  const pangolin = new PangolinService(
    fakeConfig({
      pangolin: {
        url: fake.url,
        apiKey: "pk",
        host: "api.example.test",
        orgId: "home",
        insecureTls: false,
      },
    }),
  );
  expect(await pangolin.execute("pangolin_sites", {}, call())).toEqual({
    ok: true,
    result: {
      sites: [
        { id: "site-1", name: "vps", online: true },
        { id: "site-2", name: "hidden", online: false },
      ],
    },
  });
  const seen = fake.requests.find((item) => item.url === "/org/home/sites")!;
  expect(seen.headers.authorization).toBe("Bearer pk");
  expect(seen.headers.host).toBe("api.example.test");
  const none = new PangolinService(
    fakeConfig({ pangolin: { url: fake.url, apiKey: "pk", orgId: "" } }),
  );
  expect((await none.execute("pangolin_sites", {}, call())).ok).toBe(false);
  expect(none.definitions().every((tool) => tool.risk === "READ_ONLY")).toBe(
    true,
  );
  expect(
    new PangolinService(fakeConfig({ pangolin: {} })).definitions()[0]?.enabled,
  ).toBe(false);
});

it("filters Pangolin targets by allowlist and rejects another organization", async () => {
  const targetAccess = {
    get: () => ({ mode: "allowlist" }),
    allows: (_key: string, id: string) => id === "site-1",
  };
  const pangolin = new PangolinService(
    fakeConfig({
      pangolin: {
        url: fake.url,
        apiKey: "pk",
        orgId: "home",
        insecureTls: false,
      },
    }),
    targetAccess as never,
  );
  expect(await pangolin.execute("pangolin_sites", {}, call())).toEqual({
    ok: true,
    result: { sites: [{ id: "site-1", name: "vps", online: true }] },
  });
  expect(
    await pangolin.execute("pangolin_sites", { orgId: "other" }, call()),
  ).toMatchObject({ ok: false });
  expect(fake.requests.some((item) => item.url?.includes("/org/other/"))).toBe(
    false,
  );
});
