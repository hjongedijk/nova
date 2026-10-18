import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { AuditService } from "../../../src/core/audit/audit.service.js";
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
});
