const normalize = (value: string) =>
  value
    .toLocaleLowerCase("nl-NL")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();

/** True when recognition is repeating part of the sentence NOVA just played. */
export function isSpeechEcho(heard: string, spoken: string): boolean {
  const phrase = normalize(heard);
  return phrase.length > 0 && normalize(spoken).includes(phrase);
}

/**
 * True when the owner is clearly saying something of their own while NOVA talks: at least three
 * words, and most of them are not in what NOVA is saying. The recognizer garbles NOVA's own voice
 * from the speakers, so an exact-substring echo test alone would let her interrupt herself.
 */
export function isOwnSpeech(heard: string, spoken: string): boolean {
  const words = normalize(heard).split(" ").filter(Boolean);
  if (words.length < 3 || isSpeechEcho(heard, spoken)) return false;
  const said = new Set(normalize(spoken).split(" "));
  const shared = words.filter((word) => said.has(word)).length;
  return shared / words.length < 0.5;
}
