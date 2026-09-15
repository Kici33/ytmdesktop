export type ListenTrack = { videoId: string; title: string; author: string; index: number };
export type ListenPlayback = {
  videoId: string | null;
  title: string;
  author: string;
  position: number;
  duration: number;
  playing: boolean;
  buffering: boolean;
  adPlaying: boolean;
  queue: ListenTrack[];
};
export type ListenSnapshot = {
  playback: ListenPlayback;
  members: { id: string; name: string }[];
  allowControls: boolean;
};
export type ListenStatus = {
  role: "idle" | "host" | "guest";
  invite: string;
  error: string;
  connected: boolean;
  snapshot: ListenSnapshot | null;
};
export type ListenCommand =
  | { type: "add"; videoId: string; next: boolean }
  | { type: "play" | "pause" | "next" }
  | { type: "seek"; position: number }
  | { type: "select"; index: number; videoId: string };

export function parseVideoId(input: string): string {
  if (typeof input !== "string" || input.length > 2048) throw new Error("Enter a YouTube Music song link or video ID.");
  input = input.trim();
  if (/^[A-Za-z0-9_-]{11}$/.test(input)) return input;
  try {
    const url = new URL(input);
    if (url.protocol !== "https:") throw new Error();
    if (["music.youtube.com", "www.youtube.com", "youtube.com", "youtu.be"].includes(url.hostname)) {
      const id = url.hostname === "youtu.be" ? url.pathname.slice(1) : url.searchParams.get("v");
      if (/^[A-Za-z0-9_-]{11}$/.test(id ?? "")) return id;
    }
  } catch {
    /* Show the same validation error for malformed links. */
  }
  throw new Error("Enter a YouTube Music song link or video ID.");
}

export function validateListenCommand(value: unknown): ListenCommand {
  if (!value || typeof value !== "object") throw new Error("Invalid session command.");
  const command = value as Record<string, unknown>;
  switch (command.type) {
    case "add":
      return { type: "add", videoId: parseVideoId(command.videoId as string), next: command.next === true };
    case "play":
    case "pause":
    case "next":
      return { type: command.type };
    case "seek":
      if (typeof command.position === "number" && Number.isFinite(command.position) && command.position >= 0 && command.position <= 86400)
        return { type: "seek", position: command.position };
      break;
    case "select":
      if (Number.isInteger(command.index) && Number(command.index) >= 0 && Number(command.index) < 500)
        return { type: "select", index: Number(command.index), videoId: parseVideoId(command.videoId as string) };
  }
  throw new Error("Invalid session command.");
}

export function listenAddress(input: string): URL {
  const url = new URL(input);
  const ipv4 = /^(\d{1,3}\.){3}\d{1,3}$/.test(url.hostname) && url.hostname.split(".").every(part => Number(part) <= 255);
  const local =
    url.hostname === "localhost" ||
    url.hostname === "[::1]" ||
    (ipv4 &&
      (/^127\./.test(url.hostname) ||
        /^10\./.test(url.hostname) ||
        /^192\.168\./.test(url.hostname) ||
        /^172\.(1[6-9]|2\d|3[01])\./.test(url.hostname) ||
        /^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./.test(url.hostname)));
  if (url.username || url.password || url.search || url.pathname !== "/" || (url.protocol !== "https:" && !(url.protocol === "http:" && local))) {
    throw new Error("Use an HTTPS host address, or HTTP on a local network/private VPN.");
  }
  return url;
}
