import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { SidebarItem } from "@nova/contracts";
import { SettingsStore } from "../../src/settings/store/settings.store.js";
import { SidebarHistory } from "../../src/settings/sidebar-history.service.js";
import { resolveSidebar } from "../../src/settings/settings-validation.js";
import type { AuditService } from "../../src/core/audit/audit.service.js";
import type { NovaConfig } from "../../src/core/config/nova-config.js";
import { dbStat, historyText } from "../helpers/nova-db.js";

const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
});

function fixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "nova-sidebar-history-"));
  cleanups.push(() => fs.rmSync(dir, { recursive: true, force: true }));
  const config = { dataFile: (name: string) => path.join(dir, name) };
  const settings = new SettingsStore(config as NovaConfig);
  const record = vi.fn();
  const history = new SidebarHistory(config as NovaConfig, settings, {
    record,
  } as unknown as AuditService);
  return { dir, settings, record, history };
}

describe("sidebar history", () => {
  it("stores a bounded private layout history without content fields", () => {
    const f = fixture();
    const before = resolveSidebar(f.settings.get());
    const after: SidebarItem[] = before.map((item, index) =>
      index === 0 ? { ...item, shown: !item.shown } : item,
    );
    f.history.record(before, after);
    expect(f.history.list().revisions[0]).toMatchObject({ before, after });
    const file = path.join(f.dir, "sidebar-history.json");
    expect(dbStat(file).mode & 0o777).toBe(0o600);
    expect(historyText(file)).not.toMatch(/prompt|source|url|headers/i);
  });

  it("rolls back only while effective layout still matches", () => {
    const f = fixture();
    const before = resolveSidebar(f.settings.get());
    const after = before.map((item, index) =>
      index === 0 ? { ...item, shown: !item.shown } : item,
    );
    f.settings.update((next) => {
      next.sidebar = { items: after as never[] };
    });
    f.history.record(before, after);
    const revision = f.history.list().revisions[0]!;
    expect(f.history.rollback(revision.id).sidebar).toEqual(before);
    expect(f.history.list().revisions[0]?.revertedFrom).toBe(revision.id);
    f.settings.update((next) => {
      next.sidebar!.items[0]!.page = 2;
    });
    expect(() => f.history.rollback(revision.id)).toThrow(
      "De zijbalk is daarna gewijzigd.",
    );
  });

  it("keeps no more than one hundred revisions", () => {
    const f = fixture();
    let before = resolveSidebar(f.settings.get());
    for (let index = 0; index < 105; index++) {
      const after = before.map((item, row) =>
        row === 0 ? { ...item, shown: !item.shown } : item,
      );
      f.history.record(before, after);
      before = after;
    }
    expect(f.history.list().revisions).toHaveLength(50);
    expect(f.history.list().truncated).toBe(true);
  });
});
