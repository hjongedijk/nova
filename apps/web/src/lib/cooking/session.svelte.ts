import { speak, stopSpeaking } from "#lib/voice/speaker.ts";
import { cookingCommand } from "./commands.ts";
export { parseRecipe } from "./commands.ts";

export const cooking = $state({
  open: false,
  active: false,
  steps: [] as string[],
  index: 0,
});

export function beginCooking(steps: string[]): void {
  cooking.steps = steps;
  cooking.index = 0;
  cooking.active = true;
  void readCookingStep();
}

export async function readCookingStep(): Promise<void> {
  if (!cooking.active) return;
  stopSpeaking();
  await speak(
    `Stap ${cooking.index + 1} van ${cooking.steps.length}. ${cooking.steps[cooking.index]}`,
  );
}

export function nextCookingStep(): void {
  if (!cooking.active) return;
  if (cooking.index < cooking.steps.length - 1) {
    cooking.index++;
    void readCookingStep();
  } else {
    void speak("Dat was de laatste stap. Eet smakelijk!");
  }
}

export function previousCookingStep(): void {
  if (!cooking.active) return;
  cooking.index = Math.max(0, cooking.index - 1);
  void readCookingStep();
}

export function endCooking(): void {
  stopSpeaking();
  cooking.active = false;
  cooking.open = false;
  cooking.steps = [];
  cooking.index = 0;
}

/** Exact local commands work through both wake-word and push-to-talk recognition. */
export function handleCookingCommand(text: string): boolean {
  if (!cooking.active) return false;
  const command = cookingCommand(text);
  if (command === "next") {
    nextCookingStep();
    return true;
  }
  if (command === "repeat") {
    void readCookingStep();
    return true;
  }
  if (command === "previous") {
    previousCookingStep();
    return true;
  }
  if (command === "stop") {
    endCooking();
    return true;
  }
  return false;
}
