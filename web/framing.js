// Framing hints and target-size silhouettes: shows roughly how big a hand (Finger Pong) or a full
// body (Volleyball, Juggling, Colour Juggle) should look on screen when nobody is in view yet or
// when a player stands sustainedly too close or too far from the camera.
import { add, sub, norm, mul, clamp, alpha, rgb, drawText } from "./common.js";

const HOLD_S = 0.45; // out-of-range framing must last this long before nagging
const FADE_S = 0.25; // fade-in / fade-out time for a framing hint

// Finger Pong: palm length (wrist 0 to middle/index knuckle) as a share of court height.
// At ~0.18 the whole open hand spans ~1/3 of the court's height.
const IDEAL_PALM = 0.18;
const HAND_FAR_IN = 0.09, HAND_FAR_OUT = 0.115;
const HAND_CLOSE_IN = 0.36, HAND_CLOSE_OUT = 0.31;

// Full-body games: standing height estimated from shoulders/torso/ankles as a share of screen height.
const IDEAL_BODY = 0.60;
const BODY_FAR_IN = 0.32, BODY_FAR_OUT = 0.37;
const BODY_CLOSE_IN = 0.90, BODY_CLOSE_OUT = 0.80;
const SEEN = 0.5;

// Hysteresis + hold timer for one player or side
class SlotState {
  constructor() {
    this.size = null;
    this.issue = null; // "far" | "close" | "feet" | null
    this.hold = 0;
    this.fade = 0;
    this.x = null;
  }
  measure(dt, rawSize, x = null) {
    const d = Math.max(dt, 1e-3);
    this.size = this.size === null ? rawSize : this.size + alpha(5.0, d) * (rawSize - this.size);
    if (x !== null) this.x = this.x === null ? x : this.x + alpha(6.0, d) * (x - this.x);
    return this.size;
  }
  step(dt, rawIssue) {
    if (rawIssue) {
      this.issue = rawIssue;
      this.hold = Math.min(HOLD_S + 0.1, this.hold + dt);
    } else {
      this.hold = Math.max(0, this.hold - dt * 2);
      if (this.hold === 0) this.issue = null;
    }
    const show = this.hold >= HOLD_S;
    this.fade = clamp(this.fade + (show ? dt : -dt) / FADE_S, 0, 1);
  }
  clear(dt) {
    this.size = null;
    this.step(dt, null);
  }
}

// Closed smooth hand outline in units of palm length `u` (wrist at +0.80u, middle tip at -1.08u,
// thumb spread towards +x; mirrored for the right-hand player so thumbs point inward)
function traceHand(c, u) {
  const p = (x, y) => [x * u, y * u];
  c.beginPath();
  c.moveTo(...p(-0.28, 0.80));
  c.quadraticCurveTo(...p(-0.44, 0.36), ...p(-0.48, -0.12));
  // pinky -> ring -> middle -> index, with rounded tips and valleys
  c.lineTo(...p(-0.55, -0.64));
  c.quadraticCurveTo(...p(-0.47, -0.75), ...p(-0.38, -0.65));
  c.lineTo(...p(-0.31, -0.22));
  c.lineTo(...p(-0.30, -0.90));
  c.quadraticCurveTo(...p(-0.21, -1.02), ...p(-0.12, -0.90));
  c.lineTo(...p(-0.09, -0.26));
  c.lineTo(...p(-0.07, -1.02));
  c.quadraticCurveTo(...p(0.02, -1.14), ...p(0.11, -1.01));
  c.lineTo(...p(0.13, -0.25));
  c.lineTo(...p(0.17, -0.92));
  c.quadraticCurveTo(...p(0.27, -1.03), ...p(0.35, -0.90));
  // thumb-index web out to spread thumb and back down to the wrist
  c.quadraticCurveTo(...p(0.33, -0.26), ...p(0.36, -0.10));
  c.lineTo(...p(0.76, -0.25));
  c.quadraticCurveTo(...p(0.90, -0.22), ...p(0.84, -0.07));
  c.quadraticCurveTo(...p(0.54, 0.16), ...p(0.46, 0.44));
  c.quadraticCurveTo(...p(0.36, 0.68), ...p(0.26, 0.80));
  c.closePath();
}

export function drawHandSilhouette(c, [cx, cy], palmLen, color, mirror = false, angle = 0, opacity = 1) {
  if (opacity <= 0.01) return;
  c.save();
  c.translate(cx, cy);
  if (angle) c.rotate(angle);
  if (mirror) c.scale(-1, 1);
  traceHand(c, palmLen);
  c.fillStyle = rgb(color, 0.13 * opacity);
  c.fill();
  c.lineCap = c.lineJoin = "round";
  c.strokeStyle = `rgba(0,0,0,${0.45 * opacity})`;
  c.lineWidth = 5;
  c.stroke();
  c.setLineDash([8, 7]);
  c.strokeStyle = rgb(color, 0.75 * opacity);
  c.lineWidth = 2.5;
  c.stroke();
  // dashed line between thumb tip and index tip showing where the bouncer sits
  c.beginPath();
  c.moveTo(0.26 * palmLen, -0.94 * palmLen);
  c.lineTo(0.80 * palmLen, -0.15 * palmLen);
  c.setLineDash([5, 5]);
  c.strokeStyle = `rgba(255,255,255,${0.7 * opacity})`;
  c.lineWidth = 3;
  c.stroke();
  c.restore();
}

// Closed symmetric standing figure of height `B` with feet at (0, 0) and crown near (0, -B)
function traceBody(c, B) {
  c.beginPath();
  c.arc(0, -0.915 * B, 0.072 * B, 0, 2 * Math.PI);
  c.closePath();
  const half = [
    [0, -0.81], [0.06, -0.81], [0.15, -0.79], [0.29, -0.54], [0.32, -0.50], [0.26, -0.47],
    [0.13, -0.68], [0.11, -0.50], [0.125, -0.38], [0.115, -0.03], [0.11, 0], [0.045, 0],
    [0.045, -0.03], [0.022, -0.42], [0, -0.44],
  ];
  c.moveTo(0, -0.81 * B);
  for (let i = 1; i < half.length; i++) c.lineTo(half[i][0] * B, half[i][1] * B);
  for (let i = half.length - 2; i >= 0; i--) c.lineTo(-half[i][0] * B, half[i][1] * B);
  c.closePath();
}

export function drawBodySilhouette(c, cx, bottomY, B, { color = [255, 255, 255], opacity = 1, mode = "volley", limbColors = null } = {}) {
  if (opacity <= 0.01) return;
  c.save();
  c.translate(cx, bottomY);
  c.lineCap = c.lineJoin = "round";
  traceBody(c, B);
  c.fillStyle = rgb(color, 0.11 * opacity);
  c.fill();
  c.strokeStyle = `rgba(0,0,0,${0.45 * opacity})`;
  c.lineWidth = 5;
  c.stroke();
  c.setLineDash([9, 7]);
  c.strokeStyle = rgb(color, 0.65 * opacity);
  c.lineWidth = 2.5;
  c.stroke();
  c.setLineDash([]);
  if (mode === "volley") {
    c.setLineDash([6, 6]);
    c.strokeStyle = rgb(color, 0.75 * opacity);
    c.lineWidth = 4;
    c.beginPath();
    c.moveTo(-0.29 * B, -0.50 * B);
    c.lineTo(0.29 * B, -0.50 * B);
    c.stroke();
  } else if (limbColors) {
    const pads = [[-0.29, -0.50, limbColors[0]], [0.29, -0.50, limbColors[1]], [-0.08, 0.005, limbColors[2]], [0.08, 0.005, limbColors[3]]];
    for (const [px, py, col] of pads) {
      c.strokeStyle = rgb(col, 0.8 * opacity);
      c.lineWidth = Math.max(4, B * 0.018);
      c.beginPath();
      c.moveTo((px - 0.065) * B, py * B);
      c.lineTo((px + 0.065) * B, py * B);
      c.stroke();
    }
  }
  c.restore();
}

// --- Finger Pong per-side hand size guide ---------------------------------------------------
export class HandGuide {
  constructor() {
    this.sides = [new SlotState(), new SlotState()];
  }

  update(dt, frame, app, field) {
    const found = frame?.found || [];
    const pts = found.map((h) => h.map((q) => app.toCourt(q)));
    const mx = (p) => (p[4][0] + p[8][0]) / 2;
    const order = pts.map((p, i) => [mx(p), p, i]).sort((a, b) => a[0] - b[0]);
    const bySide = [null, null];
    if (order.length >= 2) {
      bySide[0] = order[0][1];
      bySide[1] = order.at(-1)[1];
    } else if (order.length === 1) {
      bySide[order[0][0] < field.centerX ? 0 : 1] = order[0][1];
    }
    for (let i = 0; i < 2; i++) {
      const p = bySide[i], st = this.sides[i];
      if (!p) {
        st.clear(dt);
        continue;
      }
      const palm = Math.max(norm(sub(p[9], p[0])), norm(sub(p[5], p[0]))) / field.height;
      const ref = st.measure(dt, palm);
      let issue = null;
      if (st.issue === "far" ? ref < HAND_FAR_OUT : ref < HAND_FAR_IN) issue = "far";
      else if (st.issue === "close" ? ref > HAND_CLOSE_OUT : ref > HAND_CLOSE_IN) issue = "close";
      st.step(dt, issue);
    }
  }

  // draws target-size hand silhouettes and hints for waiting or poorly distanced hands
  draw(c, scene, turned) {
    if (scene.winner !== null) return;
    const f = scene.field, palmLen = IDEAL_PALM * f.height;
    const angle = turned ? -Math.PI / 2 : 0;
    const off = (dx, dy) => (turned ? [dy, -dx] : [dx, dy]); // screen-upright offset in court px
    const small = f.height * 0.042;
    scene.players.forEach((p, i) => {
      const hasPad = !!scene.paddle(i), waiting = !scene.ball && !hasPad;
      const st = this.sides[i];
      const op = waiting ? 0.85 : st.fade * (scene.ball ? 0.65 : 0.9);
      if (op <= 0.01) return;
      const base = [f.centerX - p.dir * f.width * 0.25, f.centerY];
      const silPos = add(base, off(0, -f.height * 0.05));
      const txtPos = add(base, off(0, f.height * 0.20));
      drawHandSilhouette(c, silPos, palmLen, p.color, i === 1, angle, op);
      const msg = waiting
        ? `${p.name}: show your hand`
        : st.issue === "close"
          ? `${p.name}: too close - move back`
          : `${p.name}: too far - move closer`;
      c.save();
      c.globalAlpha = waiting ? 1 : st.fade;
      drawText(c, small, msg, txtPos, p.color, angle);
      c.restore();
    });
  }
}

// --- Full-body framing guide (Volleyball, Juggling, Colour Juggle) --------------------------
export function estimateBodyHeight(pts) {
  const ok = (j) => pts[j][2] >= SEEN;
  let h = 0;
  if (ok(11) && ok(12)) {
    const sh = mul(add(pts[11], pts[12]), 0.5);
    h = Math.max(h, norm(sub(pts[11], pts[12])) / 0.21);
    if (ok(0)) h = Math.max(h, norm(sub(sh, pts[0])) / 0.115);
    if (ok(23) && ok(24)) h = Math.max(h, norm(sub(mul(add(pts[23], pts[24]), 0.5), sh)) / 0.30);
  }
  if (ok(0) && (ok(27) || ok(28))) {
    const ay = ok(27) && ok(28) ? (pts[27][1] + pts[28][1]) / 2 : pts[ok(27) ? 27 : 28][1];
    h = Math.max(h, (ay - pts[0][1]) / 0.86);
  }
  return h;
}

function feetClipped(pts, W, H, wasFeet) {
  const ok = (j) => pts[j][2] >= SEEN;
  if (!ok(11) || !ok(12)) return false;
  const shY = (pts[11][1] + pts[12][1]) / 2;
  const hipLow = ok(23) && ok(24) && (pts[23][1] + pts[24][1]) / 2 > (wasFeet ? 0.68 : 0.74) * H;
  if (shY < (wasFeet ? 0.38 : 0.46) * H && !hipLow) return false;
  return [27, 28].every((a) => pts[a][2] < (wasFeet ? 0.55 : 0.45) || pts[a][0] < 10 || pts[a][0] > W - 10 || pts[a][1] > H - 12);
}

export class BodyGuide {
  constructor(mode = "volley", { splitSides = false, needFeet = false, limbColors = null } = {}) {
    Object.assign(this, { mode, splitSides, needFeet, limbColors });
    this.slots = [new SlotState(), new SlotState()];
  }

  update(dt, frame, toCourt, W, H) {
    const bodies = (frame?.found || []).map((lm) => lm.map((q) => [...toCourt(q), q[2]]))
      .filter((P) => P[0][2] >= SEEN || (P[11][2] >= SEEN && P[12][2] >= SEEN));
    const groups = this.splitSides
      ? [bodies.filter((P) => (P[0][2] >= SEEN ? P[0][0] : (P[11][0] + P[12][0]) / 2) < W / 2),
         bodies.filter((P) => (P[0][2] >= SEEN ? P[0][0] : (P[11][0] + P[12][0]) / 2) >= W / 2)]
      : [bodies];
    groups.forEach((list, s) => {
      const st = this.slots[s];
      if (!list.length) {
        st.clear(dt);
        return;
      }
      // pick the worst framing issue among bodies in this group, unless someone in a shared-court game is already well framed
      let chosenIssue = null, chosenRatio = null, chosenX = null, firstRatio = null, firstX = null, anyGood = false;
      const closeIn = this.needFeet ? 0.88 : BODY_CLOSE_IN, closeOut = this.needFeet ? 0.78 : BODY_CLOSE_OUT;
      for (const P of list) {
        const ratio = estimateBodyHeight(P) / H;
        if (ratio <= 0) continue;
        const x = P[0][2] >= SEEN ? P[0][0] : (P[11][0] + P[12][0]) / 2;
        if (firstRatio === null) [firstRatio, firstX] = [ratio, x];
        const ref = list.length === 1 ? st.measure(dt, ratio, x) : ratio;
        let issue = null;
        if (st.issue === "close" ? ref > closeOut : ref > closeIn) issue = "close";
        else if (this.needFeet && feetClipped(P, W, H, st.issue === "feet")) issue = "feet";
        else if (st.issue === "far" ? ref < BODY_FAR_OUT : ref < BODY_FAR_IN) issue = "far";
        if (!issue) anyGood = true;
        else if (!chosenIssue) [chosenIssue, chosenRatio, chosenX] = [issue, ratio, x];
      }
      if (!this.splitSides && anyGood && list.length > 1) chosenIssue = null;
      if (list.length > 1 && (chosenRatio ?? firstRatio) !== null) {
        st.measure(dt, chosenRatio ?? firstRatio, chosenX ?? firstX);
      }
      st.step(dt, chosenIssue);
    });
  }

  // returns true if a pre-serve empty-court silhouette is shown (so the scene knows its prompt is covered)
  draw(c, { W, H, floorY, empty, inPlay, sideColors = [[255, 255, 255], [255, 255, 255]] }) {
    const B = IDEAL_BODY * H, bot = floorY - H * 0.025, small = H * 0.038;
    if (empty) {
      if (this.splitSides) {
        drawBodySilhouette(c, W * 0.25, bot, B, { color: sideColors[0], opacity: 0.75, mode: this.mode });
        drawBodySilhouette(c, W * 0.75, bot, B, { color: sideColors[1], opacity: 0.75, mode: this.mode });
      } else {
        drawBodySilhouette(c, W / 2, bot, B, { opacity: 0.8, mode: this.mode, limbColors: this.limbColors });
      }
      const msg = this.needFeet ? "step back so your hands & feet fit" : "step back so your full body fits";
      drawText(c, small, msg, [W / 2, bot - B - H * 0.055], [255, 255, 255]);
      return true;
    }
    const count = this.splitSides ? 2 : 1;
    for (let s = 0; s < count; s++) {
      const st = this.slots[s];
      if (st.fade <= 0.01 || !st.issue) continue;
      const cx = this.splitSides ? W * (s ? 0.75 : 0.25) : clamp(st.x ?? W / 2, W * 0.22, W * 0.78);
      const col = this.splitSides ? sideColors[s] : [255, 255, 255];
      const op = st.fade * (inPlay ? 0.55 : 0.85);
      drawBodySilhouette(c, cx, bot, B, { color: col, opacity: op, mode: this.mode, limbColors: this.limbColors });
      const msg = st.issue === "close"
        ? "too close - step back"
        : st.issue === "feet"
          ? "step back so your feet show"
          : "too far - step closer";
      c.save();
      c.globalAlpha = st.fade;
      drawText(c, small * 0.92, msg, [cx, bot - B - H * 0.05], col);
      c.restore();
    }
    return false;
  }
}
