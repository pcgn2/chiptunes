/* Keeps the display on while music plays.

   Screen Wake Lock is used where it is available. iOS Safari support is
   partial, so we also play a silent, looping audio element; iOS treats any
   active audio element as a reason to keep the screen awake. The silent clip
   is generated in memory at 0.0001 volume, so it is inaudible and adds no
   network request or asset to the project. */

let active = false;
let sentinel = null;
let silentAudio = null;
let listenersAttached = false;
let reacquireTimer = null;

function createSilentWavUrl() {
  const sampleRate = 8000;
  const sampleCount = sampleRate / 4; // 0.25 seconds
  const buffer = new ArrayBuffer(44 + sampleCount * 2);
  const view = new DataView(buffer);
  const writeText = (offset, value) => {
    for (let i = 0; i < value.length; i += 1) view.setUint8(offset + i, value.charCodeAt(i));
  };

  writeText(0, 'RIFF');
  view.setUint32(4, 36 + sampleCount * 2, true);
  writeText(8, 'WAVE');
  writeText(12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true); // PCM
  view.setUint16(22, 1, true); // mono
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  writeText(36, 'data');
  view.setUint32(40, sampleCount * 2, true);
  // The samples are already zero-filled, i.e. silence.

  return URL.createObjectURL(new Blob([buffer], { type: 'audio/wav' }));
}

function ensureSilentAudio() {
  if (!silentAudio) {
    silentAudio = new Audio(createSilentWavUrl());
    silentAudio.loop = true;
    silentAudio.preload = 'auto';
    // Do not use muted = true: iOS ignores muted elements for wake behavior.
    silentAudio.volume = 0.0001;
    silentAudio.setAttribute('playsinline', '');
    silentAudio.setAttribute('webkit-playsinline', '');
  }
  return silentAudio;
}

async function playSilentAudio() {
  const audio = ensureSilentAudio();
  try {
    await audio.play();
  } catch {
    // Autoplay can be rejected by policy; the Screen Wake Lock may still work.
  }
  // A pause may have happened while play() was pending.
  if (!active) audio.pause();
}

function stopSilentAudio() {
  if (!silentAudio) return;
  silentAudio.pause();
  try { silentAudio.currentTime = 0; } catch { /* not seekable yet */ }
}

async function requestScreenLock() {
  const wakeLock = navigator.wakeLock;
  if (!wakeLock || typeof wakeLock.request !== 'function') return;
  if (sentinel && !sentinel.released) return;
  try {
    const next = await wakeLock.request('screen');
    if (!active) {
      next.release().catch(() => {});
      return;
    }
    sentinel = next;
    next.addEventListener('release', () => {
      if (sentinel === next) sentinel = null;
      // Browsers release the lock when the tab is hidden. Reacquire it when
      // the page is visible again and audio is still playing.
      if (active && document.visibilityState === 'visible') {
        clearTimeout(reacquireTimer);
        reacquireTimer = setTimeout(requestScreenLock, 500);
      }
    });
  } catch {
    sentinel = null;
  }
}

function attachListeners() {
  if (listenersAttached) return;
  listenersAttached = true;
  document.addEventListener('visibilitychange', () => {
    if (active && document.visibilityState === 'visible') requestScreenLock();
  });
  window.addEventListener('focus', () => {
    if (active && document.visibilityState === 'visible') requestScreenLock();
  });
}

/** Call from the play/pause state transition. */
export function setWakeActive(shouldBeActive) {
  attachListeners();
  if (shouldBeActive === active) return;
  active = shouldBeActive;

  if (active) {
    // Both calls start synchronously so the silent audio play() is still
    // associated with the user's tap on iOS.
    playSilentAudio();
    requestScreenLock();
    return;
  }

  clearTimeout(reacquireTimer);
  stopSilentAudio();
  if (sentinel) {
    const current = sentinel;
    sentinel = null;
    current.release().catch(() => {});
  }
}

/** Small inspection helper for the console/debug hook. */
export function getWakeState() {
  const supported = !!(navigator.wakeLock && typeof navigator.wakeLock.request === 'function');
  return {
    active,
    wakeLockSupported: supported,
    screenLocked: !!(sentinel && !sentinel.released),
    silentAudioPlaying: !!(silentAudio && !silentAudio.paused),
  };
}
