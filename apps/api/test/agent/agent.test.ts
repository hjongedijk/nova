import { expect, test } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { AgentService } from "../../src/agent/agent.service.js";
import { AgentSource } from "../../src/agent/agent.source.js";
import { AgentStore } from "../../src/agent/agent.store.js";

function setup(replies: Array<Record<string, unknown>>) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-"));
  const store = new AgentStore({
    dataFile: (n: string) => path.join(dir, n),
  } as never);
  const sent: string[] = [];
  const orchestrator = {
    run: async (input: { message: string }) => {
      sent.push(input.message);
      return replies.shift() ?? { reply: "KLAAR: niets meer" };
    },
  };
  const alerts: Array<{ payload: { title: string } }> = [];
  const handled: unknown[][] = [];
  const service = new AgentService(
    store,
    orchestrator as never,
    {
      handle: async (...a: unknown[]) => (handled.push(a), { reply: "gedaan" }),
    } as never,
    { add: () => undefined } as never,
    { emit: (e: { payload: { title: string } }) => alerts.push(e) } as never,
    { record: () => undefined } as never,
  );
  service.pauseMs = 0;
  service.onModuleInit();
  return { service, store, sent, alerts, handled, dir };
}

const settle = () => new Promise((r) => setTimeout(r, 30));

test("run continues until KLAAR and reports", async () => {
  const { service, alerts, sent } = setup([
    { reply: "Eerst gezocht." },
    { reply: "KLAAR: Het is 14 graden." },
  ]);
  const run = service.start("zoek het weer in Utrecht uit");
  await settle();
  expect(run.status).toBe("done");
  expect(run.turns).toBe(2);
  expect(run.result!).toMatch(/14 graden/);
  expect(sent[0]!).toMatch(/AUTONOME OPDRACHT/);
  expect(sent[1]).toBe("Ga verder met het doel.");
  expect(alerts.some((a) => a.payload.title.startsWith("Klaar"))).toBe(true);
});

test("run stops at the turn budget", async () => {
  const { service } = setup(
    Array.from({ length: 20 }, () => ({ reply: "bezig" })),
  );
  const run = service.start("blijf maar doorgaan met werk", { maxTurns: 3 });
  await settle();
  expect(run.status).toBe("failed");
  expect(run.turns).toBe(3);
});

test("HULP pauses and an answer resumes", async () => {
  const { service } = setup([
    { reply: "HULP: welk adres?" },
    { reply: "KLAAR: klaar" },
  ]);
  const run = service.start("regel de bezorging voor mij");
  await settle();
  expect(run.status).toBe("waiting");
  expect(run.waiting?.kind).toBe("question");
  await service.respond(run.id, { answer: "Straat 1" });
  await settle();
  expect(run.status).toBe("done");
});

test("confirmation pauses; approval goes through the confirmation handler", async () => {
  const { service, handled } = setup([
    {
      reply: "wil sluiten",
      confirmation: { confirmationId: "c1", tool: "windows_close_app" },
    },
    { reply: "KLAAR: gesloten" },
  ]);
  const run = service.start("sluit de browser op de pc");
  await settle();
  expect(run.status).toBe("waiting");
  expect(run.waiting?.confirmationId).toBe("c1");
  await service.respond(run.id, { approve: true });
  await settle();
  expect(run.status).toBe("done");
  expect(handled.length).toBe(1);
});

test("restart marks running runs interrupted and persists", async () => {
  const { service, store } = setup([]);
  const data = store.load();
  data.runs.push({
    id: "aaaaaaaa",
    goal: "oud doel hier",
    status: "running",
    createdAt: 1,
    updatedAt: 1,
    turns: 1,
    maxTurns: 5,
    deadline: 1,
    log: [],
  });
  store.save(data);
  service.recover();
  expect(service.get("aaaaaaaa").status).toBe("interrupted");
  expect(fs.statSync(store.file).mode & 0o777).toBe(0o600);
});

test("validation, duplicates and recursion block", async () => {
  const { service } = setup([{ reply: "bezig" }]);
  expect(() => service.start("kort")).toThrow();
  const a = service.start("onderzoek de energieprijzen nu");
  expect(service.start("Onderzoek de energieprijzen nu")).toBe(a);
  const source = new AgentSource(service);
  const blocked = await source.execute(
    "agent_run",
    { goal: "nog een taak starten" },
    { sessionId: "agent_abcd1234" },
  );
  expect(blocked.ok).toBe(false);
  service.cancel(a.id);
  expect(a.status).toBe("cancelled");
});

test("autonomy level endpoint validates and stores the level", async () => {
  const { AutonomyLevelController } =
    await import("../../src/agent/autonomy-level.controller.js");
  let level = "balanced";
  const controller = new AutonomyLevelController({
    get: () => level,
    set: (l: string) => (level = l),
  } as never);
  expect(controller.read().level).toBe("balanced");
  expect(controller.update({ level: "careful" }).level).toBe("careful");
  expect(() => controller.update({ level: "yolo" })).toThrow();
  expect(level).toBe("careful");
});

test("a read-only run passes readOnlyOnly to every turn", async () => {
  const calls: Array<{ readOnlyOnly?: boolean }> = [];
  const { service } = setup([{ reply: "KLAAR: ok" }]);
  (
    service as unknown as {
      orchestrator: { run: (i: never) => Promise<unknown> };
    }
  ).orchestrator.run = async (i) => (calls.push(i), { reply: "KLAAR: ok" });
  const run = service.start("onderzoek de storing alleen lezend", {
    readOnly: true,
  });
  await settle();
  expect(run.readOnly).toBe(true);
  expect(calls[0]?.readOnlyOnly).toBe(true);
});
