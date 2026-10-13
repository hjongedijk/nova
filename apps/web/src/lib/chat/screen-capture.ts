import type { ChatAttachment } from "@nova/contracts";

export function fitScreen(
  width: number,
  height: number,
): {
  width: number;
  height: number;
} {
  if (
    !Number.isFinite(width) ||
    !Number.isFinite(height) ||
    width < 1 ||
    height < 1
  )
    throw new Error("No screen frame");
  const scale = Math.min(1, 1600 / Math.max(width, height));
  return {
    width: Math.max(1, Math.round(width * scale)),
    height: Math.max(1, Math.round(height * scale)),
  };
}

/** One user-triggered frame. The browser picker grants this stream; tracks stop before preview. */
export async function captureScreen(): Promise<{
  attachment: ChatAttachment;
  preview: string;
}> {
  if (!navigator.mediaDevices?.getDisplayMedia)
    throw new Error("Screen capture unavailable");
  // Keep this call before any await: browsers require an active user gesture.
  const stream = await navigator.mediaDevices.getDisplayMedia({
    video: true,
    audio: false,
  });
  const video = document.createElement("video");
  try {
    if (!stream.getVideoTracks().length) throw new Error("No video track");
    video.srcObject = stream;
    video.muted = true;
    video.playsInline = true;
    await video.play();
    const size = fitScreen(video.videoWidth, video.videoHeight);
    const canvas = document.createElement("canvas");
    canvas.width = size.width;
    canvas.height = size.height;
    const context = canvas.getContext("2d");
    if (!context) throw new Error("Canvas unavailable");
    context.drawImage(video, 0, 0, size.width, size.height);
    const preview = canvas.toDataURL("image/jpeg", 0.82);
    const content = preview.split(",", 2)[1] ?? "";
    if (!content || content.length > 13_981_016)
      throw new Error("Screen image too large");
    return {
      attachment: {
        name: "schermopname.jpg",
        content,
        encoding: "base64",
        mimeType: "image/jpeg",
      },
      preview,
    };
  } finally {
    stream.getTracks().forEach((track) => track.stop());
    video.srcObject = null;
  }
}
