/**
 * How much NOVA may do on her own. The backend still owns risk: DANGEROUS tools and anything that needs a screen
 * confirmation are never auto-approved. This only decides whether an ordinary CONFIRM-tier call may run without asking.
 *
 * - careful: ask for every CONFIRM tool (the old behaviour).
 * - balanced (default): routine, reversible actions run by themselves: home and media control, calendar entries, closing an
 *   app, calls to your own phones and contacts, reading files she may read.
 * - independent: a few more everyday actions (scripts, bulk off, moving calendar entries, locking the PC, clearing lists).
 *
 * Never automatic, at any level: deleting or forgetting data, shell commands, settings, code changes, servers and VMs,
 * file writes, calls to numbers that are not saved contacts, and anything not listed here. A new tool starts as "ask".
 *
 * Injection guard: once untrusted content (web, mail, documents, files, the screen) was read in this session, nothing
 * is auto-approved for a short while, so text on a web page cannot make NOVA do something.
 */
export type AutonomyLevel = "careful" | "balanced" | "independent";
export const AUTONOMY_LEVELS: readonly AutonomyLevel[] = [
  "careful",
  "balanced",
  "independent",
] as const;
export const DEFAULT_AUTONOMY_LEVEL: AutonomyLevel = "balanced";

const BALANCED = new Set([
  "ha_toggle",
  "ha_activate_scene",
  "sonos_group",
  "sonos_ungroup",
  "sonos_announce",
  "media_bulk_pause",
  "calendar_create",
  "windows_close_app",
  "mcp_filesystem_read_file",
  "mcp_filesystem_read_text_file",
  "mcp_filesystem_read_media_file",
  "mcp_filesystem_read_multiple_files",
  "mcp_filesystem_list_directory",
  "mcp_filesystem_list_directory_with_sizes",
  "mcp_filesystem_directory_tree",
  "mcp_filesystem_search_files",
  "mcp_filesystem_get_file_info",
  "mcp_filesystem_list_allowed_directories",
]);

const INDEPENDENT_EXTRA = new Set([
  "ha_run_script",
  "ha_bulk_turn_off",
  "calendar_move",
  "windows_lock",
  "list_clear",
  "notes_delete",
  "mcp_filesystem_create_directory",
]);

/** Sources whose output can carry text written by someone else. */
export const UNTRUSTED_SOURCES: ReadonlySet<string> = new Set([
  "documents",
  "mcp",
  "world",
  "browser",
  "desktop",
]);

/** How long after reading untrusted content nothing is auto-approved. */
export const TAINT_WINDOW_MS = 180_000;

export interface AutoApprovalContext {
  level: AutonomyLevel;
  /** The source judged this exact call routine (for example a call to a saved contact). */
  routine?: boolean;
  /** Untrusted content was read in this session within the taint window. */
  tainted: boolean;
}

export function isAutonomyLevel(value: unknown): value is AutonomyLevel {
  return (
    typeof value === "string" &&
    (AUTONOMY_LEVELS as readonly string[]).includes(value)
  );
}

/** May this CONFIRM-tier call run without asking? */
export function allowsAutoApproval(
  name: string,
  context: AutoApprovalContext,
): boolean {
  if (context.level === "careful" || context.tainted) return false;
  if (context.routine === true) return true;
  if (BALANCED.has(name)) return true;
  return context.level === "independent" && INDEPENDENT_EXTRA.has(name);
}
