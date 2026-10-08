# Drive playback

The video is the clock. `currentOffset()` reads its current time and adds the
route's camera start offset. The map, timeline and time display keep using that
function. There is no speed correction or periodic seek to catch up with a
separate clock.

Redux stores the controls: speed, selection and requested seek position.
`seekVersion` changes for a seek, reset or selection change. Buffering, pause
and speed changes leave it alone, so those updates cannot cause another seek.
A seek requested before metadata is ready waits for the video to load. A newer
request replaces it.

The player uses native HLS on iOS and hls.js elsewhere. hls.js loads only when
needed. Native playback is also the fallback for browsers without Media Source
support. iPadOS with a desktop user agent follows the iOS path.

Map view keeps the same video in a small preview. This keeps the clock
running without hiding the media element from Safari. If video fails, map view
can still play the route using the existing map clock.

The selected range loops within the available video. A range with no camera
frames shows a message. Transient HLS errors are left to the library's retries;
a fatal media error gets one recovery attempt. Other fatal errors show Retry.
Seeking after an error also reloads the source at the requested position.
Callbacks from an older source cannot report an HLS error or reject playback
for the current source.

## Automated checks

```sh
bun install --frozen-lockfile
bun run lint
bun run test
bun run build:production
```

The component tests cover control changes, paused seeking, early seeks,
loop boundaries, autoplay rejection, source changes and error recovery.
They simulate media events; they do not prove a browser can decode the video.

For actual decoding, install ffmpeg and the Playwright browsers, then run:

```sh
bunx playwright install chromium firefox webkit
bun run test:playback
```

This starts Vite on port 3001 and generates a 12-second HLS video with audio in
a temporary folder. Chromium, Firefox and an iPhone-sized WebKit context test playback,
audio controls, seeking while paused, map switching, looping, retry after a
404 playlist and seeking past a missing first segment. Demo API responses and
video files are served by the test; no account, device or network access is
needed. The temporary files are removed
when it finishes. `PLAYBACK_BASE_URL` can point to an existing dev server.

## Checks on devices

Browser automation does not replace these checks:

- Desktop Chrome, Firefox and Safari: open a real demo drive, seek repeatedly,
  change speed, select a range and switch between video and map.
- iPhone Safari and the home screen app: play a drive with microphone audio,
  unmute, seek, pause, background the app and return. Listen for audio glitches.
- Android Chrome and the installed app: repeat those controls with audio.
- Interrupt the network, restore it and retry. Check a missing segment, a range
  before the first camera frame and a range after the last one.

Record the browser, device and result in the PR. Leave anything not checked
unchecked.
