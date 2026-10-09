import { parentPort, workerData } from "node:worker_threads";
import { getDocumentProxy } from "unpdf";
import { unzipSync, strFromU8 } from "fflate";
import { XMLParser, XMLValidator } from "fast-xml-parser";

export interface DocumentText {
  text: string;
  truncated: boolean;
}

// Reject oversized expanded ZIPs before decompressing a DOCX.
function checkZip(buffer: Buffer): void {
  let end = buffer.length - 22;
  const minimum = Math.max(0, end - 65535);
  while (end >= minimum && buffer.readUInt32LE(end) !== 0x06054b50) end--;
  if (end < minimum) throw new Error("Invalid DOCX");
  const count = buffer.readUInt16LE(end + 10);
  let offset = buffer.readUInt32LE(end + 16);
  let expanded = 0;
  if (count > 2000) throw new Error("DOCX has too many entries");
  for (let i = 0; i < count; i++) {
    if (
      offset + 46 > buffer.length ||
      buffer.readUInt32LE(offset) !== 0x02014b50
    )
      throw new Error("Invalid DOCX directory");
    expanded += buffer.readUInt32LE(offset + 24);
    if (expanded > 32 * 1024 * 1024)
      throw new Error("DOCX expands beyond 32 MiB");
    offset +=
      46 +
      buffer.readUInt16LE(offset + 28) +
      buffer.readUInt16LE(offset + 30) +
      buffer.readUInt16LE(offset + 32);
  }
}

/** Runs only in an isolated worker, with memory and elapsed-time limits. */
export async function parseDocument(
  data: Uint8Array,
  kind: "pdf" | "docx",
): Promise<DocumentText> {
  const maxChars = 24000;
  if (kind === "docx") {
    const buffer = Buffer.from(data);
    checkZip(buffer);
    const files = unzipSync(buffer, {
      filter: (file) => file.name === "word/document.xml",
    });
    const document = files["word/document.xml"];
    if (!document) throw new Error("No Word document body");
    const xml = strFromU8(document);
    if (/<!DOCTYPE/i.test(xml) || XMLValidator.validate(xml) !== true)
      throw new Error("Invalid document XML");
    const tree: unknown = new XMLParser({
      preserveOrder: true,
      removeNSPrefix: true,
      ignoreAttributes: true,
      parseTagValue: false,
      trimValues: false,
    }).parse(xml);
    let text = "";
    function visit(node: unknown, insideText = false): void {
      if (text.length > maxChars) return;
      if (Array.isArray(node)) {
        for (const child of node) visit(child, insideText);
        return;
      }
      if (!node || typeof node !== "object") return;
      for (const [name, value] of Object.entries(node)) {
        if (name === "#text" && insideText) text += String(value);
        else if (name === "tab") text += "\t";
        else if (name === "br") text += "\n";
        else {
          visit(value, name === "t");
          if (name === "p") text += "\n";
        }
      }
    }
    visit(tree);
    return { text: text.slice(0, maxChars), truncated: text.length > maxChars };
  }
  const pdf = await getDocumentProxy(data);
  try {
    // Bound both page count and text; do not silently claim to read a whole book.
    let text = "";
    let pages = 0;
    for (
      ;
      pages < Math.min(pdf.numPages, 100) && text.length <= maxChars;
      pages++
    ) {
      const page = await pdf.getPage(pages + 1);
      const content = await page.getTextContent();
      text +=
        content.items
          .map((item) =>
            "str" in item ? item.str + (item.hasEOL ? "\n" : " ") : "",
          )
          .join("") + "\n";
      page.cleanup();
    }
    return {
      text: text.slice(0, maxChars),
      truncated: pages < pdf.numPages || text.length > maxChars,
    };
  } finally {
    await pdf.loadingTask.destroy();
  }
}

if (parentPort) {
  const { data, kind } = workerData as {
    data: Uint8Array;
    kind: "pdf" | "docx";
  };
  try {
    parentPort.postMessage(await parseDocument(data, kind));
  } catch {
    parentPort.postMessage({ error: "Document cannot be read" });
  }
}
