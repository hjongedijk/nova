/*
 * Deterministic turn classification for the conversation style. No model call: a few Dutch and English
 * heuristics decide whether a message is something to execute, something to answer, or something to talk about.
 * The result only changes how much "conversation partner" guidance the prompt carries; it never grants
 * or removes a tool, so a misclassification costs tone, not safety.
 */
export type TurnKind =
  "command" | "question" | "discussion" | "brainstorm" | "smalltalk";

export interface TurnLike {
  role: string;
  content: string;
}

/** Turns where NOVA should talk rather than execute or look up. */
export function isConversational(kind: TurnKind): boolean {
  return kind === "discussion" || kind === "brainstorm" || kind === "smalltalk";
}

const normalise = (text: string) =>
  text
    .toLocaleLowerCase("nl-NL")
    .replace(/[“”"«»]/g, "")
    .replace(/\s+/g, " ")
    .trim();

const POLITE_PREFIX =
  /^(?:(?:hey |hoi |nova |ok(?:é|e|ay)? |alsjeblieft |graag |please )*)(?:kun je|kan je|kunt u|wil je|zou je|zou u|can you|could you|will you|would you|please|alsjeblieft|graag|even)\s+/;

const COMMAND_VERBS = [
  "zet",
  "doe",
  "schakel",
  "start",
  "stop",
  "open",
  "sluit",
  "speel",
  "pauzeer",
  "bel",
  "stuur",
  "maak",
  "voeg",
  "verwijder",
  "wis",
  "zoek",
  "toon",
  "herinner",
  "onthoud",
  "vergeet",
  "schrijf",
  "zeg",
  "lees",
  "controleer",
  "check",
  "activeer",
  "deactiveer",
  "dim",
  "verhoog",
  "verlaag",
  "sla",
  "plan",
  "annuleer",
  "vertel",
  "geef",
  "laat",
  "ga",
  "draai",
  "volgende",
  "turn",
  "switch",
  "play",
  "pause",
  "set",
  "call",
  "remind",
  "add",
  "remove",
  "delete",
  "search",
  "show",
  "run",
  "send",
  "create",
  "tell",
  "give",
  "close",
  "lock",
  "unlock",
  "skip",
  "mute",
  "unmute",
  "remember",
  "forget",
  "save",
  "read",
  "find",
  "look",
  "make",
  "put",
  "cancel",
  "schedule",
];
const COMMAND_START = new RegExp(`^(?:${COMMAND_VERBS.join("|")})\\b`);
// "kun je het licht aan zetten": the verb sits at the end
const COMMAND_INFINITIVE_END =
  /\b(?:zetten|doen|aanzetten|uitzetten|openen|sluiten|starten|stoppen|afspelen|bellen|sturen|opzoeken|toevoegen|verwijderen|opslaan|uitschakelen|aanschakelen|dimmen|pauzeren|instellen|annuleren|onthouden|vertellen|laten zien|turn on|turn off|switch on|switch off|open|close|start|stop|play|call|send)\s*[?.!]*$/;

const BRAINSTORM =
  /\b(?:brainstorm\w*|ideeën|ideeen|idee voor|bedenk (?:samen|eens|met me)|laten we (?:even |samen |eens )*(?:nadenken|bedenken|brainstormen|verzinnen|fantaseren)|zullen we (?:even )?(?:brainstormen|bedenken|nadenken)|geef me (?:wat |een paar )?(?:ideeën|ideeen|suggesties|tips)|suggesties voor|wat zijn (?:leuke|goede|originele) |let'?s (?:brainstorm|think|come up)|ideas (?:for|about)|come up with|give me (?:some )?ideas|what could i (?:do|make|call)|hoe zouden we)\b/;

const DISCUSSION =
  /\b(?:wat vind je|wat denk je|wat denk jij|wat is jouw (?:mening|idee|visie)|hoe zie jij|hoe denk jij|ben je het (?:met mij |met me |daar )?(?:eens|oneens)|vind je (?:het |dat |ook )?(?:een |niet )?(?:goed|slim|slecht|gek|raar|zinvol|logisch|verstandig|overdreven)|is (?:het|dat|dit) (?:slim|verstandig|een goed idee|een slecht idee|logisch|zinvol|normaal|gek)|waarom (?:denk|vind|zou) (?:je|jij)|ik twijfel|ik overweeg|ik ben van plan|ik wil eigenlijk|ik denk dat|ik vind dat|ik geloof dat|volgens mij|stel dat|wat als|zou het (?:niet )?beter|moet ik (?:nou |dan )?(?:wel |toch )?(?:liever )?(?:\w+ ){0,6}of\b|beter of|\bversus\b|\bvs\b|what do you think|what'?s your (?:take|opinion|view)|do you think|do you agree|your opinion|should i|i'?m thinking (?:about|of)|i wonder|i think |in my opinion|would it be (?:better|smart|wise)|is it (?:smart|wise|a good idea)|pros and cons|voor- en nadelen|voor en nadelen)\b/;

const SMALLTALK =
  /^(?:hoi|hallo|hey|hee|hi|hello|yo|goedemorgen|goedemiddag|goedenavond|goedenacht|welterusten|dag|doei|tot ziens|tot straks|bye|goodnight|good morning|good evening|hoe gaat (?:het|ie)(?: met je| met jou)?|hoe is het met (?:je|jou)|hoe was je dag|hoe voel je je|how are you|how'?s it going|what'?s up|wat een dag|wat een (?:gedoe|week|weer)|ik ben (?:moe|blij|boos|verdrietig|bang|zenuwachtig|gestrest|chagrijnig|druk|bezig)|ik heb (?:het druk|honger|dorst|zin in|er zin in|slecht geslapen|een rotdag|een goede dag)|bedankt|dank (?:je|u)|dankjewel|thanks|thank you|thx|haha\w*|lol|grappig|leuk|lekker|balen|jammer|gezellig|nice|cool|top|mooi|geweldig|fijn|prima|oke|oké|ok|okay|goed zo|sterk|wow|helemaal goed|tof|vertel (?:me )?(?:een )?(?:mop|grap|grapje)|tell me a joke|ik verveel me|i'?m (?:tired|bored|happy|sad|stressed))\b/;

const CONFIRM =
  /^(?:(?:ja|yes|oké|oke|ok)[\s,]+)?(?:ja|jawel|jazeker|nee|nope|nee hoor|yes|yep|yeah|no|doe maar|ga je gang|ga maar|go ahead|do it|graag|liever niet|laat maar|laat maar zitten)[\s.!,]*(?:maar|hoor|even|graag|alsjeblieft|please)?[\s.!]*$/;

const QUESTION_WORD =
  /^(?:wat|wie|waar|waarom|wanneer|hoe|hoeveel|welke|welk|waarvoor|waarmee|waarheen|wanneer|is|zijn|was|waren|heeft|hebben|had|kan|kun|kunt|mag|moet|moeten|zal|zou|gaat|gaan|wordt|worden|doe je|ken je|weet je|what|who|where|when|why|how|which|is|are|was|were|does|do|did|can|could|will|would|should|has|have)\b/;

const lastAssistantAsked = (recent: TurnLike[]): boolean => {
  for (let i = recent.length - 1; i >= 0; i--) {
    const turn = recent[i];
    if (turn?.role === "assistant") return /\?\s*$/.test(turn.content.trim());
  }
  return false;
};

const wordCount = (text: string) => text.split(/\s+/).filter(Boolean).length;

/** Decide what kind of turn this is. Pure and deterministic; `recentTurns` are the turns before this message. */
export function classifyTurn(
  message: string,
  recentTurns: TurnLike[] = [],
): TurnKind {
  const text = normalise(message);
  if (!text) return "question";
  const words = wordCount(text);
  const asked = lastAssistantAsked(recentTurns);

  if (BRAINSTORM.test(text)) return "brainstorm";

  // A bare yes/no: an answer to NOVA's own question is an instruction to continue, otherwise small talk.
  if (CONFIRM.test(text)) return asked ? "command" : "smalltalk";

  if (/\b(?:mop|grap|grapje|joke)\b/.test(text)) return "smalltalk";

  const stripped = text.replace(POLITE_PREFIX, "");
  const polite = stripped !== text;
  if (
    COMMAND_START.test(stripped) &&
    !/\?$/.test(text) &&
    !DISCUSSION.test(text)
  )
    return "command";
  if (polite && COMMAND_INFINITIVE_END.test(stripped) && !DISCUSSION.test(text))
    return "command";
  if (polite && COMMAND_START.test(stripped) && !DISCUSSION.test(text))
    return "command";

  if (DISCUSSION.test(text)) return "discussion";
  if (SMALLTALK.test(text) && words <= 8 && !QUESTION_WORD.test(text))
    return "smalltalk";
  if (SMALLTALK.test(text) && words <= 5) return "smalltalk";

  if (/\?/.test(text) || QUESTION_WORD.test(text)) {
    // "wat vind je ervan" style handled above; a very short follow-up to NOVA's own question is conversation
    if (asked && words <= 4 && !/\?/.test(text)) return "discussion";
    return "question";
  }

  // A statement. It continues a thread when NOVA just asked something or the user is clearly sharing a view.
  if (asked) return "discussion";
  if (words >= 5) return "discussion";
  return "smalltalk";
}

const STOPWORDS = new Set(
  (
    "aan about achter adres alle allemaal alleen altijd andere anders bedankt behalve beetje beter bijna bijvoorbeeld " +
    "binnen blijkbaar daar daarom dacht dagen dank dankjewel dat deze dezelfde doen door echt eens eerst eigenlijk " +
    "even gaan gaat geen gewoon goed haar hebben heeft heel hier hoe hoor houden iets ieder iemand jouw jullie kan " +
    "kijk komen komt kunnen kunt laat later liever maar maken meer meest mijn moet moeten mogelijk naar nodig nooit " +
    "nogal onder ongeveer ooit onze other over precies samen schijnt soms steeds tegen toch toen tussen uiteindelijk " +
    "veel verder voor vooral waar waarom want waren weer weet welke werd wilde willen wordt worden zeg zeker zelf " +
    "zich zijn zoals zodat zonder zouden zullen about after again also always because been before being between both " +
    "could does doing done dont down each even every from have having here into just kind know like make many maybe " +
    "more most much need only other really should some something still such than that their them then there these " +
    "they thing think this those through very want were what when where which while will with would your yours " +
    "wat niet ook nog wel meer mooi leuk graag gisteren vandaag morgen"
  ).split(" "),
);

const keywords = (text: string): string[] =>
  (text.toLocaleLowerCase("nl-NL").match(/[\p{L}][\p{L}\p{N}-]{3,}/gu) ?? [])
    .map((word) => word.replace(/-+$/, ""))
    .filter((word) => word.length >= 4 && !STOPWORDS.has(word));

/**
 * One line that names what the last few turns were about, so NOVA can refer back to it.
 * Cheap keyword counting over the user's words (assistant words count for less); null when nothing stands out.
 */
export function topicHint(
  recentTurns: TurnLike[],
  maxTurns = 6,
): string | null {
  const turns = recentTurns
    .filter((turn) => turn.role === "user" || turn.role === "assistant")
    .slice(-maxTurns);
  if (!turns.length) return null;
  const score = new Map<string, number>();
  const lastSeen = new Map<string, number>();
  turns.forEach((turn, index) => {
    const weight = turn.role === "user" ? 2 : 1;
    // Only the first 400 characters of long answers: the opening carries the topic.
    for (const word of new Set(keywords(turn.content.slice(0, 400)))) {
      score.set(word, (score.get(word) ?? 0) + weight);
      lastSeen.set(word, index);
    }
  });
  const top = [...score.entries()]
    .filter(([, value]) => value >= 2)
    .sort(
      (a, b) =>
        b[1] - a[1] || (lastSeen.get(b[0]) ?? 0) - (lastSeen.get(a[0]) ?? 0),
    )
    .slice(0, 3)
    .map(([word]) => word);
  if (!top.length) return null;
  return `We hadden het eerder in dit gesprek over: ${top.join(", ")}.`;
}
