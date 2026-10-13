import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AuditService } from "../../src/core/audit/audit.service.js";
import { NovaConfig } from "../../src/core/config/nova-config.js";
import { RoutingService } from "../../src/routing/routing.service.js";
import { ModelRolesService } from "../../src/settings/model-roles.service.js";
import { SettingsStore } from "../../src/settings/store/settings.store.js";

const dirs: string[] = [];
function fixture(
  available = true,
  explicitModels = ["free/provider-a", "free/provider-b"],
) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "nova-model-roles-"));
  dirs.push(dir);
  const config = { dataFile: (name: string) => path.join(dir, name) };
  const settings = new SettingsStore(config as NovaConfig);
  const routing = {
    status: () => ({
      ready: available,
      freeOnly: true,
      policyVerified: available,
      enabledModels: available ? ["free/provider-a", "free/provider-b"] : [],
      explicitModels: available ? explicitModels : [],
    }),
  };
  const audit = { record: vi.fn() };
  return {
    service: new ModelRolesService(
      settings,
      routing as unknown as RoutingService,
      audit as unknown as AuditService,
      config as NovaConfig,
    ),
    settings,
    audit,
  };
}
afterEach(() => {
  for (const dir of dirs.splice(0))
    fs.rmSync(dir, { recursive: true, force: true });
});

describe("model role preferences", () => {
  it("offers only currently verified free models and saves ordered role preferences", () => {
    const f = fixture();
    const current = f.service.get();
    expect(current.verifiedFreeModels).toEqual([
      "free/provider-a",
      "free/provider-b",
    ]);
    expect(current.roles.conversation).toEqual({
      preferred: [],
      fallback: null,
    });
    const next = structuredClone(current.roles);
    next.conversation = {
      preferred: ["free/provider-b", "free/provider-a"],
      fallback: null,
    };
    next.code = { preferred: ["free/provider-a"], fallback: "free/provider-b" };
    expect(f.service.save(next).roles).toEqual(next);
    expect(f.audit.record).toHaveBeenCalledWith(
      expect.objectContaining({ tool: "model_roles_update", risk: "SAFE" }),
    );
    expect(f.service.get().roles).toEqual(next);
  });

  it("offers only the explicit key scope and refuses a free model without a grant", () => {
    const f = fixture(true, ["free/provider-a"]);
    expect(f.service.get().verifiedFreeModels).toEqual(["free/provider-a"]);
    const next = structuredClone(f.service.get().roles);
    next.code = { preferred: ["free/provider-b"], fallback: null };
    expect(() => f.service.save(next)).toThrow(
      "actuele geverifieerde gratis lijst",
    );
    expect(f.settings.get().modelRoles.code.preferred).toEqual([]);
  });

  it("does not offer role models for an auto-only key", () => {
    const f = fixture(true, []);
    expect(f.service.get()).toMatchObject({
      available: false,
      verifiedFreeModels: [],
    });
  });

  it("rejects models outside the currently verified free list", () => {
    const f = fixture();
    const next = f.service.get().roles;
    next.conversation.preferred = ["paid/private"];
    expect(() => f.service.save(next)).toThrow(
      "actuele geverifieerde gratis lijst",
    );
  });

  it("refuses edits while the free route is unverified", () => {
    const f = fixture(false);
    expect(f.service.get()).toMatchObject({
      available: false,
      verifiedFreeModels: [],
    });
    expect(() => f.service.save(f.service.get().roles)).toThrow(
      "niet geverifieerd",
    );
  });

  it("records secret-free history and restores only while the saved state is current", () => {
    const f = fixture();
    const next = f.service.get().roles;
    next.conversation.preferred = ["free/provider-b"];
    f.service.save(next);
    const history = f.service.history();
    const originalId = history.revisions[0]!.id;
    expect(history.revisions).toHaveLength(1);
    expect(
      fs.statSync(path.join(dirs.at(-1)!, "model-roles-history.json")).mode &
        0o777,
    ).toBe(0o600);

    f.service.rollback(originalId);
    expect(f.service.get().roles.conversation.preferred).toEqual([]);
    expect(f.service.history().revisions[0]!.revertedFrom).toBe(originalId);

    expect(() => f.service.rollback(originalId)).toThrow("daarna gewijzigd");
  });

  it("rejects rollback when its previous model is no longer free and eligible", () => {
    const f = fixture();
    const next = f.service.get().roles;
    next.conversation.preferred = ["free/provider-b"];
    f.service.save(next);
    const id = f.service.history().revisions[0]!.id;
    // The old state is empty and remains safe. Change history to make the attempted restore
    // require a model that has since left the verified free catalogue.
    const file = path.join(dirs.at(-1)!, "model-roles-history.json");
    const rows = JSON.parse(fs.readFileSync(file, "utf8"));
    rows[0].before.conversation.preferred = ["free/removed-model"];
    fs.writeFileSync(file, JSON.stringify(rows), { mode: 0o600 });
    expect(() => f.service.rollback(id)).toThrow("niet meer beschikbaar");
  });
});
