import fs from "node:fs";

/** A coordinate pair with the name NOVA should use for it. */
export interface HomeLocation {
  latitude: number;
  longitude: number;
  name: string;
}

export const HOME_LOCATION_FILE = "home-location.json";

/**
 * The home location is remembered on disk, so weather at home works right after a restart,
 * before Home Assistant has finished syncing.
 */
export function rememberHome(
  home: { latitude: number; longitude: number },
  file: string,
): void {
  try {
    const saved = JSON.parse(fs.readFileSync(file, "utf8")) as Partial<
      typeof home
    >;
    if (saved.latitude === home.latitude && saved.longitude === home.longitude)
      return;
  } catch {
    /* nothing saved yet */
  }
  try {
    fs.writeFileSync(
      file,
      JSON.stringify({ latitude: home.latitude, longitude: home.longitude }),
    );
  } catch {
    /* read-only data directory: fine, we only lose the cache */
  }
}

export function recallHome(file: string): HomeLocation | null {
  try {
    const { latitude, longitude } = JSON.parse(
      fs.readFileSync(file, "utf8"),
    ) as { latitude?: unknown; longitude?: unknown };
    return typeof latitude === "number" &&
      typeof longitude === "number" &&
      Number.isFinite(latitude) &&
      Number.isFinite(longitude)
      ? { latitude, longitude, name: "thuis" }
      : null;
  } catch {
    return null;
  }
}
