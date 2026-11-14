// Finger Pong's fire hands (?fx=fire, or the h key): each player's hand is cut out of the camera
// image, tinted in their colour and drawn undimmed over the video, with flames licking off the
// fingertips and a glow that flares when their bouncer hits the ball.
//
// The cut-out is a soft mask built from the 21 hand landmarks the game already tracks (fat
// strokes along the fingers, a filled palm, blurred and drawn at half resolution), not a
// segmentation model: a model would add its time to every tracking pass or fight the tracker for
// the GPU, and the light ones (MediaPipe's 256 px selfie segmenters) are too coarse for a hand
// anyway. The mask is moved on by the hand's speed so it keeps up with the live video, which
// runs a detection or so ahead of the landmarks.
import { FLAGS, clamp } from "./common.js";

const FINGERS = [[1, 2, 3, 4], [5, 6, 7, 8], [9, 10, 11, 12], [13, 14, 15, 16], [17, 18, 19, 20]];
const PALM = [0, 1, 2, 5, 9, 13, 17];
const TIPS = [4, 8, 12, 16, 20];
const RES = 0.5; // the mask and the tinted hand are drawn at this fraction of screen px
const LEAD_MAX = 0.08; // s: move the mask on by the hand's speed for at most this long
const FLAME_RATE = 28; // flames per fingertip per second
const MAX_FLAMES = 900;
const MAX_SMOKE = 250;
const SMOKE_ODDS = 0.3; // chance a dying flame leaves a puff of smoke
const BALL_FIRE = [255, 150, 40]; // the ball's flame before anyone has hit it
const BALL_RATE = 120; // ball flames per second
const FLASH_S = 0.45; // a hit's glow fades over this long

export class HandFire {
  static on = FLAGS.fx === "fire";

  constructor(app) {
    this.app = app;
    this.mask = document.createElement("canvas");
    this.layer = document.createElement("canvas");
    this.mc = this.mask.getContext("2d");
    this.lc = this.layer.getContext("2d");
    this.flames = []; // also sparks (`spark: true`)
    this.smoke = [];
    this.tracks = []; // per found hand: { c: normalised centre, vel: per second, t }
    this.frameN = -1;
    this.sprites = new Map();
    this.last = null;
  }

  // a soft round blob: white-hot (`hot`) or in the colour
  sprite(color, hot) {
    const key = color.join() + hot;
    let s = this.sprites.get(key);
    if (s) return s;
    s = document.createElement("canvas");
    s.width = s.height = 64;
    const g = s.getContext("2d"), grad = g.createRadialGradient(32, 32, 0, 32, 32, 32);
    const [r, gr, b] = color;
    if (hot) {
      grad.addColorStop(0, "rgba(255,255,240,1)");
      grad.addColorStop(0.3, "rgba(255,230,150,0.8)");
      grad.addColorStop(0.65, `rgba(${r},${gr},${b},0.35)`);
    } else {
      grad.addColorStop(0, `rgba(${r},${gr},${b},0.9)`);
      grad.addColorStop(0.45, `rgba(${r},${gr},${b},0.4)`);
    }
    grad.addColorStop(1, `rgba(${r},${gr},${b},0)`);
    g.fillStyle = grad;
    g.fillRect(0, 0, 64, 64);
    this.sprites.set(key, s);
    return s;
  }

  // follow each hand from frame to frame for its speed (normalised units per second)
  follow(frame) {
    if (frame.n === this.frameN) return;
    this.frameN = frame.n;
    this.tracks = frame.found.map((h) => {
      const c = [(h[0][0] + h[9][0]) / 2, (h[0][1] + h[9][1]) / 2];
      let best = null, bd = 0.15;
      for (const p of this.tracks) {
        const d = Math.hypot(c[0] - p.c[0], c[1] - p.c[1]);
        if (d < bd) [best, bd] = [p, d];
      }
      let vel = [0, 0];
      if (best && frame.t > best.t) {
        const dt = frame.t - best.t, v = [(c[0] - best.c[0]) / dt, (c[1] - best.c[1]) / dt];
        vel = [0.5 * best.vel[0] + 0.5 * v[0], 0.5 * best.vel[1] + 0.5 * v[1]];
      }
      return { c, vel, t: frame.t };
    });
  }

  // which player each found hand belongs to: the game's rule (leftmost and rightmost on the court)
  owners(found) {
    const app = this.app;
    const mx = (h) => (app.toCourt(h[4])[0] + app.toCourt(h[8])[0]) / 2;
    const order = found.map((h, i) => [mx(h), i]).sort((a, b) => a[0] - b[0]);
    const who = found.map(() => -1);
    if (order.length >= 2) {
      who[order[0][1]] = 0;
      who[order.at(-1)[1]] = 1;
    } else if (order.length) {
      who[order[0][1]] = order[0][0] < app.field.centerX ? 0 : 1;
    }
    return who;
  }

  // grey puff for smoke, drawn normally (not added light)
  smokeSprite() {
    if (this.puff) return this.puff;
    const s = (this.puff = document.createElement("canvas"));
    s.width = s.height = 64;
    const g = s.getContext("2d"), grad = g.createRadialGradient(32, 32, 0, 32, 32, 32);
    grad.addColorStop(0, "rgba(150,145,140,0.7)");
    grad.addColorStop(0.5, "rgba(110,105,100,0.35)");
    grad.addColorStop(1, "rgba(80,80,80,0)");
    g.fillStyle = grad;
    g.fillRect(0, 0, 64, 64);
    return s;
  }

  // court px -> screen px (the court turns 90 degrees on a portrait screen), and the same for a direction
  pt(q) { return this.app.turned ? [this.app.W - q[1], q[0]] : q; }
  dir(v) { return this.app.turned ? [-v[1], v[0]] : v; }

  spawn(x, y, vx, vy, size, life, color, spark = false) {
    if (this.flames.length < MAX_FLAMES) this.flames.push({ x, y, vx, vy, size, life, color, spark, age: 0 });
  }

  // flames thrown out around `at` (screen px) along `d` (unit, screen) with `spread` radians each way
  blast(at, d, spread, r, color, { flames = 0, sparks = 0, smoke = 0, speed = 1 }) {
    const a0 = Math.atan2(d[1], d[0]);
    for (let i = 0; i < flames + sparks; i++) {
      const spark = i >= flames, a = a0 + (Math.random() * 2 - 1) * spread;
      const sp = r * speed * (spark ? 18 + Math.random() * 30 : 4 + Math.random() * 10);
      this.spawn(at[0], at[1], Math.cos(a) * sp, Math.sin(a) * sp,
        spark ? r * (0.35 + Math.random() * 0.3) : r * (1.6 + Math.random() * 1.6),
        spark ? 0.3 + Math.random() * 0.4 : 0.35 + Math.random() * 0.35, color, spark);
    }
    for (let i = 0; i < smoke && this.smoke.length < MAX_SMOKE; i++) {
      const a = a0 + (Math.random() * 2 - 1) * spread, sp = r * (1 + Math.random() * 3);
      this.smoke.push({ x: at[0], y: at[1], vx: Math.cos(a) * sp, vy: Math.sin(a) * sp, size: r * (2 + Math.random() * 2), life: 1.2 + Math.random(), age: 0 });
    }
  }

  // the game's events, in court px: a bouncer hit (normal: away from the bouncer), a wall bounce, a goal
  hit(at, normal, color, hard, r) {
    this.blast(this.pt(at), this.dir(normal), 1.1, r, color, { flames: Math.round(10 + 14 * hard), sparks: Math.round(14 + 26 * hard), smoke: 3, speed: 0.6 + 0.6 * hard });
  }
  wall(at, normal, color, r) {
    this.blast(this.pt(at), this.dir(normal), 1.2, r, color, { flames: 3, sparks: 7, speed: 0.5 });
  }
  goal(at, d, color, r) {
    this.blast(this.pt(at), this.dir(d), 1.3, r, color, { flames: 45, sparks: 45, smoke: 12, speed: 1.4 });
  }

  // the hand's outline, in screen px, on a context already transformed to the right place
  shape(g, p, L, wrist) {
    g.lineCap = g.lineJoin = "round";
    g.beginPath();
    g.moveTo(...p[PALM[0]]);
    for (const k of PALM) g.lineTo(...p[k]);
    g.closePath();
    g.lineWidth = 0.38 * L;
    g.fill();
    g.stroke();
    // the heel of the hand and the wrist, below the wrist landmark
    g.lineWidth = 0.6 * L;
    g.beginPath();
    g.moveTo((p[0][0] + p[9][0]) / 2, (p[0][1] + p[9][1]) / 2);
    g.lineTo(...wrist);
    g.stroke();
    FINGERS.forEach((f, j) => {
      g.lineWidth = (j === 0 ? 0.32 : j === 4 ? 0.24 : 0.28) * L;
      g.beginPath();
      g.moveTo(...p[j === 0 ? 1 : f[0]]);
      for (const k of f) g.lineTo(...p[k]);
      g.stroke();
    });
  }

  // c: the game's canvas context (any transform); scene: the HandPong
  draw(c, scene, now) {
    const app = this.app, frame = app.frame;
    const dt = this.last === null ? 0 : clamp(now - this.last, 0, 0.1);
    this.last = now;
    c.save();
    const dpr = c.canvas.width / app.W;
    c.setTransform(dpr, 0, 0, dpr, 0, 0); // screen px: flames rise up the screen however the court is turned
    this.burn(c, dt, true); // smoke under the hands
    if (frame && frame.found.length && app.fw) {
      this.follow(frame);
      const who = this.owners(frame.found);
      const lead = clamp(now - frame.t, 0, LEAD_MAX);
      frame.found.forEach((h, i) => {
        if (who[i] < 0) return;
        const v = this.tracks[i]?.vel || [0, 0];
        const p = h.map((q) => app.toScreen([q[0] + v[0] * lead, q[1] + v[1] * lead]));
        const flash = scene.flash && scene.flash[0] === who[i] ? Math.max(0, 1 - (now - scene.flash[1]) / FLASH_S) : 0;
        this.hand(c, p, scene.players[who[i]].color, flash, dt, v);
      });
    }
    if (scene.ball) this.ball(c, scene, dt);
    this.burn(c, dt, false);
    c.restore();
  }

  // the ball burns in the colour of whoever hit it last, its flames left behind as it flies
  ball(c, scene, dt) {
    const r = scene.r, b = this.pt(scene.ball), v = this.dir(scene.vel);
    const color = scene.flash ? scene.players[scene.flash[0]].color : BALL_FIRE;
    c.globalCompositeOperation = "lighter";
    c.globalAlpha = 0.6;
    const gs = r * 8;
    c.drawImage(this.sprite(color, false), b[0] - gs / 2, b[1] - gs / 2, gs, gs);
    c.globalAlpha = 1;
    c.globalCompositeOperation = "source-over";
    let n = BALL_RATE * dt;
    while (n > 0) {
      if (n < 1 && Math.random() > n) break;
      n -= 1;
      const a = Math.random() * 2 * Math.PI, d = Math.random() * r * 0.8;
      this.spawn(b[0] + Math.cos(a) * d, b[1] + Math.sin(a) * d,
        -v[0] * 0.1 + (Math.random() - 0.5) * r * 3, -v[1] * 0.1 - r * (2 + Math.random() * 3),
        r * (2 + Math.random() * 1.4), 0.25 + Math.random() * 0.25, color);
    }
  }

  hand(c, p, color, flash, dt, v) {
    const app = this.app, video = app.video;
    const L = Math.hypot(p[9][0] - p[0][0], p[9][1] - p[0][1]); // wrist to middle knuckle, px
    if (L < 8) return;
    // a little past the wrist landmark, away from the fingers: covers the heel of the hand and the wrist
    const wrist = [p[0][0] + (p[0][0] - p[9][0]) * 0.4, p[0][1] + (p[0][1] - p[9][1]) * 0.4];
    // the hand's box on screen, padded for the mask's width and blur
    const pad = 0.45 * L;
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const [x, y] of [...p, wrist]) {
      x0 = Math.min(x0, x); y0 = Math.min(y0, y); x1 = Math.max(x1, x); y1 = Math.max(y1, y);
    }
    x0 = Math.max(0, Math.floor(x0 - pad)); y0 = Math.max(0, Math.floor(y0 - pad));
    x1 = Math.min(app.W, Math.ceil(x1 + pad)); y1 = Math.min(app.H, Math.ceil(y1 + pad));
    const w = x1 - x0, h = y1 - y0;
    if (w > 4 && h > 4) {
      const cw = Math.ceil(w * RES), ch = Math.ceil(h * RES);
      for (const cv of [this.mask, this.layer]) { // grow only: resizing a canvas every frame is slow
        if (cv.width < cw || cv.height < ch) {
          cv.width = Math.max(cv.width, cw);
          cv.height = Math.max(cv.height, ch);
        }
      }
      const m = this.mc, g = this.lc;
      // mask: the hand's shape, softened by its own shadow
      m.setTransform(1, 0, 0, 1, 0, 0);
      m.clearRect(0, 0, cw + 2, ch + 2);
      m.setTransform(RES, 0, 0, RES, -x0 * RES, -y0 * RES);
      m.fillStyle = m.strokeStyle = m.shadowColor = "white";
      m.shadowBlur = 0.12 * L * RES;
      this.shape(m, p, L, wrist);
      // the camera pixels under the box (the video is mirrored on screen; screen = (fw - u) * scale + offset)
      const s = app.scale, [ox, oy] = app.offset;
      const u0 = app.fw - (x1 - ox) / s, u1 = app.fw - (x0 - ox) / s, v0 = (y0 - oy) / s, v1 = (y1 - oy) / s;
      g.globalCompositeOperation = "source-over";
      g.setTransform(-1, 0, 0, 1, cw, 0);
      g.clearRect(0, 0, cw + 2, ch + 2);
      g.drawImage(video, u0, v0, u1 - u0, v1 - v0, 0, 0, cw, ch);
      g.setTransform(1, 0, 0, 1, 0, 0);
      // tint: the player's colour with the camera's light and shade, lifted a little
      g.globalCompositeOperation = "color";
      g.fillStyle = `rgb(${color})`;
      g.fillRect(0, 0, cw, ch);
      g.globalCompositeOperation = "screen";
      g.fillStyle = `rgba(${color},${0.18 + 0.25 * flash})`;
      g.fillRect(0, 0, cw, ch);
      g.globalCompositeOperation = "destination-in";
      g.drawImage(this.mask, 0, 0, cw, ch, 0, 0, cw, ch);
      g.globalCompositeOperation = "source-over";
      // glow behind the hand, flaring on a hit
      c.globalCompositeOperation = "lighter";
      const glow = this.sprite(color, false), pc = [(p[0][0] + p[9][0]) / 2, (p[0][1] + p[9][1]) / 2];
      const gs = L * (3 + 2.5 * flash);
      c.globalAlpha = 0.25 + 0.4 * flash;
      c.drawImage(glow, pc[0] - gs / 2, pc[1] - gs / 2, gs, gs);
      c.globalAlpha = 1;
      c.globalCompositeOperation = "source-over";
      c.drawImage(this.layer, 0, 0, cw, ch, x0, y0, cw / RES, ch / RES);
      c.globalCompositeOperation = "lighter";
      const hot = this.sprite(color, true), ts = L * (0.5 + 0.4 * flash);
      c.globalAlpha = 0.3 + 0.3 * flash;
      for (const k of TIPS) c.drawImage(hot, p[k][0] - ts / 2, p[k][1] - ts / 2, ts, ts);
      c.globalAlpha = 1;
      c.globalCompositeOperation = "source-over";
    }
    // new flames off the fingertips (more on a hit), drifting with the hand
    const hv = [v[0] * app.fw * app.scale * 0.3, v[1] * app.fh * app.scale * 0.3];
    for (const k of TIPS) {
      const j = k === 4 ? 3 : k - 1; // the joint below the tip: the finger's direction
      const d = [p[k][0] - p[j][0], p[k][1] - p[j][1]], dl = Math.hypot(...d) || 1;
      let n = FLAME_RATE * (1 + 2 * flash) * dt;
      while (n > 0) {
        if (n < 1 && Math.random() > n) break;
        n -= 1;
        const sp = L * (0.5 + Math.random() * 0.6);
        this.spawn(p[k][0] + (Math.random() - 0.5) * 0.15 * L, p[k][1] + (Math.random() - 0.5) * 0.15 * L,
          (d[0] / dl) * sp * 0.8 + (Math.random() - 0.5) * 0.6 * L + hv[0],
          (d[1] / dl) * sp * 0.8 - L * (1.8 + Math.random() * 1.2) + hv[1],
          L * (0.2 + Math.random() * 0.12 + 0.1 * flash), 0.3 + Math.random() * 0.3 + 0.15 * flash, color);
      }
    }
  }

  // move and draw the smoke (`smoke`) or the flames and sparks: flames start white-hot, turn the
  // player's colour, rise and fade, and some leave a slow puff of smoke that drifts up and spreads
  burn(c, dt, smoke) {
    let n = 0;
    if (smoke) {
      const f = this.smoke, puff = this.smokeSprite();
      for (const q of f) {
        q.age += dt;
        if (q.age >= q.life) continue;
        f[n++] = q;
        q.vy -= q.size * 0.25 * dt;
        q.vx *= 1 - 1.2 * dt;
        q.vy *= 1 - 0.8 * dt;
        q.x += q.vx * dt;
        q.y += q.vy * dt;
        const k = q.age / q.life, s = q.size * (1 + 1.8 * k);
        c.globalAlpha = 0.28 * Math.min(1, k * 6) * (1 - k);
        c.drawImage(puff, q.x - s / 2, q.y - s / 2, s, s);
      }
      f.length = n;
      c.globalAlpha = 1;
      return;
    }
    const f = this.flames;
    c.globalCompositeOperation = "lighter";
    for (const q of f) {
      q.age += dt;
      if (q.age >= q.life) {
        if (!q.spark && Math.random() < SMOKE_ODDS && this.smoke.length < MAX_SMOKE) {
          this.smoke.push({ x: q.x, y: q.y, vx: q.vx * 0.3, vy: q.vy * 0.3, size: q.size * 1.3, life: 1.2 + Math.random() * 0.9, age: 0 });
        }
        continue;
      }
      f[n++] = q;
      if (q.spark) {
        q.vx *= 1 - 3 * dt;
        q.vy = q.vy * (1 - 3 * dt) - q.size * 6 * dt;
      } else {
        q.vy -= q.size * 3 * dt; // rises
        q.vx *= 1 - 2 * dt;
      }
      q.x += q.vx * dt;
      q.y += q.vy * dt;
      const k = q.age / q.life;
      if (q.spark) {
        const s = q.size * (1 - 0.5 * k);
        c.globalAlpha = 1 - k;
        c.drawImage(this.sprite(q.color, true), q.x - s / 2, q.y - s / 2, s, s);
        continue;
      }
      const s = q.size * (1 - 0.6 * k) * (k < 0.15 ? 0.5 + k / 0.3 : 1);
      const a = (1 - k) ** 1.5;
      c.globalAlpha = 0.6 * a * (1 - k);
      c.drawImage(this.sprite(q.color, true), q.x - s / 2, q.y - s, s, s * 2);
      c.globalAlpha = 0.85 * a * k * 1.4;
      c.drawImage(this.sprite(q.color, false), q.x - s / 2, q.y - s, s, s * 2);
    }
    f.length = n;
    c.globalAlpha = 1;
    c.globalCompositeOperation = "source-over";
  }
}

addEventListener("keydown", (e) => {
  if (e.key.toLowerCase() === "h" && !e.repeat) HandFire.on = !HandFire.on;
});
