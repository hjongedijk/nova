import {
  Injectable,
  Logger,
  type OnModuleDestroy,
  type OnModuleInit,
} from "@nestjs/common";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import type { ArgumentSchema, Risk } from "@nova/contracts";
import { Ajv } from "ajv";
import { NovaConfig } from "../../core/config/nova-config.js";
import type { ToolDefinition, ToolResult } from "../../tools/tool.types.js";
import {
  RISKS,
  readMcpServers,
  resolveEnv,
  toolName,
  type McpServerSpec,
} from "./mcp-config.js";

const MAX_RESULT = 20000;
const MAX_TOOLS_PER_SERVER = 50;
const CONNECT_TIMEOUT_MS = 20000;
const CALL_TIMEOUT_MS = 30000;
const RESYNC_MS = 60000;

interface McpTool {
  server: string;
  remote: string;
  description: string;
  parameters: ArgumentSchema;
  risk: Risk;
}

/**
 * MCP client hub: starts the stdio servers listed in the MCP config file and exposes their
 * tools to NOVA. A tool the server marks readOnlyHint is READ_ONLY; every other tool gets the
 * server's declared risk (default CONFIRM), so it needs the same user confirmation as other
 * state-changing actions. A server that is missing or broken is logged and skipped; start-up
 * never waits for it.
 */
@Injectable()
export class McpHub implements OnModuleInit, OnModuleDestroy {
  private readonly log = new Logger("MCP");
  private readonly ajv = new Ajv({ strict: false });
  private readonly clients = new Map<string, Client>();
  private readonly tools = new Map<string, McpTool>();
  private readonly lastFailure = new Map<string, string>();
  private timer: NodeJS.Timeout | null = null;
  private syncing: Promise<void> | null = null;
  private stopped = false;

  constructor(private readonly config: NovaConfig) {}

  /** Start in the background: the API is ready before any server is. */
  onModuleInit(): void {
    void this.start();
  }

  async onModuleDestroy(): Promise<void> {
    await this.stop();
  }

  async start(): Promise<void> {
    this.stopped = false;
    this.timer ??= setInterval(
      () => void this.sync().catch(() => {}),
      RESYNC_MS,
    ).unref();
    await this.sync();
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    await this.syncing?.catch(() => {});
    const clients = [...this.clients.values()];
    this.clients.clear();
    this.tools.clear();
    await Promise.allSettled(clients.map((client) => client.close()));
  }

  get configured(): boolean {
    return this.tools.size > 0;
  }

  owns(name: string): boolean {
    return this.tools.has(name);
  }

  /** Connect every enabled server that is not connected yet. Never throws. */
  sync(): Promise<void> {
    this.syncing ??= this.connectAll().finally(() => {
      this.syncing = null;
    });
    return this.syncing;
  }

  private async connectAll(): Promise<void> {
    const servers = readMcpServers(this.config.mcpConfig);
    for (const [id, spec] of Object.entries(servers)) {
      if (this.stopped) return;
      if (spec.enabled === false || this.clients.has(id)) continue;
      try {
        await this.connect(id, spec);
        this.lastFailure.delete(id);
      } catch (error) {
        const message = (error as Error).message;
        // Retried every minute: say it once, not every time.
        if (this.lastFailure.get(id) !== message) {
          this.lastFailure.set(id, message);
          this.log.warn(`${id} unavailable: ${message}`);
        }
      }
    }
  }

  private async connect(id: string, spec: McpServerSpec): Promise<void> {
    if (!spec || typeof spec.command !== "string" || !spec.command)
      throw new Error("no command");
    const resolved = resolveEnv(spec.env);
    if (resolved.missing)
      throw new Error(`missing ${resolved.missing.join(", ")}`);
    const client = new Client({ name: "nova", version: "1.0.0" });
    const transport = new StdioClientTransport({
      command: spec.command,
      args: spec.args ?? [],
      env: resolved.env,
      stderr: "ignore",
    });
    transport.onclose = () => this.drop(id, client);
    try {
      await client.connect(transport, { timeout: CONNECT_TIMEOUT_MS });
      const { tools } = await client.listTools(undefined, {
        timeout: CONNECT_TIMEOUT_MS,
      });
      if (this.stopped) throw new Error("shutting down");
      this.register(id, spec, tools);
      this.clients.set(id, client);
      this.log.log(`${id} connected with ${tools.length} tools`);
    } catch (error) {
      await client.close().catch(() => {});
      throw error;
    }
  }

  private register(
    id: string,
    spec: McpServerSpec,
    tools: Awaited<ReturnType<Client["listTools"]>>["tools"],
  ): void {
    const fallback = RISKS.find((risk) => risk === spec.risk) ?? "CONFIRM";
    for (const tool of tools.slice(0, MAX_TOOLS_PER_SERVER)) {
      const name = toolName(id, tool.name);
      const inputSchema: Record<string, unknown> = { ...tool.inputSchema };
      delete inputSchema.$schema;
      const parameters = (
        inputSchema.type === "object"
          ? { ...inputSchema, additionalProperties: false }
          : { type: "object", properties: {}, additionalProperties: false }
      ) as ArgumentSchema;
      try {
        this.ajv.compile(parameters);
      } catch {
        this.log.warn(`${id}/${tool.name} skipped: unsupported schema`);
        continue;
      }
      this.tools.set(name, {
        server: id,
        remote: tool.name,
        description: `[${id}] ${tool.description || tool.name}`.slice(0, 1000),
        parameters,
        risk: tool.annotations?.readOnlyHint === true ? "READ_ONLY" : fallback,
      });
    }
  }

  /** The server went away (or was closed): forget it, so the next sync can retry. */
  private drop(id: string, client: Client): void {
    if (this.clients.get(id) !== client) return;
    this.clients.delete(id);
    for (const [name, tool] of this.tools)
      if (tool.server === id) this.tools.delete(name);
  }

  definitions(): ToolDefinition[] {
    return [...this.tools].map(([name, tool]) => ({
      name,
      description: tool.description,
      parameters: tool.parameters,
      risk: tool.risk,
    }));
  }

  health(): { configured: boolean; servers: string[]; tools: number } {
    return {
      configured: this.configured,
      servers: [...this.clients.keys()],
      tools: this.tools.size,
    };
  }

  async execute(
    name: string,
    args: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<ToolResult> {
    const tool = this.tools.get(name);
    const client = tool && this.clients.get(tool.server);
    if (!tool || !client) return { ok: false, error: "MCP server is offline" };
    try {
      const response = await client.callTool(
        { name: tool.remote, arguments: args },
        undefined,
        { signal, timeout: CALL_TIMEOUT_MS },
      );
      const parts = (response.content ?? []) as {
        type: string;
        text?: string;
      }[];
      const text = parts
        .map((part) => (part.type === "text" ? part.text : `[${part.type}]`))
        .join("\n")
        .slice(0, MAX_RESULT);
      return response.isError
        ? { ok: false, error: text.slice(0, 500) }
        : { ok: true, verified: null, result: text };
    } catch (error) {
      return {
        ok: false,
        error: String((error as Error).message).slice(0, 500),
      };
    }
  }
}
