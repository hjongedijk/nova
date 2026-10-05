import { Global, Module, type INestApplication } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import http from "node:http";
import os from "node:os";
import request from "supertest";
import { vi } from "vitest";
import { AuditService } from "../../src/core/audit/audit.service.js";
import type { AuditRecord } from "../../src/core/audit/audit.service.js";
import { CoreModule } from "../../src/core/core.module.js";
import { LLM_CLIENT, type LlmClient } from "../../src/settings/llm-client.js";
import { SettingsModule } from "../../src/settings/settings.module.js";
import { SettingsStore } from "../../src/settings/store/settings.store.js";
import {
  WALLPAPER_PORT,
  type WallpaperPort,
} from "../../src/settings/wallpaper.port.js";
import { ToolsModule } from "../../src/tools/tools.module.js";
import { ToolsService } from "../../src/tools/tools.service.js";
import {
  schema,
  type ToolDefinition,
  ToolSourceProvider,
  type ToolSource,
} from "../../src/tools/tool.types.js";

/** A built-in tool, like the prototype's node-red echo. */
@ToolSourceProvider()
class EchoSource implements ToolSource {
  readonly source = "node-red";
  definitions(): ToolDefinition[] {
    return [
      {
        name: "echo",
        description: "Return supplied text",
        parameters: schema(),
        risk: "READ_ONLY",
      },
    ];
  }
  async execute() {
    return { ok: true };
  }
}

@Module({ providers: [EchoSource] })
class EchoModule {}

export interface TestApp {
  app: INestApplication;
  api: ReturnType<typeof agent>;
  store: SettingsStore;
  tools: ToolsService;
  audit: AuditService;
  /** Everything written to the action log through AuditService.record while the app ran. */
  audits: AuditRecord[];
}

const agent = (app: INestApplication) => request(app.getHttpServer());

/**
 * The real controllers on a real Nest app. `env` is applied while the configuration is read,
 * because NovaConfig reads the environment once.
 */
export async function createApp(
  options: {
    env?: Record<string, string>;
    llm?: LlmClient;
    wallpaper?: WallpaperPort;
  } = {},
): Promise<TestApp> {
  const saved: Record<string, string | undefined> = {};
  for (const [key, value] of Object.entries(options.env ?? {})) {
    saved[key] = process.env[key];
    process.env[key] = value;
  }
  const providers: { provide: symbol; useValue: unknown }[] = [];
  if (options.llm)
    providers.push({ provide: LLM_CLIENT, useValue: options.llm });
  if (options.wallpaper)
    providers.push({ provide: WALLPAPER_PORT, useValue: options.wallpaper });

  // The optional ports are provided globally, as the chat and Windows modules will do.
  @Global()
  @Module({ providers, exports: providers.map((p) => p.provide) })
  class PortsModule {}

  try {
    const moduleRef = await Test.createTestingModule({
      imports: [
        CoreModule,
        ToolsModule,
        EchoModule,
        SettingsModule,
        PortsModule,
      ],
    }).compile();
    const app = moduleRef.createNestApplication();
    app.setGlobalPrefix("api");
    await app.init();
    const audit = moduleRef.get(AuditService);
    const audits: AuditRecord[] = [];
    const original = audit.record.bind(audit);
    vi.spyOn(audit, "record").mockImplementation((record) => {
      audits.push(record);
      return original(record);
    });
    return {
      app,
      api: agent(app),
      store: moduleRef.get(SettingsStore),
      tools: moduleRef.get(ToolsService),
      audit,
      audits,
    };
  } finally {
    for (const [key, value] of Object.entries(saved))
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
  }
}

export const ADMIN = { "x-nova-admin": "1" };

export const lan = Object.values(os.networkInterfaces())
  .flat()
  .find((item) => item?.family === "IPv4" && !item.internal)?.address;

export interface Seen {
  method?: string;
  url?: string;
  headers: http.IncomingHttpHeaders;
  body: string;
}

/** A small web server on all interfaces, for skills to call. */
export async function service(
  handler: (entry: Seen, response: http.ServerResponse) => void,
) {
  const seen: Seen[] = [];
  const server = http.createServer((req, res) => {
    let raw = "";
    req.on("data", (chunk) => (raw += chunk));
    req.on("end", () => {
      const entry = {
        method: req.method,
        url: req.url,
        headers: req.headers,
        body: raw,
      };
      seen.push(entry);
      handler(entry, res);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "0.0.0.0", resolve));
  const port = (server.address() as { port: number }).port;
  return {
    seen,
    port,
    close: () => {
      server.closeAllConnections();
      server.close();
    },
  };
}

export const json = (
  response: http.ServerResponse,
  status: number,
  body: unknown,
) => {
  response.writeHead(status, { "content-type": "application/json" });
  response.end(JSON.stringify(body));
};

export const onLan = (port: number, tail = "") =>
  `http://${lan}:${port}${tail}`;

export const webhook = (extra: Record<string, unknown> = {}) => ({
  type: "webhook",
  name: "Garagedeur",
  description: "Open of sluit de garagedeur van het huis",
  parameters: [
    {
      name: "actie",
      type: "string",
      description: "open of dicht",
      enum: ["open", "dicht"],
    },
  ],
  http: {
    method: "POST",
    url: "http://192.168.2.50/api/{actie}",
    body: '{"door":"garage","do":"{actie}"}',
    headers: [{ name: "X-Source", value: "nova" }],
    secretHeaders: [{ name: "X-Token", value: "geheim-123" }],
  },
  risk: "CONFIRM",
  ...extra,
});

export const playbook = (extra: Record<string, unknown> = {}) => ({
  type: "instruction",
  name: "Filmavond",
  description: "Sfeer voor een film",
  examples: ["start filmavond", "ik wil een film kijken"],
  instructions: "Dim de lampen in de woonkamer en zet de televisie aan.",
  ...extra,
});

/** The Dutch message a validation throws. */
export const problem = (fn: () => unknown): string | null => {
  try {
    fn();
  } catch (error) {
    return (
      (error as { details?: string[] }).details?.[0] ?? (error as Error).message
    );
  }
  return null;
};

/** A JSON answer; the tests check the fields they care about. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type Reply = { status: number } & Record<string, any>;
