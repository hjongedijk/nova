import type { McpServerSpec } from "./mcp-config.js";

/**
 * Exact process identities reviewed for this image. Package versions are pinned in the
 * Dockerfile and reviewed in docs/mcp-server-policy.md. A new command or argument set is
 * rejected until its source and provider behavior are reviewed here.
 */
const REVIEWED: Record<
  string,
  { command: string; args: string[]; env: Record<string, string> }
> = {
  "sequential-thinking": {
    command: "mcp-server-sequential-thinking",
    args: [],
    env: {},
  },
  context7: { command: "context7-mcp", args: [], env: {} },
  filesystem: {
    command: "mcp-server-filesystem",
    args: ["/data/workspace"],
    env: {},
  },
  arxiv: {
    command: "/opt/arxiv-mcp/bin/arxiv-mcp-server",
    args: ["--storage-path", "/data/arxiv"],
    env: {},
  },
  caldav: {
    command: "/opt/caldav-mcp/node_modules/.bin/caldav-mcp",
    args: [],
    env: {
      CALDAV_URL: "${CALDAV_URL}",
      CALDAV_USERNAME: "${CALDAV_USERNAME}",
      CALDAV_PASSWORD: "${CALDAV_PASSWORD}",
      CALDAV_READ_ONLY: "true",
      CALDAV_ALLOW_TOOLS:
        "list_calendars,list_events,get_event,search_events,get_free_busy",
    },
  },
};

const CATALOG: Record<
  string,
  {
    description: string;
    rights: string;
    risk: "READ_ONLY" | "CONFIRM";
    disabledTools?: string[];
    toolRisks?: Record<string, string>;
  }
> = {
  "sequential-thinking": {
    description: "Helpt NOVA een vraag stap voor stap te analyseren.",
    rights:
      "Levert alleen redeneerstappen; geen toegang tot je bestanden of accounts.",
    risk: "READ_ONLY",
  },
  context7: {
    description: "Zoekt actuele documentatie voor programmeerbibliotheken.",
    rights: "Leest publieke documentatie via internet.",
    risk: "READ_ONLY",
  },
  filesystem: {
    description: "Geeft tools toegang tot de ingestelde werkruimte.",
    rights:
      "Kan bestanden in /data/workspace lezen en wijzigen na bevestiging.",
    risk: "CONFIRM",
  },
  arxiv: {
    description:
      "Zoekt wetenschappelijke artikelen en leest lokaal opgeslagen papers.",
    rights:
      "Zoekt openbare arXiv-metadata; downloads zijn lokaal in /data/arxiv.",
    risk: "CONFIRM",
    disabledTools: ["semantic_search", "reindex"],
    toolRisks: {
      search_papers: "READ_ONLY",
      get_abstract: "READ_ONLY",
      list_papers: "READ_ONLY",
      read_paper: "READ_ONLY",
      get_paper_outline: "READ_ONLY",
      read_paper_section: "READ_ONLY",
      search_paper_text: "READ_ONLY",
      get_paper_latex: "READ_ONLY",
      list_paper_latex_sections: "READ_ONLY",
      get_paper_latex_section: "READ_ONLY",
      citation_graph: "READ_ONLY",
      export_citations: "READ_ONLY",
      unwatch_topic: "DANGEROUS",
    },
  },
  caldav: {
    description: "Leest je agenda via CalDAV.",
    rights:
      "Leest alleen agenda's van de ingestelde CalDAV-server; schrijft geen afspraken.",
    risk: "READ_ONLY",
    toolRisks: {
      list_calendars: "READ_ONLY",
      list_events: "READ_ONLY",
      get_event: "READ_ONLY",
      search_events: "READ_ONLY",
      get_free_busy: "READ_ONLY",
    },
  },
};

/** Only reviewed package identities may run as MCP servers in the shipped application. */
export function isReviewedMcpServer(id: string, spec: McpServerSpec): boolean {
  const reviewed = REVIEWED[id];
  if (!reviewed) return false;
  return (
    spec.command === reviewed.command &&
    JSON.stringify(spec.args ?? []) === JSON.stringify(reviewed.args) &&
    JSON.stringify(spec.env ?? {}) === JSON.stringify(reviewed.env)
  );
}

/** Return only safe catalog labels to the settings screen. */
export function reviewedMcpCatalog() {
  return Object.entries(CATALOG).map(([id, metadata]) => ({
    id,
    description: metadata.description,
    rights: metadata.rights,
    risk: metadata.risk,
  }));
}

/** Create a fixed reviewed configuration. New servers always start disabled. */
export function reviewedMcpServerSpec(id: string): McpServerSpec | undefined {
  const identity = REVIEWED[id];
  const metadata = CATALOG[id];
  if (!identity || !metadata) return undefined;
  return {
    ...metadata,
    howToDisable: "Schakel deze server uit via de MCP-instellingen.",
    command: identity.command,
    args: [...identity.args],
    env: { ...identity.env },
    enabled: false,
  };
}
