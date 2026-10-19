import type { ModelRoleId } from "@nova/contracts";
import {
  isApiOperationTool,
  MAX_API_OPERATION_TOOLS,
} from "../apis/api-tool-names.js";

export interface SelectableTool {
  type: "function";
  function: { name: string; description: string; parameters: unknown };
}

const STOP_WORDS = new Set(
  `a aan als al ben bij de den der deze dit doen doe een en er graag het help hier hoe i in is je kan kun kunt me met mijn naar niet nu of om op please tell te the van vraag wat welke with wil wo woonkamer zoek eens iets leuke leuks vertel`.split(
    /\s+/,
  ),
);

const ALIASES: Record<string, string[]> = {
  pc: ["desktop", "windows", "computer", "screen", "takeover"],
  computer: ["desktop", "windows", "pc", "screen", "takeover"],
  bureaublad: ["desktop", "windows", "pc", "screen", "takeover"],
  overnemen: ["desktop", "takeover", "control"],
  bedienen: ["desktop", "control", "keyboard", "mouse"],
  tijd: ["clock", "time", "timezone"],
  laat: ["clock", "time"],
  datum: ["clock", "date"],
  dag: ["clock", "date"],
  day: ["clock", "date"],
  lamp: ["light", "lighting", "lamp"],
  licht: ["light", "lighting", "lamp"],
  lampen: ["light", "lighting", "lamp"],
  weer: ["weather", "forecast", "temperature", "rain", "wind"],
  temperatuur: ["temperature", "weather"],
  regen: ["rain", "weather"],
  afspraak: ["calendar", "event", "agenda"],
  agenda: ["calendar", "event", "agenda"],
  mail: ["email", "imap", "mail"],
  e_mail: ["email", "imap", "mail"],
  bestand: ["file", "filesystem", "document"],
  bestanden: ["file", "filesystem", "document"],
  document: ["documents", "document", "file", "library"],
  documenten: ["documents", "document", "file", "library"],
  pdf: ["documents", "document", "file", "search"],
  bibliotheek: ["documents", "document", "library"],
  map: ["directory", "folder", "filesystem"],
  code: ["code", "workspace", "git", "file", "test"],
  repository: ["repository", "git", "github", "code"],
  repo: ["repository", "git", "github", "code"],
  server: ["server", "proxmox", "system", "host"],
  vm: ["vm", "virtual", "proxmox"],
  nieuws: ["news", "headline"],
  zoeken: ["search", "find", "lookup"],
  zoek: ["search", "find", "lookup"],
  web: ["web", "search", "browser", "internet"],
  lichtschakelaar: ["light", "switch", "lighting"],
  muziek: ["music", "media", "sonos", "play"],
  timer: ["timer", "reminder"],
  onthouden: ["memory", "list"],
  geheugen: ["memory", "list", "correct"],
  herinneringen: ["memory", "list"],
  corrigeer: ["memory", "correct"],
  corrigeren: ["memory", "correct"],
  verbeter: ["memory", "correct"],
  klopt: ["memory", "correct", "list"],
  herinnering: ["reminder", "timer"],
  toon: ["visualization", "visualize", "holographic", "show"],
  toont: ["visualization", "visualize", "holographic", "show"],
  visualiseer: ["visualization", "visualize", "holographic"],
  visualisatie: ["visualization", "visualize", "holographic"],
  hologram: ["visualization", "holographic"],
  holografisch: ["visualization", "holographic"],
  topologie: ["visualization", "topology", "proxmox"],
  graaf: ["visualization", "graph"],
  bel: ["phone", "call", "contact", "extension"],
  bellen: ["phone", "call", "contact", "extension"],
  belt: ["phone", "call", "contact"],
  opbellen: ["phone", "call", "contact", "extension"],
  telefoon: ["phone", "call", "extension"],
  telefoneer: ["phone", "call", "contact"],
  telefoneren: ["phone", "call", "contact"],
  ophangen: ["phone", "hangup", "call"],
  houd: ["objective", "monitor", "watch"],
  gaten: ["objective", "monitor", "watch"],
  monitor: ["objective", "monitor", "watch"],
  monitoren: ["objective", "monitor", "watch"],
  bewaak: ["objective", "monitor", "watch"],
  bewaken: ["objective", "monitor", "watch"],
  weten: ["objective", "monitor", "notify"],
  waarschuw: ["objective", "monitor", "notify"],
  waarschuwen: ["objective", "monitor", "notify"],
  gezond: ["objective", "monitor", "server", "health"],
  blijft: ["objective", "monitor"],
  doelen: ["objective", "monitor"],
  api: ["api", "connect", "integration", "endpoint"],
  apis: ["api", "connect", "integration", "endpoint"],
  koppel: ["api", "connect", "integration"],
  koppelen: ["api", "connect", "integration"],
  koppeling: ["api", "connect", "integration"],
  integreer: ["api", "connect", "integration"],
  integreren: ["api", "connect", "integration"],
  integratie: ["api", "connect", "integration"],
  verbind: ["api", "connect", "integration"],
  verbinden: ["api", "connect", "integration"],
  endpoint: ["api", "endpoint", "connect", "call"],
  token: ["api", "token", "connect"],
  leer: ["api", "connect", "describe"],
  swagger: ["api", "connect", "describe"],
  openapi: ["api", "connect", "describe"],
  graphql: ["api", "connect", "describe"],
  soap: ["api", "connect", "describe"],
};

function words(value: string): Set<string> {
  return new Set(
    value
      .normalize("NFD")
      .replace(/[\u0300-\u036f]/g, "")
      .toLocaleLowerCase("nl-NL")
      .replace(/[^a-z0-9_]+/g, " ")
      .split(/\s+/)
      .filter(
        (word) =>
          (word.length > 2 || Object.hasOwn(ALIASES, word)) &&
          !STOP_WORDS.has(word),
      ),
  );
}

/** Per-operation tools of connected APIs: only the ones that match the request, at most MAX_API_OPERATION_TOOLS. */
export function capApiOperationTools<T extends SelectableTool>(
  tools: T[],
  message: string,
  role: ModelRoleId,
): T[] {
  const operations = tools.filter((tool) =>
    isApiOperationTool(tool.function.name),
  );
  if (!operations.length) return tools;
  const keep = new Set(
    rankToolsForRequest(operations, message, role).slice(
      0,
      MAX_API_OPERATION_TOOLS,
    ),
  );
  return tools.filter(
    (tool) => !isApiOperationTool(tool.function.name) || keep.has(tool),
  );
}

export const TOOL_DISCOVERY_NAME = "nova_tools_search";
export const MAX_MODEL_TOOLS = 24;

/** Shared lexical ranking for initial selection and explicit catalog discovery. */
export function rankToolsForRequest<T extends SelectableTool>(
  tools: T[],
  message: string,
  role: ModelRoleId,
): T[] {
  const query = words(message);
  const explicitPc = [
    "pc",
    "computer",
    "windows",
    "desktop",
    "bureaublad",
  ].some((word) => query.has(word));
  const expanded = new Set(query);
  for (const word of query)
    for (const alias of Object.hasOwn(ALIASES, word)
      ? (ALIASES[word] ?? [])
      : [])
      expanded.add(alias);
  return tools
    .map((tool, index) => {
      const nameWords = words(tool.function.name.replace(/_/g, " "));
      nameWords.add(tool.function.name.toLowerCase());
      const descriptionWords = words(tool.function.description);
      // Keep the complete observe/control sequence available for explicit PC requests,
      // even when a large integration catalog also matches the requested app/media.
      let score =
        explicitPc &&
        /^desktop_(?:status|windows|screenshot|takeover_start|act|takeover_stop)$/.test(
          tool.function.name,
        )
          ? 100
          : 0;
      for (const word of expanded) {
        if (nameWords.has(word)) score += 3;
        if (descriptionWords.has(word)) score += 1;
      }
      if (
        role === "code" &&
        /(?:^|_)(?:code|git|workspace|filesystem)(?:_|$)/i.test(
          tool.function.name,
        )
      )
        score += 2;
      return { tool, index, score };
    })
    .filter((entry) => entry.score > 0)
    .sort((a, b) => b.score - a.score || a.index - b.index)
    .map((entry) => entry.tool);
}

/** Keep large catalogs discoverable rather than sending every schema on weak matches. */
export function selectToolsForRequest<T extends SelectableTool>(
  tools: T[],
  message: string,
  role: ModelRoleId,
  maxTools = MAX_MODEL_TOOLS,
): T[] {
  tools = capApiOperationTools(tools, message, role);
  if (tools.length <= maxTools) return tools;
  const discovery = tools.find(
    (tool) => tool.function.name === TOOL_DISCOVERY_NAME,
  );
  const candidates = tools.filter((tool) => tool !== discovery);
  const ranked = rankToolsForRequest(candidates, message, role);
  // Compatibility for registries that intentionally disable catalog discovery.
  if (!ranked.length) return discovery ? [discovery] : tools;
  return [
    ...ranked.slice(0, Math.max(0, maxTools - (discovery ? 1 : 0))),
    ...(discovery ? [discovery] : []),
  ];
}
