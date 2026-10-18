import { ApiError, getJson, sendJson } from "./client.ts";

export interface VoiceProfilePayload {
  voice?: string;
  rate: number;
  pitch: number;
}

/**
 * The browser keeps the chosen voice in local storage, but phone calls and spoken conversations run on the server, so
 * every change is mirrored there. Best effort: speech in the browser never depends on it.
 */
export async function pushVoiceProfile(
  profile: VoiceProfilePayload,
): Promise<void> {
  try {
    await sendJson("PUT", "/settings/voice-profile", profile);
  } catch {
    /* the next change tries again */
  }
}

export type VoiceProfileSync =
  | { status: "unchanged" | "synced" }
  | { status: "failed"; message: string; auth?: boolean };

const sameProfile = (a: VoiceProfilePayload, b: VoiceProfilePayload) =>
  (a.voice ?? null) === (b.voice ?? null) &&
  a.rate === b.rate &&
  a.pitch === b.pitch;

/**
 * Makes the server (phone calls) match the profile this browser stored: reads the server copy and only writes when it
 * differs, so running it on every start is harmless. Unlike pushVoiceProfile the outcome is reported, never swallowed.
 */
export async function reconcileVoiceProfile(
  local: VoiceProfilePayload,
): Promise<VoiceProfileSync> {
  try {
    const remote = await getJson<VoiceProfilePayload>(
      "/settings/voice-profile",
    );
    if (sameProfile(local, remote)) return { status: "unchanged" };
    await sendJson("PUT", "/settings/voice-profile", local);
    return { status: "synced" };
  } catch (error) {
    return {
      status: "failed",
      message: error instanceof Error ? error.message : String(error),
      // Rejected for auth: reported quietly by the caller; this never leads to an unlock prompt.
      auth:
        error instanceof ApiError &&
        (error.status === 401 || error.status === 403),
    };
  }
}
