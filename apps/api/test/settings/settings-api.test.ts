import fs from "node:fs";
import path from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { DEFAULT_QUICK_ACTIONS } from "../../src/settings/store/settings.store.js";
import type { WallpaperPort } from "../../src/settings/wallpaper.port.js";
import {
  ADMIN,
  createApp,
  type Reply,
  json,
  lan,
  onLan,
  playbook,
  service,
  type TestApp,
  webhook,
} from "./helpers.js";

let nova: TestApp;
const improveCalls: string[] = [];

beforeAll(async () => {
  nova = await createApp({
    llm: {
      complete: async (messages) => {
        improveCalls.push(messages[1]!.content);
        const draft = JSON.parse(messages[1]!.content).concept;
        return JSON.stringify({
          description: `Beter: ${draft.name}`,
          notes: "ok",
        });
      },
    },
  });
});
afterAll(() => nova.app.close());
beforeEach(() => {
  fs.rmSync(path.join(nova.store["file" as never] as string), { force: true });
  nova.store.reset();
  nova.audits.length = 0;
});

const call = async (
  method: "get" | "post" | "put" | "delete",
  route: string,
  body?: unknown,
  headers: Record<string, string> = ADMIN,
): Promise<Reply> => {
  const response = await nova.api[method](`/api/settings${route}`)
    .set(headers)
    .send(body as object | undefined);
  return { status: response.status, ...(response.body as object) };
};

describe("the settings API", () => {
  it("needs the admin header for writes, and reads the home screen without it", async () => {
    expect((await call("put", "/persona", { text: "x" }, {})).status).toBe(403);
    expect((await call("post", "/skills", playbook(), {})).status).toBe(403);
    expect((await call("get", "/", undefined, {})).status).toBe(200);
    const pub = await call("get", "/public", undefined, {});
    expect(pub.status).toBe(200);
    expect(pub.quickActions).toEqual(DEFAULT_QUICK_ACTIONS);
  });

  it("protects everything except the public list when a PIN is set", async () => {
    const pinned = await createApp({ env: { NOVA_ADMIN_PIN: "4321" } });
    try {
      const send = (
        method: "get" | "put",
        route: string,
        headers: Record<string, string>,
        body?: object,
      ) =>
        pinned.api[method](`/api/settings${route}`)
          .set(headers)
          .send(body)
          .then((r) => ({ status: r.status, body: r.body }));
      const denied = await send("get", "/", {});
      expect(denied.status).toBe(401);
      expect(denied.body).toEqual({ error: "PIN vereist", pinRequired: true });
      expect((await send("get", "/", { "x-nova-pin": "0000" })).status).toBe(
        401,
      );
      const ok = await send("get", "/", { "x-nova-pin": "4321" });
      expect(ok.status).toBe(200);
      expect(ok.body.pinRequired).toBe(true);
      // the PIN alone does not allow a write
      expect(
        (await send("put", "/persona", { "x-nova-pin": "4321" }, { text: "x" }))
          .status,
      ).toBe(403);
      expect(
        (
          await send(
            "put",
            "/persona",
            { "x-nova-pin": "4321", ...ADMIN },
            { text: "x" },
          )
        ).status,
      ).toBe(200);
      expect((await send("get", "/public", {})).status).toBe(200);
    } finally {
      await pinned.app.close();
    }
  });

  it("creates, changes, switches off and deletes skills, and logs each change", async () => {
    const created = await call("post", "/skills", playbook());
    expect(created.status).toBe(201);
    expect(created.skill.id).toBe("filmavond");
    expect((await call("post", "/skills", playbook())).status).toBe(400);
    const changed = await call("put", "/skills/filmavond", {
      ...created.skill,
      instructions: "Nieuwe stappen.",
      enabled: false,
    });
    expect(changed.status).toBe(200);
    expect(changed.skill.version).toBe(2);
    expect(changed.skill.enabled).toBe(false);
    const overview = await call("get", "/");
    expect(
      overview.skills.find((item: { id: string }) => item.id === "filmavond")
        .instructions,
    ).toBe("Nieuwe stappen.");
    expect((await call("put", "/skills/bestaatniet", playbook())).status).toBe(
      404,
    );
    const bad = await call("put", "/skills/filmavond", {
      ...created.skill,
      instructions: "",
    });
    expect(bad.status).toBe(400);
    expect(bad.error).toMatch(/Schrijf de instructies/);
    expect((await call("delete", "/skills/filmavond")).status).toBe(200);
    const gone = await call("delete", "/skills/filmavond");
    expect(gone.status).toBe(404);
    expect(gone.error).toBe("Die vaardigheid bestaat niet.");
    expect(
      nova.audits.map((item) => (item.arguments as { what: string }).what),
    ).toEqual(["skill-created", "skill-updated", "skill-deleted"]);
    expect(
      nova.audits.every(
        (item) =>
          item.sessionId === "settings" &&
          item.tool === "settings_change" &&
          item.confirmation === "admin_ui",
      ),
    ).toBe(true);
  });

  it("offers an enabled webhook skill to the model at once", async () => {
    await call("post", "/skills", webhook());
    expect(nova.tools.list().map((tool) => tool.name)).toContain(
      "skill_garagedeur",
    );
    expect(
      nova.tools.list().find((t) => t.name === "skill_garagedeur"),
    ).toMatchObject({
      source: "skills",
      risk: "CONFIRM",
    });
    await call("delete", "/skills/garagedeur");
    expect(nova.tools.list().map((tool) => tool.name)).not.toContain(
      "skill_garagedeur",
    );
  });

  it("stores a secret, never returns it, and keeps it on edit", async () => {
    const created = await call("post", "/skills", webhook());
    expect(created.status).toBe(201);
    expect(JSON.stringify(created)).not.toContain("geheim-123");
    expect(JSON.stringify(await call("get", "/"))).not.toContain("geheim-123");
    expect(JSON.stringify(await call("get", "/export"))).not.toContain(
      "geheim-123",
    );
    const edited = await call("put", "/skills/garagedeur", {
      ...created.skill,
      description: "Een andere beschrijving van de deur",
    });
    expect(edited.status).toBe(200);
    const stored = nova.store.get().skills[0] as {
      http: { secretHeaders: { value: string }[] };
    };
    expect(stored.http.secretHeaders[0]?.value).toBe("geheim-123");
  });

  it("switches built-in tools off, edits them and restores them", async () => {
    let overview = await call("get", "/");
    expect(overview.tools[0].enabled).toBe(true);
    await call("put", "/tools/echo", {
      enabled: false,
      description: "Mijn eigen uitleg voor echo",
    });
    overview = await call("get", "/");
    const echo = overview.tools.find(
      (item: { name: string }) => item.name === "echo",
    );
    expect(echo).toMatchObject({
      enabled: false,
      switchedOff: true,
      edited: true,
      description: "Mijn eigen uitleg voor echo",
      defaultDescription: "Return supplied text",
    });
    expect(
      (await call("put", "/tools/echo", { description: "kort" })).status,
    ).toBe(400);
    expect((await call("delete", "/tools/echo")).status).toBe(200);
    const restored = (await call("get", "/")).tools.find(
      (item: { name: string }) => item.name === "echo",
    );
    expect(restored.enabled).toBe(true);
    expect(restored.description).toBe("Return supplied text");
  });

  it("sets personal rules and quick actions, including going back to the defaults", async () => {
    expect(
      (await call("put", "/persona", { text: "Spreek me aan met Harm." }))
        .status,
    ).toBe(200);
    expect((await call("get", "/")).persona).toBe("Spreek me aan met Harm.");
    expect(
      (await call("put", "/persona", { text: "x".repeat(2001) })).status,
    ).toBe(400);
    const items = [
      { label: "Licht aan", prompt: "Zet het licht in de woonkamer aan" },
    ];
    expect(
      (await call("put", "/quick-actions", { items })).quickActions,
    ).toEqual(items);
    expect((await call("get", "/public", undefined, {})).quickActions).toEqual(
      items,
    );
    expect((await call("get", "/")).quickActionsAreDefault).toBe(false);
    expect(
      (
        await call("put", "/quick-actions", {
          items: [{ label: "", prompt: "x" }],
        })
      ).status,
    ).toBe(400);
    expect(
      (await call("put", "/quick-actions", { reset: true })).quickActions,
    ).toEqual(DEFAULT_QUICK_ACTIONS);
    expect((await call("get", "/")).quickActionsAreDefault).toBe(true);
  });

  it("shows examples in the public list only for skills that are on", async () => {
    await call("post", "/skills", playbook());
    await call(
      "post",
      "/skills",
      playbook({ name: "Uit", enabled: false, examples: ["verborgen"] }),
    );
    const pub = await call("get", "/public", undefined, {});
    expect(pub.skillExamples).toEqual([
      {
        name: "Filmavond",
        examples: ["start filmavond", "ik wil een film kijken"],
      },
    ]);
  });

  it.skipIf(!lan)("tests a draft before it is saved", async () => {
    const fake = await service((_entry, response) =>
      json(response, 200, { state: "open" }),
    );
    try {
      const draft = {
        ...webhook(),
        http: {
          ...webhook().http,
          url: onLan(fake.port, "/api/{actie}"),
          allowPrivate: true,
          extract: "state",
        },
      };
      const ok = await call("post", "/skills/test", {
        skill: draft,
        args: { actie: "open" },
      });
      expect(ok.type).toBe("webhook");
      expect(ok.ok).toBe(true);
      expect(ok.result.response).toBe("open");
      expect(nova.store.get().skills).toHaveLength(0); // a test saves nothing
      const wrong = await call("post", "/skills/test", {
        skill: draft,
        args: { actie: "half" },
      });
      expect(wrong.ok).toBe(false);
      expect(wrong.error).toMatch(/moet een van deze zijn/);
      expect(
        (
          await call("post", "/skills/test", {
            skill: { ...draft, name: "" },
            args: {},
          })
        ).status,
      ).toBe(400);
    } finally {
      fake.close();
    }
  });

  it("tests whether a playbook would be picked", async () => {
    const match = await call("post", "/skills/test", {
      skill: playbook(),
      phrase: "start filmavond",
    });
    expect(match).toMatchObject({ type: "instruction", matched: true });
    expect(
      (
        await call("post", "/skills/test", {
          skill: playbook(),
          phrase: "wat is het weer",
        })
      ).matched,
    ).toBe(false);
  });

  it("lists the recent runs of a skill from the action log", async () => {
    nova.audit.record({
      tool: "skill_garagedeur",
      result: { ok: true },
      arguments: { actie: "dicht" },
    });
    nova.audit.record({ tool: "echo", result: { ok: true } });
    nova.audit.record({
      tool: "skill_garagedeur",
      result: { ok: false, error: "HTTP 500" },
      arguments: { actie: "open" },
    });
    const runs = (await call("get", "/skills/garagedeur/runs")).runs;
    expect(
      runs.map((item: { ok: boolean; error: string }) => [item.ok, item.error]),
    ).toEqual([
      [false, "HTTP 500"],
      [true, null],
    ]);
    expect(runs[0].at).toBeTruthy();
    expect((await call("get", "/skills/nietbestaand/runs")).runs).toEqual([]);
  });

  it("proposes an improvement and saves nothing", async () => {
    const proposal = await call("post", "/skills/improve", {
      skill: playbook(),
      goal: "duidelijker",
    });
    expect(proposal.ok).toBe(true);
    expect(proposal.changes.description).toBe("Beter: Filmavond");
    expect(nova.store.get().skills).toHaveLength(0);
    expect((await call("post", "/skills/improve", {})).status).toBe(400);
    expect(JSON.parse(improveCalls.at(-1)!).doel).toBe("duidelijker");
  });

  it("drafts a skill from a description", async () => {
    const draft = await call("post", "/skills/draft", {
      description: "Als ik goedenacht zeg, zet dan alle lampen uit",
    });
    expect(draft.ok).toBe(true);
    expect(draft.fellBack).toBe(true); // the fake model answers with a skill proposal, not a draft
    expect(draft.draft.type).toBe("instruction");
    expect(
      (await call("post", "/skills/draft", { description: "kort" })).status,
    ).toBe(400);
  });

  it("restores skills and settings from a backup, without the secrets", async () => {
    await call("post", "/skills", webhook());
    await call("post", "/skills", playbook());
    await call("put", "/persona", { text: "Kort antwoorden." });
    await call("put", "/tools/echo", { enabled: false });
    const backup = await call("get", "/export");
    expect(backup.format).toBe("nova-settings");
    expect(JSON.stringify(backup)).not.toContain("geheim-123");
    nova.store.update((settings) => {
      settings.skills = [];
      settings.persona = "";
      settings.toolOverrides = {};
    });
    const data = { ...backup, status: undefined };
    const restored = await call("post", "/import", { data, mode: "replace" });
    expect(restored.status).toBe(200);
    expect(restored.imported).toBe(2);
    expect(restored.missingSecrets).toEqual([
      { skill: "Garagedeur", headers: ["X-Token"] },
    ]);
    const now = nova.store.get();
    expect(now.persona).toBe("Kort antwoorden.");
    expect(now.toolOverrides).toEqual({ echo: { enabled: false } });
    const garage = now.skills.find((item) => item.id === "garagedeur") as {
      http: { secretHeaders: unknown[] };
    };
    expect(garage.http.secretHeaders).toEqual([]);
    expect(
      (await call("post", "/import", { data: { format: "iets-anders" } }))
        .status,
    ).toBe(400);
    expect(
      (
        await call("post", "/import", {
          data: { ...data, skills: [{ type: "webhook", name: "Kapot" }] },
        })
      ).status,
    ).toBe(400);
    const merged = await call("post", "/import", {
      data: {
        ...data,
        skills: [playbook({ name: "Extra" })],
        persona: undefined,
      },
      mode: "merge",
    });
    expect(merged.status).toBe(200);
    expect(
      nova.store
        .get()
        .skills.map((item) => item.id as string)
        .sort(),
    ).toEqual(["extra", "filmavond", "garagedeur"]);
  });

  it("has a ceiling on the number of skills", async () => {
    nova.store.update(
      (settings) =>
        void (settings.skills = Array.from({ length: 50 }, (_, i) => ({
          ...playbook({ name: `Skill ${i}`, examples: [] }),
          id: `skill_${i}`,
        }))),
    );
    const refused = await call(
      "post",
      "/skills",
      playbook({ name: "Een te veel" }),
    );
    expect(refused.status).toBe(400);
    expect(refused.error).toMatch(/Maximaal 50/);
  });

  it("groups tools in abilities and switches a whole ability", async () => {
    const overview = await call("get", "/");
    const system = overview.abilities.find(
      (a: { id: string }) => a.id === "systeem",
    );
    expect(system.tools).toContain("echo");
    expect(system.total).toBe(system.tools.length);
    const off = await call("put", "/abilities/systeem", { enabled: false });
    expect(off.status).toBe(200);
    expect(nova.store.get().toolOverrides.echo).toEqual({ enabled: false });
    expect(
      (await call("get", "/")).abilities.find(
        (a: { id: string }) => a.id === "systeem",
      ).state,
    ).toBe("off");
    await call("put", "/abilities/systeem", { enabled: true });
    expect(nova.store.get().toolOverrides.echo).toBeUndefined();
    const missing = await call("put", "/abilities/bestaat-niet", {
      enabled: true,
    });
    expect(missing.status).toBe(404);
    expect(missing.error).toBe("Dat onderdeel bestaat niet.");
    expect((await call("put", "/abilities/systeem", {})).status).toBe(400);
  });

  it("shows the public address with only its origin", async () => {
    const proxied = await createApp({
      env: { NOVA_PUBLIC_URL: "https://nova.example.com/app" },
    });
    try {
      const shown = await proxied.api.get("/api/settings/public");
      expect(shown.body.publicUrl).toBe("https://nova.example.com");
    } finally {
      await proxied.app.close();
    }
    expect((await call("get", "/public", undefined, {})).publicUrl).toBe("");
  });
});

describe("the wallpaper screen", () => {
  it("says there is no agent without a Windows module", async () => {
    const response = await call("get", "/wallpaper");
    expect(response).toMatchObject({ available: false, reason: "no-agent" });
    expect(
      (await call("post", "/wallpaper", { display: 1, mode: "full" })).status,
    ).toBe(400);
  });

  it("lists the displays and sets the wallpaper through the port", async () => {
    const displays = [
      {
        index: 1,
        name: "D1",
        primary: true,
        width: 1920,
        height: 1080,
        mode: "off",
      },
      {
        index: 2,
        name: "D2",
        primary: false,
        width: 2560,
        height: 1440,
        mode: "off",
      },
    ] as const;
    const state = displays.map((item) => ({ ...item })) as {
      index: number;
      mode: string;
    }[];
    const sets: unknown[] = [];
    let failure: string | null = null;
    const port: WallpaperPort = {
      configured: true,
      displays: async () =>
        failure
          ? { ok: false, error: failure }
          : { ok: true, displays: structuredClone(state) as never },
      setWallpaper: async (display, mode) => {
        sets.push({ display, mode });
        for (const screen of state)
          if (display === 0 || display === screen.index) screen.mode = mode;
        return { ok: true, displays: structuredClone(state) as never };
      },
      setMode: async () => ({ ok: true, displays: [] }),
      helperSize: async () => ({ ok: true }),
    };
    const wallpaper = await createApp({ wallpaper: port });
    try {
      const send = async (
        method: "get" | "post",
        body?: object,
        headers: Record<string, string> = ADMIN,
      ): Promise<Reply> => {
        const r = await wallpaper.api[method]("/api/settings/wallpaper")
          .set(headers)
          .send(body);
        return { status: r.status, ...(r.body as object) };
      };
      const listed = await send("get");
      expect(listed.available).toBe(true);
      expect(listed.displays).toHaveLength(2);
      const set = await send("post", { display: 2, mode: "sphere" });
      expect(set.displays[1].mode).toBe("sphere");
      expect(set.displays[0].mode).toBe("off");
      expect(sets.at(-1)).toEqual({ display: 2, mode: "sphere" });
      expect((await send("post", { display: 1, mode: "zwart" })).status).toBe(
        400,
      );
      expect((await send("post", { display: 99, mode: "full" })).status).toBe(
        400,
      );
      expect(
        (await send("post", { display: 1, mode: "full" }, {})).status,
      ).toBe(403);
      failure = "De agent is te oud voor deze functie.";
      expect(await send("get")).toMatchObject({
        available: false,
        reason: "old-agent",
      });
      failure = "geen verbinding";
      expect(await send("get")).toMatchObject({
        available: false,
        reason: "unreachable",
      });
      expect(
        wallpaper.audits.some(
          (row) => (row.arguments as { what?: string }).what === "wallpaper",
        ),
      ).toBe(true);
    } finally {
      await wallpaper.app.close();
    }
  });
});

describe("the helper overlay choice", () => {
  const port = (
    log: unknown[],
    failure: { error: string | null },
  ): WallpaperPort => ({
    configured: true,
    displays: async () => ({
      ok: true,
      displays: [],
      mode: "wallpaper",
      helperDisplay: 0,
    }),
    setWallpaper: async () => ({ ok: true, displays: [] }),
    setMode: async (mode, display) => {
      log.push({ mode, display });
      return failure.error
        ? { ok: false, error: failure.error }
        : { ok: true, displays: [], mode, helperDisplay: display };
    },
    helperSize: async (expanded) => {
      log.push({ expanded });
      return { ok: true };
    },
  });

  it("defaults to the wallpaper and says there is no agent without one", async () => {
    const app = await createApp();
    try {
      const got = await app.api.get("/api/settings/helper").set(ADMIN);
      expect(got.body.settings).toEqual({ mode: "wallpaper", display: 0 });
      expect(got.body.desktop).toMatchObject({ reason: "no-agent" });
      const set = await app.api
        .post("/api/settings/helper")
        .set(ADMIN)
        .send({ mode: "helper", display: 2 });
      // Saved, but not applied.
      expect(set.body).toMatchObject({
        settings: { mode: "helper", display: 2 },
        applied: false,
      });
      const again = await app.api.get("/api/settings/helper").set(ADMIN);
      expect(again.body.settings).toEqual({ mode: "helper", display: 2 });
    } finally {
      await app.app.close();
    }
  });

  it("validates, saves and applies the choice through the port", async () => {
    const log: unknown[] = [];
    const failure = { error: null as string | null };
    const app = await createApp({ wallpaper: port(log, failure) });
    try {
      const post = (body: object, headers: Record<string, string> = ADMIN) =>
        app.api.post("/api/settings/helper").set(headers).send(body);
      const ok = await post({ mode: "both", display: 1 });
      expect(ok.status).toBe(200);
      expect(ok.body).toMatchObject({
        applied: true,
        settings: { mode: "both", display: 1 },
        desktop: { available: true, mode: "both", helperDisplay: 1 },
      });
      expect(log.at(-1)).toEqual({ mode: "both", display: 1 });
      expect((await post({ mode: "scherm" })).status).toBe(400);
      expect((await post({ mode: "helper", display: 99 })).status).toBe(400);
      expect((await post({ mode: "helper", display: 1.5 })).status).toBe(400);
      expect((await post({ mode: "helper" }, {})).status).toBe(403);
      // An agent that cannot be reached: the choice is still kept.
      failure.error = "geen verbinding";
      const down = await post({ mode: "helper", display: 0 });
      expect(down.body).toMatchObject({
        applied: false,
        error: "geen verbinding",
        settings: { mode: "helper", display: 0 },
      });
      expect(
        (await app.api.get("/api/settings/helper").set(ADMIN)).body.settings,
      ).toEqual({ mode: "helper", display: 0 });
      expect(
        app.audits.some(
          (row) => (row.arguments as { what?: string }).what === "helper",
        ),
      ).toBe(true);
    } finally {
      await app.app.close();
    }
  });

  it("lets the helper page resize its window without a PIN, and only with a boolean", async () => {
    const log: unknown[] = [];
    const app = await createApp({
      env: { NOVA_ADMIN_PIN: "1234" },
      wallpaper: port(log, { error: null }),
    });
    try {
      const size = (body: object) =>
        app.api.post("/api/settings/helper/size").send(body);
      expect((await size({ expanded: true })).body).toEqual({ ok: true });
      expect(log.at(-1)).toEqual({ expanded: true });
      expect((await size({ expanded: "ja" })).status).toBe(400);
      // The choice itself still needs the PIN.
      expect((await app.api.get("/api/settings/helper")).status).toBe(401);
    } finally {
      await app.app.close();
    }
  });
});
