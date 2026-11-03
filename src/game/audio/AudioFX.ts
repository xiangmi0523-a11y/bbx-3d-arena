/**
 * 实时合成音效（Web Audio，无外部音频文件，离线可用）：
 *  - 金属碰撞：若干非谐波正弦分音（模拟金属板振动）+ 带通噪声瞬态；
 *    力度越大：音量越大、瞬态越亮、余音越长，并加一层低频“咚”的冲击；
 *  - 发射：拉绳的“嘶”声 + 快速上扬的转动声；
 *  - 旋转嗡鸣：随转速变化的低音量持续音（可选）。
 * iOS Safari 必须在用户手势里解锁 AudioContext，所以首次触摸时调用 unlock()。
 */
export class AudioFX {
  private ctx: AudioContext | null = null;
  private master: GainNode | null = null;
  private noiseBuf: AudioBuffer | null = null;
  private lastHit = 0;
  private hum: { osc: OscillatorNode; osc2: OscillatorNode; gain: GainNode } | null = null;
  muted = false;

  /** 在触摸 / 点击事件里调用 */
  unlock(): void {
    if (!this.ctx) {
      const Ctor = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
      if (!Ctor) return;
      this.ctx = new Ctor();
      this.master = this.ctx.createGain();
      this.master.gain.value = 0.8;
      const comp = this.ctx.createDynamicsCompressor();
      comp.threshold.value = -10;
      comp.ratio.value = 6;
      this.master.connect(comp).connect(this.ctx.destination);
      const len = Math.floor(this.ctx.sampleRate * 0.5);
      this.noiseBuf = this.ctx.createBuffer(1, len, this.ctx.sampleRate);
      const d = this.noiseBuf.getChannelData(0);
      for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
    }
    if (this.ctx.state === 'suspended') void this.ctx.resume();
  }

  get ready(): boolean {
    return !!this.ctx && this.ctx.state === 'running' && !this.muted;
  }

  /** 金属碰撞，strength 0..1 */
  clash(strength: number): void {
    if (!this.ready) return;
    const ctx = this.ctx!;
    const now = ctx.currentTime;
    // 同一帧多次碰撞合并
    if (now - this.lastHit < 0.03) return;
    this.lastHit = now;
    const s = Math.max(0.05, Math.min(1, strength));
    const out = ctx.createGain();
    out.gain.value = 0.25 + 0.75 * s;
    out.connect(this.master!);

    // 金属振动分音（非谐波比例），随机微调音高避免重复感
    const base = 820 + Math.random() * 360 - s * 200;
    const ratios = [1, 1.63, 2.76, 3.91, 5.4];
    const decay = 0.12 + 0.45 * s;
    ratios.forEach((ratio, i) => {
      const osc = ctx.createOscillator();
      osc.type = i === 0 ? 'triangle' : 'sine';
      osc.frequency.value = base * ratio * (1 + (Math.random() - 0.5) * 0.02);
      const g = ctx.createGain();
      const amp = (0.22 / (i + 1)) * (i > 2 ? 0.5 + s : 1);
      g.gain.setValueAtTime(0, now);
      g.gain.linearRampToValueAtTime(amp, now + 0.002);
      g.gain.exponentialRampToValueAtTime(0.0001, now + decay / (1 + i * 0.35));
      osc.connect(g).connect(out);
      osc.start(now);
      osc.stop(now + decay + 0.05);
    });

    // 瞬态噪声：撞击的“咔”
    const noise = ctx.createBufferSource();
    noise.buffer = this.noiseBuf;
    const bp = ctx.createBiquadFilter();
    bp.type = 'bandpass';
    bp.frequency.value = 2500 + 4000 * s;
    bp.Q.value = 0.9;
    const ng = ctx.createGain();
    ng.gain.setValueAtTime(0.9 * s + 0.2, now);
    ng.gain.exponentialRampToValueAtTime(0.0001, now + 0.04 + 0.06 * s);
    noise.connect(bp).connect(ng).connect(out);
    noise.start(now, Math.random() * 0.3, 0.15);

    // 强撞击：低频冲击
    if (s > 0.45) {
      const thump = ctx.createOscillator();
      thump.type = 'sine';
      thump.frequency.setValueAtTime(140, now);
      thump.frequency.exponentialRampToValueAtTime(45, now + 0.18);
      const tg = ctx.createGain();
      tg.gain.setValueAtTime(0.55 * s, now);
      tg.gain.exponentialRampToValueAtTime(0.0001, now + 0.25);
      thump.connect(tg).connect(out);
      thump.start(now);
      thump.stop(now + 0.3);
    }
  }

  /** 发射音效，power 0..1 */
  launch(power: number): void {
    if (!this.ready) return;
    const ctx = this.ctx!;
    const now = ctx.currentTime;
    const noise = ctx.createBufferSource();
    noise.buffer = this.noiseBuf;
    const hp = ctx.createBiquadFilter();
    hp.type = 'highpass';
    hp.frequency.setValueAtTime(800, now);
    hp.frequency.exponentialRampToValueAtTime(3000 + 3000 * power, now + 0.2);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, now);
    g.gain.exponentialRampToValueAtTime(0.5, now + 0.03);
    g.gain.exponentialRampToValueAtTime(0.0001, now + 0.3);
    noise.connect(hp).connect(g).connect(this.master!);
    noise.start(now, 0, 0.35);
    const osc = ctx.createOscillator();
    osc.type = 'sawtooth';
    osc.frequency.setValueAtTime(120, now);
    osc.frequency.exponentialRampToValueAtTime(500 + 500 * power, now + 0.35);
    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.value = 1400;
    const og = ctx.createGain();
    og.gain.setValueAtTime(0.0001, now);
    og.gain.exponentialRampToValueAtTime(0.12, now + 0.05);
    og.gain.exponentialRampToValueAtTime(0.0001, now + 0.45);
    osc.connect(lp).connect(og).connect(this.master!);
    osc.start(now);
    osc.stop(now + 0.5);
  }

  /** 旋转嗡鸣：spin 为两台陀螺的平均转速比例 0..1；传 0 停止 */
  setHum(spin: number): void {
    if (!this.ready) return;
    const ctx = this.ctx!;
    if (!this.hum && spin > 0.02) {
      const osc = ctx.createOscillator();
      osc.type = 'sawtooth';
      const osc2 = ctx.createOscillator();
      osc2.type = 'sine';
      const lp = ctx.createBiquadFilter();
      lp.type = 'lowpass';
      lp.frequency.value = 700;
      const gain = ctx.createGain();
      gain.gain.value = 0;
      osc.connect(lp);
      osc2.connect(lp);
      lp.connect(gain).connect(this.master!);
      osc.start();
      osc2.start();
      this.hum = { osc, osc2, gain };
    }
    if (!this.hum) return;
    const t = ctx.currentTime;
    this.hum.osc.frequency.setTargetAtTime(60 + 200 * spin, t, 0.1);
    this.hum.osc2.frequency.setTargetAtTime(121 + 400 * spin, t, 0.1);
    this.hum.gain.gain.setTargetAtTime(spin > 0.02 ? 0.03 + 0.05 * spin : 0, t, 0.15);
  }

  stopHum(): void {
    if (!this.hum || !this.ctx) return;
    this.hum.gain.gain.setTargetAtTime(0, this.ctx.currentTime, 0.05);
  }

  /** 部件装配“咔哒”声 */
  click(): void {
    if (!this.ready) return;
    const ctx = this.ctx!;
    const now = ctx.currentTime;
    const osc = ctx.createOscillator();
    osc.type = 'square';
    osc.frequency.setValueAtTime(1800, now);
    osc.frequency.exponentialRampToValueAtTime(600, now + 0.04);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.12, now);
    g.gain.exponentialRampToValueAtTime(0.0001, now + 0.06);
    osc.connect(g).connect(this.master!);
    osc.start(now);
    osc.stop(now + 0.08);
  }
}
