import type { CommunicationPreference } from "@nova/contracts";

const KEY = "nova-communication-preferences-v1";
const ALLOWED: CommunicationPreference[] = [
  "concise",
  "fewer_jokes",
  "more_detail",
  "warmer",
];

export function readCommunicationPreferences(
  storage: Pick<Storage, "getItem"> | null = typeof localStorage === "undefined"
    ? null
    : localStorage,
): CommunicationPreference[] {
  try {
    const value = JSON.parse(storage?.getItem(KEY) ?? "[]");
    if (!Array.isArray(value)) return [];
    return [...new Set(value.filter((item) => ALLOWED.includes(item)))].slice(
      0,
      ALLOWED.length,
    );
  } catch {
    return [];
  }
}

export function saveCommunicationPreference(
  preference: CommunicationPreference,
  storage: Pick<Storage, "getItem" | "setItem"> | null = typeof localStorage ===
  "undefined"
    ? null
    : localStorage,
): CommunicationPreference[] {
  const next = readCommunicationPreferences(storage);
  if (!ALLOWED.includes(preference)) return next;
  const updated = [...new Set([...next, preference])].slice(0, ALLOWED.length);
  try {
    storage?.setItem(KEY, JSON.stringify(updated));
  } catch {
    /* Private browsing or full storage must not break chat. */
  }
  return updated;
}
