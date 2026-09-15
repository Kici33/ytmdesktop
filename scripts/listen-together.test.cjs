const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");
require("ts-node").register({ transpileOnly: true, compilerOptions: { module: "CommonJS", moduleResolution: "Node" } });
const { createListenServer } = require("../src/main/listen-together/server.ts");
const ListenTogether = require("../src/main/listen-together/index.ts").default;
const { parseVideoId, validateListenCommand, listenAddress } = require("../src/shared/listen-together.ts");
const playback = () => ({
  videoId: "abcdefghijk",
  title: "Song",
  author: "Artist",
  position: 12,
  duration: 180,
  playing: true,
  buffering: false,
  adPlaying: false,
  queue: [{ index: 0, videoId: "abcdefghijk", title: "Song", author: "Artist" }]
});
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(check) {
  for (let i = 0; i < 80; i++) {
    if (check()) return;
    await delay(50);
  }
  throw new Error("Timed out waiting for session state");
}

test("song IDs, commands and host URLs reject malformed/untrusted input", () => {
  assert.equal(parseVideoId("https://music.youtube.com/watch?v=abcdefghijk&list=test"), "abcdefghijk");
  assert.equal(parseVideoId("https://youtu.be/abcdefghijk"), "abcdefghijk");
  for (const value of ["https://evil.test/watch?v=abcdefghijk", "x", null, "<script>"]) assert.throws(() => parseVideoId(value));
  for (const value of [
    { type: "seek", position: -1 },
    { type: "seek", position: Infinity },
    { type: "select", index: -1 },
    { type: "execute", script: "bad" }
  ])
    assert.throws(() => validateListenCommand(value));
  for (const url of ["http://public.test", "http://10.evil.test", "https://user:pass@host.test", "file:///test", "https://host.test/path"])
    assert.throws(() => listenAddress(url));
  assert.equal(listenAddress("https://host.test#abc").origin, "https://host.test");
  assert.equal(listenAddress("http://100.100.10.1:9864").port, "9864");
});

test("session authentication, permissions, serialized queue additions and revocation", async t => {
  const calls = [];
  let active = 0;
  const server = await createListenServer({
    name: "Host",
    getPlayback: playback,
    command: async c => {
      assert.equal(active++, 0);
      await delay(10);
      calls.push(c);
      active--;
    }
  });
  t.after(() => server.app.close());
  const request = (method, url, token, payload) => server.app.inject({ method, url, headers: token ? { authorization: `Bearer ${token}` } : {}, payload });
  assert.equal((await request("GET", "/listen/state")).statusCode, 401);
  assert.equal((await request("POST", "/listen/join", "wrong", { name: "Guest" })).statusCode, 401);
  const join = await request("POST", "/listen/join", server.inviteToken, { name: "Guest" });
  assert.equal(join.statusCode, 200);
  const token = join.json().token;
  assert.notEqual(token, server.inviteToken);
  assert.equal(server.requests()[0].kind, "join");
  assert.equal(server.requests()[0].memberName, "Guest");
  assert.equal((await request("GET", "/listen/state", token)).json().members.length, 2);
  assert.equal((await request("POST", "/listen/command", token, { type: "pause" })).statusCode, 403);
  assert.equal(server.requests()[0].ok, false);
  assert.match(server.requests()[0].summary, /pause/);
  assert.equal((await request("POST", "/listen/command", token, { type: "add", videoId: "abcdefghijk", next: true })).statusCode, 403);
  assert.equal((await request("POST", "/listen/command", token, { type: "playNow", videoId: "12345678901" })).statusCode, 200);
  assert.equal(calls.at(-1)?.type, "playNow");
  assert.equal(server.requests()[0].ok, true);
  assert.match(server.requests()[0].summary, /play now/);
  await Promise.all([0, 1].map(() => request("POST", "/listen/command", token, { type: "add", videoId: "abcdefghijk", next: false })));
  assert.equal(calls.filter(c => c.type === "add").length, 2);
  server.setControls(true);
  assert.equal((await request("POST", "/listen/command", token, { type: "pause" })).statusCode, 200);
  server.setControls(false);
  assert.equal((await request("POST", "/listen/command", token, { type: "play" })).statusCode, 403);
  assert.equal((await request("POST", "/listen/command", token, { type: "add", videoId: "invalid" })).statusCode, 400);
  await request("POST", "/listen/leave", token, {});
  assert.equal((await request("GET", "/listen/state", token)).statusCode, 401);
  assert.equal(server.snapshot().members.length, 1);
});

test("enabling guest controls applies to guests already in the session", async t => {
  const server = await createListenServer({ name: "Host", getPlayback: playback, command: async () => {} });
  t.after(() => server.app.close());
  const request = (method, url, token, payload) => server.app.inject({ method, url, headers: token ? { authorization: `Bearer ${token}` } : {}, payload });
  const join = await request("POST", "/listen/join", server.inviteToken, { name: "Guest" });
  const token = join.json().token;
  assert.equal((await request("POST", "/listen/command", token, { type: "pause" })).statusCode, 403);
  assert.equal(join.json().snapshot.allowControls, false);
  server.setControls(true);
  assert.equal((await request("GET", "/listen/state", token)).json().allowControls, true);
  assert.equal((await request("POST", "/listen/command", token, { type: "pause" })).statusCode, 200);
  server.setControls(false);
  assert.equal((await request("POST", "/listen/command", token, { type: "play" })).statusCode, 403);
});

test("queued controls are rejected when the host revokes permission", async t => {
  let release;
  let calls = 0;
  const gate = new Promise(resolve => {
    release = resolve;
  });
  const server = await createListenServer({
    name: "Host",
    getPlayback: playback,
    command: async () => {
      calls++;
      await gate;
    }
  });
  t.after(() => server.app.close());
  const joined = await server.app.inject({
    method: "POST",
    url: "/listen/join",
    headers: { authorization: `Bearer ${server.inviteToken}` },
    payload: { name: "Guest" }
  });
  const headers = { authorization: `Bearer ${joined.json().token}` };
  server.setControls(true);
  const first = server.app.inject({ method: "POST", url: "/listen/command", headers, payload: { type: "pause" } });
  await until(() => calls === 1);
  const second = server.app.inject({ method: "POST", url: "/listen/command", headers, payload: { type: "play" } });
  await delay(20);
  server.setControls(false);
  release();
  assert.equal((await first).statusCode, 200);
  assert.equal((await second).statusCode, 400);
  assert.equal(calls, 1);
});

test("real HTTP guest follows host, adds songs, observes pause/seek and stops syncing after leaving", async t => {
  const state = playback();
  const commands = [];
  const server = await createListenServer({
    name: "Host",
    getPlayback: () => state,
    command: async c => {
      commands.push(c);
    }
  });
  await server.app.listen({ host: "127.0.0.1", port: 0 });
  t.after(() => server.app.close());
  const received = [];
  const guest = new ListenTogether({
    getPlayback: playback,
    command: async () => {},
    sync: async p => {
      received.push(p);
    }
  });
  t.after(() => guest.leave());
  await guest.join("Friend", `http://127.0.0.1:${server.app.server.address().port}#${server.inviteToken}`);
  await until(() => received.length > 0);
  assert.equal(received[0].videoId, state.videoId);
  await guest.command({ type: "add", videoId: "12345678901", next: false });
  assert.equal(commands[0].videoId, "12345678901");
  await assert.rejects(guest.command({ type: "pause" }), /Only the host/);
  state.playing = false;
  state.position = 40;
  await until(() => received.some(p => !p.playing && p.position === 40));
  await guest.leave();
  const count = received.length;
  await delay(1100);
  assert.equal(received.length, count);
  assert.equal(server.snapshot().members.length, 1);
});

test("guest playing a local song switches the party and holds sync until the host catches up", async t => {
  const state = playback();
  const commands = [];
  const server = await createListenServer({
    name: "Host",
    getPlayback: () => state,
    command: async c => {
      commands.push(c);
      if (c.type === "playNow") {
        await delay(1500);
        state.videoId = c.videoId;
      }
    }
  });
  await server.app.listen({ host: "127.0.0.1", port: 0 });
  t.after(() => server.app.close());
  const received = [];
  const guest = new ListenTogether({
    getPlayback: playback,
    command: async () => {},
    sync: async p => {
      received.push(p);
    }
  });
  t.after(() => guest.leave());
  await guest.join("Friend", `http://127.0.0.1:${server.app.server.address().port}#${server.inviteToken}`);
  await until(() => received.length > 0);
  guest.onLocalPlayback("abcdefghijk", false);
  // Pretend the guest has been stably following long enough, past the post-sync quiet window.
  guest.syncedOnPartySince = Date.now() - 9000;
  guest.syncQuietUntil = 0;
  guest.lastLocalVideoId = "abcdefghijk";
  const before = received.length;
  guest.onLocalPlayback("12345678901", false);
  await until(() => commands.some(c => c.type === "playNow" && c.videoId === "12345678901"));
  await delay(1100);
  assert.equal(received.length, before);
  assert.equal(received.at(-1).videoId, "abcdefghijk");
  await until(() => received.some(p => p.videoId === "12345678901"));
});

test("guest does not bounce playNow back when the host changes songs", async t => {
  const state = playback();
  const commands = [];
  const server = await createListenServer({
    name: "Host",
    getPlayback: () => state,
    command: async c => {
      commands.push(c);
    }
  });
  await server.app.listen({ host: "127.0.0.1", port: 0 });
  t.after(() => server.app.close());
  const guest = new ListenTogether({
    getPlayback: playback,
    command: async () => {},
    sync: async () => {}
  });
  t.after(() => guest.leave());
  await guest.join("Friend", `http://127.0.0.1:${server.app.server.address().port}#${server.inviteToken}`);
  await until(() => guest.getStatus().snapshot?.playback?.videoId === "abcdefghijk");
  guest.onLocalPlayback("abcdefghijk", false);
  state.videoId = "12345678901";
  await until(() => guest.getStatus().snapshot?.playback?.videoId === "12345678901");
  guest.onLocalPlayback("Bp1w5eKY8wo", false);
  guest.onLocalPlayback("qJ2dhhDGLBg", false);
  guest.onLocalPlayback("12345678901", false);
  await delay(300);
  assert.equal(commands.some(c => c.type === "playNow"), false);
});

test("guest autoplay after the host track ends does not switch the party", async t => {
  const state = playback();
  state.position = 179;
  state.playing = false;
  const commands = [];
  const server = await createListenServer({
    name: "Host",
    getPlayback: () => state,
    command: async c => {
      commands.push(c);
    }
  });
  await server.app.listen({ host: "127.0.0.1", port: 0 });
  t.after(() => server.app.close());
  const guest = new ListenTogether({
    getPlayback: playback,
    command: async () => {},
    sync: async () => {}
  });
  t.after(() => guest.leave());
  await guest.join("Friend", `http://127.0.0.1:${server.app.server.address().port}#${server.inviteToken}`);
  await until(() => guest.getStatus().snapshot?.playback?.videoId === "abcdefghijk");
  guest.onLocalPlayback("abcdefghijk", false);
  guest.onLocalPlayback("12345678901", false);
  await delay(200);
  assert.equal(commands.some(c => c.type === "playNow"), false);
});

test("malformed host state is not forwarded to the player", async t => {
  const server = await createListenServer({ name: "Host", getPlayback: () => ({ ...playback(), position: NaN }), command: async () => {} });
  await server.app.listen({ host: "127.0.0.1", port: 0 });
  t.after(() => server.app.close());
  let syncs = 0;
  const guest = new ListenTogether({
    getPlayback: playback,
    command: async () => {},
    sync: async () => {
      syncs++;
    }
  });
  t.after(() => guest.leave());
  await guest.join("Friend", `http://127.0.0.1:${server.app.server.address().port}#${server.inviteToken}`);
  await until(() => !!guest.getStatus().error);
  assert.equal(syncs, 0);
  assert.match(guest.getStatus().error, /Invalid session state/);
});

function playerFixture(queueItems) {
  const calls = [];
  const items =
    queueItems ??
    [
      {
        playlistPanelVideoRenderer: {
          videoId: "abcdefghijk",
          navigationEndpoint: { watchEndpoint: { videoId: "abcdefghijk" } }
        }
      }
    ];
  const queueState = { items, queueContextParams: "ctx", nextQueueItemId: 1 };
  const api = {
    isReady: () => true,
    getPlayerResponse: () => ({ videoDetails: { videoId: "abcdefghijk" } }),
    getDuration: () => 180,
    getCurrentTime: () => 10,
    getPlayerState: () => 1,
    seekTo: p => calls.push(["seek", p]),
    playVideo: () => calls.push(["play"]),
    pauseVideo: () => calls.push(["pause"]),
    nextVideo: () => calls.push(["next"])
  };
  const element = {
    polymerController: { playerApi: api },
    dispatchEvent: event => {
      calls.push(["event", event]);
      event.detail.returnValue.push({ ajaxPromise: Promise.resolve() });
    }
  };
  const queue = {
    dispatch: action => {
      calls.push(["queue", action]);
      if (action.type === "CLEAR") queueState.items = [];
      if (action.type === "REMOVE_ITEM") queueState.items.splice(action.payload, 1);
      if (action.type === "ADD_ITEMS") queueState.items.splice(action.payload.index, 0, ...action.payload.items);
      if (action.type === "MOVE_ITEM") {
        const [item] = queueState.items.splice(action.payload.fromIndex, 1);
        queueState.items.splice(action.payload.toIndex, 0, item);
      }
    },
    queue: { store: { store: { getState: () => ({ queue: queueState }) } } }
  };
  const app = {
    networkManager: {
      fetch: async (path, body) => {
        calls.push(["fetch", path, body]);
        return {
          queueDatas: (body.videoIds ?? []).map(videoId => ({
            content: { playlistPanelVideoRenderer: { videoId, navigationEndpoint: { watchEndpoint: { videoId } } } }
          }))
        };
      }
    }
  };
  const context = {
    document: {
      querySelector: selector => {
        if (selector === "#queue") return queue;
        if (selector === "ytmusic-app") return app;
        return element;
      },
      dispatchEvent: e => calls.push(["navigate", e])
    },
    CustomEvent: class {
      constructor(type, options) {
        this.type = type;
        Object.assign(this, options);
      }
    },
    window: {
      __YTMD_HOOK__: {
        ytmStore: {
          getState: () => ({
            player: { adPlaying: false },
            queue: queueState
          })
        }
      }
    },
    Date
  };
  const run = vm.runInNewContext(fs.readFileSync("src/renderer/ytmview/scripts/listentogether.script.js", "utf8"), context);
  return { calls, api, run, queueState };
}
test("player sync corrects drift, follows pause, avoids repeated navigation and skips host ads", async () => {
  const { run, calls } = playerFixture();
  await run({ type: "sync", playback: { ...playback(), position: 30 } });
  assert.deepEqual(calls[0], ["seek", 30]);
  calls.length = 0;
  await run({ type: "sync", playback: { ...playback(), position: 10.5 } });
  assert.equal(calls.length, 0);
  await run({ type: "sync", playback: { ...playback(), playing: false, position: 10 } });
  assert.deepEqual(calls[0], ["pause"]);
  calls.length = 0;
  await run({ type: "sync", playback: { ...playback(), playing: false, position: 179.5 } });
  assert.deepEqual(calls[0], ["pause"]);
  assert.equal(calls.some(c => c[0] === "seek"), false);
  calls.length = 0;
  await run({ type: "sync", playback: { ...playback(), adPlaying: true } });
  assert.equal(calls.length, 0);
  await run({ type: "sync", playback: { ...playback(), videoId: "12345678901" } });
  await run({ type: "sync", playback: { ...playback(), videoId: "12345678901" } });
  assert.equal(calls.filter(c => c[0] === "navigate").length, 1);
});
test("guest queue is rebuilt to match the shared listen-together queue", async () => {
  const { run, calls, queueState } = playerFixture([]);
  await run({
    type: "sync",
    playback: {
      ...playback(),
      queue: [
        { index: 0, videoId: "abcdefghijk", title: "Song", author: "Artist" },
        { index: 1, videoId: "12345678901", title: "Other", author: "Artist" }
      ]
    }
  });
  assert.equal(calls.some(c => c[0] === "fetch"), true);
  assert.equal(queueState.items.map(item => item.playlistPanelVideoRenderer.videoId).join(","), "abcdefghijk,12345678901");
  calls.length = 0;
  await run({
    type: "sync",
    playback: {
      ...playback(),
      position: 10.2,
      queue: [
        { index: 0, videoId: "abcdefghijk", title: "Song", author: "Artist" },
        { index: 1, videoId: "12345678901", title: "Other", author: "Artist" }
      ]
    }
  });
  assert.equal(calls.some(c => c[0] === "fetch" || (c[0] === "queue" && c[1].type === "CLEAR")), false);
});
test("queue actions use YouTube service requests and preserve play-next position", async () => {
  const { run, calls } = playerFixture();
  await run({ type: "add", videoId: "12345678901", next: false });
  assert.equal(calls[0][1].detail.args[1].queueAddEndpoint.queueInsertPosition, "INSERT_AT_END");
  calls.length = 0;
  await run({ type: "add", videoId: "12345678901", next: true });
  assert.equal(calls[0][1].detail.args[1].queueAddEndpoint.queueInsertPosition, "INSERT_AFTER_CURRENT_VIDEO");
  calls.length = 0;
  run({ type: "remove", index: 0, videoId: "abcdefghijk" });
  assert.equal(calls[0][0], "queue");
  assert.equal(calls[0][1].type, "REMOVE_ITEM");
  assert.equal(calls[0][1].payload, 0);
  assert.throws(() => run({ type: "remove", index: 0, videoId: "12345678901" }), /queue changed/i);
  calls.length = 0;
  run({ type: "playNow", videoId: "12345678901" });
  assert.equal(calls[0][0], "navigate");
});
