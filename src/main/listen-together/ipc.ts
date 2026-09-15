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
  const session = new ListenTogether({
    getPlayback: () => {
      const state = playerStateStore.getState();
      return {
        videoId: state.videoDetails?.id ?? null,
        title: state.videoDetails?.title ?? "Nothing playing",
        author: state.videoDetails?.author ?? "",
        position: Number.isFinite(state.videoProgress) ? state.videoProgress : 0,
        duration: Number.isFinite(state.videoDetails?.durationSeconds) ? state.videoDetails.durationSeconds : 0,
        playing: state.trackState === VideoState.Playing,
        buffering: state.trackState === VideoState.Buffering || isLoading(),
        adPlaying: state.adPlaying,
        queue: (state.queue?.items ?? []).slice(0, 500).map((item, index) => ({
          index,
          videoId: item.videoId,
          title: item.title,
          author: item.author
        }))
      };
    },
    command: async command => {
      const state = playerStateStore.getState();
      if (command.type === "seek" && command.position > (state.videoDetails?.durationSeconds ?? 0)) throw new Error("Seek position is outside this song.");
      if (command.type === "select" && state.queue?.items[command.index]?.videoId !== command.videoId)
        throw new Error("The queue changed. Choose the song again.");
      await execute(command);
    },
    sync: playback => execute({ type: "sync", playback })
  });
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
    void session.leave();
  });
}
