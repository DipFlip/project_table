// Ballistic's camera menu and the gestures that lead back to it, so the games run with no mouse or
// keyboard. In the menu a cursor follows each hand; hovering one over a game for HOVER_S picks it.
// In a game, holding both arms up in an O above the head (body games) or an OK sign (Finger Pong)
// goes back to the menu, and so does nobody being in view for IDLE_S.
import { add, sub, mul, norm, clamp, rgb, drawText } from "./common.js";

const HOVER_S = 1.5; // hovering a hand over a game this long picks it
const O_HOLD_S = 3; // arms up in an O above the head this long: back to the menu
const OK_HOLD_S = 2; // an OK sign this long (Finger Pong): back to the menu
const GAP_S = 0.3; // a gesture survives tracking blinks this short
const IDLE_S = 30; // nobody in view this long: back to the menu
const VIS = 0.5;

export const CARDS = [
  { key: "pong", name: "Finger Pong", color: [70, 220, 120], text: "Two players by the camera: pinch to make a paddle" },
  { key: "volley", name: "Volleyball", color: [255, 150, 50], text: "Bop the ball over the net" },
  { key: "juggle", name: "Juggling", color: [255, 210, 60], text: "Keep every ball up with hands and feet" },
  { key: "color", name: "Colour Juggle", color: [70, 195, 255], text: "Hit the ball with the limb of its colour" },
];

// MediaPipe hand landmarks: palm centre from the wrist and the finger bases
const palmOf = (h) => mul([0, 5, 9, 13, 17].reduce((s, j) => add(s, h[j]), [0, 0]), 1 / 5);

export class Menu {
  static turns = false;

  constructor(app) {
    this.app = app;
    this.progress = CARDS.map(() => 0);
    this.cursors = [];
  }

  newMatch() {}

  cards() {
    const W = this.app.W, H = this.app.H, m = W * 0.04, gap = W * 0.02;
    const w = (W - 2 * m - 3 * gap) / 4, h = H * 0.3, y = H * 0.36;
    return CARDS.map((card, i) => ({ ...card, x: m + i * (w + gap), y, w, h }));
  }

  // every hand in view: pose wrists, and the hand landmarker's palms when it sees fingers
  hands() {
    const f = this.app.frame, out = [];
    if (!f) return out;
    for (const body of f.found) for (const j of [15, 16]) if (body[j][2] >= VIS) out.push(this.app.toCourt(body[j]));
    for (const h of f.hands || []) out.push(this.app.toCourt(palmOf(h)));
    return out;
  }

  update(dt, now) {
    if (this.app.loading) return;
    this.cursors = this.hands();
    this.cards().forEach((card, i) => {
      const over = this.cursors.some(([x, y]) => x >= card.x && x <= card.x + card.w && y >= card.y && y <= card.y + card.h);
      this.progress[i] = clamp(this.progress[i] + (over ? dt / HOVER_S : -2 * dt), 0, 1);
      if (this.progress[i] >= 1) {
        this.progress = CARDS.map(() => 0);
        this.app.sound.play("score");
        this.app.select(card.key);
      }
    });
  }

  draw(c, now) {
    const W = this.app.W, H = this.app.H;
    c.fillStyle = "rgba(0,0,0,0.35)";
    c.fillRect(0, 0, W, H);
    drawText(c, H * 0.13, "Ballistic", [W / 2, H * 0.17], [255, 255, 255]);
    drawText(c, H * 0.035, this.app.loading ? "loading…" : "hover a hand over a game to play", [W / 2, H * 0.28], [230, 230, 230]);
    this.cards().forEach((card, i) => {
      const p = this.progress[i], lift = p * 8;
      c.save();
      c.fillStyle = rgb(card.color, 0.9);
      c.strokeStyle = "black";
      c.lineWidth = 4;
      c.beginPath();
      c.roundRect(card.x, card.y - lift, card.w, card.h, 18);
      c.fill();
      c.stroke();
      if (p > 0) { // fills from the bottom while a hand hovers
        c.save();
        c.clip();
        c.fillStyle = "rgba(255,255,255,0.45)";
        c.fillRect(card.x, card.y - lift + card.h * (1 - p), card.w, card.h * p);
        c.restore();
      }
      c.fillStyle = "#111";
      c.textAlign = "center";
      c.font = `bold ${Math.round(Math.min(card.w * 0.13, H * 0.05))}px system-ui, sans-serif`;
      c.fillText(card.name, card.x + card.w / 2, card.y - lift + card.h * 0.38);
      c.font = `${Math.round(Math.min(card.w * 0.065, H * 0.025))}px system-ui, sans-serif`;
      wrap(c, card.text, card.x + card.w / 2, card.y - lift + card.h * 0.58, card.w * 0.84, H * 0.032);
      c.restore();
    });
    drawText(c, H * 0.028, "back here: arms up in an O over your head for 3 s · Finger Pong: OK sign for 2 s", [W / 2, H * 0.78], [220, 220, 220]);
    for (const [x, y] of this.cursors) {
      c.fillStyle = "rgba(255,255,255,0.85)";
      c.strokeStyle = "black";
      c.lineWidth = 3;
      c.beginPath();
      c.arc(x, y, H * 0.022, 0, 2 * Math.PI);
      c.fill();
      c.stroke();
    }
  }
}

function wrap(c, text, x, y, width, lineH) {
  const words = text.split(" "), lines = [""];
  for (const w of words) {
    const tryLine = lines.at(-1) ? `${lines.at(-1)} ${w}` : w;
    if (c.measureText(tryLine).width > width && lines.at(-1)) lines.push(w);
    else lines[lines.length - 1] = tryLine;
  }
  lines.forEach((l, i) => c.fillText(l, x, y + i * lineH));
}

// --- leaving a game --------------------------------------------------------------------------
// both wrists above the nose and close together, elbows up and wider apart than the hands
function armsInO(P) {
  const ok = (j) => P[j][2] >= VIS;
  if (![0, 11, 12, 13, 14, 15, 16].every(ok)) return null;
  const sw = norm(sub(P[11], P[12])), wl = P[15], wr = P[16];
  const handsApart = norm(sub(wl, wr)), elbowsApart = norm(sub(P[13], P[14]));
  const up = wl[1] < P[0][1] && wr[1] < P[0][1] && P[13][1] < P[11][1] && P[14][1] < P[12][1];
  return up && handsApart < 1.3 * sw && elbowsApart > handsApart ? mul(add(wl, wr), 0.5) : null;
}
// thumb and index tips touching, the other three fingers stretched out
function okSign(h) {
  const size = norm(sub(h[0], h[9]));
  if (size < 1) return null;
  const out = (tip, pip) => norm(sub(h[tip], h[0])) > norm(sub(h[pip], h[0])) * 1.15;
  return norm(sub(h[4], h[8])) < 0.35 * size && out(12, 10) && out(16, 14) && out(20, 18) ? palmOf(h) : null;
}

export class ExitGesture {
  constructor(hands) {
    this.hands = hands; // Finger Pong: the frame's bodies are hands, so look for an OK sign
    this.hold = this.HOLD = hands ? OK_HOLD_S : O_HOLD_S;
    this.reset(performance.now() / 1000);
  }
  reset(now) {
    this.since = null; // when the current hold started
    this.lastSeen = now; // the gesture, last frame it was seen
    this.anyone = now; // anyone in view
    this.at = null;
  }
  // true when it's time to go back to the menu
  update(frame, toCourt, now) {
    if (!frame) return false;
    if (frame.found.length) this.anyone = now;
    if (now - this.anyone > IDLE_S) return true;
    let at = null;
    for (const lm of frame.found) {
      const P = lm.map((q) => [...toCourt(q), q[2]]);
      at = this.hands ? okSign(P) : armsInO(P);
      if (at) break;
    }
    if (at) {
      this.at = at;
      this.lastSeen = now;
      if (this.since === null) this.since = now;
    } else if (now - this.lastSeen > GAP_S) this.since = null;
    return this.since !== null && now - this.since >= this.HOLD;
  }
  draw(c, now, H) {
    if (this.since === null || !this.at) return;
    const p = clamp((now - this.since) / this.HOLD, 0, 1), r = H * 0.05;
    const [x, y] = this.hands ? this.at : add(this.at, [0, -r * 1.6]);
    c.save();
    c.lineCap = "round";
    c.lineWidth = r * 0.3;
    c.strokeStyle = "rgba(0,0,0,0.6)";
    c.beginPath();
    c.arc(x, y, r, 0, 2 * Math.PI);
    c.stroke();
    c.strokeStyle = "white";
    c.beginPath();
    c.arc(x, y, r, -Math.PI / 2, -Math.PI / 2 + 2 * Math.PI * p);
    c.stroke();
    c.restore();
    drawText(c, H * 0.03, "menu", [x, y + r * 1.9], [255, 255, 255]);
  }
}
