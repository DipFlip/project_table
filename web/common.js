// Shared by both games: 2D vector helpers, the One Euro filter, synthesised sounds, particles
// and the URL switches.

// switches: ?debug=1 shows the stats panel (tap it for the report), ?fx=0 no particles,
// ?sound=0 no sound, ?delegate=cpu MediaPipe on the CPU
export const FLAGS = Object.fromEntries(new URLSearchParams(location.search));

// --- small 2D vector helpers -------------------------------------------------
export const add = (a, b) => [a[0] + b[0], a[1] + b[1]];
export const sub = (a, b) => [a[0] - b[0], a[1] - b[1]];
export const mul = (a, k) => [a[0] * k, a[1] * k];
export const dot = (a, b) => a[0] * b[0] + a[1] * b[1];
export const norm = (a) => Math.hypot(a[0], a[1]);
export const perp = (v) => [-v[1], v[0]];
export const clamp = (x, lo, hi) => Math.min(hi, Math.max(lo, x));
export const rgb = (c, a = 1) => `rgba(${c[0]},${c[1]},${c[2]},${a})`;
export const rand = (lo, hi) => lo + Math.random() * (hi - lo);

// --- One Euro filter (pmd/filters.py), over a flat array ---------------------
export function alpha(cutoff, dt) {
  const tau = 1 / (2 * Math.PI * cutoff);
  return 1 / (1 + tau / dt);
}

export class OneEuro {
  constructor(minCutoff = 1.0, beta = 0.01, dCutoff = 2.0) {
    Object.assign(this, { minCutoff, beta, dCutoff, x: null, dx: null });
  }
  filter(x, dt) {
    if (this.x === null || dt <= 0) {
      this.x = x.slice();
      this.dx = x.map(() => 0);
      return this.x;
    }
    const ad = alpha(this.dCutoff, dt);
    this.dx = this.dx.map((d, i) => d + ad * ((x[i] - this.x[i]) / dt - d));
    const cutoff = this.minCutoff + this.beta * Math.hypot(...this.dx);
    const a = alpha(cutoff, dt);
    this.x = this.x.map((v, i) => v + a * (x[i] - v));
    return this.x;
  }
}

// --- synthesised sounds (pmd/sound.py) ---------------------------------------
export class Sound {
  constructor() {
    this.ctx = new (window.AudioContext || window.webkitAudioContext)();
    this.out = this.ctx.createGain();
    this.out.gain.value = 0.8;
    this.out.connect(this.ctx.destination);
    this.live = 0; // sounds playing (for the stats)
    const n = { C5: 523.3, E5: 659.3, G5: 784.0, C6: 1046.5 };
    this.lib = {
      hit: [["square", 520, 0.08, 0.35, 0.7, 0], ["noise", 0, 0.05, 0.2, 0, 0]],
      wall: [["triangle", 300, 0.05, 0.3, 0, 0]],
      score: [["square", n.E5, 0.09, 0.3, 0, 0], ["square", n.C6, 0.2, 0.3, 0, 0.09]],
      win: [["square", n.C5, 0.12, 0.3, 0, 0], ["square", n.E5, 0.12, 0.3, 0, 0.12],
        ["square", n.G5, 0.12, 0.3, 0, 0.24], ["square", n.C6, 0.45, 0.3, 0, 0.36]],
      over: [["sawtooth", 260, 0.14, 0.28, 0.75, 0], ["sawtooth", 180, 0.26, 0.28, 0.7, 0.13]],
      valve: [["triangle", 400, 0.08, 0.2, 1.3, 0]],
    };
  }
  play(name, vol = 1) {
    if (FLAGS.sound === "0") return;
    const ctx = this.ctx, t0 = ctx.currentTime;
    for (const [wave, freq, dur, v, slide, delay] of this.lib[name] || []) {
      const g = ctx.createGain(), t = t0 + delay;
      const level = v * vol * (wave === "square" ? 0.5 : 1);
      g.gain.setValueAtTime(0, t);
      g.gain.linearRampToValueAtTime(level, t + 0.005);
      g.gain.setValueAtTime(level, t + Math.max(0.006, dur - 0.08));
      g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
      g.connect(this.out);
      let src;
      if (wave === "noise") {
        const buf = ctx.createBuffer(1, Math.ceil(ctx.sampleRate * dur), ctx.sampleRate);
        const d = buf.getChannelData(0);
        let acc = 0;
        for (let i = 0; i < d.length; i++) d[i] = acc += 0.5 * (Math.random() * 2 - 1 - acc);
        src = ctx.createBufferSource();
        src.buffer = buf;
      } else {
        src = ctx.createOscillator();
        src.type = wave;
        src.frequency.setValueAtTime(freq, t);
        if (slide) src.frequency.linearRampToValueAtTime(freq * slide, t + dur);
      }
      src.connect(g);
      src.start(t);
      src.stop(t + dur + 0.02);
      this.live++;
      src.onended = () => { // some browsers keep connected nodes alive, piling up over a game
        g.disconnect();
        this.live--;
      };
    }
  }
}

// --- particles (pmd/particles.py) --------------------------------------------
export class Particles {
  constructor(max = FLAGS.fx === "0" ? 0 : 1500) {
    this.p = [];
    this.max = max;
  }
  burst(pos, color, { n = 20, speed = 200, life = 0.6, size = 4, spread = 2 * Math.PI, direction = 0, drag = 2, colors = null } = {}) {
    for (let i = 0; i < n; i++) {
      const ang = direction + (Math.random() - 0.5) * spread, sp = speed * (0.3 + 0.7 * Math.random());
      this._add(pos, [Math.cos(ang) * sp, Math.sin(ang) * sp], life * (0.6 + 0.4 * Math.random()),
        size * (0.6 + 0.8 * Math.random()), colors ? colors[Math.floor(Math.random() * colors.length)] : color, drag);
    }
  }
  ring(pos, color, radius, { n = 24, speed = 60, life = 0.4, size = 3 } = {}) {
    for (let i = 0; i < n; i++) {
      const d = [Math.cos(2 * Math.PI * i / n), Math.sin(2 * Math.PI * i / n)];
      this._add(add(pos, mul(d, radius)), mul(d, speed), life, size, color, 1);
    }
  }
  // falls from the top of the screen; on a turned court the screen's top is the court's left
  confetti(f, turned, n = 150) {
    const colors = [[255, 80, 80], [255, 210, 60], [80, 230, 120], [240, 120, 255], [255, 255, 255], [255, 150, 40]];
    for (let i = 0; i < n; i++) {
      const across = Math.random(), down = Math.random() * 0.2, drift = (Math.random() - 0.5) * 200, fall = 150 + Math.random() * 250;
      const pos = turned ? [f.left + down * f.width, f.top + across * f.height] : [f.left + across * f.width, f.top + down * f.height];
      this._add(pos, turned ? [fall, drift] : [drift, fall], 1.5 + Math.random() * 1.5, 3 + Math.random() * 4,
        colors[Math.floor(Math.random() * colors.length)], 0.3);
    }
  }
  _add(pos, v, life, size, color, drag) {
    this.p.push({ pos: pos.slice(), v, life, age: 0, size, color, drag });
    if (this.p.length > this.max) this.p.splice(0, this.p.length - this.max);
  }
  update(dt) {
    for (const q of this.p) {
      q.age += dt;
      q.v = mul(q.v, Math.exp(-q.drag * dt));
      q.pos = add(q.pos, mul(q.v, dt));
    }
    this.p = this.p.filter((q) => q.age < q.life);
  }
  draw(c) {
    for (const q of this.p) {
      const f = Math.min(1, (1 - q.age / q.life) * 1.5);
      c.fillStyle = rgb(q.color, f);
      c.beginPath();
      c.arc(q.pos[0], q.pos[1], Math.max(1, q.size * (0.4 + 0.6 * f)), 0, 2 * Math.PI);
      c.fill();
    }
  }
  clear() { this.p = []; }
}

// --- game text with a drop shadow (and optional black border), centred on (x, y) ---------
export const FONT = '"The Bomb Sound", system-ui, -apple-system, sans-serif';
if (typeof document !== "undefined") document.fonts?.load('24px "The Bomb Sound"');

export function drawText(c, size, msg, [x, y], color, angle = 0, border = 0) {
  c.save();
  c.translate(x, y);
  if (angle) c.rotate(angle);
  c.font = `${Math.round(size)}px ${FONT}`;
  c.textAlign = "center";
  c.textBaseline = "middle";
  c.lineJoin = "round";
  c.miterLimit = 2;
  if (border > 0) {
    const off = Math.max(3, Math.round(border * 0.35));
    c.strokeStyle = "rgba(0,0,0,0.85)";
    c.lineWidth = border;
    c.strokeText(msg, off, off);
    c.strokeStyle = "#000";
    c.strokeText(msg, 0, 0);
  } else {
    c.fillStyle = "rgba(0,0,0,0.85)";
    c.fillText(msg, 3, 3);
  }
  c.fillStyle = rgb(color);
  c.fillText(msg, 0, 0);
  c.restore();
}
