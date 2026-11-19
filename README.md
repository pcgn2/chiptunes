# KEYGEN MUSIC — modern chiptune player

A no-build, static-browser player for the keygenmusic.tk MOD/XM/IT/S3M catalog (4,350 modules).
It replaces the original single-file player with a Web Audio pipeline and a modern UI.

## Run it

ES modules and AudioWorklet require HTTP, so serve the folder rather than opening `index.html` directly:

```bash
cd /Users/christophlamprecht/My\ Drive/_Claude/chiptunes
python3 -m http.server 8123
# open http://127.0.0.1:8123
```

Any static host works; there is no build step. Audio streams directly from `keygenmusic.tk`
(the host sends `Access-Control-Allow-Origin: *`). The app shell is cached by a service worker
for offline browsing; audio is never cached.

## Architecture

- `js/decoder-worker.js` — libopenmpt in a Web Worker; fetches modules, renders interleaved stereo chunks, handles seeking and reports tracker position.
- `js/audio-worklet.js` — glitch-resistant ring-buffer AudioWorklet source.
- `js/player.js` — audio graph (worklet → analyser → gain), transport and worker messaging.
- `js/visualizer.js` — canvas spectrum visualizer driven by real FFT data.
- `js/catalog.js` — catalog normalization, search/filter/sort.
- `js/app.js` — UI state, virtualized library, keyboard shortcuts, MediaSession, persistence.

## Features

Real-time spectrum visualizer · virtualized 4,350-track library · instant search with highlighted matches ·
favorites and recent history (localStorage) · format filters and sorting · shuffle/repeat (off/all/one) ·
seeking with MediaSession support · volume/mute · keyboard shortcuts · responsive layout ·
PWA installability · ARIA labels, focus states and reduced-motion support.

The interface uses a deliberately minimal layout: search, a compact player and a clean track list.
Use the heart button in the library search bar to switch to a persistent Favorites-only mode — the library and
playback queue are then limited to favorited tracks. Advanced controls remain available through
keyboard shortcuts (see `js/app.js`).

Legacy `js/chiptune2.js`, `music/` and `_backup.zip` were left untouched.
