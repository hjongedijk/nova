/** Cleans model output for speech: no markdown, links, code or emoji; numbers stay as written. */
export function forSpeech(text: string): string {
  return text
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/`([^`]*)`/g, "$1")
    .replace(/!\[[^\]]*\]\([^)]*\)/g, " ")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/https?:\/\/\S+/g, "een link")
    .replace(/^\s{0,3}#{1,6}\s+/gm, "")
    .replace(/^\s*[-*•]\s+/gm, "")
    .replace(/^\s*\d+[.)]\s+/gm, "")
    .replace(/[*_~>|]+/g, "")
    .replace(/[\p{Extended_Pictographic}️‍]/gu, "")
    .replace(/\s+/g, " ")
    .trim();
}

const END = /([.!?…]+["')\]]*)(\s+|$)/;
const SOFT = /([,;:])\s+/;

/**
 * Collects streamed tokens and releases complete sentences so speech can start before the model
 * has finished. Very short fragments are merged into the next sentence; very long ones are cut at a
 * comma or space.
 */
export class SentenceChunker {
  private buffer = "";
  constructor(
    private readonly minChars = 14,
    private readonly maxChars = 220,
  ) {}

  push(text: string): string[] {
    this.buffer += text;
    const out: string[] = [];
    for (;;) {
      const match = END.exec(this.buffer);
      let cut = -1;
      if (match) {
        const end = match.index + match[1]!.length;
        // "3.5", "14.30" and "dr." are not sentence ends.
        const before = this.buffer.slice(
          Math.max(0, match.index - 1),
          match.index + 1,
        );
        const decimal =
          /\d\./.test(before) && /^\d/.test(this.buffer.slice(end).trimStart());
        if (!decimal && match[2] !== "") cut = end;
        else if (!decimal && match[2] === "" && this.buffer.length - end === 0)
          cut = -1; // wait for more
      }
      if (cut < 0 && this.buffer.length > this.maxChars) {
        const head = this.buffer.slice(0, this.maxChars);
        const soft = [...head.matchAll(new RegExp(SOFT, "g"))].at(-1);
        cut = soft ? soft.index! + soft[1]!.length : head.lastIndexOf(" ");
        if (cut <= 0) cut = this.maxChars;
      }
      if (cut < 0) break;
      const sentence = this.buffer.slice(0, cut).trim();
      const rest = this.buffer.slice(cut).trimStart();
      if (sentence.length < this.minChars && rest) {
        // Too short on its own: keep it and wait for the next sentence.
        this.buffer = `${sentence} ${rest}`;
        const next = END.exec(this.buffer.slice(sentence.length + 1));
        if (!next) break;
        const end = sentence.length + 1 + next.index + next[1]!.length;
        out.push(this.buffer.slice(0, end).trim());
        this.buffer = this.buffer.slice(end).trimStart();
        continue;
      }
      if (sentence) out.push(sentence);
      this.buffer = rest;
    }
    return out;
  }

  /** The rest, when the model is done. */
  flush(): string | null {
    const rest = this.buffer.trim();
    this.buffer = "";
    return rest || null;
  }
}
