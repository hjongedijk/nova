/** Fixed network providers; no command, arguments or general environment are caller-controlled. */
const FIELDS = {
  imap: ["IMAP_HOST", "IMAP_USER", "IMAP_PASSWORD"],
  caldav: ["CALDAV_URL", "CALDAV_USERNAME", "CALDAV_PASSWORD"],
};
export function networkMcpSpec(server, input) {
  const fields = FIELDS[server];
  if (!fields) {
    if (input !== undefined) throw new Error("invalid MCP credentials");
    return null;
  }
  if (
    !input ||
    typeof input !== "object" ||
    Array.isArray(input) ||
    Object.keys(input).length !== fields.length ||
    Object.keys(input).some((key) => !fields.includes(key)) ||
    fields.some(
      (key) =>
        typeof input[key] !== "string" ||
        !input[key] ||
        Buffer.byteLength(input[key]) > 2048 ||
        input[key].includes("\0"),
    )
  )
    throw new Error("invalid MCP credentials");
  if (
    server === "imap" &&
    !/^[A-Za-z0-9][A-Za-z0-9.-]{0,252}$/.test(input.IMAP_HOST)
  )
    throw new Error("invalid MCP credentials");
  if (server === "caldav") {
    let url;
    try {
      url = new URL(input.CALDAV_URL);
    } catch {
      throw new Error("invalid MCP credentials");
    }
    if (url.protocol !== "https:" || url.username || url.password || url.hash)
      throw new Error("invalid MCP credentials");
  }
  return {
    command: [`/opt/${server}-mcp/node_modules/.bin/${server}-mcp`],
    environment: {
      ...Object.fromEntries(fields.map((key) => [key, input[key]])),
      ...(server === "imap"
        ? {
            IMAP_TLS: "implicit",
            IMAP_PORT: "993",
            IMAP_READ_ONLY: "true",
            IMAP_SEEN_KEYWORD: "",
            IMAP_ALLOW_TOOLS: "list_messages,get_message",
          }
        : {
            CALDAV_READ_ONLY: "true",
            CALDAV_ALLOW_TOOLS:
              "list_calendars,list_events,get_event,search_events,get_free_busy",
          }),
    },
  };
}
