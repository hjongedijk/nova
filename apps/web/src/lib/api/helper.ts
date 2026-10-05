import { sendJson } from "./client.ts";

/**
 * The helper window on the Windows PC grows for an answer or a question and shrinks back to its pill. The page
 * asks NOVA, NOVA asks the Windows agent (which holds the token). Without an agent, or in a normal browser tab,
 * this does nothing and the page simply lives in whatever window it has.
 */
export async function requestHelperSize(expanded: boolean): Promise<void> {
  try {
    await sendJson<{ ok: boolean }>("POST", "/settings/helper/size", {
      expanded,
    });
  } catch {
    /* no agent: nothing to resize */
  }
}
