import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { NodeRedFlowRevisions } from "../../src/settings/node-red-flow-revisions.service.js";
import type { NodeRedFlowSnapshot } from "../../src/settings/node-red-management.service.js";

const roots: string[] = [];
function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "nova-node-red-history-"));
  roots.push(root);
  const file = path.join(root, "node-red-flow-revisions.json");
  const store = new NodeRedFlowRevisions({ dataFile: () => file });
  return { store, file };
}

function snapshot(revision: string, label: string): NodeRedFlowSnapshot {
  return {
    revision,
    flows: [{ id: "tab-a", type: "tab", label }],
  };
}

afterEach(() => {
  for (const root of roots.splice(0))
    fs.rmSync(root, { recursive: true, force: true });
});

describe("private Node-RED flow revisions", () => {
  it("stores bounded private snapshots and exposes metadata only", () => {
    const { store, file } = fixture();
    for (let index = 0; index < 22; index++)
      store.record(snapshot(`rev-${index}`, `Private flow ${index}`));
    const listed = store.list();
    expect(listed.revisions).toHaveLength(10);
    expect(listed.truncated).toBe(true);
    expect(JSON.stringify(listed)).not.toContain("Private flow");
    expect(fs.statSync(file).mode & 0o777).toBe(0o600);
    const stored = JSON.parse(fs.readFileSync(file, "utf8")) as unknown[];
    expect(stored).toHaveLength(20);
    expect(JSON.stringify(stored)).toContain("Private flow 21");
    expect(JSON.stringify(stored)).not.toContain("Private flow 0");
  });

  it("restores through the revision checked Node-RED writer and records the result", async () => {
    const { store } = fixture();
    const first = store.record(snapshot("rev-1", "Before"));
    store.record(snapshot("rev-2", "After"));
    let live = snapshot("rev-2", "After");
    const management = {
      flowSnapshot: async () => structuredClone(live),
      writeFlowSnapshot: async (expected: string, flows: unknown) => {
        expect(expected).toBe("rev-2");
        live = { revision: "rev-3", flows: flows as Record<string, unknown>[] };
        return { ok: true, revision: "rev-3" };
      },
    };
    const prepared = store.prepareRestore(first.id, live);
    expect(prepared).toMatch(/^[0-9a-f]{64}$/);
    const restored = await store.restore(first.id, prepared, management);
    expect(live.flows).toEqual(snapshot("rev-1", "Before").flows);
    expect(restored).toMatchObject({ nodeCount: 1 });
    expect(store.list().revisions[0]?.id).toBe(restored.id);
  });

  it("rejects external edits before writing and rejects sensitive snapshots", async () => {
    const { store } = fixture();
    const first = store.record(snapshot("rev-1", "Before"));
    store.record(snapshot("rev-2", "After"));
    let writes = 0;
    const prepared = store.prepareRestore(first.id, snapshot("rev-2", "After"));
    await expect(
      store.restore(first.id, prepared, {
        flowSnapshot: async () => snapshot("external-rev", "Changed"),
        writeFlowSnapshot: async () => {
          writes++;
          return { ok: true, revision: "new" };
        },
      }),
    ).rejects.toThrow("later gewijzigd");
    expect(writes).toBe(0);
    expect(() =>
      store.record({
        revision: "rev-3",
        flows: [
          { id: "tab-b", type: "tab", credentials: { password: "private" } },
        ],
      }),
    ).toThrow();
    expect(store.list().revisions).toHaveLength(2);
  });

  it("rejects a changed target after preparation without a write", async () => {
    const { store, file } = fixture();
    const first = store.record(snapshot("rev-1", "Before"));
    store.record(snapshot("rev-2", "After"));
    const fingerprint = store.prepareRestore(
      first.id,
      snapshot("rev-2", "After"),
    );
    const rows = JSON.parse(fs.readFileSync(file, "utf8")) as {
      snapshot: NodeRedFlowSnapshot;
    }[];
    rows[0]!.snapshot.flows[0]!.label = "Changed privately";
    fs.writeFileSync(file, JSON.stringify(rows), { mode: 0o600 });
    let writes = 0;
    await expect(
      store.restore(first.id, fingerprint, {
        flowSnapshot: async () => snapshot("rev-2", "After"),
        writeFlowSnapshot: async () => {
          writes++;
          return { ok: true, revision: "rev-3" };
        },
      }),
    ).rejects.toThrow("na voorbereiding gewijzigd");
    expect(writes).toBe(0);
  });

  it("reports a verified restore as successful when only follow-up history read fails", async () => {
    const { store } = fixture();
    const first = store.record(snapshot("rev-1", "Before"));
    store.record(snapshot("rev-2", "After"));
    const fingerprint = store.prepareRestore(
      first.id,
      snapshot("rev-2", "After"),
    );
    let reads = 0;
    const result = await store.restore(first.id, fingerprint, {
      flowSnapshot: async () => {
        if (++reads === 1) return snapshot("rev-2", "After");
        throw new Error("private upstream failure");
      },
      writeFlowSnapshot: async () => ({ ok: true, revision: "rev-3" }),
    });
    expect(result.historyWarning).toContain("versiegeschiedenis");
    expect(JSON.stringify(result)).not.toContain("private upstream failure");
    expect(store.list().revisions).toHaveLength(2);
  });

  it("does not leave a half-history when a verified change contains secrets", () => {
    const { store } = fixture();
    expect(() =>
      store.recordVerifiedChange(snapshot("rev-1", "Before"), {
        revision: "rev-2",
        flows: [{ id: "tab-a", type: "tab", password: "private" }],
      }),
    ).toThrow();
    expect(store.list().revisions).toHaveLength(0);
  });
});
