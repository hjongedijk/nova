/** The browser proxy exposes only the native editor protocol, never arbitrary runtime routes. */
export interface NodeRedEditorRoute {
  path: string;
  authenticated: boolean;
}

const ID = "[A-Za-z0-9_.-]{1,128}";
const MODULE = `(?:@${ID}/)?${ID}`;
const nodeCatalog = new RegExp(`^/nodes/${MODULE}/${ID}/messages$`);
const nodeModuleOrSet = new RegExp(`^/nodes/${MODULE}(?:/${ID})?$`);
const pluginModuleOrId = new RegExp(`^/plugins/${MODULE}(?:/${ID})?$`);
const icon = new RegExp(`^/icons/${MODULE}/${ID}$`);
const flow = new RegExp(`^/flow/${ID}$`);
const credentials = new RegExp(`^/credentials/[^/]{1,128}/${ID}$`);
const context = new RegExp(
  `^/context/(?:global|(?:node|flow)/${ID})(/[^/]+(?:/[^/]+)*)?$`,
);
const library = new RegExp(`^/library/${ID}/${ID}(/[^/]+(?:/[^/]+)*)?/?$`);
const inject = new RegExp(`^/inject/${ID}$`);
const debug = new RegExp(`^/debug/(?:${ID}/)?(?:enable|disable)$`);
const udpPorts = new RegExp(`^/udp-ports/${ID}$`);
const privateQueryNames = new Set([
  "access_token",
  "auth",
  "token",
  "authorization",
]);

/** rawUrl is origin-relative, after removing the public editor proxy prefix. */
export function nodeRedEditorRoute(
  rawUrl: string,
  method: string,
): NodeRedEditorRoute | null {
  if (
    rawUrl.length > 8192 ||
    !rawUrl.startsWith("/") ||
    rawUrl.startsWith("//") ||
    // eslint-disable-next-line no-control-regex -- Reject raw control bytes in URLs.
    /[\u0000-\u0020\u007f#]/.test(rawUrl)
  )
    return null;

  const queryIndex = rawUrl.indexOf("?");
  const encodedPath = queryIndex < 0 ? rawUrl : rawUrl.slice(0, queryIndex);
  const query = queryIndex < 0 ? "" : rawUrl.slice(queryIndex + 1);
  let path: string;
  try {
    // Validate before URL parsing, which would silently normalize dot segments.
    if (/%(?:2f|5c|2e)/i.test(encodedPath)) return null;
    path = decodeURIComponent(encodedPath);
    const decodedQuery = decodeURIComponent(query.replace(/\+/g, " "));
    // eslint-disable-next-line no-control-regex -- Reject encoded control bytes too.
    if (/[\u0000-\u001f\u007f]/.test(decodedQuery)) return null;
  } catch {
    return null;
  }
  if (
    // eslint-disable-next-line no-control-regex -- Decoded paths must contain no control bytes.
    /[\\%?#\u0000-\u001f\u007f]/.test(path) ||
    path.includes("//") ||
    path.split("/").some((segment) => segment === "." || segment === "..")
  )
    return null;
  for (const name of new URLSearchParams(query).keys()) {
    if (privateQueryNames.has(name.toLowerCase())) return null;
  }

  const read = method === "GET";
  const asset =
    path === "/" ||
    path === "/favicon.ico" ||
    path === "/theme" ||
    path === "/theme/" ||
    /^\/(?:red|vendor|types|theme|resources|locales)\/.+/.test(path) ||
    icon.test(path) ||
    /^\/debug\/view\/.+/.test(path);
  if (asset) {
    return read || method === "HEAD"
      ? { path: rawUrl, authenticated: false }
      : null;
  }

  // Express matches literal route segments before decoding parameters. Both forms
  // must reach a native admin handler; otherwise a raw encoded prefix could fall
  // through to an HTTP node with the private bearer attached.
  return allowedAdminPath(encodedPath, method) && allowedAdminPath(path, method)
    ? { path: rawUrl, authenticated: true }
    : null;
}

function allowedAdminPath(path: string, method: string): boolean {
  const contextMatch = context.exec(path);
  const libraryMatch = library.exec(path);
  return (
    (method === "GET" &&
      ([
        "/settings",
        "/settings/user",
        "/flows",
        "/nodes",
        "/nodes/messages",
        "/plugins",
        "/plugins/messages",
        "/icons",
      ].includes(path) ||
        flow.test(path) ||
        nodeCatalog.test(path) ||
        nodeModuleOrSet.test(path) ||
        pluginModuleOrId.test(path) ||
        credentials.test(path) ||
        contextMatch !== null ||
        libraryMatch !== null ||
        udpPorts.test(path))) ||
    (method === "POST" &&
      (["/settings/user", "/flows", "/flow"].includes(path) ||
        Boolean(libraryMatch?.[1]) ||
        inject.test(path) ||
        debug.test(path))) ||
    ((method === "PUT" || method === "DELETE") && flow.test(path)) ||
    (method === "DELETE" && Boolean(contextMatch?.[1]))
  );
}
