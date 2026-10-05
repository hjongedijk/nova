import { afterAll, beforeAll, expect, it } from "vitest";
import { PangolinService } from "../../src/integrations/pangolin/pangolin.service.js";
import { call, fakeConfig, listen } from "./helpers.js";

let fake: Awaited<ReturnType<typeof listen>>;
beforeAll(async () => {
  fake = await listen((seen, send) =>
    seen.url === "/org/home/sites"
      ? send(200, { data: { sites: [{ name: "vps", online: true }] } })
      : send(404, {}),
  );
});
afterAll(() => fake.close());

it("sends the API key and Host override", async () => {
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
    result: { sites: [{ name: "vps", online: true }] },
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
