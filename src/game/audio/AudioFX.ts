import { impactTier } from '../battle/impactTiers';
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
  private lastStrength = 0;
  private voices = 0;
  /** 软削波曲线：给低频重击加谐波 */
  private readonly softClip: Float32Array<ArrayBuffer> = (() => {
    const n = 1024;
    const c = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      const x = (i / (n - 1)) * 2 - 1;
      c[i] = Math.tanh(x * 2.6) / Math.tanh(2.6);
    }
    return c;
  })();
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
    const s = Math.max(0.02, Math.min(1, strength));
    const tier = impactTier(s);
    // 同一时刻（≤15ms）的多次接触合并成一次；但更强的撞击总能打断弱的
    if (now - this.lastHit < 0.015 && s <= this.lastStrength) return;
    this.lastHit = now;
    this.lastStrength = s;
    // 同时发声的撞击数有上限，避免连撞时爆音 / 卡顿
    if (this.voices >= 6) return;
    this.voices++;
    const life = tier === 'heavy' ? 0.9 : tier === 'medium' ? 0.45 : 0.15;
    setTimeout(() => this.voices--, life * 1000);

    const out = ctx.createGain();
    out.gain.value = tier === 'heavy' ? 1 : tier === 'medium' ? 0.55 + 0.25 * s : 0.18 + 0.5 * s;
    out.connect(this.master!);

    // 1) 金属振动分音（非谐波比例）：轻擦高而短（“叮”），猛撞低而长（“铛——”）
    const base =
      // P2.2：力度直接来自真实冲量，同一档内越重音高越低（猛撞 560 → 400Hz，听起来更沉）
      (tier === 'heavy' ? 560 - 160 * (s - 0.65) / 0.35 : tier === 'medium' ? 860 - 120 * (s - 0.3) / 0.35 : 1400 - 200 * s / 0.3) *
      (1 + (Math.random() - 0.5) * 0.12);
    const ratios = [1, 1.63, 2.76, 3.91, 5.4];
    const decay = tier === 'heavy' ? 0.75 : tier === 'medium' ? 0.3 : 0.09;
    ratios.forEach((ratio, i) => {
      if (tier === 'light' && i > 2) return;
      const osc = ctx.createOscillator();
      osc.type = i === 0 ? 'triangle' : 'sine';
      osc.frequency.value = base * ratio * (1 + (Math.random() - 0.5) * 0.02);
      const g = ctx.createGain();
      const amp = (0.2 / (i + 1)) * (i > 2 ? 0.6 + s : 1);
      g.gain.setValueAtTime(0, now);
      g.gain.linearRampToValueAtTime(amp, now + 0.002);
      g.gain.exponentialRampToValueAtTime(0.0001, now + decay / (1 + i * 0.35));
      osc.connect(g).connect(out);
      osc.start(now);
      osc.stop(now + decay + 0.05);
    });

    // 2) 瞬态噪声：撞击的“咔”，越强越亮越长
    const noise = ctx.createBufferSource();
    noise.buffer = this.noiseBuf;
    const bp = ctx.createBiquadFilter();
    bp.type = 'bandpass';
    bp.frequency.value = tier === 'light' ? 6500 : 2600 + 2500 * s;
    bp.Q.value = 0.9;
    const ng = ctx.createGain();
    ng.gain.setValueAtTime(tier === 'light' ? 0.35 : 0.6 + 0.6 * s, now);
    ng.gain.exponentialRampToValueAtTime(0.0001, now + (tier === 'light' ? 0.03 : 0.05 + 0.07 * s));
    noise.connect(bp).connect(ng).connect(out);
    noise.start(now, Math.random() * 0.3, 0.2);

    if (tier === 'light') return;

    // 3) 低频重击：中等是短促的“咚”，猛撞是下潜的重低音。
    //    经过软削波产生谐波——手机外放发不出 50Hz，但能放出它的 2、3 次谐波，听起来依然“厚”
    const thump = ctx.createOscillator();
    thump.type = 'sine';
    const f0 = tier === 'heavy' ? 150 : 210;
    const f1 = tier === 'heavy' ? 38 : 90;
    const tl = tier === 'heavy' ? 0.38 : 0.16;
    thump.frequency.setValueAtTime(f0, now);
    thump.frequency.exponentialRampToValueAtTime(f1, now + tl * 0.8);
    const shaper = ctx.createWaveShaper();
    shaper.curve = this.softClip;
    const tg = ctx.createGain();
    tg.gain.setValueAtTime(tier === 'heavy' ? 0.95 : 0.5, now);
    tg.gain.exponentialRampToValueAtTime(0.0001, now + tl);
    thump.connect(shaper).connect(tg).connect(out);
    thump.start(now);
    thump.stop(now + tl + 0.05);

    if (tier !== 'heavy') return;

    // 4) 猛撞：低通噪声“轰”的冲击体感 + 40ms 后的场地回响
    const body = ctx.createBufferSource();
    body.buffer = this.noiseBuf;
    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.setValueAtTime(1400, now);
    lp.frequency.exponentialRampToValueAtTime(180, now + 0.3);
    const bg = ctx.createGain();
    bg.gain.setValueAtTime(0.9, now);
    bg.gain.exponentialRampToValueAtTime(0.0001, now + 0.32);
    body.connect(lp).connect(bg).connect(out);
    body.start(now, Math.random() * 0.3, 0.4);

    const echo = ctx.createOscillator();
    echo.type = 'triangle';
    echo.frequency.value = base * 0.98;
    const eg = ctx.createGain();
    eg.gain.setValueAtTime(0, now + 0.04);
    eg.gain.linearRampToValueAtTime(0.07, now + 0.045);
    eg.gain.exponentialRampToValueAtTime(0.0001, now + 0.6);
    echo.connect(eg).connect(out);
    echo.start(now + 0.04);
    echo.stop(now + 0.65);
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
