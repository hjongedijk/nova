/** The running microphone test, so closing the dialog (or pressing the button again) can stop it. */
let stop: (() => void) | null = null;

export const micTestRunning = (): boolean => stop !== null;

export function setMicTest(handler: (() => void) | null): void {
  stop = handler;
}

export function stopMicTest(): void {
  stop?.();
  stop = null;
}
