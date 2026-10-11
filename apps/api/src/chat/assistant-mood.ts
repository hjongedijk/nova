export const ASSISTANT_MOODS = [
  "happy",
  "thoughtful",
  "concerned",
  "enthusiastic",
  "neutral",
] as const;

export type AssistantMood = (typeof ASSISTANT_MOODS)[number];

export const MOOD_MARKER_PATTERN =
  /^\s*<!--NOVA_MOOD:(happy|thoughtful|concerned|enthusiastic|neutral)-->\s*/i;
const PRIVATE_MARKER = /<!--NOVA_MOOD:[^>]{0,40}-->/gi;

export function stripPrivateMoodMarkers(content: string): string {
  return content.replace(PRIVATE_MARKER, "");
}

export function extractAssistantMood(content: string): {
  content: string;
  mood: AssistantMood;
  matched: boolean;
} {
  const match = MOOD_MARKER_PATTERN.exec(content);
  if (!match)
    return {
      content: stripPrivateMoodMarkers(content),
      mood: "neutral",
      matched: false,
    };
  return {
    content: stripPrivateMoodMarkers(content.slice(match[0].length)),
    mood: match[1]!.toLowerCase() as AssistantMood,
    matched: true,
  };
}
