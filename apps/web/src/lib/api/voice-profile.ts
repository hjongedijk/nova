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
  | { status: "unchanged" | "synced"; profile?: VoiceProfilePayload }
  | { status: "failed"; message: string; auth?: boolean };

const sameProfile = (a: VoiceProfilePayload, b: VoiceProfilePayload) =>
  (a.voice ?? null) === (b.voice ?? null) &&
  a.rate === b.rate &&
  a.pitch === b.pitch;

/**
 * Reads the shared profile for every client. A legacy local choice migrates only when the server has no chosen voice.
 * Opening an older browser or helper never overwrites an existing shared voice.
 */
export async function reconcileVoiceProfile(
  local?: VoiceProfilePayload,
): Promise<VoiceProfileSync> {
  try {
    const remote = await getJson<
      VoiceProfilePayload & { initialized?: boolean }
    >("/settings/voice-profile", { signal: AbortSignal.timeout(5000) });
    if (!Number.isFinite(remote.rate) || !Number.isFinite(remote.pitch))
      throw new Error("Ongeldig stemprofiel");
    // The shared profile wins. Only migrate an older browser choice when no server voice exists.
    if (!local || remote.initialized !== false || sameProfile(local, remote))
      return { status: "unchanged", profile: remote };
    const saved = await sendJson<VoiceProfilePayload>(
      "PUT",
      "/settings/voice-profile",
      { ...local, initialize: true },
    );
    return { status: "synced", profile: saved };
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
