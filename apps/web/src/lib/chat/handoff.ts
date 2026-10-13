import type { HistoryMessage } from "#lib/stores/chat.svelte.ts";

const KEY = "nova-handoff-v1";
const MAX_AGE_MS = 30 * 24 * 60 * 60_000;

export interface HandoffCard {
  question: string;
  files: string[];
  nextStep: string;
  savedAt: number;
}

export function latestQuestion(history: HistoryMessage[]): string {
  return (
    history
      .findLast((item) => item.role === "user")
      ?.text.trim()
      .slice(0, 500) ?? ""
  );
}

export function readHandoff(
  storage:
    | (Pick<Storage, "getItem"> & Partial<Pick<Storage, "removeItem">>)
    | null = typeof localStorage === "undefined" ? null : localStorage,
  now = Date.now(),
): HandoffCard | null {
  try {
    const value = JSON.parse(
      storage?.getItem(KEY) ?? "null",
    ) as Partial<HandoffCard> | null;
    if (
      !value ||
      typeof value.question !== "string" ||
      typeof value.nextStep !== "string" ||
      !Array.isArray(value.files) ||
      typeof value.savedAt !== "number" ||
      value.savedAt > now + 60_000
    )
      return null;
    if (now - value.savedAt > MAX_AGE_MS) {
      storage?.removeItem?.(KEY);
      return null;
    }
    const question = value.question.trim().slice(0, 500);
    const nextStep = value.nextStep.trim().slice(0, 500);
    const files = value.files
      .filter((file): file is string => typeof file === "string")
      .slice(0, 8)
      .map((file) => file.trim().slice(0, 160))
      .filter(Boolean);
    return question && nextStep
      ? { question, files, nextStep, savedAt: value.savedAt }
      : null;
  } catch {
    return null;
  }
}

export function saveHandoff(
  question: string,
  files: string,
  nextStep: string,
  storage: Pick<Storage, "setItem"> | null = typeof localStorage === "undefined"
    ? null
    : localStorage,
  now = Date.now(),
): HandoffCard | null {
  const card = {
    question: question.trim().slice(0, 500),
    files: files
      .split(/[\n,]/)
      .map((file) => file.trim().slice(0, 160))
      .filter(Boolean)
      .slice(0, 8),
    nextStep: nextStep.trim().slice(0, 500),
    savedAt: now,
  };
  if (!card.question || !card.nextStep) return null;
  if (!storage) return null;
  try {
    storage.setItem(KEY, JSON.stringify(card));
    return card;
  } catch {
    return null;
  }
}

export function clearHandoff(
  storage: Pick<Storage, "removeItem"> | null = typeof localStorage ===
  "undefined"
    ? null
    : localStorage,
): void {
  try {
    storage?.removeItem(KEY);
  } catch {
    /* unavailable storage */
  }
}

export function handoffPrompt(card: HandoffCard): string {
  return [
    "Ga verder met deze eerder door mij bewaarde overdracht. Controleer eerst de actuele stand.",
    `Mijn vraag: ${card.question}`,
    ...(card.files.length
      ? [`Relevante bestanden: ${card.files.join(", ")}`]
      : []),
    `Volgende stap: ${card.nextStep}`,
  ].join("\n");
}
