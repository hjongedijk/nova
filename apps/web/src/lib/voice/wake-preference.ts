export type WakeSensitivity = "low" | "normal" | "high";

const KEY = "novaWakeSensitivity";
const VALUES: WakeSensitivity[] = ["low", "normal", "high"];

export function wakeSensitivity(
  storage: Pick<Storage, "getItem"> | null = typeof localStorage === "undefined"
    ? null
    : localStorage,
): WakeSensitivity {
  try {
    const value = storage?.getItem(KEY);
    return VALUES.includes(value as WakeSensitivity)
      ? (value as WakeSensitivity)
      : "normal";
  } catch {
    return "normal";
  }
}

export function saveWakeSensitivity(
  value: WakeSensitivity,
  storage: Pick<Storage, "setItem"> | null = typeof localStorage === "undefined"
    ? null
    : localStorage,
): WakeSensitivity {
  const safe = VALUES.includes(value) ? value : "normal";
  try {
    storage?.setItem(KEY, safe);
  } catch {
    /* Wake recognition keeps the normal setting for this session. */
  }
  return safe;
}
