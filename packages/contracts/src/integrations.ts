/** The video NOVA picked for "speel X op YouTube". */
export interface YoutubeVideo {
  videoId: string;
  title: string;
  shortTitle: string;
  channel: string;
  duration: string;
  url: string;
}

/** A Termix host as termix_hosts reports it (never with credentials). */
export interface TermixHostSummary {
  id: number | string;
  name: string;
  ip?: string;
  port?: number;
  username?: string;
  folder?: string | null;
  tags?: string[] | null;
}
