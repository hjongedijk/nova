import type { PendingConfirmation } from "@nova/contracts";

const APPROVE = new Set([
  "ja",
  "ja graag",
  "ja hoor",
  "ja doe maar",
  "jazeker",
  "graag",
  "doe maar",
  "oké",
  "oke",
  "ok",
  "okay",
  "prima",
  "akkoord",
  "zeker",
  "ga je gang",
  "bevestig",
  "yes",
  "yes please",
  "confirm",
]);
const CANCEL = new Set([
  "nee",
  "nee hoor",
  "nee dank je",
  "nee bedankt",
  "laat maar",
  "niet doen",
  "annuleer",
  "cancel",
  "no",
]);

/** A short answer to "Zal ik …?". Whether anything is waiting for an answer is the caller's question. */
export function confirmationIntent(
  message: string,
): "approve" | "cancel" | null {
  const text = message
    .trim()
    .toLowerCase()
    .replace(/[.!?,]+$/g, "");
  if (APPROVE.has(text)) return "approve";
  if (CANCEL.has(text)) return "cancel";
  return null;
}

const VERBS: Record<string, [string, string]> = {
  start: ["starten", "start"],
  stop: ["stoppen", "stop"],
  shutdown: ["afsluiten", "shut down"],
  reboot: ["opnieuw opstarten", "reboot"],
};

type Args = Record<string, unknown> & { data?: Record<string, unknown> };

/** What the user is about to approve, worded to follow "Zal ik". */
function describe(action: Pick<PendingConfirmation, "tool" | "args">): {
  nl: string;
  en: string;
} {
  const a = (action.args ?? {}) as Args;
  const verb =
    VERBS[action.tool.replace(/^proxmox_/, "").replace(/_guest$/, "")];
  if (verb && a.vmid)
    return { nl: `VM ${a.vmid} ${verb[0]}`, en: `${verb[1]} VM ${a.vmid}` };
  if (action.tool === "termix_run_command")
    return {
      nl: `\`${a.command}\` uitvoeren op ${a.host}`,
      en: `run \`${a.command}\` on ${a.host}`,
    };
  if (action.tool === "windows_close_app")
    return {
      nl: `${a.app} afsluiten op je pc`,
      en: `close ${a.app} on your PC`,
    };
  if (action.tool === "windows_lock")
    return { nl: "je pc vergrendelen", en: "lock your PC" };
  if (action.tool.startsWith("list_"))
    return {
      nl: `de lijst ${a.list} leegmaken`,
      en: `clear the list ${a.list}`,
    };
  const label =
    a.domain && a.service
      ? `${a.domain} ${a.service}`
      : action.tool.replace(/_/g, " ");
  const values: Record<string, unknown> = { ...a, ...a.data };
  const members = values.group_members as string[] | undefined;
  const changes = [
    values.temperature !== undefined ? `${values.temperature} graden` : null,
    typeof values.volume_level === "number"
      ? `volume op ${Math.round(values.volume_level * 100)}%`
      : null,
    values.brightness_pct !== undefined
      ? `helderheid ${values.brightness_pct}%`
      : null,
    members?.length ? `groep ${members.join(", ")}` : null,
    values.message ||
      values.text ||
      values.media_content_id ||
      values.media_id ||
      null,
  ]
    .filter(Boolean)
    .join(", ");
  const ids = a.entity_ids as string[] | undefined;
  const target =
    a.entity_id || ids?.join(", ") || a.id || a.host || a.app || a.url || "";
  const phrase = [label, target && `voor ${target}`, changes && `(${changes})`]
    .filter(Boolean)
    .join(" ");
  return { nl: phrase, en: phrase };
}

export function confirmationQuestion(
  action: Pick<PendingConfirmation, "tool" | "args">,
  english = false,
): string {
  const what = describe(action);
  return english
    ? `Shall I ${what.en}? Say yes or no within 60 seconds.`
    : `Zal ik ${what.nl}? Zeg maar ja of nee, je hebt 60 seconden.`;
}
