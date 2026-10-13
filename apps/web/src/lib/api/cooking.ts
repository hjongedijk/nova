import { sendJson } from "./client.ts";

export function setCookingTimer(
  minutes: number,
  step: number,
): Promise<unknown> {
  return sendJson("POST", "/cooking/timer", { minutes, step });
}
