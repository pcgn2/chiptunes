/* Real-time FFT visualizer driven by the Web Audio analyser node. */
export class Visualizer {
  constructor(canvas, analyser = null) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.analyser = analyser;
    this.bars = 60;
    this.heights = new Float32Array(this.bars);
    this.peaks = new Float32Array(this.bars);
    this.data = null;
    this.running = false;
    this.idle = true;
    this.phase = 0;
    this.dpr = 1;
    this.width = 0;
    this.height = 0;
    this.reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    this.refreshColors();

    this.resizeObserver = new ResizeObserver(() => this.resize());
    this.resizeObserver.observe(canvas);
    this.resize();
    this.frame = this.frame.bind(this);
  }

  setAnalyser(analyser) {
    this.analyser = analyser;
    this.data = analyser ? new Uint8Array(analyser.frequencyBinCount) : null;
  }

  refreshColors() {
    const style = getComputedStyle(document.documentElement);
    this.colorA = style.getPropertyValue('--accent').trim() || '#38e8ff';
    this.colorB = style.getPropertyValue('--accent-2').trim() || '#ff4fd8';
  }

  resize() {
    const rect = this.canvas.getBoundingClientRect();
    this.dpr = Math.min(window.devicePixelRatio || 1, 2);
    this.width = Math.max(1, rect.width);
    this.height = Math.max(1, rect.height);
    this.canvas.width = Math.round(this.width * this.dpr);
    this.canvas.height = Math.round(this.height * this.dpr);
    this.ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
  }

  start() {
    if (this.running) return;
    this.running = true;
    requestAnimationFrame(this.frame);
  }

  stop() {
    this.running = false;
  }

  setIdle(idle) {
    this.idle = idle;
  }

  frame(time) {
    if (!this.running) return;
    this.phase = time / 1000;
    this.render();
    requestAnimationFrame(this.frame);
  }

  sample() {
    const out = this.heights;
    if (!this.idle && this.analyser && this.data) {
      this.analyser.getByteFrequencyData(this.data);
      const nyquist = (this.analyser.context?.sampleRate || 48000) / 2;
      const binCount = this.data.length;
      const minFreq = 45;
      const maxFreq = Math.min(14000, nyquist);

      for (let i = 0; i < this.bars; i++) {
        const f0 = minFreq * Math.pow(maxFreq / minFreq, i / this.bars);
        const f1 = minFreq * Math.pow(maxFreq / minFreq, (i + 1) / this.bars);
        const b0 = Math.max(0, Math.floor((f0 / nyquist) * binCount));
        const b1 = Math.min(binCount - 1, Math.max(b0, Math.ceil((f1 / nyquist) * binCount)));
        let sum = 0;
        for (let b = b0; b <= b1; b++) sum += this.data[b];
        const value = sum / (b1 - b0 + 1) / 255;
        const boosted = Math.pow(value, 0.78) * (1 + i / this.bars * 0.22);
        out[i] += (Math.min(1, boosted) - out[i]) * 0.42;
      }
    } else {
      for (let i = 0; i < this.bars; i++) {
        const wave = 0.07 + 0.055 * Math.sin(this.phase * 1.5 + i * 0.38) + 0.035 * Math.sin(this.phase * 0.8 - i * 0.17);
        out[i] += (Math.max(0.025, wave) - out[i]) * 0.08;
      }
    }
  }

  render() {
    if (this.reduced && this.idle) return;
    this.sample();
    const { ctx, width: w, height: h } = this;
    ctx.clearRect(0, 0, w, h);

    const pad = 18;
    const gap = 3;
    const usable = w - pad * 2;
    const barW = Math.max(2, usable / this.bars - gap);
    const baseline = h - 16;
    const maxH = h - 34;

    const gradient = ctx.createLinearGradient(0, baseline, 0, baseline - maxH);
    gradient.addColorStop(0, this.colorA);
    gradient.addColorStop(0.6, this.colorB);
    gradient.addColorStop(1, this.colorA);

    for (let i = 0; i < this.bars; i++) {
      const value = this.heights[i];
      const barH = Math.max(2, value * maxH);
      const x = pad + i * (barW + gap);
      const y = baseline - barH;

      ctx.globalAlpha = this.idle ? 0.45 : 0.95;
      ctx.fillStyle = gradient;
      ctx.shadowColor = this.colorA;
      ctx.shadowBlur = this.idle ? 5 : 12;
      ctx.beginPath();
      if (typeof ctx.roundRect === 'function') ctx.roundRect(x, y, barW, barH, Math.min(3, barW / 2));
      else ctx.rect(x, y, barW, barH);
      ctx.fill();

      ctx.shadowBlur = 0;
      ctx.globalAlpha = 0.13;
      ctx.fillRect(x, baseline + 3, barW, Math.min(12, barH * 0.22));

      this.peaks[i] = Math.max(this.peaks[i] - 0.007, value);
      const peakY = baseline - this.peaks[i] * maxH;
      ctx.globalAlpha = 0.7;
      ctx.fillStyle = this.colorB;
      ctx.fillRect(x, peakY - 2, barW, 2);
    }
    ctx.globalAlpha = 1;
  }
}
