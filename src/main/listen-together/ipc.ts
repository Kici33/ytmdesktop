import { app, BrowserView, BrowserWindow, clipboard, ipcMain } from "electron";
import { randomUUID } from "node:crypto";
import ListenTogether from "./index";
import playerStateStore, { VideoState } from "../player-state-store";
import { ListenCommand, ListenPlayback } from "../../shared/listen-together";

export function setupListenTogether(getView: () => BrowserView, getSettings: () => BrowserWindow, isLoading: () => boolean) {
  const execute = (command: ListenCommand | { type: "sync"; playback: ListenPlayback }): Promise<void> => {
    const view = getView();
    if (!view || view.webContents.isDestroyed() || isLoading()) return Promise.reject(new Error("Wait for YouTube Music to finish loading."));
    return new Promise((resolve, reject) => {
      const id = randomUUID();
      const done = (error?: string) => {
        clearTimeout(timeout);
        ipcMain.removeListener("listenTogether:result", listener);
        if (error) reject(new Error(error));
        else resolve();
      };
      const listener = (event: Electron.IpcMainEvent, requestId: string, error: unknown) => {
        if (event.sender !== view.webContents || requestId !== id) return;
        done(typeof error === "string" ? error.slice(0, 200) : undefined);
      };
      const timeout = setTimeout(() => done("YouTube Music did not respond. Check that the song is available."), 6000);
      ipcMain.on("listenTogether:result", listener);
      view.webContents.send("listenTogether:execute", id, command);
    });
  };
  const videoIdOk = (id: unknown): id is string => typeof id === "string" && /^[A-Za-z0-9_-]{11}$/.test(id);
  const text = (value: unknown, fallback = "") => (typeof value === "string" ? value.slice(0, 1000) : fallback);
  const session = new ListenTogether({
    getPlayback: () => {
      const state = playerStateStore.getState();
      const id = state.videoDetails?.id;
      const position = Number.isFinite(state.videoProgress) ? state.videoProgress : 0;
      const duration = Number.isFinite(state.videoDetails?.durationSeconds) ? state.videoDetails.durationSeconds : 0;
      return {
        videoId: videoIdOk(id) ? id : null,
        title: text(state.videoDetails?.title, "Nothing playing") || "Nothing playing",
        author: text(state.videoDetails?.author),
        position: Math.min(Math.max(position, 0), 86400),
        duration: Math.min(Math.max(duration, 0), 86400),
        playing: state.trackState === VideoState.Playing,
        buffering: state.trackState === VideoState.Buffering || isLoading(),
        adPlaying: state.adPlaying === true,
        // Drop queue rows YouTube leaves without a real video id; keep original indexes for select.
        queue: (state.queue?.items ?? [])
          .slice(0, 500)
          .map((item, index) => ({
            index,
            videoId: item.videoId,
            title: text(item.title),
            author: text(item.author)
          }))
          .filter(item => videoIdOk(item.videoId))
      };
    },
    command: async command => {
      const state = playerStateStore.getState();
      if (command.type === "seek" && command.position > (state.videoDetails?.durationSeconds ?? 0)) throw new Error("Seek position is outside this song.");
      if ((command.type === "select" || command.type === "remove") && state.queue?.items[command.index]?.videoId !== command.videoId)
        throw new Error("The queue changed. Choose the song again.");
      await execute(command);
    },
    sync: playback => execute({ type: "sync", playback })
  });
  const onPlayerState = () => {
    const state = playerStateStore.getState();
    session.onLocalPlayback(state.videoDetails?.id ?? null, state.adPlaying === true);
  };
  playerStateStore.addEventListener(onPlayerState);
  let busy = false;
  ipcMain.handle("listenTogether:request", async (event, action: string, payload: Record<string, unknown> = {}) => {
    if (event.sender !== getSettings()?.webContents || event.senderFrame !== event.sender.mainFrame) throw new Error("Unauthorized window.");
    if (action === "status") return { status: session.getStatus(), addresses: session.addresses() };
    if (busy) return { error: "Please wait for the previous action to finish." };
    busy = true;
    try {
      switch (action) {
        case "host":
          if (isLoading()) throw new Error("Wait for YouTube Music to finish loading.");
          return { status: await session.host(payload.name as string, payload.address as string) };
        case "join":
          return { status: await session.join(payload.name as string, payload.invite as string) };
        case "leave":
          return { status: await session.leave() };
        case "command":
          return { status: await session.command(payload) };
        case "controls":
          return { status: session.controls(payload.enabled === true) };
        case "copy":
          if (session.getStatus().invite) clipboard.writeText(session.getStatus().invite);
          return { status: session.getStatus() };
        default:
          throw new Error("Unknown session action.");
      }
    } catch (error) {
      return { error: error instanceof Error ? error.message : "Session action failed." };
    } finally {
      busy = false;
    }
  });
  app.on("before-quit", () => {
    playerStateStore.removeEventListener(onPlayerState);
    void session.leave();
  });
}
