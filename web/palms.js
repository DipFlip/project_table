// Hand-landmarker palms fused into pose wrists, shared by the body games (juggle.js, volley.js).
// Up close the pose model's wrists are shaky and the hand landmarker's are steady; far away hands
// are too small for it and the pose carries on alone. Each hand is matched to the nearest body
// wrist, and a PalmFix per arm keeps the two sources in the same place as the hand blinks in and out.
import { add, sub, mul, norm, clamp } from "./common.js";

const REACH = 0.9; // a palm takes over a wrist within this many forearm lengths of it
const REACH_MIN = 0.07, REACH_MAX = 0.22; // ... clamped to this range (x screen height)
const KEEP = 1.6; // an arm that had a palm last frame keeps matching one this much further out
const OFF_RATE = 0.25; // per frame: how fast the learned palm-minus-pose offset follows
const FADE_S = 0.8; // after the palm drops out, its offset fades from the pose estimate over this long

// MediaPipe hand landmarks: the wrist and the four knuckles at the base of the fingers
const WRIST = 0, KNUCKLES = [5, 9, 13, 17];

// hands (mirrored, normalised landmarks) -> { wrist, at } in court px; `at` is halfway from the
// wrist to the knuckles, where the pose model's wrist + finger points put the hand
export function palmPoints(hands, toCourt) {
  return (hands || []).map((lm) => {
    const wrist = toCourt(lm[WRIST]);
    const knuckles = mul(KNUCKLES.reduce((s, j) => add(s, toCourt(lm[j])), [0, 0]), 1 / KNUCKLES.length);
    return { wrist, at: mul(add(wrist, knuckles), 0.5) };
  });
}

// arms: [{ wrist, elbow, fix }] (pose points in court px, fix: that arm's PalmFix) -> the matched
// palm point per arm, or null; nearest pairs first, each palm used once
export function matchPalms(arms, palms, H) {
  const out = arms.map(() => null);
  if (!palms.length) return out;
  const pairs = [];
  arms.forEach(({ wrist, elbow, fix }, i) => {
    const reach = clamp(REACH * norm(sub(wrist, elbow)), REACH_MIN * H, REACH_MAX * H) * (fix.had ? KEEP : 1);
    const ref = add(wrist, fix.off || [0, 0]); // where the platform's palm would be by the learned offset
    palms.forEach((p, k) => {
      const d = Math.min(norm(sub(p.wrist, ref)), norm(sub(p.at, ref)), norm(sub(p.at, wrist)));
      if (d <= reach) pairs.push({ i, k, cost: d / reach });
    });
  });
  pairs.sort((a, b) => a.cost - b.cost);
  const used = new Set();
  for (const { i, k } of pairs) {
    if (out[i] || used.has(k)) continue;
    out[i] = palms[k].at;
    used.add(k);
  }
  return out;
}

// The palm and the pose estimate of a hand sit a little apart, so switching between them as the
// hand landmarker blinks would flick a platform back and forth. While both are seen this learns
// the offset between them; when only the pose is seen it adds that offset back (fading out).
export class PalmFix {
  constructor() {
    this.reset();
  }
  reset() {
    this.off = null; // palm minus pose estimate, px
    this.seen = -1e9;
    this.had = false; // matched a palm last frame
  }
  // pose: [x, y] or null, palm: [x, y] or null -> the hand's position, or null
  apply(pose, palm, t) {
    this.had = !!palm;
    if (palm) {
      if (pose) {
        const d = sub(palm, pose);
        this.off = this.off ? add(this.off, mul(sub(d, this.off), OFF_RATE)) : d;
      }
      this.seen = t;
      return palm;
    }
    if (pose && this.off) {
      const k = Math.exp(-(t - this.seen) / FADE_S);
      if (k >= 0.02) return add(pose, mul(this.off, k));
      this.off = null;
    }
    return pose;
  }
}
