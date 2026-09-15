import { networkInterfaces } from "node:os";
import { ListenCommand, ListenPlayback, ListenSnapshot, ListenStatus, listenAddress, validateListenCommand } from "../../shared/listen-together";
import { createListenServer } from "./server";

type Player = {
  getPlayback(): ListenPlayback;
  command(command: ListenCommand): Promise<void>;
  sync(playback: ListenPlayback): Promise<void>;
};

export default class ListenTogether {
  private server: Awaited<ReturnType<typeof createListenServer>>;
  private status: ListenStatus = { role: "idle", invite: "", error: "", connected: false, snapshot: null };
  private endpoint = "";
  private token = "";
  private timer: ReturnType<typeof setTimeout>;
  private generation = 0;
  private guestReady = false;
  private holdVideoId: string | null = null;
  private holdUntil = 0;
  private lastLocalVideoId: string | null = null;
  private playNowBusy = false;

  constructor(private player: Player) {}

  public addresses() {
    return Object.values(networkInterfaces())
      .flat()
      .filter(address => address?.family === "IPv4" && !address.internal)
      .map(address => `http://${address.address}:9864`);
  }

  public getStatus(): ListenStatus {
    if (this.server) this.status.snapshot = this.server.snapshot();
    return this.status;
  }

  public async host(name: string, address: string) {
    if (this.status.role !== "idle") throw new Error("Leave your current session first.");
    if (typeof name !== "string" || !name.trim() || name.length > 40) throw new Error("Enter a name (1–40 characters).");
    const url = listenAddress(address);
    url.hash = "";
    const server = await createListenServer({ name: name.trim(), getPlayback: () => this.player.getPlayback(), command: c => this.player.command(c) });
    try {
      await server.app.listen({ host: "0.0.0.0", port: 9864 });
    } catch (error) {
      await server.app.close();
      throw error;
    }
    this.server = server;
    url.hash = server.inviteToken;
    this.status = { role: "host", invite: url.toString(), error: "", connected: true, snapshot: server.snapshot() };
    return this.getStatus();
  }

  private async request(path: string, body?: unknown, token = this.token) {
    const response = await fetch(this.endpoint + path, {
      method: body === undefined ? "GET" : "POST",
      headers: { "Authorization": `Bearer ${token}`, "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(8000),
      redirect: "error",
      credentials: "omit"
    });
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let size = 0;
    let chunk = await reader.read();
    while (!chunk.done) {
      size += chunk.value.length;
      if (size > 512000) {
        await reader.cancel();
        throw new Error("Invalid session response.");
      }
      chunks.push(chunk.value);
      chunk = await reader.read();
    }
    const result = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    if (!response.ok) throw new Error(typeof result.error === "string" ? result.error.slice(0, 200) : "The session is unavailable.");
    return result;
  }

  public async join(name: string, invite: string) {
    if (this.status.role !== "idle") throw new Error("Leave your current session first.");
    if (typeof name !== "string" || !name.trim() || name.length > 40) throw new Error("Enter a name (1–40 characters).");
    const url = listenAddress(invite);
    const token = url.hash.slice(1);
    if (!/^[a-f0-9]{64}$/.test(token)) throw new Error("Paste the complete invite, including its session key.");
    this.endpoint = url.origin;
    const result = await this.request("/listen/join", { name: name.trim() }, token);
    if (!/^[a-f0-9]{64}$/.test(result.token)) throw new Error("Invalid session response.");
    this.token = result.token;
    this.guestReady = false;
    this.holdVideoId = null;
    this.lastLocalVideoId = null;
    this.status = { role: "guest", invite: "", connected: true, error: "", snapshot: null };
    const generation = ++this.generation;
    void this.poll(generation);
    return this.getStatus();
  }

  private async poll(generation: number) {
    try {
      const start = Date.now();
      const snapshot = (await this.request("/listen/state")) as ListenSnapshot;
      if (generation !== this.generation) return;
      const p = snapshot.playback;
      if (
        !p ||
        (p.videoId !== null && !/^[A-Za-z0-9_-]{11}$/.test(p.videoId)) ||
        !Number.isFinite(p.position) ||
        p.position < 0 ||
        !Number.isFinite(p.duration) ||
        p.duration < 0 ||
        typeof p.playing !== "boolean" ||
        typeof p.buffering !== "boolean" ||
        typeof p.adPlaying !== "boolean" ||
        !Array.isArray(p.queue) ||
        p.queue.length > 500 ||
        !Array.isArray(snapshot.members) ||
        snapshot.members.length > 21 ||
        typeof p.title !== "string" ||
        typeof p.author !== "string" ||
        p.title.length > 1000 ||
        p.author.length > 1000 ||
        p.position > 86400 ||
        p.duration > 86400 ||
        typeof snapshot.allowControls !== "boolean" ||
        snapshot.members.some(member => !member || typeof member.name !== "string" || member.name.length > 40 || typeof member.id !== "string") ||
        p.queue.some(
          track =>
            !track ||
            !/^[A-Za-z0-9_-]{11}$/.test(track.videoId) ||
            typeof track.title !== "string" ||
            track.title.length > 1000 ||
            typeof track.author !== "string" ||
            track.author.length > 1000 ||
            !Number.isInteger(track.index) ||
            track.index < 0 ||
            track.index >= 500
        )
      )
        throw new Error("Invalid session state.");
      this.status.snapshot = snapshot;
      this.status.connected = true;
      this.status.error = "";
      if (this.holdVideoId && Date.now() < this.holdUntil && p.videoId !== this.holdVideoId) {
        // Guest picked a song; wait for the host before syncing away from it.
      } else {
        if (this.holdVideoId && p.videoId === this.holdVideoId) this.holdVideoId = null;
        await this.player.sync({ ...p, position: p.position + (p.playing && !p.buffering && !p.adPlaying ? Math.min((Date.now() - start) / 2000, 2) : 0) });
        this.guestReady = true;
        if (p.videoId) this.lastLocalVideoId = p.videoId;
      }
    } catch (error) {
      if (generation !== this.generation) return;
      this.status.connected = false;
      this.status.error = error instanceof Error ? error.message : "Connection lost. Retrying…";
    }
    if (generation === this.generation) this.timer = setTimeout(() => void this.poll(generation), 1000);
  }

  public async command(value: unknown) {
    const command = validateListenCommand(value);
    if (this.server) await this.player.command(command);
    else if (this.status.role === "guest") await this.request("/listen/command", command);
    else throw new Error("Start or join a session first.");
    return this.getStatus();
  }

  /** When a guest starts a different song locally, switch the party to it. */
  public onLocalPlayback(videoId: string | null, adPlaying: boolean) {
    if (this.status.role !== "guest" || !this.guestReady || adPlaying || this.playNowBusy) return;
    if (!videoId || !/^[A-Za-z0-9_-]{11}$/.test(videoId)) return;
    const partyId = this.status.snapshot?.playback?.videoId ?? null;
    if (videoId === partyId || videoId === this.lastLocalVideoId || videoId === this.holdVideoId) {
      this.lastLocalVideoId = videoId;
      return;
    }
    this.lastLocalVideoId = videoId;
    this.holdVideoId = videoId;
    this.holdUntil = Date.now() + 8000;
    this.playNowBusy = true;
    void this.command({ type: "playNow", videoId })
      .catch(() => {
        if (this.holdVideoId === videoId) this.holdVideoId = null;
      })
      .finally(() => {
        this.playNowBusy = false;
      });
  }

  public controls(enabled: boolean) {
    if (!this.server) throw new Error("Only the host can change permissions.");
    this.server.setControls(enabled === true);
    return this.getStatus();
  }

  public async leave() {
    ++this.generation;
    clearTimeout(this.timer);
    this.guestReady = false;
    this.holdVideoId = null;
    this.lastLocalVideoId = null;
    this.playNowBusy = false;
    if (this.server) {
      await this.server.app.close();
      this.server = undefined;
    } else if (this.token) await this.request("/listen/leave", {}).catch(() => {});
    this.token = "";
    this.endpoint = "";
    this.status = { role: "idle", invite: "", connected: false, error: "", snapshot: null };
    return this.getStatus();
  }
}
