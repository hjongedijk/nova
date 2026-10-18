import { describe, expect, it, vi } from "vitest";
import { NovaConfig } from "../../src/core/config/nova-config.js";
import { OmniRouteManagement } from "../../src/routing/omniroute-management.service.js";
import { NativeGatewayController } from "../../src/settings/native-gateway.controller.js";
import { NativeMemorySettingsService } from "../../src/settings/native-memory-settings.service.js";
import { NativeMemoryRecordsService } from "../../src/settings/native-memory-records.service.js";

const ERROR = "OmniRoute-beheer is niet beschikbaar. Controleer de koppeling.";
const gateway = "http://verified-gateway.invalid/v1";

function fixture({
  configured = true,
  verified = true,
  application = "jarvis",
} = {}) {
  const scope = vi.fn(() => "nova-owner");
  const configuration = vi.fn(() => configured);
  const management = {
    get configured() {
      return configuration();
    },
    get scope() {
      return scope();
    },
    request: vi.fn(async (endpoint: string): Promise<unknown> => {
      if (endpoint === "/api/skills?page=1&limit=200")
        return { data: [], totalPages: 1 };
      if (endpoint.startsWith("/api/memory?"))
        return {
          data: [
            {
              id: "owned-memory",
              apiKeyId: "nova-owner",
              content: "NOVA private fact",
              createdAt: "2026-10-11T10:00:00.000Z",
              metadata: {
                application,
                jarvis: { key: "hidden" },
                nova: { key: "hidden" },
              },
            },
            {
              id: "other-app-memory",
              apiKeyId: "nova-owner",
              content: "other app data",
              metadata: { application: "other" },
            },
            {
              id: "other-owner-memory",
              apiKeyId: "other-owner",
              content: "other client secret",
              metadata: { application: "jarvis" },
            },
          ],
        };
      return { enabled: false, prefixPrompt: "", suffixPrompt: "" };
    }),
    skills: vi.fn(async (): Promise<unknown> => ({ skills: [] })),
  };
  const controller = new NativeGatewayController(
    {
      omniUrl: gateway,
      verifiedOmniUrl: verified ? gateway : "http://other-gateway.invalid/v1",
    } as NovaConfig,
    management as unknown as OmniRouteManagement,
    {
      status: vi.fn(async () => ({
        enabled: false,
        backend: "sqlite",
        maxTokens: 1000,
      })),
    } as unknown as NativeMemorySettingsService,
    {} as NativeMemoryRecordsService,
  );
  return { controller, management, scope, configuration };
}

const privateFields = {
  handler: "private-runtime-handler",
  inputSchema: { secret: "private-input-schema" },
  input: "private-runtime-input",
  apiKey: "private-key-value",
  privateMetadata: "private-field-value",
};
const runtimeSkill = (apiKeyId: unknown, id: string) => ({
  id,
  apiKeyId,
  name: `Name ${id}`,
  version: "1.2",
  enabled: true,
  mode: "auto",
  ...privateFields,
});

function expectUnavailable(result: unknown) {
  expect(result).toMatchObject({ available: false, error: ERROR });
  const serialized = JSON.stringify(result);
  expect(serialized).not.toContain("private");
  expect(serialized).not.toContain(gateway);
}

describe("native gateway read-only report", () => {
  it.each(["jarvis", "nova"])(
    "lists only owned %s memory records on explicit request",
    async (application) => {
      const { controller, management } = fixture({ application });
      const result = await controller.memoryRecords();
      expect(result).toEqual({
        memories: [
          {
            id: "owned-memory",
            text: "NOVA private fact",
            created_at: "2026-10-11T10:00:00.000Z",
          },
        ],
        next: null,
      });
      expect(management.request).toHaveBeenCalledWith(
        "/api/memory?apiKeyId=nova-owner&limit=50&offset=0",
      );
      expect(JSON.stringify(result)).not.toContain("hidden");
      expect(JSON.stringify(result)).not.toContain("other-owner");
      expect(JSON.stringify(result)).not.toContain("other app data");
    },
  );

  it("requests only the fixed runtime, catalog and prompt endpoints", async () => {
    const { controller, management, scope } = fixture();
    expect(await controller.report()).toEqual({
      available: true,
      truncated: false,
      skills: [],
      documentation: [],
      prompt: { enabled: false, prefixCharacters: 0, suffixCharacters: 0 },
      memory: { enabled: false, backend: "sqlite", maxTokens: 1000 },
    });
    expect(scope).toHaveBeenCalledTimes(1);
    expect(management.request.mock.calls).toEqual([
      ["/api/skills?page=1&limit=200"],
      ["/api/settings/system-prompt"],
    ]);
    expect(management.skills.mock.calls).toEqual([[]]);
    expect(scope.mock.invocationCallOrder[0]).toBeLessThan(
      management.request.mock.invocationCallOrder[0]!,
    );
  });

  it.each([
    { configured: false, verified: true },
    { configured: true, verified: false },
    { configured: false, verified: false },
  ])(
    "checks management configuration and gateway provenance before scope or calls: %j",
    async (options) => {
      const { controller, management, scope } = fixture(options);
      expectUnavailable(await controller.report());
      expectUnavailable(await controller.document("safe-document"));
      expect(scope).not.toHaveBeenCalled();
      expect(management.request).not.toHaveBeenCalled();
      expect(management.skills).not.toHaveBeenCalled();
    },
  );

  it("includes only the matching owner and exact permitted global owners, projecting safe fields", async () => {
    const { controller, management } = fixture();
    management.request.mockImplementation(async (endpoint) =>
      endpoint.startsWith("/api/skills?")
        ? {
            data: [
              runtimeSkill("nova-owner", "nova-skill"),
              runtimeSkill("system", "system-skill"),
              runtimeSkill("skillsmp", "market-skill"),
              runtimeSkill("skillssh", "shell-skill"),
              runtimeSkill("other-owner", "other-owner-private"),
              runtimeSkill("System", "uppercase-owner-private"),
              runtimeSkill(undefined, "missing-owner-private"),
              runtimeSkill("nova-owner", "../invalid-id"),
              null,
            ],
            totalPages: 1,
          }
        : {
            enabled: true,
            prefixPrompt: "private-prefix-content",
            suffixPrompt: "private-suffix-content",
            ...privateFields,
          },
    );
    management.skills.mockResolvedValue({
      skills: [
        {
          id: "safe-document",
          name: "Guide",
          description: "How to use it",
          documentation: "private-document-content",
          ...privateFields,
        },
        { id: "../invalid-document", name: "invalid" },
      ],
    });
    const result = await controller.report();
    expect(result.skills).toEqual([
      {
        id: "nova-skill",
        name: "Name nova-skill",
        version: "1.2",
        scope: "nova",
        enabled: true,
        mode: "auto",
      },
      ...["system-skill", "market-skill", "shell-skill"].map((id) => ({
        id,
        name: `Name ${id}`,
        version: "1.2",
        scope: "global",
        enabled: true,
        mode: "auto",
      })),
    ]);
    expect(result.documentation).toEqual([
      { id: "safe-document", name: "Guide", description: "How to use it" },
    ]);
    expect(result.prompt).toEqual({
      enabled: true,
      prefixCharacters: 22,
      suffixCharacters: 22,
    });
    const serialized = JSON.stringify(result);
    for (const excluded of [
      "private",
      "apiKeyId",
      "handler",
      "inputSchema",
      "apiKey",
      "prefixPrompt",
      "suffixPrompt",
    ])
      expect(serialized).not.toContain(excluded);
  });

  it("returns only prompt state and lengths, with nulls for malformed prompt fields", async () => {
    const { controller, management } = fixture();
    management.request.mockImplementation(async (endpoint) =>
      endpoint.startsWith("/api/skills?")
        ? { data: [] }
        : {
            enabled: "yes",
            prefixPrompt: 12,
            suffixPrompt: [],
            ...privateFields,
          },
    );
    expect((await controller.report()).prompt).toEqual({
      enabled: null,
      prefixCharacters: null,
      suffixCharacters: null,
    });
  });

  it.each([0, 1, 2])(
    "caps each list at 200 and marks truncation only for more than one page (%i)",
    async (totalPages) => {
      const { controller, management } = fixture();
      management.request.mockImplementation(async (endpoint) =>
        endpoint.startsWith("/api/skills?")
          ? {
              data: Array.from({ length: 205 }, (_, i) =>
                runtimeSkill("nova-owner", `skill-${i}`),
              ),
              totalPages,
            }
          : {},
      );
      management.skills.mockResolvedValue({
        skills: Array.from({ length: 205 }, (_, i) => ({
          id: `doc-${i}`,
          name: `Guide ${i}`,
          description: "Guide",
        })),
      });
      const result = await controller.report();
      expect(result.skills).toHaveLength(200);
      expect(result.documentation).toHaveLength(200);
      expect(result.skills.at(-1)?.id).toBe("skill-199");
      expect(result.documentation.at(-1)?.id).toBe("doc-199");
      expect(result.truncated).toBe(totalPages > 1);
    },
  );

  it.each([
    [null, { skills: [] }],
    [{ data: {} }, { skills: [] }],
    [{ data: [] }, null],
    [{ data: [] }, { skills: "private-malformed-catalog" }],
  ])(
    "returns a generic empty report for malformed runtime or catalog %j",
    async (runtime, catalog) => {
      const { controller, management } = fixture();
      management.request.mockImplementation(async (endpoint) =>
        endpoint.startsWith("/api/skills?") ? runtime : {},
      );
      management.skills.mockResolvedValue(catalog);
      const result = await controller.report();
      expectUnavailable(result);
      expect(result.skills).toEqual([]);
      expect(result.documentation).toEqual([]);
      expect(result.prompt).toEqual({
        enabled: null,
        prefixCharacters: null,
        suffixCharacters: null,
      });
    },
  );

  it.each(["scope", "runtime", "catalog"])(
    "hides management failure details from %s",
    async (failure) => {
      const { controller, management, scope } = fixture();
      const fail = () => {
        throw new Error(`private-error at ${gateway}`);
      };
      if (failure === "scope") scope.mockImplementation(fail);
      if (failure === "runtime") management.request.mockImplementation(fail);
      if (failure === "catalog") management.skills.mockImplementation(fail);
      expectUnavailable(await controller.report());
      if (failure === "scope") {
        expect(management.request).not.toHaveBeenCalled();
        expect(management.skills).not.toHaveBeenCalled();
      }
    },
  );
});

describe("native skill documentation", () => {
  it.each([
    "../secret",
    "%2e%2e%2fsecret",
    "safe/document",
    "safe?private=1",
    "UPPER",
    "a",
    "a".repeat(82),
  ])(
    "rejects invalid document ID %s before management or scope access",
    async (id) => {
      const { controller, management, scope, configuration } = fixture();
      expectUnavailable(await controller.document(id));
      expect(configuration).not.toHaveBeenCalled();
      expect(scope).not.toHaveBeenCalled();
      expect(management.request).not.toHaveBeenCalled();
      expect(management.skills).not.toHaveBeenCalled();
    },
  );

  it("reads only the selected catalog document, returns sanitized plain text capped at 16000", async () => {
    const { controller, management, scope } = fixture();
    const content =
      "# Guide\nBearer private-bearer-value\npassword=private-password\n" +
      "x".repeat(17000);
    management.skills.mockResolvedValue({
      name: "Guide Bearer private-name-value",
      documentation: content,
      ...privateFields,
    });
    const result = await controller.document("safe-guide");
    expect(result).toMatchObject({
      available: true,
      id: "safe-guide",
      name: "Guide [redacted]",
    });
    expect(result.documentation).toHaveLength(16000);
    expect(result.documentation).toMatch(
      /^# Guide\n\[redacted\]\npassword=\[redacted\]\n/,
    );
    expect(JSON.stringify(result)).not.toContain("private");
    expect(Object.keys(result).sort()).toEqual([
      "available",
      "documentation",
      "id",
      "name",
    ]);
    expect(management.skills.mock.calls).toEqual([["safe-guide"]]);
    expect(management.request).not.toHaveBeenCalled();
    expect(scope).not.toHaveBeenCalled();
  });

  it.each([
    null,
    [],
    {},
    { documentation: 123 },
    { documentation: { private: "object" } },
  ])(
    "returns only a generic error for malformed documentation %j",
    async (data) => {
      const { controller, management } = fixture();
      management.skills.mockResolvedValue(data);
      expect(await controller.document("safe-guide")).toEqual({
        available: false,
        error: ERROR,
      });
    },
  );

  it("does not expose upstream document errors", async () => {
    const { controller, management } = fixture();
    management.skills.mockRejectedValue(
      new Error(`private-document-error ${gateway}`),
    );
    expect(await controller.document("safe-guide")).toEqual({
      available: false,
      error: ERROR,
    });
  });
});
