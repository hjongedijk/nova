import type { UiState } from "#lib/stores/chat.svelte.ts";

/** Small, connected head gestures, in radians; the neck remains the pivot. */
export function portraitPose(
  time: number,
  state: UiState,
  voice: number,
  lookX: number,
  lookY: number,
  reduced: boolean,
): [number, number, number] {
  if (reduced) return [0, 0, 0];
  let yaw = Math.sin(time * 0.43) * 0.13 + Math.sin(time * 0.19 + 0.8) * 0.045;
  let pitch = Math.sin(time * 0.67 + 0.4) * 0.055;
  let roll = Math.sin(time * 0.37 + 1.2) * 0.045;
  if (state === "listening") {
    pitch -= 0.055;
    roll *= 0.55;
  }
  if (state === "thinking") {
    yaw += 0.07;
    pitch += 0.035;
  }
  pitch += Math.sin(time * 3.1) * voice * 0.065;
  roll += Math.sin(time * 1.8) * voice * 0.018;
  return [yaw + lookX * 0.1, pitch + lookY * 0.055, roll];
}
