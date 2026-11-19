/* Browser audio engine: AudioWorklet with a ScriptProcessor fallback, driven by a decoder worker. */
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
    this.useWorklet = false;
    this.chunks = [];
    this.chunkIndex = 0;
    this.offset = 0;
    this.frames = 0;
    this.eof = false;
    this.lastNeed = 0;
  }

  async init() {
    const AudioContextClass = window.AudioContext || window.webkitAudioContext;
    if (!AudioContextClass) throw new Error('This browser does not support the Web Audio API');

    this.ctx = new AudioContextClass({ latencyHint: 'interactive' });

    this.analyser = this.ctx.createAnalyser();
    this.analyser.fftSize = 2048;
    this.analyser.smoothingTimeConstant = 0.78;
    this.gain = this.ctx.createGain();
    this.gain.gain.value = this.muted ? 0 : this.volume;

    // Safari exposes AudioWorklet with prefixes on some versions, and rejects
    // numberOfInputs: 0 on others. Try it, then fall back to ScriptProcessor.
    const WorkletNode = window.AudioWorkletNode || window.webkitAudioWorkletNode;
    const workletScope = this.ctx.audioWorklet || this.ctx.webkitAudioWorklet;
    if (WorkletNode && workletScope && typeof workletScope.addModule === 'function') {
      try {
        const url = new URL('./audio-worklet.js', import.meta.url).href;
        await workletScope.addModule(url);
        this.node = new WorkletNode(this.ctx, 'chiptune-processor', {
          numberOfInputs: 1,
          numberOfOutputs: 1,
          outputChannelCount: [2],
        });
        this.node.port.onmessage = ({ data }) => this.onAudioMessage(data);
        this.useWorklet = true;
      } catch (error) {
        this.node = null;
      }
    }
    if (!this.node) this.initFallback();

    this.node.connect(this.analyser);
    this.analyser.connect(this.gain);
    this.gain.connect(this.ctx.destination);

    this.worker = new Worker(new URL('./decoder-worker.js', import.meta.url).href);
    this.worker.onmessage = ({ data }) => {
      switch (data.type) {
        case 'ready':
          this.ready = true;
          this.handlers.ready?.();
          break;
        case 'chunk':
          this.sendAudio({ type: 'chunk', pcm: data.pcm }, [data.pcm.buffer]);
          break;
        case 'flush':
          this.sendAudio({ type: 'flush' });
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
          this.sendAudio({ type: 'eof' });
          break;
        case 'error':
          this.handlers.error?.(data.message);
          break;
      }
    };
    this.worker.onerror = (event) => this.handlers.error?.(event.message || 'Audio decoder crashed');
    this.worker.postMessage({ type: 'init', sampleRate: this.ctx.sampleRate });
  }

  sendAudio(message, transfer = []) {
    if (this.useWorklet) this.node.port.postMessage(message, transfer);
    else this.fallbackMessage(message);
  }

  onAudioMessage(data) {
    if (data.type === 'need') {
      this.worker?.postMessage({ type: 'need', buffered: data.buffered });
    } else if (data.type === 'ended') {
      this.handlers.ended?.();
    }
  }

  /* Mirrors js/audio-worklet.js on the main thread for browsers without AudioWorklet. */
  initFallback() {
    const createProcessor = this.ctx.createScriptProcessor || this.ctx.webkitCreateScriptProcessor;
    if (!createProcessor) throw new Error('This browser does not support audio processing');
    const node = createProcessor.call(this.ctx, 4096, 1, 2);
    this.node = node;
    this.chunks = [];
    this.chunkIndex = 0;
    this.offset = 0;
    this.frames = 0;
    this.eof = false;
    this.lastNeed = 0;

    node.onaudioprocess = (event) => {
      const left = event.outputBuffer.getChannelData(0);
      const right = event.outputBuffer.getChannelData(1);
      const count = left.length;
      let written = 0;

      while (written < count) {
        if (this.chunkIndex >= this.chunks.length) {
          left.fill(0, written);
          right.fill(0, written);
          break;
        }
        const chunk = this.chunks[this.chunkIndex];
        const available = chunk.length / 2 - this.offset;
        const take = Math.min(available, count - written);
        for (let i = 0; i < take; i++) {
          left[written + i] = chunk[(this.offset + i) * 2];
          right[written + i] = chunk[(this.offset + i) * 2 + 1];
        }
        written += take;
        this.offset += take;
        this.frames -= take;
        if (this.offset >= chunk.length / 2) {
          this.chunkIndex++;
          this.offset = 0;
        }
      }

      const now = this.ctx.currentTime;
      if (!this.eof && this.frames < 26000 && now - this.lastNeed > 0.04) {
        this.onAudioMessage({ type: 'need', buffered: this.frames });
        this.lastNeed = now;
      }
      if (this.eof && this.frames <= 0) {
        this.eof = false;
        this.onAudioMessage({ type: 'ended' });
      }
    };
  }

  fallbackMessage(data) {
    switch (data.type) {
      case 'chunk':
        this.chunks.push(data.pcm);
        this.frames += data.pcm.length / 2;
        if (this.frames > 240000) {
          const dropped = this.chunks.shift();
          this.frames -= dropped.length / 2;
          if (!this.chunks.length) { this.chunkIndex = 0; this.offset = 0; }
          else if (this.chunkIndex > 0) this.chunkIndex--;
        }
        break;
      case 'flush':
        this.chunks = [];
        this.chunkIndex = 0;
        this.offset = 0;
        this.frames = 0;
        this.eof = false;
        break;
      case 'eof':
        this.eof = true;
        break;
    }
  }

  async resume() {
    if (!this.ctx) return;
    // Safari reports an extra 'interrupted' state after leaving the tab.
    if (this.ctx.state !== 'running') await this.ctx.resume();
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
