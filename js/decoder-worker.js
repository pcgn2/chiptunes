/* Off-main-thread libopenmpt decoder. Streams interleaved stereo into an AudioWorklet. */
/* eslint-disable no-undef */
self.window = self; // legacy Emscripten glue expects a window object
let bootError = null;
self.Module = {
  noInitialRun: true,
  print() {},
  printErr(message) { bootError = String(message); },
};

try {
  importScripts('./libopenmpt.js');
} catch (error) {
  bootError = String(error);
}

const FRAMES = 8192;
const TARGET_BUFFER = 48000;
const LOW_WATER = 26000;

let modulePtr = 0;
let leftPtr = 0;
let rightPtr = 0;
let moduleBytes = null;
let active = false;
let pumping = false;
let eof = false;
let loadToken = 0;
let controller = null;
let fallback = {};
let sampleRate = 48000;
let lastDuration = 0;

function post(message, transfer) {
  self.postMessage(message, transfer || []);
}

function ready() {
  return !!(typeof Module !== 'undefined' && Module._openmpt_module_read_float_stereo);
}

function ptrString(ptr) {
  if (!ptr) return '';
  try {
    if (typeof Pointer_stringify === 'function') return Pointer_stringify(ptr);
    if (typeof Module.Pointer_stringify === 'function') return Module.Pointer_stringify(ptr);
  } catch { /* ignore */ }
  return '';
}

function writeAscii(text, ptr) {
  for (let i = 0; i < text.length; i++) Module.HEAPU8[ptr + i] = text.charCodeAt(i) & 0xff;
  Module.HEAPU8[ptr + text.length] = 0;
}

function readMetadata() {
  const meta = {};
  const keys = ptrString(Module._openmpt_module_get_metadata_keys(modulePtr)).split(';').filter(Boolean);
  for (const key of keys) {
    const ptr = Module._malloc(key.length + 1);
    writeAscii(key, ptr);
    meta[key.toLowerCase()] = ptrString(Module._openmpt_module_get_metadata(modulePtr, ptr));
    Module._free(ptr);
  }
  return meta;
}

function destroyModule() {
  if (modulePtr) {
    Module._openmpt_module_destroy(modulePtr);
    modulePtr = 0;
  }
  if (leftPtr) { Module._free(leftPtr); leftPtr = 0; }
  if (rightPtr) { Module._free(rightPtr); rightPtr = 0; }
}

function createModule(seconds = 0) {
  destroyModule();
  if (!moduleBytes) throw new Error('No module data loaded');
  const bytes = new Uint8Array(moduleBytes);
  const filePtr = Module._malloc(bytes.length);
  Module.HEAPU8.set(bytes, filePtr);
  modulePtr = Module._openmpt_module_create_from_memory(filePtr, bytes.length, 0, 0, 0);
  Module._free(filePtr);
  if (!modulePtr) throw new Error('Unsupported or damaged module file');
  Module._openmpt_module_set_repeat_count(modulePtr, 0);
  if (seconds > 0) Module._openmpt_module_set_position_seconds(modulePtr, seconds);
  leftPtr = Module._malloc(FRAMES * 4);
  rightPtr = Module._malloc(FRAMES * 4);
  eof = false;
}

function pump() {
  if (!active || pumping || !modulePtr || eof || !ready()) return;
  pumping = true;
  let rendered = 0;
  try {
    while (active && modulePtr && !eof && rendered < TARGET_BUFFER) {
      const frames = Module._openmpt_module_read_float_stereo(modulePtr, sampleRate, FRAMES, leftPtr, rightPtr);
      if (frames <= 0) {
        eof = true;
        post({ type: 'eof' });
        break;
      }
      const pcm = new Float32Array(frames * 2);
      const left = Module.HEAPF32.subarray(leftPtr / 4, leftPtr / 4 + frames);
      const right = Module.HEAPF32.subarray(rightPtr / 4, rightPtr / 4 + frames);
      for (let i = 0; i < frames; i++) {
        pcm[i * 2] = left[i];
        pcm[i * 2 + 1] = right[i];
      }
      post({ type: 'chunk', pcm }, [pcm.buffer]);
      rendered += frames;
    }
  } catch (error) {
    post({ type: 'error', message: String(error && error.message || error) });
    active = false;
  } finally {
    pumping = false;
  }
}

function publishPosition() {
  if (!modulePtr || !active) return;
  post({
    type: 'position',
    seconds: Module._openmpt_module_get_position_seconds(modulePtr),
    pattern: Module._openmpt_module_get_current_pattern(modulePtr),
    row: Module._openmpt_module_get_current_row(modulePtr),
    order: Module._openmpt_module_get_current_order(modulePtr),
  });
}

async function load(message) {
  const token = ++loadToken;
  if (controller) controller.abort();
  controller = new AbortController();
  active = false;
  destroyModule();
  moduleBytes = null;
  fallback = message.track || {};
  post({ type: 'flush' });

  try {
    if (!ready()) throw new Error(bootError || 'Audio decoder failed to start');
    const response = await fetch(message.url, {
      signal: controller.signal,
      mode: 'cors',
      credentials: 'omit',
      referrerPolicy: 'no-referrer',
    });
    if (!response.ok) throw new Error(`HTTP ${response.status} while fetching module`);
    const bytes = await response.arrayBuffer();
    if (token !== loadToken) return;
    moduleBytes = bytes;
    createModule(message.startAt || 0);
    const meta = readMetadata();
    lastDuration = Module._openmpt_module_get_duration_seconds(modulePtr);
    active = true;
    post({
      type: 'loaded',
      id: message.id,
      duration: lastDuration,
      meta: {
        title: meta.title || fallback.title || '',
        artist: meta.artist || fallback.artist || '',
        message: meta.message || '',
      },
    });
    pump();
  } catch (error) {
    if (token !== loadToken || (error && error.name === 'AbortError')) return;
    post({ type: 'error', id: message.id, message: String(error && error.message || error) });
  }
}

self.onmessage = ({ data }) => {
  switch (data.type) {
    case 'init':
      sampleRate = data.sampleRate || 48000;
      if (!ready()) post({ type: 'error', message: bootError || 'Audio decoder failed to start' });
      else post({ type: 'ready' });
      break;
    case 'load':
      load(data);
      break;
    case 'need':
      if (data.buffered < LOW_WATER) pump();
      break;
    case 'pause':
      active = false;
      break;
    case 'resume':
      if (modulePtr) { active = true; pump(); }
      break;
    case 'seek': {
      if (!modulePtr || !moduleBytes) break;
      const seconds = Math.max(0, Math.min(data.seconds, lastDuration || Infinity));
      active = false;
      post({ type: 'flush' });
      try {
        createModule(seconds);
        active = true;
        post({ type: 'seeked', seconds });
        pump();
      } catch (error) {
        post({ type: 'error', message: String(error && error.message || error) });
      }
      break;
    }
    case 'stop':
      loadToken++;
      if (controller) controller.abort();
      active = false;
      post({ type: 'flush' });
      destroyModule();
      moduleBytes = null;
      break;
  }
};

setInterval(publishPosition, 200);
