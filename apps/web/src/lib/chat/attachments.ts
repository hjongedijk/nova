import type { ChatAttachment } from "@nova/contracts";

const binaryTypes: Record<string, string> = {
  pdf: "application/pdf",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  webp: "image/webp",
  gif: "image/gif",
};

/** Keep raw files in the browser until submit; encoding is for the existing chat API. */
export async function encodeAttachments(
  files: File[],
): Promise<ChatAttachment[]> {
  return Promise.all(
    files.map(async (file) => {
      const mimeType =
        binaryTypes[file.name.split(".").at(-1)?.toLowerCase() ?? ""];
      if (mimeType) {
        const content = await new Promise<string>((resolve, reject) => {
          const reader = new FileReader();
          reader.onload = () =>
            resolve(String(reader.result).split(",")[1] ?? "");
          reader.onerror = () =>
            reject(new Error(`${file.name}: lezen mislukt.`));
          reader.readAsDataURL(file);
        });
        return { name: file.name, content, encoding: "base64", mimeType };
      }
      if (/\.(zip|doc|xlsx?|pptx?|exe|mp[34]|wav|heic|svg)$/i.test(file.name))
        throw new Error(
          `${file.name}: kies PDF, DOCX, PNG/JPEG/WebP/GIF of een tekstbestand.`,
        );
      try {
        const content = new TextDecoder("utf-8", { fatal: true }).decode(
          await file.arrayBuffer(),
        );
        if (hasBinaryControls(content)) throw new Error("binary");
        return { name: file.name, content };
      } catch {
        throw new Error(
          `${file.name}: geen leesbaar UTF-8 tekstbestand. Kies PDF, DOCX of een afbeelding.`,
        );
      }
    }),
  );
}

function hasBinaryControls(content: string): boolean {
  for (const char of content) {
    if (char.charCodeAt(0) < 32 && !["\t", "\n", "\r"].includes(char))
      return true;
  }
  return false;
}
