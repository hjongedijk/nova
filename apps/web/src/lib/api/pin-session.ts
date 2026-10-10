/** Device authentication stays in memory and expires after fifteen minutes. */
export const PIN_SESSION_MS = 15 * 60 * 1000;
export const PIN_KEY = "novaPin";
let pin = "";
let expiresAt = 0;

export function getPin(): string {
  if (Date.now() >= expiresAt) {
    pin = "";
    expiresAt = 0;
  }
  return pin;
}

export function setPin(value: string): void {
  pin = value;
  expiresAt = value ? Date.now() + PIN_SESSION_MS : 0;
  // Remove the former persistent credential; never read it into this session.
  try {
    localStorage.removeItem(PIN_KEY);
  } catch {
    /* storage may be blocked */
  }
}

setPin("");
