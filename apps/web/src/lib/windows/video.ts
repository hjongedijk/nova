// Players for the video window. YouTube goes through youtube-nocookie.com; commands use each player's postMessage API.
import type { NovaVideoSource } from "@nova/contracts";

export function embedUrl(
  source: NovaVideoSource,
  origin: string,
): string | null {
  if (
    source.provider === "youtube" &&
    source.id &&
    /^[A-Za-z0-9_-]{11}$/.test(source.id)
  ) {
    const query = new URLSearchParams({
      autoplay: "1",
      playsinline: "1",
      rel: "0",
      modestbranding: "1",
      enablejsapi: "1",
      origin,
    });
    if (source.start) query.set("start", String(Math.floor(source.start)));
    return `https://www.youtube-nocookie.com/embed/${source.id}?${query}`;
  }
  if (
    source.provider === "vimeo" &&
    source.id &&
    /^\d{5,12}$/.test(source.id)
  ) {
    const hash = source.start ? `#t=${Math.floor(source.start)}s` : "";
    return `https://player.vimeo.com/video/${source.id}?autoplay=1&dnt=1&title=0&byline=0${hash}`;
  }
  return null;
}

/** The message that plays or pauses an embedded player. */
export function playerCommand(
  provider: NovaVideoSource["provider"],
  play: boolean,
): string | null {
  if (provider === "youtube")
    return JSON.stringify({
      event: "command",
      func: play ? "playVideo" : "pauseVideo",
      args: [],
    });
  if (provider === "vimeo")
    return JSON.stringify({ method: play ? "play" : "pause" });
  return null;
}

export const playerOrigin = (provider: NovaVideoSource["provider"]) =>
  provider === "youtube"
    ? "https://www.youtube-nocookie.com"
    : provider === "vimeo"
      ? "https://player.vimeo.com"
      : null;

export const mediaUrl = (source: NovaVideoSource): string | null =>
  (source.provider === "file" || source.provider === "hls") &&
  typeof source.url === "string" &&
  /^https?:\/\//i.test(source.url)
    ? source.url
    : null;
