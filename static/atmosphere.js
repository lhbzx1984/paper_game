/* =====================================================================
 * PaperQuest · 氛围音效系统
 * 纯 Web Audio API 合成，无外部音频文件依赖
 * 提供：持续氛围底噪 / UI 交互音 / 悬疑弦乐 / 转场音效 / 成功失败音
 * ===================================================================== */

(function () {
  "use strict";

  const Atmosphere = {
    ctx: null,
    master: null,
    ambientGain: null,
    ambientNodes: [],
    ambientStarted: false,
    muted: false,
    volume: 0.5,

    /* 懒初始化 AudioContext（需在用户交互后） */
    init() {
      if (this.ctx) return;
      try {
        const AC = window.AudioContext || window.webkitAudioContext;
        if (!AC) return;
        this.ctx = new AC();
        this.master = this.ctx.createGain();
        this.master.gain.value = this.muted ? 0 : this.volume;
        this.master.connect(this.ctx.destination);
      } catch (e) {
        console.warn("AudioContext unavailable", e);
      }
    },

    resume() {
      if (this.ctx && this.ctx.state === "suspended") {
        this.ctx.resume().catch(() => {});
      }
    },

    setMuted(muted) {
      this.muted = muted;
      if (this.master) {
        this.master.gain.cancelScheduledValues(this.ctx.currentTime);
        this.master.gain.setTargetAtTime(muted ? 0 : this.volume, this.ctx.currentTime, 0.1);
      }
      if (muted) this.stopAmbient();
      else this.startAmbient();
    },

    setVolume(v) {
      this.volume = Math.max(0, Math.min(1, v));
      if (this.master && !this.muted) {
        this.master.gain.setTargetAtTime(this.volume, this.ctx.currentTime, 0.1);
      }
    },

    /* ---------- 噪声缓冲工厂 ---------- */
    _noiseBuffer(duration, type) {
      const len = Math.floor(this.ctx.sampleRate * duration);
      const buf = this.ctx.createBuffer(1, len, this.ctx.sampleRate);
      const data = buf.getChannelData(0);
      if (type === "pink") {
        let b0 = 0, b1 = 0, b2 = 0, b3 = 0, b4 = 0, b5 = 0, b6 = 0;
        for (let i = 0; i < len; i++) {
          const white = Math.random() * 2 - 1;
          b0 = 0.99886 * b0 + white * 0.0555179;
          b1 = 0.99332 * b1 + white * 0.0750759;
          b2 = 0.969 * b2 + white * 0.153852;
          b3 = 0.8665 * b3 + white * 0.3104856;
          b4 = 0.55 * b4 + white * 0.5329522;
          b5 = -0.7616 * b5 - white * 0.016898;
          data[i] = (b0 + b1 + b2 + b3 + b4 + b5 + b6 + white * 0.5362) * 0.11;
          b6 = white * 0.115926;
        }
      } else if (type === "brown") {
        let last = 0;
        for (let i = 0; i < len; i++) {
          const white = Math.random() * 2 - 1;
          last = (last + 0.02 * white) / 1.02;
          data[i] = last * 3.5;
        }
      } else {
        for (let i = 0; i < len; i++) data[i] = Math.random() * 2 - 1;
      }
      return buf;
    },

    /* ---------- 持续氛围底噪 ---------- */
    startAmbient() {
      if (!this.ctx || this.ambientStarted || this.muted) return;
      this.ambientStarted = true;

      const t = this.ctx.currentTime;

      // 1) 棕噪声 → 低通滤波，模拟远处低沉的房间底噪
      const noise = this.ctx.createBufferSource();
      noise.buffer = this._noiseBuffer(8, "brown");
      noise.loop = true;
      const lp = this.ctx.createBiquadFilter();
      lp.type = "lowpass";
      lp.frequency.value = 320;
      lp.Q.value = 0.7;
      const noiseGain = this.ctx.createGain();
      noiseGain.gain.value = 0.18;
      noise.connect(lp).connect(noiseGain);

      // 2) 低频持续音（drone），营造压迫感
      const drone = this.ctx.createOscillator();
      drone.type = "sine";
      drone.frequency.value = 55; // A1
      const droneGain = this.ctx.createGain();
      droneGain.gain.value = 0.06;
      const droneLfo = this.ctx.createOscillator();
      droneLfo.frequency.value = 0.08;
      const droneLfoGain = this.ctx.createGain();
      droneLfoGain.gain.value = 0.03;
      droneLfo.connect(droneLfoGain).connect(droneGain.gain);
      drone.connect(droneGain);

      // 3) 更高一层的微妙泛音
      const drone2 = this.ctx.createOscillator();
      drone2.type = "sine";
      drone2.frequency.value = 82.4; // E2
      const drone2Gain = this.ctx.createGain();
      drone2Gain.gain.value = 0.025;
      drone2.connect(drone2Gain);

      // 主增益 + 缓慢淡入
      this.ambientGain = this.ctx.createGain();
      this.ambientGain.gain.value = 0;
      this.ambientGain.gain.setTargetAtTime(1, t, 2.5);

      noiseGain.connect(this.ambientGain);
      droneGain.connect(this.ambientGain);
      drone2Gain.connect(this.ambientGain);
      this.ambientGain.connect(this.master);

      noise.start(t);
      drone.start(t);
      droneLfo.start(t);
      drone2.start(t);

      this.ambientNodes = [noise, drone, droneLfo, drone2];

      // 随机稀疏事件：远处低语/滴水
      this._scheduleRandomEvents();
    },

    stopAmbient() {
      if (!this.ambientStarted) return;
      const t = this.ctx.currentTime;
      if (this.ambientGain) {
        this.ambientGain.gain.cancelScheduledValues(t);
        this.ambientGain.gain.setTargetAtTime(0, t, 0.5);
      }
      const nodes = this.ambientNodes.slice();
      setTimeout(() => {
        nodes.forEach((n) => { try { n.stop(); } catch (_) {} });
      }, 1200);
      this.ambientStarted = false;
      if (this._eventTimer) clearTimeout(this._eventTimer);
    },

    _scheduleRandomEvents() {
      if (!this.ctx || this.muted) return;
      const delay = 4000 + Math.random() * 9000;
      this._eventTimer = setTimeout(() => {
        if (this.muted) return;
        const r = Math.random();
        if (r < 0.35) this._drip();
        else if (r < 0.7) this._whisper();
        else this._distantSting();
        this._scheduleRandomEvents();
      }, delay);
    },

    _drip() {
      if (!this.ctx) return;
      const t = this.ctx.currentTime;
      const osc = this.ctx.createOscillator();
      osc.type = "sine";
      osc.frequency.setValueAtTime(1200, t);
      osc.frequency.exponentialRampToValueAtTime(400, t + 0.12);
      const g = this.ctx.createGain();
      g.gain.setValueAtTime(0, t);
      g.gain.linearRampToValueAtTime(0.12, t + 0.01);
      g.gain.exponentialRampToValueAtTime(0.001, t + 0.25);
      osc.connect(g).connect(this.master);
      osc.start(t);
      osc.stop(t + 0.3);
    },

    _whisper() {
      if (!this.ctx) return;
      const t = this.ctx.currentTime;
      const noise = this.ctx.createBufferSource();
      noise.buffer = this._noiseBuffer(1.2, "pink");
      const bp = this.ctx.createBiquadFilter();
      bp.type = "bandpass";
      bp.frequency.value = 1800;
      bp.Q.value = 1.5;
      const g = this.ctx.createGain();
      g.gain.setValueAtTime(0, t);
      g.gain.linearRampToValueAtTime(0.05, t + 0.3);
      g.gain.linearRampToValueAtTime(0, t + 1.1);
      noise.connect(bp).connect(g).connect(this.master);
      noise.start(t);
      noise.stop(t + 1.2);
    },

    _distantSting() {
      if (!this.ctx) return;
      const t = this.ctx.currentTime;
      const osc = this.ctx.createOscillator();
      osc.type = "sawtooth";
      osc.frequency.setValueAtTime(220, t);
      osc.frequency.linearRampToValueAtTime(110, t + 0.6);
      const lp = this.ctx.createBiquadFilter();
      lp.type = "lowpass";
      lp.frequency.value = 600;
      const g = this.ctx.createGain();
      g.gain.setValueAtTime(0, t);
      g.gain.linearRampToValueAtTime(0.06, t + 0.08);
      g.gain.exponentialRampToValueAtTime(0.001, t + 0.9);
      osc.connect(lp).connect(g).connect(this.master);
      osc.start(t);
      osc.stop(t + 1.0);
    },

    /* ---------- UI 交互音 ---------- */
    ui(name) {
      if (!this.ctx || this.muted) return;
      this.resume();
      const t = this.ctx.currentTime;
      const now = t;

      if (name === "click") {
        const osc = this.ctx.createOscillator();
        osc.type = "square";
        osc.frequency.value = 680;
        const g = this.ctx.createGain();
        g.gain.setValueAtTime(0.0001, now);
        g.gain.exponentialRampToValueAtTime(0.08, now + 0.005);
        g.gain.exponentialRampToValueAtTime(0.0001, now + 0.08);
        const lp = this.ctx.createBiquadFilter();
        lp.type = "lowpass";
        lp.frequency.value = 2000;
        osc.connect(lp).connect(g).connect(this.master);
        osc.start(now);
        osc.stop(now + 0.1);
      } else if (name === "hover") {
        const osc = this.ctx.createOscillator();
        osc.type = "sine";
        osc.frequency.value = 1400;
        const g = this.ctx.createGain();
        g.gain.setValueAtTime(0.0001, now);
        g.gain.exponentialRampToValueAtTime(0.03, now + 0.005);
        g.gain.exponentialRampToValueAtTime(0.0001, now + 0.05);
        osc.connect(g).connect(this.master);
        osc.start(now);
        osc.stop(now + 0.06);
      } else if (name === "paper") {
        // 翻纸声：短噪声 burst
        const noise = this.ctx.createBufferSource();
        noise.buffer = this._noiseBuffer(0.25, "white");
        const hp = this.ctx.createBiquadFilter();
        hp.type = "highpass";
        hp.frequency.value = 2000;
        const g = this.ctx.createGain();
        g.gain.setValueAtTime(0.12, now);
        g.gain.exponentialRampToValueAtTime(0.001, now + 0.22);
        noise.connect(hp).connect(g).connect(this.master);
        noise.start(now);
        noise.stop(now + 0.25);
      } else if (name === "success") {
        // 上升双音
        [523.25, 783.99].forEach((f, i) => {
          const osc = this.ctx.createOscillator();
          osc.type = "triangle";
          osc.frequency.value = f;
          const g = this.ctx.createGain();
          const start = now + i * 0.12;
          g.gain.setValueAtTime(0.0001, start);
          g.gain.exponentialRampToValueAtTime(0.12, start + 0.02);
          g.gain.exponentialRampToValueAtTime(0.0001, start + 0.3);
          osc.connect(g).connect(this.master);
          osc.start(start);
          osc.stop(start + 0.32);
        });
      } else if (name === "fail") {
        const osc = this.ctx.createOscillator();
        osc.type = "sawtooth";
        osc.frequency.setValueAtTime(220, now);
        osc.frequency.exponentialRampToValueAtTime(90, now + 0.4);
        const lp = this.ctx.createBiquadFilter();
        lp.type = "lowpass";
        lp.frequency.value = 800;
        const g = this.ctx.createGain();
        g.gain.setValueAtTime(0.0001, now);
        g.gain.exponentialRampToValueAtTime(0.14, now + 0.03);
        g.gain.exponentialRampToValueAtTime(0.0001, now + 0.45);
        osc.connect(lp).connect(g).connect(this.master);
        osc.start(now);
        osc.stop(now + 0.5);
      }
    },

    /* ---------- 悬疑弦乐 / 转场 ---------- */
    sting(name) {
      if (!this.ctx || this.muted) return;
      this.resume();
      const t = this.ctx.currentTime;

      if (name === "reveal") {
        // 上升的弦乐 shimmer，用于发现证据
        const freqs = [392, 523.25, 659.25, 783.99];
        freqs.forEach((f, i) => {
          const osc = this.ctx.createOscillator();
          osc.type = "sine";
          osc.frequency.value = f;
          const g = this.ctx.createGain();
          const start = t + i * 0.06;
          g.gain.setValueAtTime(0.0001, start);
          g.gain.linearRampToValueAtTime(0.07, start + 0.08);
          g.gain.exponentialRampToValueAtTime(0.0001, start + 0.9);
          osc.connect(g).connect(this.master);
          osc.start(start);
          osc.stop(start + 1.0);
        });
      } else if (name === "suspense") {
        // 低沉 + 高弦短刺，用于质证/紧张时刻
        const rumble = this.ctx.createOscillator();
        rumble.type = "sine";
        rumble.frequency.value = 45;
        const rg = this.ctx.createGain();
        rg.gain.setValueAtTime(0.0001, t);
        rg.gain.exponentialRampToValueAtTime(0.2, t + 0.1);
        rg.gain.exponentialRampToValueAtTime(0.0001, t + 0.8);
        rumble.connect(rg).connect(this.master);
        rumble.start(t);
        rumble.stop(t + 0.9);

        const strings = this.ctx.createOscillator();
        strings.type = "sawtooth";
        strings.frequency.setValueAtTime(1800, t + 0.05);
        strings.frequency.exponentialRampToValueAtTime(2400, t + 0.15);
        const sg = this.ctx.createGain();
        sg.gain.setValueAtTime(0, t + 0.05);
        sg.gain.linearRampToValueAtTime(0.05, t + 0.07);
        sg.gain.exponentialRampToValueAtTime(0.0001, t + 0.4);
        const lp = this.ctx.createBiquadFilter();
        lp.type = "lowpass";
        lp.frequency.value = 4000;
        strings.connect(lp).connect(sg).connect(this.master);
        strings.start(t + 0.05);
        strings.stop(t + 0.45);
      } else if (name === "transition") {
        // whoosh 转场
        const noise = this.ctx.createBufferSource();
        noise.buffer = this._noiseBuffer(0.6, "white");
        const bp = this.ctx.createBiquadFilter();
        bp.type = "bandpass";
        bp.Q.value = 2;
        bp.frequency.setValueAtTime(200, t);
        bp.frequency.exponentialRampToValueAtTime(4000, t + 0.4);
        const g = this.ctx.createGain();
        g.gain.setValueAtTime(0, t);
        g.gain.linearRampToValueAtTime(0.15, t + 0.1);
        g.gain.exponentialRampToValueAtTime(0.0001, t + 0.55);
        noise.connect(bp).connect(g).connect(this.master);
        noise.start(t);
        noise.stop(t + 0.6);
      } else if (name === "verdict") {
        // 裁决揭晓：庄严和弦
        const freqs = [261.63, 329.63, 392, 523.25];
        freqs.forEach((f) => {
          const osc = this.ctx.createOscillator();
          osc.type = "triangle";
          osc.frequency.value = f;
          const g = this.ctx.createGain();
          g.gain.setValueAtTime(0.0001, t);
          g.gain.linearRampToValueAtTime(0.08, t + 0.1);
          g.gain.exponentialRampToValueAtTime(0.0001, t + 1.6);
          osc.connect(g).connect(this.master);
          osc.start(t);
          osc.stop(t + 1.7);
        });
      }
    },
  };

  window.Atmosphere = Atmosphere;
})();
