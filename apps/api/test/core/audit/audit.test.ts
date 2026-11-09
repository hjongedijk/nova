import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  AuditService,
  type AuditEntry,
} from "../../../src/core/audit/audit.service.js";
import { auditText, dbStat } from "../../helpers/nova-db.js";

const directories: string[] = [];
const originalToken = process.env.NOVA_TEST_AUDIT_TOKEN;
afterEach(() => {
  for (const dir of directories.splice(0))
    fs.rmSync(dir, { recursive: true, force: true });
  if (originalToken === undefined) delete process.env.NOVA_TEST_AUDIT_TOKEN;
  else process.env.NOVA_TEST_AUDIT_TOKEN = originalToken;
});

describe("audit privacy", () => {
  it("redacts credentials before writing and reading the action log", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "nova-audit-"));
    directories.push(dir);
    process.env.NOVA_TEST_AUDIT_TOKEN = "private-audit-fixture-token";
    const audit = new AuditService({
      dataFile: (name: string) => path.join(dir, name),
    } as never);

    audit.record({
      tool: "test_action",
      arguments: { note: "private-audit-fixture-token", password: "hidden" },
      result: { ok: true },
    });

    const raw = auditText(dir);
    expect(raw).not.toContain("private-audit-fixture-token");
    expect(raw).not.toContain("hidden");
    expect(dbStat(dir).mode & 0o777).toBe(0o600);
    expect(audit.read()).toMatchObject([
      { tool: "test_action", arguments: { note: "[redacted]" } },
    ]);
  });

  it("stores large tool results shortened but keeps their shape", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "nova-audit-"));
    directories.push(dir);
    const audit = new AuditService({
      dataFile: (name: string) => path.join(dir, name),
    } as never);
    const entities = Array.from({ length: 300 }, (_, i) => ({
      entity_id: `light.l${i}`,
      attributes: { friendly_name: `Lamp ${i}`, note: "x".repeat(2_000) },
    }));

    audit.record({
      tool: "ha_search_entities",
      result: { ok: true, result: entities },
    });
    audit.record({ tool: "timer_list", result: { ok: true, result: [1, 2] } });

    const [small, big] = audit.read() as [AuditEntry, AuditEntry];
    expect(small.result).toEqual({ ok: true, result: [1, 2] });
    const result = big.result as { ok: boolean; result: unknown[] };
    expect(result.ok).toBe(true);
    expect(result.result).toHaveLength(21);
    expect(result.result.at(-1)).toBe("… 280 more");
    expect(JSON.stringify(big).length).toBeLessThan(40_000);
  });
});
