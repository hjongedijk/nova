import { getJson } from "#lib/api/client.ts";

export const appAccess = $state({
  checking: true,
  required: false,
  unlocked: false,
  error: "",
});

let check: Promise<void> | undefined;

/** Share one fail-closed access check between the startup shell and its gate. */
export function checkAppAccess(): Promise<void> {
  if (check) return check;
  check = getJson<{ required: boolean; unlocked: boolean }>("/access/status")
    .then((status) => {
      appAccess.required = status.required;
      appAccess.unlocked = status.unlocked;
    })
    .catch(() => {
      appAccess.required = true;
      appAccess.unlocked = false;
      appAccess.error =
        typeof navigator !== "undefined" &&
        navigator.language.toLowerCase().startsWith("en")
          ? "Secure access could not be checked. Reload and try again."
          : "Beveiligde toegang kon niet worden gecontroleerd. Laad opnieuw.";
    })
    .finally(() => (appAccess.checking = false));
  return check;
}
