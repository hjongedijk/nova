import { wakeSensitivity, type WakeSensitivity } from "./wake-preference.ts";

export const WAKE_STRICT =
  /\b(?:nova|novah|novaa|nofa|nofah|noba|nowa|noova|nuva|no[\s-]va)\b/i;
export const WAKE_LOOSE =
  /\b(?:hey|hé|hee|he|hoi|hallo|ok|oké|okay|hi)[\s,.!?-]+(?:no[\s-]?[vbfw]a+h?|noah|nover|noe[\s-]?va|nu[\s-]?va)\b/i;
const WAKE_NORMAL = /\b(?:nova|novah|novaa)\b/i;
const WAKE_LOW_PHRASE = /\b(?:hey|hé|hoi)[\s,.!?-]+nova\b/i;

export function findWake(
  text: string,
  sensitivity: WakeSensitivity = wakeSensitivity(),
): { start: number; end: number } | null {
  const match =
    sensitivity === "low"
      ? WAKE_LOW_PHRASE.exec(text)
      : sensitivity === "normal"
        ? WAKE_NORMAL.exec(text) || WAKE_LOW_PHRASE.exec(text)
        : WAKE_STRICT.exec(text) || WAKE_LOOSE.exec(text);
  return match
    ? { start: match.index, end: match.index + match[0].length }
    : null;
}
