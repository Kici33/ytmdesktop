// This function is loaded as text and invoked in YouTube Music's main world.
// eslint-disable-next-line @typescript-eslint/no-unused-expressions
(function (command) {
  const element = document.querySelector("ytmusic-app-layout>ytmusic-player-bar");
  const bar = element?.polymerController ?? element;
  const api = bar?.playerApi;
  if (!api?.isReady()) throw new Error("YouTube Music is still loading. Try again in a moment.");
  const navigate = videoId =>
    document.dispatchEvent(
      new CustomEvent("yt-navigate", {
        detail: { endpoint: { watchEndpoint: { videoId } } }
      })
    );
  switch (command.type) {
    case "sync": {
      const state = command.playback;
      if (!state.videoId || state.adPlaying || window.__YTMD_HOOK__.ytmStore.getState().player.adPlaying) return;
      const currentId = api.getPlayerResponse()?.videoDetails?.videoId;
      if (currentId !== state.videoId) {
        const previous = window.__ytmdListenNavigation;
        if (!previous || previous.id !== state.videoId || Date.now() - previous.at > 15000) {
          window.__ytmdListenNavigation = { id: state.videoId, at: Date.now() };
          navigate(state.videoId);
        }
        return;
      }
      window.__ytmdListenNavigation = null;
      if (state.buffering) return;
      const position = Math.min(state.position, Math.max(0, api.getDuration() - 0.25));
      if (Math.abs(api.getCurrentTime() - position) > (state.playing ? 1.5 : 0.4)) api.seekTo(position, true);
      if (state.playing && api.getPlayerState() !== 1 && api.getPlayerState() !== 3) api.playVideo();
      if (!state.playing && api.getPlayerState() !== 2) api.pauseVideo();
      return;
    }
    case "play":
      api.playVideo();
      return;
    case "pause":
      api.pauseVideo();
      return;
    case "seek":
      api.seekTo(command.position, true);
      return;
    case "next":
      api.nextVideo();
      return;
    case "playNow":
      window.__ytmdListenNavigation = { id: command.videoId, at: Date.now() };
      navigate(command.videoId);
      return;
    case "select": {
      const item = window.__YTMD_HOOK__.ytmStore.getState().queue.items[command.index];
      const renderer = item?.playlistPanelVideoRenderer ?? item?.playlistPanelVideoWrapperRenderer?.primaryRenderer?.playlistPanelVideoRenderer;
      if (renderer?.videoId !== command.videoId || !renderer.navigationEndpoint) throw new Error("The queue changed. Choose the song again.");
      document.dispatchEvent(new CustomEvent("yt-navigate", { detail: { endpoint: renderer.navigationEndpoint } }));
      return;
    }
    case "remove": {
      const item = window.__YTMD_HOOK__.ytmStore.getState().queue.items[command.index];
      const renderer = item?.playlistPanelVideoRenderer ?? item?.playlistPanelVideoWrapperRenderer?.primaryRenderer?.playlistPanelVideoRenderer;
      if (renderer?.videoId !== command.videoId) throw new Error("The queue changed. Choose the song again.");
      const queue = document.querySelector("#queue");
      if (!queue?.dispatch) throw new Error("YouTube Music could not remove this song from the queue.");
      queue.dispatch({ type: "REMOVE_ITEM", payload: command.index });
      return;
    }
    case "add": {
      const returnValue = [];
      element.dispatchEvent(
        new CustomEvent("yt-action", {
          bubbles: true,
          composed: true,
          detail: {
            actionName: "yt-service-request",
            args: [
              element,
              {
                queueAddEndpoint: {
                  videoIds: [command.videoId],
                  queueInsertPosition: command.next ? "INSERT_AFTER_CURRENT_VIDEO" : "INSERT_AT_END"
                }
              }
            ],
            optionalAction: false,
            returnValue
          }
        })
      );
      if (!returnValue[0]?.ajaxPromise) throw new Error("YouTube Music could not add this song to the queue.");
      return returnValue[0].ajaxPromise.then(() => undefined);
    }
  }
  throw new Error("Unknown session command.");
});
