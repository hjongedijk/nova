/** Replies are light markdown: paragraphs, headings, bullet lists, **bold**, *bold*, `code`. */

export interface Word {
  text: string;
  /** "b" bold, "c" code, "" plain. */
  cls: "" | "b" | "c";
  /** Whitespace came before this word. */
  space: boolean;
  /** Position in the whole reply (the words light up in this order as they are spoken). */
  index: number;
  /** Characters up to and including this word, to follow the voice. */
  end: number;
}

export type Block =
  | { type: "p"; heading: boolean; words: Word[] }
  | { type: "ul"; items: Word[][] };

function inline(
  text: string,
  into: Word[],
  counter: { index: number; end: number },
  force: Word["cls"] = "",
  spaceFirst = false,
): void {
  let space = spaceFirst;
  const parts = text.split(/(\*\*[^*]+\*\*|`[^`]+`|\*[^*\s][^*]*\*)/g);
  for (const part of parts) {
    if (!part) continue;
    let cls: Word["cls"] = force;
    let body: string;
    if (/^\*\*[^*]+\*\*$/.test(part)) {
      cls = "b";
      body = part.slice(2, -2);
    } else if (/^`[^`]+`$/.test(part)) {
      cls = "c";
      body = part.slice(1, -1);
    } else if (/^\*[^*\s][^*]*\*$/.test(part)) {
      cls = "b";
      body = part.slice(1, -1);
    } else {
      body = part.replace(/[*`]/g, "");
    }
    for (const piece of body.split(/(\s+)/)) {
      if (!piece) continue;
      if (/^\s+$/.test(piece)) {
        space = true;
        continue;
      }
      counter.end += piece.length + 1;
      into.push({
        text: piece,
        cls,
        space,
        index: counter.index++,
        end: counter.end,
      });
      space = false;
    }
  }
}

export function parseReply(text: string): Block[] {
  const blocks: Block[] = [];
  const counter = { index: 0, end: 0 };
  let list: Extract<Block, { type: "ul" }> | null = null;
  let para: Extract<Block, { type: "p" }> | null = null;
  for (const raw of text.replace(/\r/g, "").split("\n")) {
    const line = raw.trim();
    if (!line) {
      para = null;
      list = null;
      continue;
    }
    const item = line.match(/^(?:[-*•]|\d+[.)])\s+(.*)$/);
    const head = line.match(/^#{1,6}\s+(.*)$/);
    if (item) {
      if (!list) {
        list = { type: "ul", items: [] };
        blocks.push(list);
      }
      para = null;
      const words: Word[] = [];
      inline(item[1] ?? "", words, counter);
      list.items.push(words);
    } else {
      list = null;
      const continued = Boolean(para) && !head;
      if (!para || head) {
        para = { type: "p", heading: Boolean(head), words: [] };
        blocks.push(para);
      }
      inline(head ? (head[1] ?? "") : line, para.words, counter, "", continued);
      if (head) para = null;
    }
  }
  return blocks;
}
