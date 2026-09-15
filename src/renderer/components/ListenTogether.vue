<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from "vue";
import { ListenCommand, ListenStatus, parseVideoId } from "~shared/listen-together";

const status = ref<ListenStatus>({ role: "idle", invite: "", error: "", connected: false, allowControls: false, snapshot: null, requests: [] });
const name = ref("");
const address = ref("");
const invite = ref("");
const song = ref("");
const error = ref("");
const notice = ref("");
const busy = ref(false);
const tab = ref("host");
const sessionTab = ref("session");
const addresses = ref<string[]>([]);
const position = ref(0);
let timer: ReturnType<typeof setTimeout>;
let mounted = true;
const canControl = computed(() => status.value.role === "host" || status.value.allowControls || status.value.snapshot?.allowControls === true);
const canManageQueue = computed(() => status.value.role === "host" || status.value.role === "guest");
const playback = computed(() => status.value.snapshot?.playback);
const guestRequests = computed(() => status.value.requests ?? []);
const time = (seconds: number) =>
  `${Math.floor(seconds / 60)}:${Math.floor(seconds % 60)
    .toString()
    .padStart(2, "0")}`;
const requestTime = (at: number) => new Date(at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });

async function refresh() {
  try {
    const result = await window.ytmd.listenTogether("status");
    if (!mounted) return;
    if (result.status) status.value = result.status;
    addresses.value = result.addresses ?? [];
  } catch {
    if (mounted) error.value = "Could not read the session status.";
  }
  if (mounted) timer = setTimeout(refresh, 1000);
}
async function action(type: string, payload?: Record<string, unknown>) {
  busy.value = true;
  error.value = "";
  notice.value = "";
  try {
    const result = await window.ytmd.listenTogether(type, payload);
    if (result.error) throw new Error(result.error);
    if (result.status) {
      status.value = result.status;
      if (result.status.role === "idle") sessionTab.value = "session";
    }
    if (type === "copy") notice.value = "Invite copied. Send it to your friends.";
    return true;
  } catch (e) {
    error.value = e instanceof Error ? e.message : "Something went wrong.";
    return false;
  } finally {
    busy.value = false;
  }
}
const command = (value: ListenCommand) => action("command", value);
const selectInvite = (event: Event) => (event.target as HTMLInputElement).select();
const changeControls = async (event: Event) => {
  const enabled = (event.target as HTMLInputElement).checked;
  if (await action("controls", { enabled })) {
    notice.value = enabled ? "Guests can now pause, skip, seek and choose songs." : "Guest playback controls are off again.";
  }
};
async function add(next: boolean) {
  try {
    if (await command({ type: "add", videoId: parseVideoId(song.value), next })) {
      song.value = "";
      notice.value = next ? "Song added to play next." : "Song added to the shared queue.";
    }
  } catch (e) {
    error.value = (e as Error).message;
  }
}
onMounted(refresh);
onUnmounted(() => {
  mounted = false;
  clearTimeout(timer);
});
</script>

<template>
  <section class="listen-together">
    <h2>Listen together</h2>
    <p class="muted">One queue. Everyone listens on their own YouTube Music account.</p>
    <p v-if="error || status.error" class="error" role="alert">{{ error || status.error }}</p>
    <p v-if="notice" role="status">{{ notice }}</p>
    <template v-if="status.role === 'idle'">
      <label>Your name<input v-model="name" maxlength="40" placeholder="Name shown to friends" /></label>
      <div class="buttons">
        <button :class="{ selected: tab === 'host' }" @click="tab = 'host'">Host a session</button>
        <button :class="{ selected: tab === 'join' }" @click="tab = 'join'">Join a friend</button>
      </div>
      <form v-if="tab === 'host'" @submit.prevent="action('host', { name, address })">
        <label>Host address<input v-model="address" placeholder="https://music.your-domain.com" required /></label>
        <p class="muted">
          For friends over the internet, use an HTTPS tunnel or reverse proxy to this computer’s port 9864. A private VPN address also works. The session stays
          open while your app is running.
        </p>
        <details v-if="addresses.length">
          <summary>Local network / VPN addresses</summary>
          <button v-for="local in addresses" :key="local" type="button" @click="address = local">{{ local }}</button>
        </details>
        <button class="primary" :disabled="busy || !name.trim() || !address.trim()">Start session</button>
      </form>
      <form v-else @submit.prevent="action('join', { name, invite })">
        <label>Invite<input v-model="invite" placeholder="Paste the full invite from your friend" required /></label>
        <p class="muted">Joining follows the host’s song and playback position. Your volume stays yours.</p>
        <button class="primary" :disabled="busy || !name.trim() || !invite.trim()">Join session</button>
      </form>
    </template>
    <template v-else>
      <div class="buttons session-heading">
        <strong>{{ status.role === "host" ? "Hosting" : status.connected ? "Listening together" : "Reconnecting…" }}</strong>
        <button :disabled="busy" @click="action('leave')">{{ status.role === "host" ? "End session" : "Leave" }}</button>
      </div>
      <template v-if="status.role === 'host'">
        <div class="buttons">
          <button :class="{ selected: sessionTab === 'session' }" @click="sessionTab = 'session'">Session</button>
          <button :class="{ selected: sessionTab === 'requests' }" @click="sessionTab = 'requests'">
            Guest requests<span v-if="guestRequests.length" class="muted"> ({{ guestRequests.length }})</span>
          </button>
        </div>
      </template>
      <template v-if="status.role === 'host' && sessionTab === 'requests'">
        <h3>Guest requests</h3>
        <p class="muted">Joins, leaves and commands from friends in this session.</p>
        <p v-if="!guestRequests.length" class="muted">No guest activity yet.</p>
        <ol class="requests">
          <li v-for="request in guestRequests" :key="request.id" :class="{ failed: !request.ok }">
            <div>
              <strong>{{ request.memberName }}</strong>
              <span class="muted">{{ request.summary }}</span>
              <span v-if="request.error" class="error">{{ request.error }}</span>
            </div>
            <span class="muted">{{ requestTime(request.at) }}</span>
          </li>
        </ol>
      </template>
      <template v-else>
        <template v-if="status.role === 'host'">
          <label>Invite friends<input :value="status.invite" readonly @focus="selectInvite" /></label>
          <button :disabled="busy" @click="action('copy')">Copy invite</button>
          <label class="permission"
            ><input type="checkbox" :checked="status.allowControls || status.snapshot?.allowControls" :disabled="busy" @change="changeControls" />Let guests
            pause, skip, seek, choose and remove songs</label
          >
        </template>
        <p class="muted">{{ status.snapshot?.members.map(member => member.name).join(" · ") }}</p>
        <div v-if="playback" class="now-playing">
          <strong>{{ playback.title }}</strong
          ><span class="muted">{{ playback.author }}</span>
          <p>{{ time(playback.position) }} / {{ time(playback.duration) }} <span v-if="playback.adPlaying"> · Host is playing an ad</span></p>
          <div v-if="canControl" class="buttons">
            <button :disabled="busy" @click="command({ type: playback.playing ? 'pause' : 'play' })">{{ playback.playing ? "Pause" : "Play" }}</button>
            <button :disabled="busy" @click="command({ type: 'next' })">Next song</button>
            <label class="seek">Seek to (seconds)<input v-model.number="position" type="number" min="0" :max="playback.duration" /></label>
            <button :disabled="busy" @click="command({ type: 'seek', position })">Seek</button>
          </div>
        </div>
        <form @submit.prevent="add(false)">
          <label>Add a song<input v-model="song" placeholder="Paste a YouTube Music song link" /></label>
          <div class="buttons">
            <button class="primary" :disabled="busy || !song.trim()">Add to queue</button>
            <button v-if="canControl" type="button" :disabled="busy || !song.trim()" @click="add(true)">Play next</button>
          </div>
        </form>
        <h3>
          Shared queue <span class="muted">({{ playback?.queue.length ?? 0 }})</span>
        </h3>
        <p v-if="!playback?.queue.length" class="muted">The queue is empty. Add a song to get started.</p>
        <ol class="queue">
          <li v-for="track in playback?.queue" :key="`${track.index}-${track.videoId}`" :class="{ current: track.videoId === playback.videoId }">
            <div>
              <strong>{{ track.title }}</strong
              ><span class="muted">{{ track.author }}</span>
            </div>
            <div v-if="canManageQueue" class="buttons queue-actions">
              <button v-if="canControl" :disabled="busy" @click="command({ type: 'select', index: track.index, videoId: track.videoId })">Play</button>
              <button :disabled="busy" @click="command({ type: 'remove', index: track.index, videoId: track.videoId })">Remove</button>
            </div>
          </li>
        </ol>
        <p class="muted">
          The shared queue stays mirrored in YouTube Music for everyone. Anyone can add or remove songs; pause/skip/seek still follow host permissions. Playing
          a song in YouTube Music switches the party to that track. Ads, buffering and unavailable songs can briefly interrupt sync.
        </p>
      </template>
    </template>
  </section>
</template>

<style scoped>
.listen-together {
  color: #eee;
  padding: 0 6px 20px;
}
h2 {
  margin: 0 0 8px;
}
h3 {
  margin-top: 20px;
}
p {
  line-height: 1.5;
}
.muted {
  color: #aaa;
  font-size: 13px;
}
.error {
  color: #ff8f99;
}
label {
  display: block;
  margin: 14px 0;
  font-size: 13px;
}
input:not([type="checkbox"]) {
  display: block;
  box-sizing: border-box;
  width: 100%;
  margin-top: 6px;
  padding: 10px;
  border: 1px solid #555;
  border-radius: 5px;
  background: #171717;
  color: white;
}
button {
  cursor: pointer;
  background: #303030;
  color: white;
  border: 1px solid #555;
  border-radius: 5px;
  padding: 8px 12px;
}
button:hover {
  background: #444;
}
button:disabled {
  opacity: 0.45;
  cursor: default;
}
.primary,
.selected {
  background: #aa1737;
  border-color: #db2850;
}
.buttons {
  display: flex;
  gap: 8px;
  align-items: center;
  flex-wrap: wrap;
  margin: 12px 0;
}
.session-heading {
  justify-content: space-between;
}
.permission {
  display: flex;
  gap: 8px;
  align-items: center;
}
.now-playing {
  border: 1px solid #444;
  border-radius: 6px;
  padding: 12px;
}
.now-playing > span,
.queue span {
  display: block;
  margin-top: 4px;
}
.seek {
  max-width: 115px;
  margin: 0;
}
.seek input {
  padding: 6px;
}
.queue {
  padding: 0;
  list-style: none;
}
.queue li {
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: 10px;
  padding: 10px;
  border-bottom: 1px solid #333;
}
.queue li.current {
  background: #351620;
}
.queue li strong {
  font-size: 13px;
}
.queue-actions {
  margin: 0;
  flex-shrink: 0;
}
.requests {
  padding: 0;
  list-style: none;
}
.requests li {
  display: flex;
  justify-content: space-between;
  align-items: flex-start;
  gap: 10px;
  padding: 10px;
  border-bottom: 1px solid #333;
}
.requests li.failed {
  background: #2a1518;
}
.requests li strong {
  display: block;
  font-size: 13px;
}
.requests .error {
  display: block;
  margin-top: 4px;
  font-size: 12px;
}
details {
  margin: 12px 0;
}
details button {
  display: block;
  margin-top: 6px;
}
summary {
  cursor: pointer;
}
</style>
