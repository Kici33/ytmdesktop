# Listen together

Open **Settings → Listen together** on each computer. Everyone needs this build of the desktop app and their own working YouTube Music account.

## Host

1. Enter your display name and a reachable host address.
2. Click **Start session**, then **Copy invite** and send the invite to your friends.
3. Keep the app running. Closing the settings window does not end the session; **End session** or quitting the app does.

For internet access, point an HTTPS tunnel or reverse proxy at `http://127.0.0.1:9864` on the host computer. Enter the public HTTPS origin (for example, `https://music.example.com`) in the app. The proxy must forward `/listen/*`, authorization headers and request bodies. No central relay is bundled or deployed automatically.

A private VPN can be used instead: enter the host's private VPN IPv4 address with port 9864, such as `http://100.100.10.1:9864`. The address picker also lists local IPv4 interfaces. Local network addresses work only when guests can route to that network. Firewall access may need to be configured on the host. Public HTTP addresses are rejected; use HTTPS for public connections.

The session server listens on port 9864 only while hosting. This is separate from the companion server and does not require companion authorization. Invitations contain a random session key; anyone with the invite can join. Ending the session invalidates its invite and guest credentials. Up to 20 guests can join. Inactive guest connections expire after 30 seconds; an expired guest must join again.

## Join and use the queue

Enter your name, choose **Join a friend**, paste the complete invite, and click **Join session**. Each app plays music directly from YouTube; audio and account credentials are never streamed through the host.

- Everyone can add or remove songs. Queue changes apply on the host and are mirrored into each listener’s YouTube Music queue.
- The queue shown in this panel is the shared Listen together queue (up to 500 entries; guests sync the first 100 into their player).
- When a guest plays a different song in YouTube Music, the party switches to that song (same as the host navigating to it).
- The host can pause/play, skip, seek, choose an existing queued song, or add a song to play next.
- **Let guests pause, skip, seek and choose songs** grants those playback controls to guests. It is off by default and enforced by the server.
- While hosting, open **Guest requests** to see joins, leaves and guest commands (including denied ones).
- Leaving stops synchronization without changing local volume.

Guests poll once a second and correct drift greater than 1.5 seconds. This is approximate synchronization, not sample-accurate audio. Ads, buffering, unavailable songs and differences between accounts can delay playback. Synchronization skips ads and catches up when playback is ready. On connection loss, the app shows an error and retries; local playback can continue independently. Sessions do not persist across host restarts.

## Validation

Run `yarn test:listen-together` for input validation, authentication/permissions, serialized queue additions, real HTTP host/guest state exchange, leave cleanup, malformed host-state rejection and playback-adapter tests. The playback-adapter tests use a simulated YouTube player; they do not verify YouTube's live private APIs or two-account playback over the internet.
