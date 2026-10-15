/** What the action log may keep about desktop tools: never typed text, never what the screen showed. */
export const isDesktopTool = (name: string) => name.startsWith("desktop_");

const NUMBER_KEYS = [
  "display",
  "maxWidth",
  "ttlSeconds",
  "x",
  "y",
  "toX",
  "toY",
  "dx",
  "dy",
];

export function desktopAuditArgs(
  name: string,
  args: Record<string, unknown>,
): Record<string, unknown> {
  const safe: Record<string, unknown> = {};
  for (const key of NUMBER_KEYS)
    if (typeof args[key] === "number") safe[key] = args[key];
  for (const key of ["action", "key", "windowId"])
    if (typeof args[key] === "string") safe[key] = args[key].slice(0, 80);
  if (typeof args.window === "string") safe.window = args.window.slice(0, 80);
  if (typeof args.goal === "string") safe.goal = args.goal.slice(0, 200);
  if (typeof args.text === "string")
    safe.textCharacters = [...args.text].length;
  if (typeof args.question === "string")
    safe.questionCharacters = [...args.question].length;
  void name;
  return safe;
}

export function desktopAuditResult(result: {
  ok: boolean;
  error?: unknown;
  requiresConfirmation?: unknown;
  [key: string]: unknown;
}): Record<string, unknown> {
  return {
    ok: result.ok,
    ...(typeof result.error === "string"
      ? { error: result.error.slice(0, 200) }
      : {}),
    ...(result.requiresConfirmation ? { requiresConfirmation: true } : {}),
    ...(typeof result.performed === "string"
      ? { performed: result.performed }
      : {}),
    ...(typeof result.cached === "boolean" ? { cached: result.cached } : {}),
  };
}
