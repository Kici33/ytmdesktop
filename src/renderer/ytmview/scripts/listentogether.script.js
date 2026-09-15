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
  const queueItemId = item => {
    const renderer = item?.playlistPanelVideoRenderer ?? item?.playlistPanelVideoWrapperRenderer?.primaryRenderer?.playlistPanelVideoRenderer;
    return renderer?.videoId ?? null;
  };
  const localQueueIds = () => (window.__YTMD_HOOK__.ytmStore.getState().queue?.items ?? []).map(queueItemId).filter(Boolean);
  const sameIds = (a, b) => a.length === b.length && a.every((id, index) => id === b[index]);
  const addVideo = (videoId, next) => {
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
                videoIds: [videoId],
                queueInsertPosition: next ? "INSERT_AFTER_CURRENT_VIDEO" : "INSERT_AT_END"
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
  };
  const rebuildQueue = async want => {
    const queue = document.querySelector("#queue");
    const app = document.querySelector("ytmusic-app");
    const store = queue?.queue?.store?.store;
    if (!queue?.dispatch || !app?.networkManager?.fetch || !store) return;
    if (!want.length) {
      queue.dispatch({ type: "CLEAR" });
      window.__ytmdListenQueueKey = "";
      return;
    }
    const result = await app.networkManager.fetch("/music/get_queue", {
      queueContextParams: store.getState().queue.queueContextParams,
      videoIds: want
    });
    const items = (result?.queueDatas ?? []).map(entry => (entry && typeof entry === "object" && "content" in entry ? entry.content : null)).filter(Boolean);
    if (!items.length) return;
    queue.dispatch({ type: "CLEAR" });
    queue.dispatch({
      type: "ADD_ITEMS",
      payload: {
        nextQueueItemId: store.getState().queue.nextQueueItemId,
        index: 0,
        items,
        shuffleEnabled: false,
        shouldAssignIds: true
      }
    });
    window.__ytmdListenQueueKey = want.join(",");
  };
  const ensureQueue = async tracks => {
    const want = (Array.isArray(tracks) ? tracks : []).map(track => track.videoId).filter(Boolean).slice(0, 100);
    const key = want.join(",");
    if (window.__ytmdListenQueueKey === key || window.__ytmdListenQueueSyncing) return;
    let have = localQueueIds();
    if (sameIds(have, want)) {
      window.__ytmdListenQueueKey = key;
      return;
    }
    const queue = document.querySelector("#queue");
    if (!queue?.dispatch) return;
    window.__ytmdListenQueueSyncing = true;
    try {
      for (let index = have.length - 1; index >= 0; index--) {
        if (!want.includes(have[index])) queue.dispatch({ type: "REMOVE_ITEM", payload: index });
      }
      have = localQueueIds();
      for (let index = 0; index < want.length; index++) {
        have = localQueueIds();
        if (have[index] === want[index]) continue;
        if (have.includes(want[index])) {
          await rebuildQueue(want);
          return;
        }
        await addVideo(want[index], false);
        have = localQueueIds();
        const from = have.lastIndexOf(want[index]);
        if (from >= 0 && from !== index) queue.dispatch({ type: "MOVE_ITEM", payload: { fromIndex: from, toIndex: index } });
      }
      have = localQueueIds();
      if (!sameIds(have, want)) await rebuildQueue(want);
      else window.__ytmdListenQueueKey = key;
    } finally {
      window.__ytmdListenQueueSyncing = false;
    }
  };
  switch (command.type) {
    case "sync": {
      const state = command.playback;
      const queueSync = ensureQueue(state.queue);
      if (!state.videoId || state.adPlaying || window.__YTMD_HOOK__.ytmStore.getState().player.adPlaying) return queueSync;
      const currentId = api.getPlayerResponse()?.videoDetails?.videoId;
      if (currentId !== state.videoId) {
        const previous = window.__ytmdListenNavigation;
        if (!previous || previous.id !== state.videoId || Date.now() - previous.at > 15000) {
          window.__ytmdListenNavigation = { id: state.videoId, at: Date.now() };
          navigate(state.videoId);
        }
        return queueSync;
      }
      window.__ytmdListenNavigation = null;
      if (state.buffering) return queueSync;
      const duration = api.getDuration();
      const ended = !state.playing && state.duration > 0 && state.position >= Math.max(0, state.duration - 1.5);
      // Host stopped at the end (often with an empty queue). Stay paused — don't seek/restart.
      if (ended) {
        if (api.getPlayerState() !== 2) api.pauseVideo();
        return queueSync;
      }
      const position = Math.min(state.position, Math.max(0, duration - 0.25));
      if (Math.abs(api.getCurrentTime() - position) > (state.playing ? 1.5 : 0.4)) api.seekTo(position, true);
      if (state.playing && api.getPlayerState() !== 1 && api.getPlayerState() !== 3) api.playVideo();
      if (!state.playing && api.getPlayerState() !== 2) api.pauseVideo();
      return queueSync;
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
      window.__ytmdListenQueueKey = null;
      return;
    }
    case "add":
      window.__ytmdListenQueueKey = null;
      return addVideo(command.videoId, command.next);
  }
  throw new Error("Unknown session command.");
});
