/* Browser audio engine: AudioWorklet playback + worker-side libopenmpt decoding. */
export class ChiptuneEngine {
  constructor(handlers = {}) {
    this.handlers = handlers;
    this.ctx = null;
    this.worker = null;
    this.node = null;
    this.gain = null;
    this.analyser = null;
    this.volume = 0.8;
    this.muted = false;
    this.loadId = 0;
    this.ready = false;
  }

  async init() {
    const AudioContextClass = window.AudioContext || window.webkitAudioContext;
    if (!AudioContextClass) throw new Error('This browser does not support the Web Audio API');
    if (!window.AudioWorkletNode) throw new Error('This browser does not support AudioWorklet');

    this.ctx = new AudioContextClass({ latencyHint: 'interactive' });
    const workletUrl = new URL('./audio-worklet.js', import.meta.url).href;
    await this.ctx.audioWorklet.addModule(workletUrl);

    this.node = new AudioWorkletNode(this.ctx, 'chiptune-processor', {
      numberOfInputs: 0,
      numberOfOutputs: 1,
      outputChannelCount: [2],
    });
    this.analyser = this.ctx.createAnalyser();
    this.analyser.fftSize = 2048;
    this.analyser.smoothingTimeConstant = 0.78;
    this.gain = this.ctx.createGain();
    this.gain.gain.value = this.muted ? 0 : this.volume;

    this.node.connect(this.analyser);
    this.analyser.connect(this.gain);
    this.gain.connect(this.ctx.destination);

    this.node.port.onmessage = ({ data }) => {
      if (data.type === 'need') {
        this.worker?.postMessage({ type: 'need', buffered: data.buffered });
      } else if (data.type === 'ended') {
        this.handlers.ended?.();
      }
    };

    this.worker = new Worker(new URL('./decoder-worker.js', import.meta.url).href);
    this.worker.onmessage = ({ data }) => {
      switch (data.type) {
        case 'ready':
          this.ready = true;
          this.handlers.ready?.();
          break;
        case 'chunk':
          this.node?.port.postMessage({ type: 'chunk', pcm: data.pcm }, [data.pcm.buffer]);
          break;
        case 'flush':
          this.node?.port.postMessage({ type: 'flush' });
          break;
        case 'loaded':
          if (data.id === this.loadId) this.handlers.loaded?.(data);
          break;
        case 'position':
          this.handlers.position?.(data);
          break;
        case 'seeked':
          this.handlers.seeked?.(data.seconds);
          break;
        case 'eof':
          this.node?.port.postMessage({ type: 'eof' });
          break;
        case 'error':
          this.handlers.error?.(data.message);
          break;
      }
    };
    this.worker.onerror = (event) => this.handlers.error?.(event.message || 'Audio decoder crashed');
    this.worker.postMessage({ type: 'init', sampleRate: this.ctx.sampleRate });
  }

  async resume() {
    if (this.ctx?.state === 'suspended') await this.ctx.resume();
  }

  load(track, startAt = 0) {
    const id = ++this.loadId;
    this.worker?.postMessage({ type: 'load', id, url: track.url, track: { title: track.title, artist: track.artist }, startAt });
    return id;
  }

  seek(seconds) {
    this.worker?.postMessage({ type: 'seek', seconds });
  }

  async pause() {
    this.worker?.postMessage({ type: 'pause' });
    if (this.ctx?.state === 'running') await this.ctx.suspend();
  }

  stop() {
    this.loadId++;
    this.worker?.postMessage({ type: 'stop' });
  }

  setVolume(value) {
    this.volume = Math.max(0, Math.min(1, value));
    if (this.gain && this.ctx) {
      this.gain.gain.setTargetAtTime(this.muted ? 0 : this.volume, this.ctx.currentTime, 0.015);
    }
  }

  setMuted(muted) {
    this.muted = muted;
    this.setVolume(this.volume);
  }
}
