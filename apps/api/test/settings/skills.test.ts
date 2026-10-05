import fs from "node:fs";
import path from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { NovaConfig } from "../../src/core/config/nova-config.js";
import {
  assertSkillTarget,
  forbiddenAddress,
  sendRequest,
} from "../../src/core/security/safe-request.js";
import { runSkill } from "../../src/settings/skills/run-skill.js";
import {
  formatPlaybooks,
  normalizeSkill,
  pick,
  publicSkill,
  relevantPlaybooks,
  render,
  renderRequest,
  toolDefinition,
  validateArguments,
  type StoredSkill,
  type StoredWebhookSkill,
} from "../../src/settings/skills/skills.js";
import { SkillsSource } from "../../src/settings/skills/skills.source.js";
import { SettingsStore } from "../../src/settings/store/settings.store.js";
import {
  json,
  lan,
  onLan,
  playbook,
  problem,
  service,
  webhook,
} from "./helpers.js";

const config = new NovaConfig();
const store = new SettingsStore(config);
beforeEach(() => {
  fs.rmSync(path.join(config.dataDir, "settings.json"), { force: true });
  store.reset();
});

const hook = (input: unknown, options?: Parameters<typeof normalizeSkill>[1]) =>
  normalizeSkill(input, options) as StoredWebhookSkill;

describe("skills", () => {
  it("makes a webhook skill a tool definition with its parameters and risk", () => {
    const skill = hook(webhook());
    expect(skill.id).toBe("garagedeur");
    const definition = toolDefinition(skill);
    expect(definition.name).toBe("skill_garagedeur");
    expect(definition.description).toBe(
      "Open of sluit de garagedeur van het huis",
    );
    expect(definition.properties.actie).toEqual({
      type: "string",
      description: "open of dicht",
      enum: ["open", "dicht"],
    });
    expect(definition.required).toEqual(["actie"]);
    expect(definition.risk).toBe("CONFIRM");
  });

  it("says in Dutch what is wrong", () => {
    const base = webhook();
    const cases: [unknown, RegExp][] = [
      [{ ...base, name: "x" }, /naam van minstens 2/],
      [{ ...base, name: "x".repeat(61) }, /te lang/],
      [{ ...base, description: "kort" }, /minstens 10 tekens/],
      [{ ...base, type: "iets" }, /Kies een soort/],
      [{ ...base, http: undefined }, /HTTP-aanroep ontbreekt/],
      [
        webhook({ http: { ...base.http, url: "ftp://x.nl/a" } }),
        /http:\/\/ of https:\/\//,
      ],
      [
        webhook({ http: { ...base.http, url: "http://user:pw@x.nl/a" } }),
        /gebruikersnaam/,
      ],
      [webhook({ http: { ...base.http, url: "geen url" } }), /geldige URL/],
      [
        webhook({ http: { ...base.http, url: "http://x.nl/{onbekend}" } }),
        /\{onbekend\}.*geen parameter/,
      ],
      [webhook({ http: { ...base.http, method: "GET" } }), /geen body/],
      [
        webhook({ parameters: [{ name: "Actie" }] }),
        /de naam moet met een kleine letter/,
      ],
      [webhook({ parameters: [{ name: "a" }, { name: "a" }] }), /twee keer/],
      [
        webhook({ parameters: [{ name: "a", type: "integer", enum: ["1"] }] }),
        /alleen bij tekst/,
      ],
      [
        webhook({
          http: { ...base.http, headers: [{ name: "Host", value: "x" }] },
        }),
        /kan niet worden ingesteld/,
      ],
      [
        webhook({
          http: {
            ...base.http,
            secretHeaders: [{ name: "X-Token", value: "" }],
          },
        }),
        /Geef een waarde op/,
      ],
      [
        webhook({ http: { ...base.http, extract: "a b" } }),
        /pad voor het antwoord/,
      ],
      [playbook({ instructions: "" }), /Schrijf de instructies/],
      [
        playbook({
          examples: Array.from({ length: 9 }, (_, i) => `voorbeeld ${i}`),
        }),
        /Maximaal 8 voorbeelden/,
      ],
    ];
    for (const [input, expected] of cases)
      expect(problem(() => normalizeSkill(input))).toMatch(expected);
    expect(
      problem(() => normalizeSkill(playbook(), { takenIds: ["filmavond"] })),
    ).toMatch(/bestaat al/);
  });

  it("never calls a call that changes something READ_ONLY, and keeps the timeout in range", () => {
    expect(hook(webhook({ risk: "READ_ONLY" })).risk).toBe("SAFE");
    const get = webhook({
      risk: "READ_ONLY",
      parameters: [],
      http: { method: "GET", url: "http://x.nl/a", timeoutMs: 999999 },
    });
    const skill = hook(get);
    expect(skill.risk).toBe("READ_ONLY");
    expect(skill.http.timeoutMs).toBe(30000);
    expect(
      hook({ ...get, http: { ...get.http, timeoutMs: 5 } }).http.timeoutMs,
    ).toBe(1000);
    expect(hook(webhook({ risk: "weird" })).risk).toBe("SAFE");
  });

  it("keeps the type and the stored secret on edit, and the screen never sees it", () => {
    const created = hook(webhook());
    const publicView = publicSkill(created);
    expect(
      publicView.type === "webhook" && publicView.http.secretHeaders,
    ).toEqual([{ name: "X-Token", set: true }]);
    expect(JSON.stringify(publicView)).not.toContain("geheim-123");
    const edited = hook(
      {
        ...webhook({ name: "Garagedeur nieuw", type: "instruction" }),
        http: {
          ...webhook().http,
          secretHeaders: [{ name: "X-Token", value: "" }],
        },
      },
      { existing: created },
    );
    expect(edited.id).toBe("garagedeur");
    expect(edited.type).toBe("webhook");
    expect(edited.http.secretHeaders[0]?.value).toBe("geheim-123");
    expect(edited.version).toBe(2);
    expect(edited.createdAt).toBe(created.createdAt);
    const replaced = hook(
      {
        ...webhook(),
        http: {
          ...webhook().http,
          secretHeaders: [{ name: "X-Token", value: "nieuw" }],
        },
      },
      { existing: created },
    );
    expect(replaced.http.secretHeaders[0]?.value).toBe("nieuw");
  });

  it("builds the request with encoded URLs, escaped JSON and the secret header", () => {
    const skill = hook({
      ...webhook(),
      parameters: [
        { name: "tekst", type: "string" },
        { name: "aantal", type: "integer" },
      ],
      http: {
        method: "POST",
        url: "http://x.nl/s/{tekst}?n={aantal}",
        body: '{"msg":"{tekst}","n":{aantal}}',
        headers: [{ name: "X-Naam", value: "nova-{tekst}" }],
        secretHeaders: [{ name: "Authorization", value: "Bearer abc" }],
      },
    });
    const request = renderRequest(skill, {
      tekst: 'hallo "wereld" & meer/\nregel',
      aantal: 3,
    });
    expect(request.url).toBe(
      "http://x.nl/s/hallo%20%22wereld%22%20%26%20meer%2F%0Aregel?n=3",
    );
    expect(JSON.parse(request.body ?? "")).toEqual({
      msg: 'hallo "wereld" & meer/\nregel',
      n: 3,
    });
    expect(request.headers.Authorization).toBe("Bearer abc");
    expect(request.headers["X-Naam"]).toBe(
      'nova-hallo "wereld" & meer/\nregel',
    );
    expect(request.headers["Content-Type"]).toBe("application/json");
    expect(render("a/{x}", { x: "../etc/passwd" }, "url")).toBe(
      "a/..%2Fetc%2Fpasswd",
    );
  });

  it("treats a value in a path as a single segment, even when it looks like more", () => {
    expect(render("/{p}", { p: "a/b?c=d#e" }, "url")).toBe(
      "/a%2Fb%3Fc%3Dd%23e",
    );
    expect(render("/{p}", {}, "url")).toBe("/");
  });

  it("checks the arguments the model gives before anything is sent", () => {
    const skill = hook({
      ...webhook(),
      parameters: [
        { name: "actie", type: "string", enum: ["open", "dicht"] },
        { name: "keer", type: "integer", required: false },
        { name: "aan", type: "boolean", required: false },
      ],
    });
    expect(validateArguments(skill, { actie: "open" })).toEqual([]);
    expect(validateArguments(skill, {})).toEqual([
      "De parameter actie ontbreekt.",
    ]);
    expect(validateArguments(skill, { actie: "half" })[0]).toMatch(
      /moet een van deze zijn/,
    );
    expect(validateArguments(skill, { actie: "open", extra: 1 })[0]).toMatch(
      /Onbekende parameter: extra/,
    );
    expect(validateArguments(skill, { actie: "open", keer: 1.5 })[0]).toMatch(
      /geheel getal/,
    );
    expect(validateArguments(skill, { actie: "open", keer: "2" })[0]).toMatch(
      /getal/,
    );
    expect(validateArguments(skill, { actie: "open", aan: "ja" })[0]).toMatch(
      /waar of onwaar/,
    );
    expect(
      validateArguments(skill, { actie: "open", keer: null, aan: "" }),
    ).toHaveLength(0);
  });

  it("picks a value out of the answer by path", () => {
    const data = {
      result: { items: [{ name: "a" }, { name: "b" }], state: "on" },
    };
    expect(pick(data, "result.state")).toBe("on");
    expect(pick(data, "result.items[1].name")).toBe("b");
    expect(pick(data, "result.nee.diep")).toBeUndefined();
    expect(pick(data, "")).toBe(data);
    expect(pick("tekst", "a")).toBeUndefined();
  });

  it("offers playbooks only when the request fits, best match first", () => {
    const list: StoredSkill[] = [
      normalizeSkill(playbook()),
      normalizeSkill(
        playbook({
          name: "Naar bed",
          description: "Alles uit voor de nacht",
          examples: ["ik ga slapen"],
          instructions: "Zet alle lampen uit.",
        }),
      ),
      normalizeSkill(
        playbook({
          name: "Uitgezet",
          enabled: false,
          examples: ["start filmavond"],
        }),
      ),
    ];
    const names = (message: string) =>
      relevantPlaybooks(message, list).map((item) => item.name);
    expect(names("start filmavond graag")).toEqual(["Filmavond"]);
    expect(names("ik ga slapen")).toEqual(["Naar bed"]);
    expect(names("wat is het weer")).toEqual([]);
    expect(names("")).toEqual([]);
    const first = relevantPlaybooks("start filmavond", list);
    expect(formatPlaybooks(first)).toMatch(
      /Filmavond \(Sfeer voor een film\): Dim de lampen/,
    );
  });
});

describe("where a webhook may go", () => {
  it("blocks addresses that would defeat the safeguards even when the local network is allowed", () => {
    for (const url of [
      "http://127.0.0.1/",
      "http://localhost/",
      "http://169.254.169.254/latest/meta-data",
      "http://0.0.0.0/",
      "http://[::1]/",
      "http://jarvis-api:3000/x",
      "http://node-red:1880/jarvis/tool",
      "http://mqtt/",
      "http://omniroute:20128/",
      "http://qdrant:6333/",
      "http://x.localhost/",
      "http://224.0.0.1/",
    ])
      expect(
        () => assertSkillTarget(url, { allowPrivate: true }),
        url,
      ).toThrow();
    expect(forbiddenAddress("169.254.1.1")).toBe(true);
    expect(forbiddenAddress("::ffff:127.0.0.1")).toBe(true);
    expect(forbiddenAddress("192.168.1.5")).toBe(false);
  });

  it("allows only public hosts on the web ports without the local-network switch", () => {
    for (const url of [
      "http://192.168.2.50/api",
      "http://10.0.0.5/",
      "http://printer/",
      "https://example.com:8443/",
      "http://nas:5000/",
      "ftp://x.nl/",
      "http://u:p@x.nl/",
    ])
      expect(() => assertSkillTarget(url), url).toThrow();
    expect(assertSkillTarget("https://api.example.com/x").hostname).toBe(
      "api.example.com",
    );
    expect(
      assertSkillTarget("http://192.168.2.50:8123/api", { allowPrivate: true })
        .port,
    ).toBe("8123");
    expect(
      assertSkillTarget("http://printer/", { allowPrivate: true }).hostname,
    ).toBe("printer");
  });

  it("never lets a blocked target or bad arguments reach the network", async () => {
    const skill = hook({
      ...webhook(),
      http: {
        ...webhook().http,
        url: "http://node-red:1880/jarvis/tool?x={actie}",
      },
    });
    const blocked = await runSkill(skill, { actie: "open" });
    expect(blocked.ok).toBe(false);
    expect(blocked.error).toMatch(/NOVA zelf/);
    const wrong = await runSkill(hook(webhook()), { actie: "half" });
    expect(wrong.error).toMatch(/moet een van deze zijn/);
    await expect(
      sendRequest("http://127.0.0.1:9/", { allowPrivate: true }),
    ).rejects.toThrow(/geblokkeerd/);
  });

  it("stops a hostname that resolves to this machine when the connection is made", async () => {
    await expect(
      sendRequest("http://127.0.0.1.nip.io/", {
        allowPrivate: true,
        timeoutMs: 3000,
      }),
    ).rejects.toThrow(
      /Blocked|geblokkeerd|ENOTFOUND|EAI_AGAIN|timed out|te lang/,
    );
  });
});

describe.skipIf(!lan)("running a skill against a real server", () => {
  it("calls the service with the method, path, headers, secret and body", async () => {
    const fake = await service((_entry, response) =>
      json(response, 200, { result: { state: "open" }, extra: "x" }),
    );
    try {
      const skill = hook({
        ...webhook(),
        http: {
          ...webhook().http,
          url: onLan(fake.port, "/api/{actie}"),
          allowPrivate: true,
          extract: "result.state",
        },
      });
      const out = await runSkill(skill, { actie: "open" });
      expect(out.ok).toBe(true);
      expect(out.result?.response).toBe("open");
      expect(out.result?.untrusted).toBe(true);
      expect(out.result?.status).toBe(200);
      const call = fake.seen[0]!;
      expect(call.method).toBe("POST");
      expect(call.url).toBe("/api/open");
      expect(call.headers["x-token"]).toBe("geheim-123");
      expect(call.headers["x-source"]).toBe("nova");
      expect(JSON.parse(call.body)).toEqual({ door: "garage", do: "open" });
      expect(call.headers["user-agent"]).toBe("NOVA/1.0");
    } finally {
      fake.close();
    }
  });

  it("reports errors, a missing answer path and a hung service plainly", async () => {
    const fake = await service((entry, response) => {
      if (entry.url?.startsWith("/boom"))
        return json(response, 500, { error: "stuk" });
      if (entry.url?.startsWith("/hang")) return;
      if (entry.url?.startsWith("/redirect")) {
        response.writeHead(302, { location: "http://169.254.169.254/" });
        return response.end();
      }
      return json(response, 200, { a: 1 });
    });
    try {
      const make = (url: string, extra: Record<string, unknown> = {}) =>
        hook({
          type: "webhook",
          name: "Test dienst",
          description: "Een test van een dienst",
          parameters: [],
          http: {
            method: "GET",
            url: onLan(fake.port, url),
            allowPrivate: true,
            ...extra,
          },
        });
      const failed = await runSkill(make("/boom"), {});
      expect(failed.ok).toBe(false);
      expect(failed.error).toMatch(/HTTP 500/);
      expect(failed.result?.response).toEqual({ error: "stuk" });
      const noPath = await runSkill(make("/ok", { extract: "b.c" }), {});
      expect(noPath.ok).toBe(true);
      expect(noPath.result?.note).toMatch(/komt niet voor/);
      const hung = await runSkill(make("/hang", { timeoutMs: 1000 }), {});
      expect(hung.ok).toBe(false);
      expect(hung.error).toMatch(/te lang/);
      const redirect = await runSkill(make("/redirect"), {});
      expect(redirect.ok).toBe(true); // a redirect is reported, never followed
      expect(redirect.result?.status).toBe(302);
      expect(redirect.result?.location).toBe("http://169.254.169.254/");
    } finally {
      fake.close();
    }
  });

  it("offers enabled webhook skills as tools and runs them", async () => {
    const fake = await service((_entry, response) =>
      json(response, 200, { ok: true }),
    );
    try {
      const http = (tail: string) => ({
        ...webhook().http,
        url: onLan(fake.port, tail),
        allowPrivate: true,
      });
      store.update(
        (settings) =>
          void (settings.skills = [
            normalizeSkill({ ...webhook(), http: http("/api/{actie}") }),
            normalizeSkill({
              ...webhook({ name: "Uitgezet" }),
              enabled: false,
              http: http("/x/{actie}"),
            }),
            normalizeSkill(playbook()),
          ] as never[]),
      );
      const source = new SkillsSource(store);
      const call = { sessionId: "t", signal: AbortSignal.timeout(5000) };
      const definitions = source.definitions();
      expect(definitions.map((item) => item.name)).toEqual([
        "skill_garagedeur",
      ]);
      expect(definitions[0]).toMatchObject({
        risk: "CONFIRM",
        parameters: { required: ["actie"] },
      });
      expect(
        (await source.execute("skill_garagedeur", { actie: "dicht" }, call)).ok,
      ).toBe(true);
      expect(fake.seen[0]?.url).toBe("/api/dicht");
      expect(
        (await source.execute("skill_uitgezet", { actie: "open" }, call)).error,
      ).toMatch(/bestaat niet of staat uit/);
      store.update((settings) => void (settings.skills = []));
      expect(source.definitions()).toEqual([]); // a deleted skill is gone at once
    } finally {
      fake.close();
    }
  });
});
