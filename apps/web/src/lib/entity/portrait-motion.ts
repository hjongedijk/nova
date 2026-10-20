import type { UiState } from "#lib/stores/chat.svelte.ts";

/** Connected head gestures, in radians; the neck remains the pivot. */
export function portraitPose(
  time: number,
  state: UiState,
  voice: number,
  lookX: number,
  lookY: number,
  reduced: boolean,
): [number, number, number] {
  if (reduced) return [0, 0, 0];
  let yaw = Math.sin(time * 0.43) * 0.27 + Math.sin(time * 0.19 + 0.8) * 0.08;
  let pitch = Math.sin(time * 0.67 + 0.4) * 0.075;
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
  return [yaw + lookX * 0.15, pitch + lookY * 0.055, roll];
}

/** The torso turns more slowly than the head, around the lower chest. */
export function portraitBodyPose(
  time: number,
  voice: number,
  reduced: boolean,
): [number, number, number] {
  if (reduced) return [0, 0, 0];
  return [
    Math.sin(time * 0.29 - 0.7) * 0.13 + Math.sin(time * 0.13) * 0.035,
    Math.sin(time * 0.41) * 0.025,
    Math.sin(time * 0.31) * 0.025 + Math.sin(time * 1.3) * voice * 0.01,
  ];
}
