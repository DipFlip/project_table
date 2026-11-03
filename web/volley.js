// Full-body Volleyball, for a projector with a laptop camera watching the players: a side view
// with gravity, a net in the middle and bouncy back walls. Everyone left of the net plays for
// green, everyone right of it for orange, as many as the camera sees. Your paddle is the line
// between your wrists; with one hand in view it's level with that hand and mirrored across your
// head, with none it sits just above your head. The ball can fly above the screen (an arrow on
// the top edge shows where it is) and has no bounce limit; when it lands, the other side scores.
import { add, sub, mul, dot, norm, perp, clamp, rgb, OneEuro, drawText } from "./common.js";

const WIN_SCORE = 11;
const GRAVITY = 1.0; // x screen height per s²
const BALL_R = 0.04; // x screen height
const MAX_SPEED = 1.0; // after a hit, x screen height per s (1.0 rises at most half a screen height)
const NET_H = 0.33; // net height above the floor, x screen height
const NET_HALF = 0.008; // half the net's thickness, x screen height
const WALL_BOUNCE = 0.9, NET_BOUNCE = 0.5; // share of the speed into a wall / the net that comes back
const PAD_BOUNCE = 0.75; // the same for a paddle (relative to the paddle)
const GRIP = 0.3; // share of the paddle's sideways motion (relative to the ball) passed to the ball
const POP = 0.45; // after a hit the ball leaves the paddle at least this fast (x screen height per s)
const PUNCH = 0.5; // share of the paddle's own speed that goes into a hit
const HIT_COOLDOWN_S = 0.25; // a paddle can't hit the ball again this soon (contact just pushes it clear)
const PAD_LEN = [0.14, 0.5]; // paddle length limits, x screen height
const SEEN = 0.5; // landmark visibility that counts a head or shoulder as in view
const WRIST_IN = 0.6, WRIST_OUT = 0.3; // a wrist comes into view above WRIST_IN and leaves below WRIST_OUT,
// so a visibility hovering around one value doesn't flip the paddle between its shapes
const WRIST_HOLD_S = 0.2; // a wrist that drops out stays where it was last seen this long
const GRACE_S = 0.5; // keep a player this long after they drop out of tracking (tracking blinks)
const PREDICT_S = 0.04; // extrapolate a paddle towards "now" by at most this much
const JUMP = 0.25; // a body this far (x screen width) from everyone tracked is someone new
const SERVE_S = 1.5; // pause after a point

// MediaPipe pose landmarks
const NOSE = 0, L_SHOULDER = 11, R_SHOULDER = 12, L_WRIST = 15, R_WRIST = 16;
const BONES = [[11, 12], [11, 13], [13, 15], [12, 14], [14, 16], [11, 23], [12, 24], [23, 24], [23, 25], [25, 27],
  [24, 26], [26, 28]];
const TEAMS = [{ name: "green", color: [70, 220, 120] }, { name: "orange", color: [255, 150, 50] }];

const closest = (p, a, b) => {
  const ab = sub(b, a);
  return add(a, mul(ab, clamp(dot(sub(p, a), ab) / Math.max(dot(ab, ab), 1e-6), 0, 1)));
};

class Athlete {
  constructor() {
    this.filter = new OneEuro(0.7, 0.01, 3.0); // steadier than Finger Pong's: body landmarks are noisier
    this.wrists = [null, null]; // last position each wrist was seen at, in screen px
    this.wristAt = [-1e9, -1e9]; // and when
    this.wristIn = [false, false];
    this.ends = null; // paddle ends in screen px, smoothed
    this.vel = [0, 0]; // paddle velocity, px/s
    this.t = null; // capture time of the last frame used
    this.seen = -1e9;
    this.at = null; // head (or shoulders), to recognise the same body next frame
    this.how = "hands"; // what the paddle comes from: "hands", "hand" or "head"
    this.team = 0;
    this.lastHit = -1e9;
  }
}

export class Volleyball {
  static turns = false; // gravity points down the screen, whatever its shape

  constructor(app) {
    this.app = app;
    const W = (this.W = app.W), H = (this.H = app.H);
    this.r = BALL_R * H;
    this.g = GRAVITY * H;
    this.thick = Math.max(6, Math.round(H * 0.014));
    this.floorY = H - 6;
    this.netX = W / 2;
    this.netTop = this.floorY - NET_H * H;
    this.athletes = [];
    this.frameN = -1;
    this.newMatch(app.now);
  }

  newMatch(now) {
    this.score = [0, 0];
    this.winner = null;
    this.winnerAt = 0;
    this.ball = null;
    this.vel = null;
    this.trail = [];
    this.serveTo = Math.random() < 0.5 ? 0 : 1;
    this.serveAt = now + 2.0;
    this.prevPads = new Map();
    this.flash = null;
  }

  // a body's head (or shoulders), or null if neither is in view
  head(pts) {
    const ok = (i) => pts[i][2] >= SEEN;
    if (ok(NOSE)) return pts[NOSE].slice(0, 2);
    return ok(L_SHOULDER) && ok(R_SHOULDER) ? mul(add(pts[L_SHOULDER], pts[R_SHOULDER]), 0.5) : null;
  }

  // a player's paddle from their head and the wrists in view (or held from a moment ago)
  reach(ath, pts, head, t) {
    const H = this.H;
    [L_WRIST, R_WRIST].forEach((w, i) => {
      ath.wristIn[i] = pts[w][2] >= (ath.wristIn[i] ? WRIST_OUT : WRIST_IN);
      if (ath.wristIn[i]) [ath.wrists[i], ath.wristAt[i]] = [pts[w].slice(0, 2), t];
    });
    const wrists = ath.wrists.filter((p, i) => p && t - ath.wristAt[i] <= WRIST_HOLD_S);
    let a, b, how;
    if (wrists.length === 2) {
      [a, b, how] = [wrists[0], wrists[1], "hands"];
    } else if (wrists.length === 1) {
      [a, b, how] = [wrists[0], [2 * head[0] - wrists[0][0], wrists[0][1]], "hand"];
    } else {
      const y = head[1] - 0.08 * H;
      [a, b, how] = [[head[0] - 1, y], [head[0] + 1, y], "head"];
    }
    const mid = mul(add(a, b), 0.5), L = norm(sub(b, a));
    const d = L > 1e-6 ? mul(sub(b, a), 1 / L) : [1, 0];
    const half = clamp(L, PAD_LEN[0] * H, PAD_LEN[1] * H) / 2;
    return { ends: [sub(mid, mul(d, half)), add(mid, mul(d, half))], how };
  }

  // bodies -> players with paddles, following each body from frame to frame
  track() {
    const frame = this.app.frame;
    if (!frame || frame.n === this.frameN) return;
    this.frameN = frame.n;
    const bodies = frame.found.map((lm) => {
      const pts = lm.map((q) => [...this.app.toCourt(q), q[2]]);
      return { pts, at: this.head(pts) };
    }).filter((b) => b.at);
    const pairs = []; // nearest first
    bodies.forEach((b, i) => this.athletes.forEach((a, j) => pairs.push([norm(sub(b.at, a.at)), i, j])));
    pairs.sort((x, y) => x[0] - y[0]);
    const matched = new Map(), taken = new Set();
    for (const [d, i, j] of pairs) {
      if (d > JUMP * this.W || matched.has(i) || taken.has(j)) continue;
      matched.set(i, this.athletes[j]);
      taken.add(j);
    }
    bodies.forEach((b, i) => {
      let ath = matched.get(i);
      if (!ath) this.athletes.push((ath = new Athlete()));
      const pad = this.reach(ath, b.pts, b.at, frame.t);
      let [p, q] = pad.ends;
      const e = ath.ends; // keep each end with the end it was last frame, so crossed arms don't swap them
      if (e && norm(sub(p, e[0])) + norm(sub(q, e[1])) > norm(sub(p, e[1])) + norm(sub(q, e[0]))) [p, q] = [q, p];
      const x = ath.filter.filter([...p, ...q], ath.t !== null ? frame.t - ath.t : 0);
      const v = ath.filter.dx;
      ath.ends = [[x[0], x[1]], [x[2], x[3]]];
      ath.vel = [(v[0] + v[2]) / 2, (v[1] + v[3]) / 2];
      ath.t = ath.seen = frame.t;
      Object.assign(ath, { at: b.at, how: pad.how, team: b.at[0] < this.netX ? 0 : 1 });
    });
    this.athletes = this.athletes.filter((a) => frame.t - a.seen <= GRACE_S);
  }

  paddle(ath) {
    const lead = clamp(this.app.now - ath.t, 0, PREDICT_S);
    return [add(ath.ends[0], mul(ath.vel, lead)), add(ath.ends[1], mul(ath.vel, lead)), ath.vel];
  }

  serve() {
    this.ball = [this.W * (this.serveTo === 0 ? 0.25 : 0.75), this.H * 0.12];
    this.vel = [0, -0.2 * this.H];
    this.trail = [];
    this.app.sound.play("valve");
    this.app.fx.ring(this.ball, [255, 255, 230], this.r * 1.5, { n: 18, speed: 120 });
  }

  wallFx(at) {
    this.app.sound.play("wall", 0.6);
    this.app.fx.burst(at, [200, 200, 200], { n: 6, speed: 120, life: 0.25, size: 2.5 });
  }

  // make the ball leave the paddle along its normal at least POP fast, and no faster than MAX_SPEED
  separate(n, u) {
    const away = dot(sub(this.vel, u), n), need = POP * this.H;
    if (away < need) this.vel = add(this.vel, mul(n, need - away));
    const speed = norm(this.vel), top = MAX_SPEED * this.H;
    if (speed > top) this.vel = mul(this.vel, top / speed);
  }

  bounce(ath, n, u, now) {
    u = mul(u, PUNCH);
    if (now - ath.lastHit < HIT_COOLDOWN_S) return this.separate(n, u);
    const rel = sub(this.vel, u), vn = dot(rel, n);
    if (vn >= 0) return this.separate(n, u); // already moving away: not a hit, just clear of the paddle
    const tangent = sub(rel, mul(n, vn));
    this.vel = sub(sub(this.vel, mul(n, (1 + PAD_BOUNCE) * vn)), mul(tangent, GRIP));
    this.separate(n, u);
    ath.lastHit = now;
    this.flash = [ath, now];
    this.app.stats.acc.hits++;
    const color = TEAMS[ath.team].color, hard = Math.min(1, norm(this.vel) / (MAX_SPEED * this.H * 0.6));
    this.app.sound.play("hit", 0.5 + 0.5 * hard);
    this.app.fx.burst(sub(this.ball, mul(n, this.r)), color, {
      n: Math.round(14 + 30 * hard), speed: 150 + 400 * hard, life: 0.45, size: 4, spread: 2.2,
      direction: Math.atan2(n[1], n[0]), colors: [color, [255, 255, 255]],
    });
  }

  touch(ath, pad, now) {
    const [a, b, u] = pad, reach = this.r + this.thick;
    const cp = closest(this.ball, a, b), d = sub(this.ball, cp), dist = norm(d);
    if (dist >= reach || dist < 1e-6) return false;
    const n = mul(d, 1 / dist);
    if (dot(sub(this.vel, u), n) >= 0) return false; // already moving away from the paddle
    this.ball = add(cp, mul(n, reach + 1));
    this.bounce(ath, n, u, now);
    return true;
  }

  net() {
    const reach = this.r + NET_HALF * this.H;
    const cp = closest(this.ball, [this.netX, this.netTop], [this.netX, this.floorY]);
    const d = sub(this.ball, cp), dist = norm(d);
    if (dist >= reach) return;
    const n = dist > 1e-6 ? mul(d, 1 / dist) : [this.vel[0] > 0 ? -1 : 1, 0];
    this.ball = add(cp, mul(n, reach));
    const vn = dot(this.vel, n);
    if (vn < 0) {
      this.vel = sub(this.vel, mul(n, (1 + NET_BOUNCE) * vn));
      this.wallFx(cp);
    }
  }

  point(now) {
    const loser = this.ball[0] < this.netX ? 0 : 1, winner = 1 - loser, wc = TEAMS[winner].color;
    this.score[winner] += 1;
    this.app.fx.burst([this.ball[0], this.floorY], wc, {
      n: 60, speed: 500, life: 0.8, size: 5, direction: -Math.PI / 2, spread: 2.0, colors: [wc, [255, 255, 255]],
    });
    this.app.sound.play("score");
    this.ball = null;
    this.serveTo = winner; // the side that won the rally serves
    this.serveAt = now + SERVE_S;
    if (this.score[winner] >= WIN_SCORE) {
      this.winner = winner;
      this.winnerAt = now;
      this.app.sound.play("win");
      this.app.fx.confetti({ left: 0, top: 0, width: this.W, height: this.H }, false);
    }
  }

  update(dt, now) {
    this.track();
    const pads = new Map(this.athletes.map((a) => [a, this.paddle(a)]));
    if (this.winner !== null) {
      if (now - this.winnerAt > 6) this.newMatch(now);
      return;
    }
    if (this.ball === null) {
      if (!this.athletes.length) this.serveAt = Math.max(this.serveAt, now + 1.0); // serve once someone's in
      if (now >= this.serveAt) this.serve();
      this.prevPads = pads;
      return;
    }
    const prev = this.ball.slice(), W = this.W;
    const steps = Math.max(1, Math.ceil((norm(this.vel) + this.g * dt) * dt / (this.r * 0.5)));
    const h = dt / steps;
    for (let s = 0; s < steps; s++) {
      this.vel[1] += this.g * h;
      this.ball = add(this.ball, mul(this.vel, h));
      if ((this.ball[0] < this.r && this.vel[0] < 0) || (this.ball[0] > W - this.r && this.vel[0] > 0)) {
        this.ball[0] = clamp(this.ball[0], this.r, W - this.r);
        this.vel[0] = -this.vel[0] * WALL_BOUNCE;
        this.wallFx(this.ball);
      }
      this.net();
      for (const [ath, pad] of pads) if (this.touch(ath, pad, now)) break;
      if (this.ball[1] > this.floorY - this.r) return this.point(now);
    }
    // fast swings: a paddle may have jumped across the ball between camera frames
    const side = (p, [a, b]) => dot(sub(p, a), perp(mul(sub(b, a), 1 / Math.max(norm(sub(b, a)), 1e-6))));
    for (const [ath, pad] of pads) {
      const old = this.prevPads.get(ath);
      if (!old) continue;
      const s0 = side(prev, old), s1 = side(this.ball, pad);
      const [a, b, u] = pad, ab = sub(b, a), L = Math.max(norm(ab), 1e-6), along = dot(sub(this.ball, a), ab) / L;
      if (s0 * s1 < 0 && along >= -this.r && along <= L + this.r) {
        const n = mul(perp(mul(ab, 1 / L)), Math.sign(s0));
        this.ball = add(closest(this.ball, a, b), mul(n, this.r + this.thick + 1));
        this.bounce(ath, n, u, now);
      }
    }
    this.prevPads = pads;
    this.trail.push(this.ball.slice());
    if (this.trail.length > 12) this.trail.shift();
  }

  draw(c, now) {
    const W = this.W, H = this.H, big = H * 0.11, small = H * 0.05;
    c.lineCap = "butt";
    TEAMS.forEach((t, i) => { // each side's floor in its colour
      c.strokeStyle = rgb(t.color);
      c.lineWidth = 8;
      c.beginPath();
      c.moveTo(i ? this.netX : 0, this.floorY);
      c.lineTo(i ? W : this.netX, this.floorY);
      c.stroke();
    });
    c.lineCap = "round";
    for (const [col, w] of [["black", NET_HALF * H * 2 + 6], ["rgb(240,240,240)", NET_HALF * H * 2]]) {
      c.strokeStyle = col;
      c.lineWidth = w;
      c.beginPath();
      c.moveTo(this.netX, this.netTop);
      c.lineTo(this.netX, this.floorY);
      c.stroke();
    }
    TEAMS.forEach((t, i) => drawText(c, big, String(this.score[i]), [this.netX + (i ? 1 : -1) * W * 0.08, H * 0.1], t.color));

    const frame = this.app.frame;
    if (frame && this.app.debug) {
      c.strokeStyle = "white";
      c.lineWidth = 2;
      for (const body of frame.found) {
        const pts = body.map((q) => this.app.toCourt(q));
        c.beginPath();
        for (const [a, b] of BONES) {
          c.moveTo(...pts[a]);
          c.lineTo(...pts[b]);
        }
        c.stroke();
      }
    }

    for (const ath of this.athletes) {
      const [a, b] = this.paddle(ath);
      const lit = this.flash && this.flash[0] === ath && now - this.flash[1] < 0.15;
      const alpha = ath.how === "hands" ? 1 : 0.6; // fainter when it's a guess from one hand or the head
      for (const [col, w] of [["rgba(0,0,0,0.8)", this.thick * 2 + 6], [lit ? "white" : rgb(TEAMS[ath.team].color, alpha), this.thick * 2]]) {
        c.strokeStyle = col;
        c.lineWidth = w;
        c.beginPath();
        c.moveTo(...a);
        c.lineTo(...b);
        c.stroke();
      }
    }

    if (this.ball) {
      const [x, y] = this.ball, r = this.r;
      const lift = clamp((this.floorY - y) / H, 0, 1.5); // shadow on the floor, smaller the higher the ball
      c.fillStyle = `rgba(0,0,0,${0.45 - 0.2 * lift})`;
      c.beginPath();
      c.ellipse(x, this.floorY - 2, r * (1.2 - 0.5 * lift), r * 0.3, 0, 0, 2 * Math.PI);
      c.fill();
      if (y < -r) { // above the screen: an arrow on the top edge, smaller the higher it is
        const s = r * clamp(1 - -y / (1.5 * H), 0.35, 1), ax = clamp(x, s + 4, W - s - 4);
        c.fillStyle = "rgb(255,255,230)";
        c.strokeStyle = "black";
        c.lineWidth = 3;
        c.beginPath();
        c.moveTo(ax, 4);
        c.lineTo(ax - s, 4 + 1.6 * s);
        c.lineTo(ax + s, 4 + 1.6 * s);
        c.closePath();
        c.stroke();
        c.fill();
      } else {
        const n = this.trail.length;
        this.trail.forEach((q, j) => {
          const k = (j + 1) / n;
          c.fillStyle = `rgb(${120 + 135 * k},${120 + 135 * k},${100 + 130 * k})`;
          c.beginPath();
          c.arc(q[0], q[1], r * (0.25 + 0.6 * k), 0, 2 * Math.PI);
          c.fill();
        });
        c.fillStyle = "black";
        c.beginPath();
        c.arc(x, y, r + 3, 0, 2 * Math.PI);
        c.fill();
        c.fillStyle = "rgb(255,255,230)";
        c.beginPath();
        c.arc(x, y, r, 0, 2 * Math.PI);
        c.fill();
      }
    } else if (this.winner === null) {
      const msg = this.athletes.length ? `serve in ${Math.round(Math.max(0, this.serveAt - now))}` : "step in front of the camera";
      drawText(c, small, msg, [W / 2, H * 0.4], [255, 255, 255]);
    }
    if (this.winner !== null) {
      const w = TEAMS[this.winner];
      drawText(c, big, `${w.name} wins!`, [W / 2, H * 0.4], w.color);
    }
  }
}
