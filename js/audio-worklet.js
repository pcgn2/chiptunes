/* AudioWorklet ring-buffer consumer. The decoder worker sends interleaved stereo chunks. */
class ChiptuneProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.chunks = [];
    this.chunkIndex = 0;
    this.offset = 0;
    this.frames = 0;
    this.eof = false;
    this.lastNeed = 0;
    this.underruns = 0;

    this.port.onmessage = ({ data }) => {
      switch (data.type) {
        case 'chunk':
          this.chunks.push(data.pcm);
          this.frames += data.pcm.length / 2;
          if (this.frames > 240000) this.#dropOldest();
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
        case 'underruns':
          this.port.postMessage({ type: 'underruns', count: this.underruns });
          break;
      }
    };
  }

  #dropOldest() {
    const dropped = this.chunks.shift();
    this.frames -= dropped.length / 2;
    if (this.chunks.length === 0) {
      this.chunkIndex = 0;
      this.offset = 0;
    } else if (this.chunkIndex > 0) {
      this.chunkIndex--;
    }
  }

  process(_inputs, outputs) {
    const left = outputs[0][0];
    const right = outputs[0][1] || outputs[0][0];
    const count = left.length;
    let written = 0;

    while (written < count) {
      if (this.chunkIndex >= this.chunks.length) {
        left.fill(0, written);
        right.fill(0, written);
        this.underruns++;
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

    if (!this.eof && this.frames < 26000 && currentTime - this.lastNeed > 0.04) {
      this.port.postMessage({ type: 'need', buffered: this.frames });
      this.lastNeed = currentTime;
    }
    if (this.eof && this.frames === 0) {
      this.eof = false;
      this.port.postMessage({ type: 'ended' });
    }
    return true;
  }
}

registerProcessor('chiptune-processor', ChiptuneProcessor);
