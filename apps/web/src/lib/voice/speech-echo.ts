/** True when recognition is repeating part of the sentence NOVA just played. */
export function isSpeechEcho(heard: string, spoken: string): boolean {
  const normalize = (value: string) =>
    value
      .toLocaleLowerCase("nl-NL")
      .replace(/[^\p{L}\p{N}]+/gu, " ")
      .trim();
  const phrase = normalize(heard);
  return phrase.length > 0 && normalize(spoken).includes(phrase);
}
