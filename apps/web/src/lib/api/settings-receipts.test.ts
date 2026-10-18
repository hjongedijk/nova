import fs from "node:fs";
import * as ts from "typescript";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  classifySettingsWrite,
  settingsWriteReceipt,
} from "./settings-receipts.ts";

afterEach(() => vi.restoreAllMocks());
const approved = { approve: true };
const card = (
  method: string,
  path: string,
  result: unknown,
  body: unknown = approved,
) => settingsWriteReceipt(method, path, body, result);

describe("settings write receipts", () => {
  it.each([
    ["PUT", "/abilities/private-name", "Vaardigheden"],
    ["POST", "/skills", "Vaardigheden"],
    ["PUT", "/persona/profile", "Gedrag en profielen"],
    ["PUT", "/household-profiles", "Gedrag en profielen"],
    ["POST", "/sidebar/history/private/rollback", "Zijbalk"],
    ["DELETE", "/tools/private-name", "Gereedschapsinstellingen"],
    [
      "POST",
      "/tools/private/description-history/private/rollback",
      "Gereedschapsinstellingen",
    ],
    ["DELETE", "/widgets/private", "Zijpanelen"],
    ["PUT", "/helper/preferences", "Desktophelper"],
    ["DELETE", "/standing-approvals/private", "Toestemmingen"],
    ["POST", "/services/qdrant/maintenance", "Geheugenindex"],
    ["PUT", "/managed-targets/access", "Apparaattoegang"],
    ["PUT", "/services/private", "Serviceverbindingen"],
    ["POST", "/services/windows/pair", "Serviceverbindingen"],
    ["POST", "/import", "Instellingen herstellen"],
    [
      "POST",
      "/node-red/flow-revisions/private/confirm-restore",
      "Node-RED-flows",
    ],
  ])(
    "records successful %s %s with a fixed family label",
    (method, path, family) => {
      const receipt = card(method, path, { ok: true, verified: true });
      expect(receipt?.requested).toBe(`${family} aanpassen`);
      expect(receipt?.performed).toContain("verwerkt");
      expect(receipt?.verification).toContain("niet apart gecontroleerd");
      expect(JSON.stringify(receipt)).not.toContain("private");
    },
  );

  it.each([
    ["/omniroute/native/memory/confirm", "AI-geheugen"],
    ["/omniroute/native/memories/delete-many/confirm", "AI-geheugen"],
    ["/omniroute/native/prompt/confirm", "AI-instructies"],
    ["/omniroute/native/skills/private/confirm", "AI-vaardigheden"],
    ["/omniroute/native/skills/private/remove/confirm", "AI-vaardigheden"],
    ["/omniroute/accounts/create/confirm", "AI-accounts"],
    ["/omniroute/accounts/private/activation/confirm", "AI-accounts"],
    ["/omniroute/accounts/keys/private/model-access/confirm", "AI-sleutels"],
    ["/omniroute/combos/private/update/confirm", "AI-modelcombinaties"],
    ["/omniroute/policy/confirm", "Gratis AI-routering"],
    ["/mcp/servers/confirm-catalog", "MCP-instellingen"],
    ["/node-red/palette/confirm", "Node-RED-palette"],
    ["/workspace/projects/history/confirm-rollback", "Werkruimte"],
  ])(
    "uses explicit verification only for known confirmation %s",
    (path, family) => {
      expect(
        card("POST", path, { ok: true, verified: true })?.verification,
      ).toBe("De API heeft het resultaat gecontroleerd en bevestigd.");
      expect(card("POST", path, { ok: true, verified: true })?.requested).toBe(
        `${family} aanpassen`,
      );
      expect(card("POST", path, { ok: true })?.verification).toContain(
        "niet apart gecontroleerd",
      );
      expect(
        card("POST", path, { ok: true, verified: null })?.verification,
      ).toContain("niet apart gecontroleerd");
      expect(card("POST", path, { ok: true }, { approve: false })).toBeNull();
      expect(
        settingsWriteReceipt("POST", path, undefined, { ok: true }),
      ).toBeNull();
    },
  );

  it("distinguishes queued restart, staged palette upgrade and unverified acceptance", () => {
    const scheduled = card("POST", "/services/restart", {
      ok: true,
      scheduled: true,
      verified: true,
    });
    expect(scheduled?.performed).toContain("aangevraagd");
    expect(scheduled?.verification).toContain("niet apart gecontroleerd");
    const staged = card("POST", "/node-red/palette/confirm", {
      ok: true,
      verified: true,
      pendingRestart: true,
    });
    expect(staged?.performed).toContain("klaargezet; herstart nodig");
    expect(staged?.verification).toContain("niet apart gecontroleerd");
    const accepted = card("POST", "/omniroute/native/prompt/confirm", {
      ok: true,
      accepted: true,
      verified: null,
    });
    expect(accepted?.performed).toContain("aangevraagd");
    expect(accepted?.verification).toContain("niet apart gecontroleerd");
  });

  it("recognizes endpoint-specific successful responses without assuming empty HTTP success", () => {
    expect(
      card("PUT", "/model-roles", {
        available: false,
        roles: {},
        verifiedFreeModels: [],
      }),
    ).not.toBeNull();
    expect(
      card("POST", "/workspace/projects", {
        version: 1,
        projects: [],
        activeId: null,
      }),
    ).not.toBeNull();
    expect(
      card("PUT", "/workspace/projects/active", {
        version: 1,
        projects: [],
        activeId: "private",
      }),
    ).not.toBeNull();
    expect(
      card("POST", "/widgets", { widget: { id: "private" } }),
    ).not.toBeNull();
    expect(
      card("PUT", "/widgets/private", { widget: { id: "private" } }),
    ).not.toBeNull();
    expect(
      card("POST", "/mcp/servers/private/config", { fields: [] }),
    ).not.toBeNull();
    expect(
      card("POST", "/wallpaper", { available: true, displays: [] }),
    ).not.toBeNull();
    expect(
      card("POST", "/wallpaper", { available: false, reason: "unreachable" }),
    ).toBeNull();
    const helper = card("POST", "/helper", {
      settings: { mode: "helper", display: 0 },
      desktop: { available: false },
      applied: false,
      error: "private runtime failure",
    });
    expect(helper?.performed).toContain(
      "keuze opgeslagen; toepassen niet bevestigd",
    );
    expect(helper?.verification).toContain("niet apart gecontroleerd");
    for (const [method, path] of [
      ["PUT", "/model-roles"],
      ["POST", "/workspace/projects"],
      ["POST", "/widgets"],
      ["POST", "/mcp/servers/private/config"],
      ["POST", "/wallpaper"],
      ["POST", "/helper"],
    ]) {
      expect(card(method!, path!, {})).toBeNull();
      expect(card(method!, path!, { success: true })).toBeNull();
    }
  });

  it.each([
    null,
    [],
    {},
    { success: true },
    { ok: false },
    { ok: true, error: "private upstream failure" },
    { ok: true, executed: false },
    { ok: true, cancelled: true },
    { ok: true, requiresConfirmation: true },
    { ok: true, pendingConfirmation: true },
    { ok: true, action: { confirmationId: "private" } },
    { ok: true, confirmation: { confirmationId: "private" } },
  ])(
    "never creates a successful card for failed or pending outcome %#",
    (result) => {
      expect(card("PUT", "/abilities/private", result)).toBeNull();
    },
  );

  it("never duplicates existing readback owners, including indistinguishable tool edits", () => {
    for (const [method, path] of [
      ["PUT", "/persona"],
      ["PUT", "/persona/style"],
      ["PUT", "/sidebar"],
      ["PUT", "/quick-actions"],
      ["POST", "/quick-actions/history/private/rollback"],
      ["PUT", "/tools/private"],
    ]) {
      expect(card(method!, path!, { ok: true }, {})).toBeNull();
      expect(card(method!, path!, { ok: true }, { enabled: true })).toBeNull();
      expect(
        card(
          method!,
          path!,
          { ok: true },
          { description: "private description" },
        ),
      ).toBeNull();
    }
  });

  it.each([
    ["POST", "/skills/test"],
    ["POST", "/skills/draft"],
    ["POST", "/skills/improve"],
    ["POST", "/widgets/preview"],
    ["POST", "/node-red/flows/export"],
    ["POST", "/node-red/flow-revisions/capture"],
    ["POST", "/mcp/servers/private/test"],
    ["POST", "/services/private/test"],
    ["POST", "/omniroute/policy/prepare"],
    ["POST", "/mcp/servers/private/prepare-catalog"],
    ["POST", "/future/confirm"],
    ["PUT", "/future/settings"],
    ["POST", "/omniroute/future/confirm"],
  ])("does not infer writes for excluded or future %s %s", (method, path) => {
    expect(card(method, path, { ok: true, verified: true })).toBeNull();
  });

  it("does not read credentials or response prose and emits unique safe identifiers", () => {
    vi.spyOn(Date, "now").mockReturnValue(12345);
    const body = Object.defineProperty({ approve: true }, "apiKey", {
      get() {
        throw new Error("Private request data was read");
      },
    });
    const result = Object.defineProperty({ ok: true }, "warning", {
      get() {
        throw new Error("Private response prose was read");
      },
    });
    const receipts = Array.from({ length: 12 }, () =>
      card("PUT", "/services/private-user%40private-host", result, body),
    );
    expect(new Set(receipts.map((receipt) => receipt?.id)).size).toBe(12);
    expect(JSON.stringify(receipts)).not.toMatch(
      /private-user|private-host|apiKey/,
    );
  });

  it("avoids identifier collisions with the retained legacy receipt owner", async () => {
    vi.spyOn(Date, "now").mockReturnValue(12345);
    vi.resetModules();
    const { settingsWriteReceipt: centralReceipt } =
      await import("./settings-receipts.ts");
    const { settingsActionReceipt: legacyReceipt } =
      await import("../../components/settings/action-receipts.ts");
    const central = centralReceipt("PUT", "/abilities/fixture", undefined, {
      ok: true,
    });
    const legacy = legacyReceipt(
      { kind: "persona-rules", text: "Synthetic rules." },
      null,
    );
    expect(central).not.toBeNull();
    expect(central?.id).not.toBe(legacy.id);
    expect(new Set([central?.id, legacy.id]).size).toBe(2);
  });

  it("records Windows pairing without exposing its code or claiming a connection check", () => {
    const receipt = card(
      "POST",
      "/services/windows/pair",
      { ok: true, services: [] },
      { code: "nova1.private-pairing-code" },
    );
    expect(receipt?.requested).toBe("Serviceverbindingen aanpassen");
    expect(receipt?.verification).toBe(
      "Het effect is niet apart gecontroleerd.",
    );
    expect(JSON.stringify(receipt)).not.toContain("private-pairing-code");
    expect(card("POST", "/services/windows/pair", { ok: false })).toBeNull();
  });

  it("classifies every current settings write explicitly while future routes stay closed", () => {
    const source = ts.createSourceFile(
      "settings.ts",
      fs.readFileSync(new URL("./settings.ts", import.meta.url), "utf8"),
      ts.ScriptTarget.Latest,
      true,
      ts.ScriptKind.TS,
    );
    const routes: Array<{ method: string; path: string }> = [];
    const visit = (node: ts.Node): void => {
      if (
        ts.isCallExpression(node) &&
        ts.isIdentifier(node.expression) &&
        node.expression.text === "write"
      ) {
        const [method, route] = node.arguments;
        expect(method && ts.isStringLiteral(method)).toBe(true);
        let path: string;
        if (route && ts.isStringLiteral(route)) path = route.text;
        else if (route && ts.isTemplateExpression(route))
          path =
            route.head.text +
            route.templateSpans
              .map((span) => `fixture${span.literal.text}`)
              .join("");
        else
          throw new Error(
            "New settings route requires an explicit receipt policy",
          );
        routes.push({ method: (method as ts.StringLiteral).text, path });
      }
      ts.forEachChild(node, visit);
    };
    visit(source);
    expect(routes).toHaveLength(130);
    for (const route of routes)
      expect(
        classifySettingsWrite(route.method, route.path),
        `${route.method} ${route.path}`,
      ).not.toBeNull();
    expect(classifySettingsWrite("POST", "/unknown/new/confirm")).toBeNull();
  });
});
