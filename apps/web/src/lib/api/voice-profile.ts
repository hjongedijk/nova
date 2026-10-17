import { sendJson } from "./client.ts";
import { getPin } from "./pin-session.ts";

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
  const pin = getPin();
  try {
    await sendJson("PUT", "/settings/voice-profile", profile, {
      "x-nova-admin": "1",
      ...(pin ? { "x-nova-pin": pin } : {}),
    });
  } catch {
    /* the next change tries again */
  }
}
