import { getPublicConfig } from "#lib/api/shell.ts";
import { DEFAULT_CHIPS, shell } from "#lib/stores/shell.svelte.ts";

/** Quick actions and the public address from /api/settings/public; the defaults stay when it fails. */
export async function loadPublicConfig(): Promise<void> {
  try {
    const data = await getPublicConfig();
    shell.quickActions = data.quickActions ?? DEFAULT_CHIPS;
    shell.publicOrigin = data.publicUrl || "";
  } catch {
    /* the defaults stay */
  }
}
