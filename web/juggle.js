// One-player full-body Juggling (Juggle) and Colour Juggle (ColorJuggle): side-view gravity,
// bouncy walls and MediaPipe pose tracking like Volleyball (volley.js), with platforms in four
// distinct colours on both hands and both feet. Each hand aims bounces towards the other hand (and
// each foot towards the opposite / furthest hand), while moving sideways shifts that angle left or
// right and snaps back as soon as you stop.
import { add, sub, mul, dot, norm, perp, clamp, rgb, alpha, OneEuro, drawText } from "./common.js";
import { palmPoints, matchPalms, PalmFix } from "./palms.js";

const GRAVITY = 1.25; // x screen height per s²
const BALL_R = 0.038; // x screen height
const MAX_SPEED = 1.45; // after a hit, x screen height per s
const HAND_RISE = 0.24; // arc apex height above the higher hand on a calm hand-to-hand bounce (x screen height)
const FOOT_RISE = 0.18; // arc apex height above the target hand on a foot save (x screen height)
const SCOOP_GAIN = 0.38; // share of upward hand/foot speed converted into extra launch speed
const FLOOR_BOUNCE = 0.8; // first floor hit bounces back up; a second floor hit before a touch drops the ball
const FLOOR_POP = 0.95; // minimum upward speed on the one allowed ground bounce so hands can reach it
const MIN_ARC_UP = 0.48; // minimum upward speed even on a steep sideways deflection
const WALL_BOUNCE = 0.9; // share of speed into a side wall that comes back
const PAD_W = 0.18; // platform width, x screen height
const MAX_BASE_TILT = 0.40; // max inward base tilt towards the target hand (~23°)
const MAX_MOVE_TILT = 0.48; // max extra tilt left/right from sideways movement (~27.5°)
const MAX_TOTAL_TILT = 0.78; // overall visual platform tilt cap (~45°)
const TILT_DEAD = 0.06; // sideways deadband (x screen height per s) before movement shifts the angle
const TILT_SPAN = 0.34; // sideways speed above TILT_DEAD to reach MAX_MOVE_TILT
const TILT_IN_RATE = 26; // smoothing rate (1/s) when tilting into motion
const TILT_OUT_RATE = 65; // fast snap-back rate (1/s) when a hand or foot stops moving
const INACTIVE_SCALE = 0.2; // off-colour platforms in Colour Juggle shrink to 1/5 length
const SCALE_OMEGA = 26; // natural frequency (rad/s) of the size spring (~0.35 s settle)
const SCALE_ZETA = 0.44; // underdamped ratio for a slight wobbly overshoot (~20%)
const HIT_COOLDOWN_S = 0.2; // a platform can't re-hit the same ball this soon
const MAX_BALLS = 6;
const SEEN = 0.5; // landmark visibility that counts a head, shoulder, hip, elbow or knee as in view
const HAND_IN = 0.55, HAND_OUT = 0.28; // hysteresis on wrist visibility
const FOOT_IN = 0.65, FOOT_OUT = 0.4; // stricter for ankles so cut-off legs at the bottom edge don't ghost in
const HOLD_S = 0.25; // hold a dropped hand where it was last seen this long
const EXTEND = 0.85; // wrist lost, elbow + shoulder seen: extend straight past the elbow
const GRACE_S = 0.5; // keep the player through short tracking dropouts
const PREDICT_S = 0.035; // extrapolate a platform towards "now" by at most this much
const JUMP = 0.3; // a limb jumping further than this (x screen width) restarts its smoothing
const SERVE_S = 1.5; // countdown before the first ball
const OVER_S = 2.8; // pause after game over before starting a new round

// MediaPipe pose landmarks
const NOSE = 0;
const L_SHOULDER = 11, R_SHOULDER = 12, L_ELBOW = 13, R_ELBOW = 14, L_WRIST = 15, R_WRIST = 16;
const L_PINKY = 17, R_PINKY = 18, L_INDEX = 19, R_INDEX = 20;
const L_HIP = 23, R_HIP = 24, L_KNEE = 25, R_KNEE = 26, L_ANKLE = 27, R_ANKLE = 28;
const L_HEEL = 29, R_HEEL = 30, L_TOE = 31, R_TOE = 32;

// [root, mid, end, tipA, tipB, isFoot]
const LIMBS = [
  [L_SHOULDER, L_ELBOW, L_WRIST, L_INDEX, L_PINKY, false],
  [R_SHOULDER, R_ELBOW, R_WRIST, R_INDEX, R_PINKY, false],
  [L_HIP, L_KNEE, L_ANKLE, L_TOE, L_HEEL, true],
  [R_HIP, R_KNEE, R_ANKLE, R_TOE, R_HEEL, true],
];
// Four distinct limb colours: left hand green, right hand orange, left foot sky blue, right foot pink
export const LIMB_COLORS = [
  [70, 220, 120],
  [255, 150, 50],
  [70, 195, 255],
  [245, 95, 220],
];
const BONES = [
  [11, 12], [11, 13], [13, 15], [12, 14], [14, 16],
  [11, 23], [12, 24], [23, 24],
  [23, 25], [25, 27], [27, 29], [27, 31], [29, 31],
  [24, 26], [26, 28], [28, 30], [28, 32], [30, 32],
];
const BALL_COLORS = [
  [255, 255, 230],
  [255, 215, 60],
  [255, 95, 95],
  [185, 145, 255],
  [135, 250, 195],
  [255, 190, 125],
];
const GOLD = [255, 210, 60];
const SKY = [70, 195, 255];

const bestScores = { juggle: 0, color: 0 }; // kept across rounds and fullscreen resizes

const closest = (p, a, b) => {
  const ab = sub(b, a);
  return add(a, mul(ab, clamp(dot(sub(p, a), ab) / Math.max(dot(ab, ab), 1e-6), 0, 1)));
};

const rotate = ([x, y], ang) => {
  const c = Math.cos(ang), s = Math.sin(ang);
  return [x * c - y * s, x * s + y * c];
};

class LimbPad {
  constructor(foot) {
    this.foot = foot;
    this.reset();
  }
  reset() {
    this.filter = new OneEuro(1.6, 0.03, 3.0); // higher cutoff + beta so platform motion tracks tightly
    this.raw = null;
    this.prevRaw = null;
    this.rawAt = -1e9;
    this.inView = false;
    this.direct = false;
    this.pos = null; // smoothed [x, y] in screen px
    this.vel = [0, 0]; // px/s from raw landmark motion so stopping registers immediately
    this.baseTilt = 0; // inward tilt towards the target hand
    this.moveTilt = 0; // offset left/right from sideways movement
    this.tilt = 0; // total visual platform tilt (radians)
    this.scale = null; // platform size multiplier (1 = full, 0.2 = shrunk in Colour Juggle)
    this.scaleVel = 0;
    this.t = null;
    this.seen = -1e9;
    this.flashAt = -1e9;
    this.palm = new PalmFix(); // keeps hand-landmarker palms and the pose estimate in one place
  }
}

export class Juggle {
  static turns = false; // gravity points down the screen, whatever its shape

  constructor(app) {
    this.app = app;
    const W = (this.W = app.W), H = (this.H = app.H);
    this.r = BALL_R * H;
    this.g = GRAVITY * H;
    this.half = (PAD_W * H) / 2;
    this.thick = Math.max(6, Math.round(H * 0.014));
    this.floorY = H - 6;
    this.limbs = LIMBS.map((l) => new LimbPad(l[5]));
    this.at = null; // player's head/shoulders, to pick the tracked player and aim spawns
    this.playerSeen = -1e9;
    this.frameN = -1;
    this.modeKey = "juggle";
    this.hudColor = GOLD;
    this.newMatch(app.now);
  }

  get ball() { return this.balls[0] || null; } // for CamApp's stats report
  get best() { return bestScores[this.modeKey]; }
  set best(v) { bestScores[this.modeKey] = v; }

  newMatch(now, delay = 2.0) {
    this.score = 0;
    this.roundBest = this.best;
    this.balls = [];
    this.spawned = 0;
    this.nextBallAt = 6;
    this.serveAt = now + delay;
    this.endedAt = null;
    this.overReason = null;
    this.newRecord = false;
    this.banner = null;
    this.prevPads = this.limbs.map(() => null);
  }

  anchor(pts) {
    const ok = (i) => pts[i][2] >= SEEN;
    if (ok(NOSE)) return pts[NOSE].slice(0, 2);
    if (ok(L_SHOULDER) && ok(R_SHOULDER)) return mul(add(pts[L_SHOULDER], pts[R_SHOULDER]), 0.5);
    const w = [L_WRIST, R_WRIST].filter((i) => pts[i][2] >= HAND_OUT);
    return w.length ? mul(w.reduce((s, i) => add(s, pts[i]), [0, 0]), 1 / w.length) : null;
  }

  limbPoint(h, pts, root, mid, end, tipA, tipB, foot) {
    const W = this.W, H = this.H, ok = (j) => pts[j][2] >= SEEN;
    const p = pts[end], m = 10;
    const inBounds = p[0] >= m && p[0] <= W - m && p[1] >= m && p[1] <= H - m;
    // never extrapolate or show foot markers when the feet are outside (or clipped at the edge of) the screen
    if (foot && !inBounds) {
      h.inView = false;
      return { offScreen: true };
    }
    const [visIn, visOut] = foot ? [FOOT_IN, FOOT_OUT] : [HAND_IN, HAND_OUT];
    h.inView = p[2] >= (h.inView ? visOut : visIn);
    if (h.inView) {
      let at = p.slice(0, 2);
      if (pts[tipA][2] >= visOut && pts[tipB][2] >= visOut) {
        const tip = mul(add(pts[tipA], pts[tipB]), 0.5);
        if (norm(sub(tip, at)) <= 0.18 * H) at = mul(add(at, tip), 0.5);
      }
      if (foot && (at[0] < m || at[0] > W - m || at[1] < m || at[1] > H - m)) return { offScreen: true };
      return { at, direct: true };
    }
    if (!foot && ok(mid) && ok(root)) {
      const upper = sub(pts[mid], pts[root]);
      const guess = norm(sub(p, pts[mid])) <= 1.4 * norm(upper) ? p : add(pts[mid], mul(upper, EXTEND));
      return { at: guess.slice(0, 2), direct: false };
    }
    return foot ? { offScreen: true } : null;
  }

  live(i, t = this.app.now) {
    const h = this.limbs[i];
    return !!(h.pos && t - h.seen <= GRACE_S);
  }

  // where limb i aims its base bounce: each hand aims at the other hand; each foot aims at the
  // opposite / furthest-away hand (falling back across the body centre when only one hand is seen)
  aimTarget(i, fromPos, t = this.app.now) {
    const W = this.W, H = this.H;
    const cx = this.at ? this.at[0] : W / 2;
    if (i < 2) {
      const other = 1 - i;
      if (this.live(other, t)) return this.limbs[other].pos;
      return [clamp(2 * cx - fromPos[0], W * 0.15, W * 0.85), fromPos[1]];
    }
    const hands = [0, 1].filter((j) => this.live(j, t)).map((j) => this.limbs[j].pos);
    if (hands.length === 2) {
      const score = (hp) => Math.abs(hp[0] - fromPos[0]) + 0.3 * norm(sub(hp, fromPos));
      return score(hands[0]) >= score(hands[1]) ? hands[0] : hands[1];
    }
    if (hands.length === 1) return hands[0];
    return [clamp(2 * cx - fromPos[0], W * 0.2, W * 0.8), H * 0.58];
  }

  // ballistic launch velocity from `from` that arcs above the higher hand and lands at `target`
  arcVel(from, target, foot, extraRise = 0) {
    const H = this.H, g = this.g;
    const rise = (foot ? FOOT_RISE : HAND_RISE) * H + extraRise;
    const peakY = Math.min(from[1], target[1]) - rise;
    const tUp = Math.sqrt(Math.max(0.02, (2 * (from[1] - peakY)) / g));
    const tDown = Math.sqrt(Math.max(0.02, (2 * (target[1] - peakY)) / g));
    const dx = clamp(target[0] - from[0], -0.8 * this.W, 0.8 * this.W);
    return [dx / (tUp + tDown), -g * tUp];
  }

  track() {
    const frame = this.app.frame;
    if (!frame || frame.n === this.frameN) return;
    this.frameN = frame.n;
    const bodies = frame.found.map((lm) => {
      const pts = lm.map((q) => [...this.app.toCourt(q), q[2]]);
      return { pts, at: this.anchor(pts) };
    }).filter((b) => b.at);

    if (!bodies.length) {
      if (frame.t - this.playerSeen > GRACE_S) {
        this.at = null;
        this.limbs.forEach((h) => h.reset());
      }
      return;
    }
    const target = this.at || [this.W / 2, this.H / 2];
    bodies.sort((a, b) => norm(sub(a.at, target)) - norm(sub(b.at, target)));
    const { pts, at } = bodies[0];
    // hand-landmarker palms (when the game runs it) for the two hands, see palms.js
    const palms = matchPalms([0, 1].map((i) => ({ wrist: pts[LIMBS[i][2]], elbow: pts[LIMBS[i][1]], fix: this.limbs[i].palm })),
      palmPoints(frame.hands, (q) => this.app.toCourt(q)), this.H);
    this.at = at;
    this.playerSeen = frame.t;

    const W = this.W, H = this.H;
    const dts = [0, 0, 0, 0];
    LIMBS.forEach(([root, mid, end, tipA, tipB, foot], i) => {
      const h = this.limbs[i];
      let found = this.limbPoint(h, pts, root, mid, end, tipA, tipB, foot);
      if (!foot) {
        const pose = found && !found.offScreen ? found : null;
        const at = h.palm.apply(pose && pose.at, palms[i], frame.t);
        if (palms[i]) [found, h.inView] = [{ at, direct: true }, true];
        else if (pose) found = { ...pose, at };
      }
      if (found && found.offScreen) {
        h.reset();
        return;
      }
      const prevRaw = h.raw;
      if (found) {
        // keep visible feet just above the floor trigger so low foot saves catch before the floor
        h.raw = foot ? [found.at[0], Math.min(found.at[1], this.floorY - 4)] : found.at;
        h.rawAt = frame.t;
        h.direct = found.direct;
      }
      if (!h.raw || frame.t - h.rawAt > HOLD_S) {
        if (frame.t - h.seen > GRACE_S) h.reset();
        return;
      }
      if (h.pos && norm(sub(h.raw, h.pos)) > JUMP * W) {
        const keep = [h.raw, h.rawAt, h.inView, h.direct];
        h.reset();
        [h.raw, h.rawAt, h.inView, h.direct] = keep;
      }
      const dt = h.t !== null ? frame.t - h.t : 0;
      dts[i] = dt;
      const x = h.filter.filter(h.raw, dt);
      h.pos = [x[0], x[1]];
      if (found && prevRaw && dt > 0) {
        // velocity from raw landmarks (lightly smoothed) so stopping drops to zero on the very next frame
        const av = alpha(14.0, dt);
        h.vel = [
          h.vel[0] + av * ((h.raw[0] - prevRaw[0]) / dt - h.vel[0]),
          h.vel[1] + av * ((h.raw[1] - prevRaw[1]) / dt - h.vel[1]),
        ];
      } else if (!found && dt > 0) {
        h.vel = mul(h.vel, Math.exp(-dt * 25));
      } else {
        h.vel = [0, 0];
      }
      h.t = frame.t;
      if (found) h.seen = frame.t;
    });

    // update base tilt towards the target hand + left/right offset from movement angle and speed
    this.limbs.forEach((h, i) => {
      if (!h.pos || frame.t - h.seen > GRACE_S) return;
      const dt = dts[i];
      const aim = this.arcVel(h.pos, this.aimTarget(i, h.pos, frame.t), h.foot);
      const wantBase = clamp(Math.atan2(aim[0], -aim[1]) * 0.55, -MAX_BASE_TILT, MAX_BASE_TILT);
      const vx = Math.abs(h.vel[0]) / H, vy = Math.abs(h.vel[1]) / H;
      const moveAngleFactor = clamp((Math.atan2(vx, vy) - 0.16) / 0.34, 0, 1);
      const excess = Math.max(0, vx - TILT_DEAD) * moveAngleFactor;
      const wantMove = Math.sign(h.vel[0]) * Math.min(MAX_MOVE_TILT, (excess / TILT_SPAN) * MAX_MOVE_TILT);
      const releasing = Math.abs(wantMove) < Math.abs(h.moveTilt) || wantMove * h.moveTilt < 0;
      const kBase = dt > 0 ? 1 - Math.exp(-dt * TILT_IN_RATE) : 1;
      const kMove = dt > 0 ? 1 - Math.exp(-dt * (releasing ? TILT_OUT_RATE : TILT_IN_RATE)) : 1;
      h.baseTilt += (wantBase - h.baseTilt) * kBase;
      h.moveTilt += (wantMove - h.moveTilt) * kMove;
      if (wantMove === 0 && Math.abs(h.moveTilt) < 0.015) h.moveTilt = 0;
      h.tilt = clamp(h.baseTilt + h.moveTilt, -MAX_TOTAL_TILT, MAX_TOTAL_TILT);
    });
  }

  wantScale(i) {
    return 1;
  }

  stepScales(dt) {
    const steps = Math.max(1, Math.ceil(dt * 240)), hStep = dt / steps;
    const w2 = SCALE_OMEGA * SCALE_OMEGA, damp = 2 * SCALE_ZETA * SCALE_OMEGA;
    this.limbs.forEach((h, i) => {
      if (!this.live(i)) return;
      const target = this.wantScale(i);
      if (h.scale === null) {
        h.scale = target;
        h.scaleVel = 0;
        return;
      }
      for (let s = 0; s < steps; s++) {
        h.scaleVel += (w2 * (target - h.scale) - damp * h.scaleVel) * hStep;
        h.scale += h.scaleVel * hStep;
      }
      if (Math.abs(target - h.scale) < 0.003 && Math.abs(h.scaleVel) < 0.02) {
        h.scale = target;
        h.scaleVel = 0;
      }
    });
  }

  padThick() {
    return this.thick; // the size spring only changes platform length, never thickness
  }

  paddle(i) {
    const h = this.limbs[i];
    if (!this.live(i)) return null;
    const lead = clamp(this.app.now - h.t, 0, PREDICT_S);
    const p = add(h.pos, mul(h.vel, lead));
    if (h.foot) p[1] = Math.min(p[1], this.floorY - 4);
    const d = [Math.cos(h.tilt), Math.sin(h.tilt)];
    const half = this.half * Math.max(0.06, h.scale ?? 1);
    return [sub(p, mul(d, half)), add(p, mul(d, half)), h.vel];
  }

  ready() {
    return this.limbs.some((_, i) => this.live(i));
  }

  spawnBall(now) {
    const px = clamp(this.at ? this.at[0] : this.W / 2, this.W * 0.22, this.W * 0.78);
    const side = this.spawned % 2 === 0 ? -1 : 1;
    const pos = [clamp(px + side * this.W * 0.09, this.r * 2, this.W - this.r * 2), this.H * 0.14];
    const vel = [-side * 0.07 * this.H, -0.08 * this.H];
    const color = BALL_COLORS[this.spawned % BALL_COLORS.length];
    this.spawned++;
    this.balls.push({ pos, vel, color, bounced: false, trail: [], lastHit: this.limbs.map(() => -1e9) });
    this.nextBallAt = this.score + 6 * this.balls.length;
    this.app.sound.play(this.balls.length > 1 ? "score" : "valve");
    this.app.fx.ring(pos, color, this.r * 1.6, { n: 20, speed: 130 });
    if (this.balls.length > 1) this.banner = [`${this.balls.length} balls!`, color, now];
  }

  wallFx(at) {
    this.app.sound.play("wall", 0.6);
    this.app.fx.burst(at, [200, 200, 200], { n: 6, speed: 120, life: 0.25, size: 2.5 });
  }

  clampVel(ball) {
    if (ball.vel[1] > -MIN_ARC_UP * this.H) ball.vel[1] = -MIN_ARC_UP * this.H;
    const speed = norm(ball.vel), top = MAX_SPEED * this.H;
    if (speed > top) ball.vel = mul(ball.vel, top / speed);
  }

  onValidHit(ball, i, now) {
    if (this.score >= this.nextBallAt && this.balls.length < MAX_BALLS) this.spawnBall(now);
  }

  bounce(ball, i, pad, n, now) {
    const [a, b, u] = pad, h = this.limbs[i];
    const effU = [u[0] * SCOOP_GAIN, Math.min(0, u[1]) * SCOOP_GAIN];
    if (now - ball.lastHit[i] < HIT_COOLDOWN_S) {
      ball.bounced = false;
      const away = dot(sub(ball.vel, effU), n), minPop = 0.55 * this.H;
      if (away < minPop) ball.vel = add(ball.vel, mul(n, minPop - away));
      return this.clampVel(ball);
    }
    if (dot(sub(ball.vel, effU), n) >= 0) return;
    if (ball.targetLimb !== undefined && i !== ball.targetLimb) {
      return this.wrongLimb(ball, i, now);
    }

    ball.bounced = false; // touching a valid hand or foot refreshes the ball's one allowed ground bounce
    const scoopUp = Math.max(0, -u[1]) * SCOOP_GAIN;
    const extraRise = clamp((scoopUp * scoopUp) / (2 * this.g) + scoopUp * 0.12, 0, 0.34 * this.H);
    const base = this.arcVel(ball.pos, this.aimTarget(i, ball.pos, now), h.foot, extraRise);
    const mid = mul(add(a, b), 0.5), along = sub(b, a), halfLen = Math.max(norm(along) / 2, 1);
    const edgeOffset = clamp(dot(sub(ball.pos, mid), along) / Math.max(norm(along) * halfLen, 1e-6), -1, 1);
    ball.vel = rotate(base, h.moveTilt * 1.35 + edgeOffset * 0.12);
    this.clampVel(ball);

    ball.lastHit[i] = now;
    h.flashAt = now;
    this.score++;
    if (this.score > this.best) this.best = this.score;
    this.app.stats.acc.hits++;
    const hitColor = ball.color;
    this.onValidHit(ball, i, now);
    const hard = Math.min(1, norm(ball.vel) / (MAX_SPEED * this.H * 0.65));
    this.app.sound.play("hit", 0.5 + 0.5 * hard);
    this.app.fx.burst(sub(ball.pos, mul(n, this.r)), hitColor, {
      n: Math.round(14 + 26 * hard), speed: 150 + 380 * hard, life: 0.45, size: 4, spread: 2.2,
      direction: Math.atan2(n[1], n[0]), colors: [hitColor, ball.color, [255, 255, 255]],
    });
  }

  touch(ball, i, pad, now) {
    const [a, b, u] = pad, reach = this.r + this.padThick(i);
    const cp = closest(ball.pos, a, b), d = sub(ball.pos, cp), dist = norm(d);
    if (dist >= reach || dist < 1e-6) return false;
    const n = mul(d, 1 / dist);
    // upward and angled bounces only; rising balls pass freely through upper limbs from below
    if (n[1] > 0.2) return false;
    const effU = [u[0] * SCOOP_GAIN, Math.min(0, u[1]) * SCOOP_GAIN];
    if (dot(sub(ball.vel, effU), n) >= 0) return false;
    ball.pos = add(cp, mul(n, reach + 1));
    this.bounce(ball, i, pad, n, now);
    return true;
  }

  endRound(now, reason = null) {
    this.endedAt = now;
    this.overReason = reason;
    this.newRecord = this.score > 0 && this.score > this.roundBest;
    if (this.newRecord) {
      this.app.sound.play("win");
      this.app.fx.confetti({ left: 0, top: 0, width: this.W, height: this.H }, false);
    } else {
      this.app.sound.play(reason ? "over" : "score");
    }
  }

  drop(idx, now) {
    const [ball] = this.balls.splice(idx, 1);
    this.app.fx.burst([ball.pos[0], this.floorY], ball.color, {
      n: this.balls.length ? 35 : 65, speed: 460, life: 0.75, size: 5,
      direction: -Math.PI / 2, spread: 2.0, colors: [ball.color, [255, 255, 255]],
    });
    if (this.balls.length) {
      this.app.sound.play("wall", 0.9);
      return;
    }
    this.endRound(now);
  }

  afterGameOver(now) {
    this.newMatch(now);
  }

  update(dt, now) {
    this.track();
    this.stepScales(dt);
    const pads = this.limbs.map((_, i) => this.paddle(i));
    if (this.endedAt !== null) {
      if (now - this.endedAt > (this.newRecord ? 4.0 : OVER_S)) this.afterGameOver(now);
      this.prevPads = pads;
      return;
    }
    if (!this.balls.length) {
      if (!this.ready()) this.serveAt = Math.max(this.serveAt, now + SERVE_S);
      if (now >= this.serveAt) this.spawnBall(now);
      this.prevPads = pads;
      return;
    }

    const W = this.W, nLimbs = pads.length;
    const side = (p, [a, b]) => dot(sub(p, a), perp(mul(sub(b, a), 1 / Math.max(norm(sub(b, a)), 1e-6))));
    for (const ball of this.balls.slice()) {
      const prev = ball.pos.slice();
      const steps = Math.max(1, Math.ceil((norm(ball.vel) + this.g * dt) * dt / (this.r * 0.5)));
      const h = dt / steps;
      let gone = false;
      for (let s = 0; s < steps; s++) {
        ball.vel[1] += this.g * h;
        ball.pos = add(ball.pos, mul(ball.vel, h));
        if ((ball.pos[0] < this.r && ball.vel[0] < 0) || (ball.pos[0] > W - this.r && ball.vel[0] > 0)) {
          ball.pos[0] = clamp(ball.pos[0], this.r, W - this.r);
          ball.vel[0] = -ball.vel[0] * WALL_BOUNCE;
          this.wallFx(ball.pos);
        }
        for (let i = 0; i < nLimbs; i++) if (pads[i] && this.touch(ball, i, pads[i], now)) break;
        if (!this.balls.includes(ball)) {
          gone = true;
          break;
        }
        if (ball.pos[1] > this.floorY - this.r && ball.vel[1] > 0) {
          if (!ball.bounced) {
            ball.bounced = true;
            ball.pos[1] = this.floorY - this.r;
            ball.vel[1] = -Math.max(ball.vel[1] * FLOOR_BOUNCE, FLOOR_POP * this.H);
            this.app.sound.play("wall", 0.8);
            this.app.fx.burst([ball.pos[0], this.floorY], ball.color, {
              n: 16, speed: 220, life: 0.35, size: 3.5, direction: -Math.PI / 2, spread: 1.8,
            });
          } else {
            const idx = this.balls.indexOf(ball);
            if (idx >= 0) this.drop(idx, now);
            gone = true;
            break;
          }
        }
      }
      if (gone) continue;

      // fast scoops or kicks crossing a ball between camera frames
      for (let i = 0; i < nLimbs; i++) {
        const pad = pads[i], old = this.prevPads[i];
        if (!pad || !old) continue;
        const s0 = side(prev, old), s1 = side(ball.pos, pad);
        const [a, b] = pad, ab = sub(b, a), L = Math.max(norm(ab), 1e-6), along = dot(sub(ball.pos, a), ab) / L;
        if (s0 * s1 < 0 && along >= -this.r && along <= L + this.r) {
          const n = mul(perp(mul(ab, 1 / L)), Math.sign(s0));
          if (n[1] <= 0.2) {
            ball.pos = add(closest(ball.pos, a, b), mul(n, this.r + this.padThick(i) + 1));
            this.bounce(ball, i, pad, n, now);
            if (!this.balls.includes(ball)) break;
          }
        }
      }
      if (!this.balls.includes(ball)) continue;

      ball.trail.push(ball.pos.slice());
      if (ball.trail.length > 12) ball.trail.shift();
    }
    this.prevPads = pads;
  }

  draw(c, now) {
    const W = this.W, H = this.H, big = H * 0.11, small = H * 0.05;
    c.lineCap = "butt";
    c.strokeStyle = rgb(this.hudColor);
    c.lineWidth = 8;
    c.beginPath();
    c.moveTo(0, this.floorY);
    c.lineTo(W, this.floorY);
    c.stroke();

    drawText(c, big, String(this.score), [W / 2, H * 0.09], this.hudColor);
    if (this.best > 0) drawText(c, H * 0.038, `best ${this.best}`, [W - Math.max(90, W * 0.1), H * 0.07], [225, 225, 225]);
    if (this.banner && now - this.banner[2] < 1.2) {
      drawText(c, small, this.banner[0], [W / 2, H * 0.2], this.banner[1]);
    }

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

    c.lineCap = "round";
    for (let i = 0; i < this.limbs.length; i++) {
      const pad = this.paddle(i);
      if (!pad) continue;
      const [a, b] = pad, h = this.limbs[i], thick = this.padThick(i);
      const lit = now - h.flashAt < 0.15;
      const alpha = h.direct ? 1 : 0.6;
      for (const [col, w] of [["rgba(0,0,0,0.8)", thick * 2 + 6], [lit ? "white" : rgb(LIMB_COLORS[i], alpha), thick * 2]]) {
        c.strokeStyle = col;
        c.lineWidth = w;
        c.beginPath();
        c.moveTo(...a);
        c.lineTo(...b);
        c.stroke();
      }
    }

    for (const ball of this.balls) {
      const [x, y] = ball.pos, r = this.r, col = ball.color;
      const lift = clamp((this.floorY - y) / H, 0, 1.5);
      c.fillStyle = `rgba(0,0,0,${0.45 - 0.2 * lift})`;
      c.beginPath();
      c.ellipse(x, this.floorY - 2, r * (1.2 - 0.5 * lift), r * 0.3, 0, 0, 2 * Math.PI);
      c.fill();
      if (y < -r) { // above the screen: an arrow on the top edge in this ball's colour
        const s = r * clamp(1 - -y / (1.5 * H), 0.35, 1), ax = clamp(x, s + 4, W - s - 4);
        c.fillStyle = rgb(col);
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
        const n = ball.trail.length;
        ball.trail.forEach((q, j) => {
          const k = (j + 1) / n;
          c.fillStyle = rgb(col, 0.18 + 0.45 * k);
          c.beginPath();
          c.arc(q[0], q[1], r * (0.25 + 0.6 * k), 0, 2 * Math.PI);
          c.fill();
        });
        c.fillStyle = "black";
        c.beginPath();
        c.arc(x, y, r + 3, 0, 2 * Math.PI);
        c.fill();
        c.fillStyle = rgb(col);
        c.beginPath();
        c.arc(x, y, r, 0, 2 * Math.PI);
        c.fill();
        if (ball.bounced) { // hollow ring inside a ball that has used its ground bounce
          c.strokeStyle = "rgba(0,0,0,0.65)";
          c.lineWidth = Math.max(2.5, r * 0.14);
          c.beginPath();
          c.arc(x, y, r * 0.5, 0, 2 * Math.PI);
          c.stroke();
        }
      }
    }

    if (!this.balls.length && this.endedAt === null) {
      const msg = this.ready() ? `serve in ${Math.round(Math.max(0, this.serveAt - now))}` : "step in front of the camera";
      drawText(c, small, msg, [W / 2, H * 0.4], [255, 255, 255]);
    }
    if (this.endedAt !== null) {
      if (this.overReason) {
        drawText(c, big * 0.8, "game over!", [W / 2, H * 0.36], [255, 110, 110]);
        const subMsg = this.newRecord ? `${this.overReason} · new best: ${this.score}!` : `${this.overReason} · score: ${this.score}`;
        drawText(c, small * 0.95, subMsg, [W / 2, H * 0.47], this.newRecord ? GOLD : [235, 235, 235]);
      } else {
        const msg = this.newRecord ? `new best: ${this.score}!` : `score: ${this.score}`;
        drawText(c, big * 0.85, msg, [W / 2, H * 0.4], this.newRecord ? GOLD : [255, 255, 255]);
      }
    }
  }
}

// One-ball colour-matching mode: the ball takes the colour of the limb you must bounce it with
// next; touching it with any other limb (or letting it bounce twice on the floor) is game over,
// then a fresh ball drops automatically after a few seconds.
export class ColorJuggle extends Juggle {
  constructor(app) {
    super(app);
    this.modeKey = "color";
    this.hudColor = SKY;
    this.roundBest = this.best;
  }

  newMatch(now, delay = 2.0) {
    super.newMatch(now, delay);
    if (this.modeKey === "color") this.hudColor = SKY;
  }

  wantScale(i) {
    const b = this.balls[0];
    if (!b) return 1;
    return i === b.targetLimb ? 1 : INACTIVE_SCALE;
  }

  pickNextLimb(now, exclude = -1) {
    const active = [0, 1, 2, 3].filter((j) => this.live(j, now));
    const pool = active.length ? active : [0, 1];
    const diff = pool.filter((j) => j !== exclude);
    const choices = diff.length ? diff : pool;
    return choices[Math.floor(Math.random() * choices.length)];
  }

  spawnBall(now) {
    const targetLimb = this.pickNextLimb(now);
    const px = clamp(this.at ? this.at[0] : this.W / 2, this.W * 0.24, this.W * 0.76);
    const side = targetLimb % 2 === 0 ? -1 : 1;
    const pos = [clamp(px + side * this.W * 0.08, this.r * 2, this.W - this.r * 2), this.H * 0.14];
    const vel = [-side * 0.04 * this.H, -0.08 * this.H];
    const color = LIMB_COLORS[targetLimb];
    this.spawned++;
    this.balls = [{ pos, vel, color, targetLimb, bounced: false, trail: [], lastHit: this.limbs.map(() => -1e9) }];
    this.hudColor = color;
    this.app.sound.play("valve");
    this.app.fx.ring(pos, color, this.r * 1.6, { n: 20, speed: 130 });
  }

  onValidHit(ball, i, now) {
    const next = this.pickNextLimb(now, i);
    ball.targetLimb = next;
    ball.color = LIMB_COLORS[next];
    this.hudColor = ball.color;
    this.app.fx.ring(ball.pos, ball.color, this.r * 1.4, { n: 16, speed: 95, life: 0.35 });
  }

  wrongLimb(ball, i, now) {
    this.limbs[i].flashAt = now;
    this.app.fx.burst(ball.pos, LIMB_COLORS[i], {
      n: 55, speed: 440, life: 0.7, size: 5, colors: [LIMB_COLORS[i], ball.color, [255, 90, 90]],
    });
    this.balls = [];
    this.endRound(now, "wrong colour");
  }

  drop(idx, now) {
    const [ball] = this.balls.splice(idx, 1);
    this.app.fx.burst([ball.pos[0], this.floorY], ball.color, {
      n: 60, speed: 460, life: 0.75, size: 5,
      direction: -Math.PI / 2, spread: 2.0, colors: [ball.color, [255, 255, 255]],
    });
    this.endRound(now, "missed");
  }

  afterGameOver(now) {
    this.newMatch(now, 0);
    if (this.ready()) this.spawnBall(now);
  }
}
