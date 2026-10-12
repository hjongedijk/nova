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
    const selected = [
      ...new Set(value.filter((item) => ALLOWED.includes(item))),
    ].slice(0, ALLOWED.length) as CommunicationPreference[];
    if (selected.includes("concise") && selected.includes("more_detail"))
      selected.splice(selected.indexOf("concise"), 1);
    return selected;
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
  const updated = next.includes(preference)
    ? next.filter((item) => item !== preference)
    : [
        ...next.filter((item) =>
          preference === "concise"
            ? item !== "more_detail"
            : preference === "more_detail"
              ? item !== "concise"
              : true,
        ),
        preference,
      ].slice(0, ALLOWED.length);
  try {
    storage?.setItem(KEY, JSON.stringify(updated));
  } catch {
    /* Private browsing or full storage must not break chat. */
  }
  return updated;
}
