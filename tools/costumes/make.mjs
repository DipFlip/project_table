// Paints the costume PSDs in web/costumes/ (see web/costumes/README.md for drawing your own): a
// blank mannequin template (in a reference group, under empty part layers) plus four costumes, each
// with one layer per body part (back, leg_l, leg_r, torso, head, arm_l, arm_r, ball) in the front
// rest pose of web/rest.js (left half), a "side" group with the side view (right half: arm_far,
// leg_far, back, torso, leg_near, head, arm_near) and a hidden "guide" layer showing the bones. Open template.psd in Photoshop, paint
// on the part layers, save as web/costumes/<name>.psd and add the name to COSTUMES in web/rig.js.
//
//   cd tools/costumes && npm install && node make.mjs
//
// Shapes are signed distance fields: anti-aliased edges, ink outlines and a soft rounded shading
// from the distance to the edge, so the parts read as smooth rounded forms rather than flat blocks.
import fs from "node:fs";
import zlib from "node:zlib";
import path from "node:path";
import agPsd from "ag-psd";
import { SIZE, REST as J, BONES, REST_SIDE as K, SIDE_BONES, BALL } from "../../web/rest.js";

const [W, H] = SIZE;
const OUT = path.join(import.meta.dirname, "../../web/costumes");

// --- maths ----------------------------------------------------------------------------------
const clamp = (x, a, b) => (x < a ? a : x > b ? b : x);
const smooth = (a, b, x) => {
  const t = clamp((x - a) / (b - a), 0, 1);
  return t * t * (3 - 2 * t);
};
const mixc = (a, b, t) => a.map((v, i) => v + (b[i] - v) * t);
const hex = (h) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16) / 255);
const add = (a, b) => [a[0] + b[0], a[1] + b[1]];
const sub = (a, b) => [a[0] - b[0], a[1] - b[1]];
const mul = (a, k) => [a[0] * k, a[1] * k];
const lerp = (a, b, t) => add(a, mul(sub(b, a), t));
const len = (a) => Math.hypot(a[0], a[1]);
const unit = (a) => mul(a, 1 / (len(a) || 1));
const perp = (a) => [-a[1], a[0]];

// value noise, for fur and woven straw
const hash = (x, y) => {
  const s = Math.sin(x * 127.1 + y * 311.7) * 43758.5453;
  return s - Math.floor(s);
};
function noise(x, y) {
  const xi = Math.floor(x), yi = Math.floor(y), xf = x - xi, yf = y - yi;
  const u = xf * xf * (3 - 2 * xf), v = yf * yf * (3 - 2 * yf);
  const a = hash(xi, yi), b = hash(xi + 1, yi), c = hash(xi, yi + 1), d = hash(xi + 1, yi + 1);
  return a + (b - a) * u + (c - a) * v + (a - b - c + d) * u * v;
}
const fbm = (x, y) => noise(x, y) * 0.6 + noise(x * 2.1, y * 2.1) * 0.3 + noise(x * 4.3, y * 4.3) * 0.1;

// --- shapes: { f(x, y) -> signed distance in px (negative inside), box: [x0, y0, x1, y1] } ----
const S = (f, box) => ({ f, box });
const grow = (b, r) => [b[0] - r, b[1] - r, b[2] + r, b[3] + r];
const joinBox = (...bs) => [Math.min(...bs.map((b) => b[0])), Math.min(...bs.map((b) => b[1])), Math.max(...bs.map((b) => b[2])), Math.max(...bs.map((b) => b[3]))];

const circle = (c, r) => S((x, y) => Math.hypot(x - c[0], y - c[1]) - r, [c[0] - r, c[1] - r, c[0] + r, c[1] + r]);
function ellipse(c, rx, ry, rot = 0) {
  const cs = Math.cos(rot), sn = Math.sin(rot), m = Math.max(rx, ry);
  return S((x, y) => {
    const dx = x - c[0], dy = y - c[1];
    const lx = dx * cs + dy * sn, ly = -dx * sn + dy * cs;
    const k = Math.hypot(lx / rx, ly / ry);
    return (k - 1) * Math.min(rx, ry) * (k < 1 ? 1 : Math.min(1.6, 0.7 + 0.3 * k));
  }, [c[0] - m, c[1] - m, c[0] + m, c[1] + m]);
}
// a segment with a radius that runs from r1 at a to r2 at b
function capsule(a, b, r1, r2 = r1) {
  const ba = sub(b, a), bb = ba[0] * ba[0] + ba[1] * ba[1] || 1, r = Math.max(r1, r2);
  return S((x, y) => {
    const pa = [x - a[0], y - a[1]];
    const t = clamp((pa[0] * ba[0] + pa[1] * ba[1]) / bb, 0, 1);
    return Math.hypot(pa[0] - ba[0] * t, pa[1] - ba[1] * t) - (r1 + (r2 - r1) * t);
  }, joinBox([a[0] - r, a[1] - r, a[0] + r, a[1] + r], [b[0] - r, b[1] - r, b[0] + r, b[1] + r]));
}
// a rounded box centred at c, half-size hw x hh, corner radius r, rotated by rot
function box(c, hw, hh, r = 0, rot = 0) {
  const cs = Math.cos(rot), sn = Math.sin(rot), m = Math.hypot(hw, hh);
  return S((x, y) => {
    const dx = x - c[0], dy = y - c[1];
    const qx = Math.abs(dx * cs + dy * sn) - (hw - r), qy = Math.abs(-dx * sn + dy * cs) - (hh - r);
    return Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) + Math.min(Math.max(qx, qy), 0) - r;
  }, [c[0] - m, c[1] - m, c[0] + m, c[1] + m]);
}
function poly(pts) {
  const xs = pts.map((p) => p[0]), ys = pts.map((p) => p[1]);
  return S((x, y) => {
    let d = Infinity, s = 1;
    for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
      const a = pts[j], b = pts[i], e = sub(b, a), w = [x - a[0], y - a[1]];
      const t = clamp((w[0] * e[0] + w[1] * e[1]) / (e[0] * e[0] + e[1] * e[1]), 0, 1);
      d = Math.min(d, Math.hypot(w[0] - e[0] * t, w[1] - e[1] * t));
      const c1 = y >= a[1], c2 = y < b[1], c3 = e[0] * w[1] > e[1] * w[0];
      if ((c1 && c2 && c3) || (!c1 && !c2 && !c3)) s = -s;
    }
    return s * d;
  }, [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)]);
}
const union = (...ss) => S((x, y) => Math.min(...ss.map((s) => s.f(x, y))), joinBox(...ss.map((s) => s.box)));
// a blobby union: shapes melt into each other over k px, so joints are soft rather than creased
function blend(k, ...ss) {
  return S((x, y) => {
    let d = ss[0].f(x, y);
    for (let i = 1; i < ss.length; i++) {
      const e = ss[i].f(x, y), h = clamp(0.5 + (0.5 * (e - d)) / k, 0, 1);
      d = e + (d - e) * h - k * h * (1 - h);
    }
    return d;
  }, joinBox(...ss.map((s) => s.box)));
}
const cut = (a, b) => S((x, y) => Math.max(a.f(x, y), -b.f(x, y)), a.box);
const clip = (a, b) => S((x, y) => Math.max(a.f(x, y), b.f(x, y)), a.box);
const round = (s, r) => S((x, y) => s.f(x, y) - r, grow(s.box, r));
const ring = (s, w) => S((x, y) => Math.abs(s.f(x, y)) - w / 2, grow(s.box, w));
const shaggy = (s, amp, scale) => S((x, y) => s.f(x, y) + amp * (fbm(x / scale, y / scale) * 2 - 1), grow(s.box, amp));
const chain = (k, pts, radii) => blend(k, ...pts.slice(1).map((p, i) => capsule(pts[i], p, radii[i], radii[i + 1])));

// --- painting --------------------------------------------------------------------------------
const LIGHT = (() => {
  const l = [-0.45, -0.62, 0.64], n = Math.hypot(...l);
  return l.map((v) => v / n);
})();
const INK = hex("#1d1822");

class Layer {
  constructor(name, hidden = false) {
    this.name = name;
    this.hidden = hidden;
    this.px = new Float32Array(W * H * 4); // premultiplied RGBA
  }
  // fill: [r, g, b] or (x, y) -> [r, g, b]; ink: outline width (0 for none); thick: how deep the
  // rounded shading goes (px); gloss: specular highlight strength; alpha: opacity
  paint(s, { fill, ink = 5, thick = 40, shade = true, gloss = 0.15, alpha = 1, glow = 0 }) {
    const [x0, y0, x1, y1] = grow(s.box, ink + 2).map(Math.round);
    const f = s.f;
    for (let y = Math.max(0, y0); y < Math.min(H, y1); y++) {
      for (let x = Math.max(0, x0); x < Math.min(W, x1); x++) {
        const px = x + 0.5, py = y + 0.5;
        const d = f(px, py);
        if (d > ink + 1) continue;
        let a = (ink > 0 ? clamp(ink + 0.5 - d, 0, 1) : clamp(0.5 - d, 0, 1)) * alpha;
        if (a <= 0) continue;
        let col = typeof fill === "function" ? fill(px, py) : fill;
        if (shade && d < 1) {
          let gx = f(px + 1, py) - f(px - 1, py), gy = f(px, py + 1) - f(px, py - 1);
          const gl = Math.hypot(gx, gy) || 1;
          gx /= gl;
          gy /= gl;
          const t = clamp(-d / thick, 0, 1), sr = 1 - t, nz = Math.sqrt(1 - sr * sr);
          const lam = gx * sr * LIGHT[0] + gy * sr * LIGHT[1] + nz * LIGHT[2];
          const k = 0.56 + 0.44 * smooth(-0.15, 0.75, lam);
          const spec = gloss * smooth(0.9, 0.98, lam);
          const rim = 0.1 * smooth(0.6, 1, sr) * smooth(0, 0.4, -(gx * LIGHT[0] + gy * LIGHT[1])); // bounce light on the shadow side
          col = col.map((v) => Math.min(1, v * (k + rim) + spec));
        }
        if (glow) col = col.map((v) => Math.min(1, v + glow * (1 - smooth(0, thick, -d))));
        const inkAmt = ink > 0 ? clamp(d + 0.5, 0, 1) : 0;
        const c = inkAmt ? mixc(col, INK, inkAmt) : col;
        const i = (y * W + x) * 4, o = this.px;
        const k = 1 - a;
        o[i] = c[0] * a + o[i] * k;
        o[i + 1] = c[1] * a + o[i + 1] * k;
        o[i + 2] = c[2] * a + o[i + 2] * k;
        o[i + 3] = a + o[i + 3] * k;
      }
    }
    return this;
  }
  // a limb: painted as usual, then its end behind the root joint (the shoulder or hip, where it
  // tucks under the torso) is painted again without ink, so when the limb swings up or across
  // its rounded end doesn't show an outline over the body
  limb(s, root, toward, opts) {
    this.paint(s, opts);
    const d = unit(sub(toward, root));
    const behind = S((x, y) => (x - root[0]) * d[0] + (y - root[1]) * d[1] - 26, [0, 0, W, H]);
    return this.paint(clip(s, behind), { ...opts, ink: 0 });
  }

  // a little darker, for the far limbs in the side view
  darken(k) {
    for (let i = 0; i < this.px.length; i += 4) for (let c = 0; c < 3; c++) this.px[i + c] *= k;
    return this;
  }

  // straight-alpha 8-bit pixels cropped to what's painted
  crop() {
    let x0 = W, y0 = H, x1 = -1, y1 = -1;
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
      if (this.px[(y * W + x) * 4 + 3] > 0.002) {
        if (x < x0) x0 = x;
        if (x > x1) x1 = x;
        if (y < y0) y0 = y;
        if (y > y1) y1 = y;
      }
    }
    if (x1 < 0) [x0, y0, x1, y1] = [0, 0, 0, 0];
    const w = x1 - x0 + 1, h = y1 - y0 + 1, data = new Uint8ClampedArray(w * h * 4);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      const i = ((y + y0) * W + x + x0) * 4, o = (y * w + x) * 4, a = this.px[i + 3];
      for (let c = 0; c < 3; c++) data[o + c] = a > 0 ? Math.round((this.px[i + c] / a) * 255) : 0;
      data[o + 3] = Math.round(a * 255);
    }
    return { left: x0, top: y0, right: x1 + 1, bottom: y1 + 1, imageData: { width: w, height: h, data } };
  }
}

// A costume PSD: the front part layers, the "side" group and the hidden guide. With `reference`
// (the template) the drawn mannequin goes in a "template" group the game ignores, under empty
// part layers with the same names to paint on.
function writeCostume(name, front, side, reference = false) {
  const layers = [...front, ...side, guide()];
  const entry = (l) => ({ name: l.name, hidden: l.hidden, ...l.crop() });
  const parts = (front, side) => [...front.map(entry), { name: "side", opened: true, children: side.map(entry) }];
  const empty = (ls) => ls.map((l) => new Layer(l.name));
  const children = reference
    ? [{ name: "template (reference only, not drawn in the game)", opened: true, children: parts(front, side) }, ...parts(empty(front), empty(side)), entry(layers.at(-1))]
    : [...parts(front, side), entry(layers.at(-1))];
  // the flattened image Photoshop shows before it reads the layers
  const comp = new Uint8ClampedArray(W * H * 4);
  const acc = new Float32Array(W * H * 4);
  for (const l of layers) {
    if (l.hidden) continue;
    for (let i = 0; i < acc.length; i += 4) {
      const a = l.px[i + 3];
      if (!a) continue;
      for (let c = 0; c < 4; c++) acc[i + c] = l.px[i + c] + acc[i + c] * (1 - a);
    }
  }
  for (let i = 0; i < acc.length; i += 4) {
    const a = acc[i + 3];
    for (let c = 0; c < 3; c++) comp[i + c] = a > 0 ? Math.round((acc[i + c] / a) * 255) : 0;
    comp[i + 3] = Math.round(a * 255);
  }
  if (reference) {
    // pictures of the template's figure for web/costumes/README.md, at half size
    savePng(comp, [100, 0, 1000, 1536], path.join(OUT, "template-front.png"));
    savePng(comp, [1280, 0, 1800, 1536], path.join(OUT, "template-side.png"));
  }
  const psd = { width: W, height: H, children, imageData: { width: W, height: H, data: comp } };
  fs.writeFileSync(path.join(OUT, `${name}.psd`), Buffer.from(agPsd.writePsd(psd, { generateThumbnail: false })));
  console.log(`${name}.psd: ${front.map((l) => l.name).join(", ")} | side: ${side.map((l) => l.name).join(", ")}`);
}

// a region [x0, y0, x1, y1] of straight-alpha RGBA pixels, halved, as a PNG file
function savePng(rgba, [x0, y0, x1, y1], file) {
  const w = (x1 - x0) >> 1, h = (y1 - y0) >> 1, raw = Buffer.alloc((w * 4 + 1) * h);
  for (let y = 0; y < h; y++) {
    raw[y * (w * 4 + 1)] = 0;
    for (let x = 0; x < w; x++) {
      // average 2 x 2 pixels, weighting colour by alpha
      let r = 0, g = 0, b = 0, a = 0;
      for (const [dx, dy] of [[0, 0], [1, 0], [0, 1], [1, 1]]) {
        const i = ((y0 + 2 * y + dy) * W + x0 + 2 * x + dx) * 4, k = rgba[i + 3];
        r += rgba[i] * k; g += rgba[i + 1] * k; b += rgba[i + 2] * k; a += k;
      }
      const o = y * (w * 4 + 1) + 1 + x * 4;
      raw[o] = a ? r / a : 0; raw[o + 1] = a ? g / a : 0; raw[o + 2] = a ? b / a : 0; raw[o + 3] = a / 4;
    }
  }
  const crcTable = Array.from({ length: 256 }, (_, n) => {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    return c >>> 0;
  });
  const crc = (buf) => {
    let c = 0xffffffff;
    for (const v of buf) c = crcTable[(c ^ v) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  };
  const chunk = (type, data) => {
    const len = Buffer.alloc(4), body = Buffer.concat([Buffer.from(type), data]), c = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    c.writeUInt32BE(crc(body));
    return Buffer.concat([len, body, c]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr.set([8, 6, 0, 0, 0], 8); // 8-bit RGBA
  fs.writeFileSync(file, Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk("IHDR", ihdr), chunk("IDAT", zlib.deflateSync(raw, { level: 9 })), chunk("IEND", Buffer.alloc(0))]));
}

// the hidden guide layer: bones in pink, joints in cyan, the head's tracked size as a ring
function guide() {
  const g = new Layer("guide", true);
  for (const [bones, joints] of [[BONES, J], [SIDE_BONES, K]]) {
    for (const b of Object.values(bones)) g.paint(capsule(joints[b.from], joints[b.to], 3), { fill: hex("#ff3b8b"), ink: 0, shade: false, alpha: 0.9 });
    for (const p of Object.values(joints)) g.paint(circle(p, 8), { fill: hex("#38e0ff"), ink: 2, shade: false });
  }
  g.paint(ring(circle(J.head, 97), 3), { fill: hex("#38e0ff"), ink: 0, shade: false, alpha: 0.7 });
  g.paint(ring(circle(BALL.at, BALL.r), 3), { fill: hex("#38e0ff"), ink: 0, shade: false, alpha: 0.9 }); // the ball's circle
  return g;
}

// handy body geometry at the rest pose
const SIDES = [
  { s: "L", sh: J.shL, el: J.elL, wr: J.wrL, hand: J.handL, hip: J.hipL, kn: J.knL, an: J.anL, toe: J.toeL, out: -1 },
  { s: "R", sh: J.shR, el: J.elR, wr: J.wrR, hand: J.handR, hip: J.hipR, kn: J.knR, an: J.anR, toe: J.toeR, out: 1 },
];
// the side view's limbs, facing right: "near" towards the camera, "far" behind the body
const SIDE_LIMBS = [
  { s: "far", sh: add(K.sh, [-6, 0]), el: K.elF, wr: K.wrF, hand: K.handF, hip: add(K.hip, [-10, 0]), kn: K.knF, an: K.anF, toe: K.toeF, out: 1 },
  { s: "near", sh: add(K.sh, [6, 0]), el: K.elN, wr: K.wrN, hand: K.handN, hip: add(K.hip, [10, 0]), kn: K.knN, an: K.anN, toe: K.toeN, out: 1 },
];
let LIMBS = SIDES; // which limbs the costume functions paint: SIDES (front) or SIDE_LIMBS
// the side view's torso: chest to the right, back to the left
const C = K.sh[0];
const sideTorso = (wide = 0) => round(poly([
  [C - 40, 352], [C + 30, 346], [C + 76 + wide, 432], [C + 86 + wide, 540], [C + 66 + wide, 680], [C + 74 + wide, 800], [C + 62 + wide, 852],
  [C - 70 - wide, 852], [C - 80 - wide, 762], [C - 62 - wide, 640], [C - 74 - wide, 470], [C - 54 - wide, 384],
]), 22);

// shoulders slope down from the neck and stop inside the sleeves, so they don't stick out past
// where the arms start
const torsoShape = (wide = 0) => round(poly([
  [J.shL[0] + 70, J.shL[1] - 40], [J.shR[0] - 70, J.shR[1] - 40],
  [J.shR[0] - 6 + wide / 2, J.shR[1] + 4], [J.shR[0] - 2 + wide / 2, 560], [J.hipR[0] + 26 + wide, 700], [J.hipR[0] + 30 + wide, 850],
  [J.hipL[0] - 30 - wide, 850], [J.hipL[0] - 26 - wide, 700], [J.shL[0] + 2 - wide / 2, 560], [J.shL[0] + 6 - wide / 2, J.shL[1] + 4],
]), 26);
// the bottom strip (h px) of a foot drawn from the ankle (radius ra) to the toe (radius rt)
const sole = (sd, ra, rt, h) => {
  const bottom = Math.max(sd.an[1] + ra, sd.toe[1] + rt);
  return S((x, y) => bottom - h - y, [0, 0, W, H]);
};
const handShape = (sd, rx, ry) => {
  const d = unit(sub(sd.hand, sd.wr));
  return ellipse(lerp(sd.wr, sd.hand, 0.75), rx, ry, Math.atan2(d[1], d[0]) - Math.PI / 2);
};
const thumb = (sd, r) => {
  const d = unit(sub(sd.hand, sd.wr)), n = mul(perp(d), -sd.out);
  const base = add(lerp(sd.wr, sd.hand, 0.45), mul(n, r * 1.6));
  return capsule(base, add(base, add(mul(d, r * 2.2), mul(n, r * 0.9))), r * 0.75, r * 0.6);
};

// --- the blank template -------------------------------------------------------------------
function template() {
  const skin = hex("#d9d3ca"), L = (n) => new Layer(n);
  const legs = LIMBS.map((sd) => L(`leg_${sd.s.toLowerCase()}`)
    .limb(blend(24, chain(22, [sd.hip, sd.kn, sd.an], [52, 40, 28]), capsule(sd.an, sd.toe, 26, 20)), sd.hip, sd.kn, { fill: skin, thick: 44 }));
  const torso = L("torso").paint(torsoShape(), { fill: skin, thick: 90 });
  const arms = LIMBS.map((sd) => L(`arm_${sd.s.toLowerCase()}`)
    .limb(blend(16, chain(18, [add(sd.sh, [sd.out * -14, 6]), sd.el, sd.wr], [44, 32, 25]), handShape(sd, 26, 40), thumb(sd, 12)), sd.sh, sd.el, { fill: skin, thick: 36 }));
  // the neck's end tucks under the torso without an outline, like the limbs'
  const head = L("head")
    .limb(blend(8, capsule([512, 300], [512, 372], 32), blend(14, ellipse([512, 205], 88, 102), ellipse([512, 262], 62, 52)), ellipse(J.earL, 15, 25), ellipse(J.earR, 15, 25)), [512, 348], [512, 200], { fill: skin, thick: 70 });
  // where the tracker puts the eyes, nose and mouth: draw faces over these
  for (const e of [J.eyeL, J.eyeR]) head.paint(ellipse(e, 11, 7), { fill: hex("#5d5750"), ink: 0, shade: false });
  head.paint(ellipse(J.nose, 9, 12), { fill: hex("#c9c2b8"), ink: 2.5, thick: 9 });
  head.paint(capsule(J.mouthL, J.mouthR, 4), { fill: hex("#8f6f6a"), ink: 0, shade: false });
  return { back: new Layer("back"), legs, torso, arms, head };
}

// --- astronaut: a white suit and a helmet with the player's own face behind the visor --------
function astronaut() {
  const white = hex("#f3f2ee"), grey = hex("#a7aeb8"), dark = hex("#3a404a"), orange = hex("#f07a3a"), blue = hex("#3d7be0"), gold = hex("#e2b33c");
  const back = new Layer("back")
    .paint(box([512, 560], 196, 220, 48), { fill: grey, thick: 70 })
    .paint(capsule([322, 400], [322, 720], 34), { fill: hex("#d5d9de"), thick: 34, gloss: 0.3 })
    .paint(capsule([702, 400], [702, 720], 34), { fill: hex("#d5d9de"), thick: 34, gloss: 0.3 });
  const legs = LIMBS.map((sd) => {
    const l = new Layer(`leg_${sd.s.toLowerCase()}`);
    l.limb(chain(24, [add(sd.hip, [0, -20]), sd.kn, sd.an], [62, 54, 48]), sd.hip, sd.kn, { fill: white, thick: 56 });
    l.paint(ellipse(add(sd.kn, [0, 4]), 54, 40), { fill: grey, thick: 30 });
    l.paint(ring(capsule(add(sd.an, [-50, -48]), add(sd.an, [50, -48]), 1), 12), { fill: grey, ink: 3, thick: 8 });
    l.paint(blend(18, capsule(add(sd.an, [0, -30]), sd.an, 50, 50), capsule(sd.an, add(sd.toe, [0, -6]), 48, 40)), { fill: hex("#8e959f"), thick: 40, gloss: 0.2 });
    l.paint(clip(capsule(sd.an, add(sd.toe, [0, -6]), 48, 40), sole(sd, 48, 34, 16)), { fill: dark, thick: 14 });
    return l;
  });
  const torso = new Layer("torso");
  const body = torsoShape(14);
  torso.paint(body, { fill: white, thick: 100 });
  torso.paint(clip(body, box([512, 800], 200, 22)), { fill: grey, ink: 4, thick: 18 });
  torso.paint(ring(capsule([512, 400], [512, 780], 0), 3), { fill: hex("#c9ccd2"), ink: 0, shade: false });
  torso.paint(box([512, 540], 84, 56, 16), { fill: dark, thick: 20, gloss: 0.35 });
  torso.paint(box([488, 524], 44, 20, 6), { fill: hex("#1b2a3a"), ink: 3, shade: false, glow: 0.15 });
  [["#ff5a5a", 552, 512], ["#4de17a", 576, 512], ["#ffd23c", 552, 540], ["#4dbbff", 576, 540]].forEach(([c, x, y]) =>
    torso.paint(circle([x, y], 9), { fill: hex(c), ink: 2.5, thick: 9, gloss: 0.5 }));
  [0, 1, 2].forEach((i) => torso.paint(box([470 + i * 30, 575, 0], 10, 5, 3), { fill: hex("#9aa1ab"), ink: 2, shade: false }));
  torso.paint(circle([424, 462], 34), { fill: blue, thick: 30 });
  torso.paint(ring(circle([424, 462], 26), 6), { fill: orange, ink: 0, shade: false });
  torso.paint(poly([[424, 440], [432, 458], [450, 462], [432, 468], [424, 486], [416, 468], [398, 462], [416, 458]]), { fill: white, ink: 0, shade: false });
  const arms = LIMBS.map((sd) => {
    const l = new Layer(`arm_${sd.s.toLowerCase()}`);
    l.limb(chain(20, [add(sd.sh, [sd.out * -12, 4]), sd.el, sd.wr], [52, 44, 40]), sd.sh, sd.el, { fill: white, thick: 46 });
    l.paint(ellipse(sd.el, 44, 36, Math.atan2(sd.wr[1] - sd.el[1], sd.wr[0] - sd.el[0])), { fill: grey, thick: 26 });
    const d = unit(sub(sd.wr, sd.el)), n = perp(d);
    l.paint(capsule(add(sd.wr, mul(n, 44)), sub(sd.wr, mul(n, 44)), 14), { fill: grey, thick: 14 });
    l.paint(blend(10, handShape(sd, 36, 48), thumb(sd, 15)), { fill: orange, thick: 34, gloss: 0.2 });
    return l;
  });
  const head = new Layer("head");
  head.paint(ellipse([512, 352], 132, 44), { fill: grey, thick: 30 });
  const visor = ellipse([512, 232], 118, 106);
  head.paint(cut(circle([512, 222], 160), visor), { fill: white, thick: 60, gloss: 0.25 });
  head.paint(ring(visor, 12), { fill: gold, ink: 3, thick: 6, gloss: 0.5 });
  head.paint(visor, { fill: hex("#8cc2ff"), ink: 0, shade: false, alpha: 0.13 });
  head.paint(clip(ring(ellipse([512, 232], 96, 84), 14), poly([[380, 90], [520, 90], [520, 160], [430, 230], [380, 260]])), { fill: [1, 1, 1], ink: 0, shade: false, alpha: 0.7 });
  head.paint(circle([592, 172], 8), { fill: [1, 1, 1], ink: 0, shade: false, alpha: 0.8 });
  head.paint(box([660, 170], 22, 30, 8), { fill: grey, thick: 16 });
  head.paint(circle([668, 160], 11), { fill: hex("#fff2a8"), ink: 3, shade: false, glow: 0.4, thick: 11 });
  head.paint(capsule([418, 82], [396, 18], 5), { fill: grey, ink: 3, thick: 5 });
  head.paint(circle([396, 16], 12), { fill: hex("#ff4d4d"), ink: 3, thick: 12, gloss: 0.5 });
  return { back, legs, torso, arms, head };
}

// --- werewolf: shaggy fur, torn purple trousers, a wolf's head ------------------------------
function werewolf() {
  const furA = hex("#5d3d27"), furB = hex("#3b2617"), tan = hex("#b8905f"), purple = hex("#6c40a3"), claw = hex("#f4eedf");
  const fur = (x, y) => mixc(furA, furB, smooth(0.35, 0.75, fbm(x / 22, y / 7)));
  const belly = (x, y) => mixc(tan, hex("#94704a"), smooth(0.3, 0.8, fbm(x / 18, y / 6)));
  const claws = (l, at, dir, k) => {
    const n = perp(dir);
    for (const o of [-1.5, -0.5, 0.5, 1.5]) {
      const b = add(at, mul(n, o * 15 * k));
      l.paint(capsule(b, add(add(b, mul(dir, 26 * k)), mul(n, o * 4 * k)), 7 * k, 2.5 * k), { fill: claw, ink: 3, thick: 6, gloss: 0.4 });
    }
  };
  const back = new Layer("back")
    .paint(shaggy(chain(30, [[560, 760], [660, 880], [720, 1000], [700, 1080]], [34, 58, 50, 18]), 12, 10), { fill: fur, thick: 50 });
  const legs = LIMBS.map((sd) => {
    const l = new Layer(`leg_${sd.s.toLowerCase()}`);
    l.limb(shaggy(chain(24, [add(sd.hip, [0, -20]), sd.kn, sd.an], [60, 50, 42]), 9, 9), sd.hip, sd.kn, { fill: fur, thick: 52 });
    // torn trousers down to the knee
    const legShape = chain(24, [add(sd.hip, [0, -30]), sd.kn, sd.an], [66, 56, 48]);
    const hem = S((x, y) => y - (sd.kn[1] + 30 + 26 * Math.sin(x / 13) * Math.sin(x / 31 + 1)), [0, 0, W, H]);
    l.limb(clip(legShape, hem), sd.hip, sd.kn, { fill: purple, thick: 50 });
    const pawDir = unit(sub(sd.toe, sd.an));
    l.paint(shaggy(blend(14, capsule(sd.an, sd.toe, 40, 34), ellipse(sd.toe, 46, 28)), 5, 8), { fill: fur, thick: 34 });
    claws(l, add(sd.toe, mul(pawDir, 18)), pawDir, 1.1);
    return l;
  });
  const torso = new Layer("torso");
  const body = shaggy(torsoShape(10), 10, 10);
  torso.paint(body, { fill: fur, thick: 100 });
  torso.paint(shaggy(ellipse([512, 560], 112, 190), 10, 8), { fill: belly, ink: 0, thick: 80 });
  torso.paint(clip(torsoShape(14), S((x, y) => 778 - y + 6 * Math.sin(x / 9), [0, 0, W, H])), { fill: purple, thick: 60 });
  torso.paint(clip(torsoShape(14), box([512, 790], 220, 12)), { fill: hex("#4a2a75"), ink: 3, thick: 10 });
  const arms = LIMBS.map((sd) => {
    const l = new Layer(`arm_${sd.s.toLowerCase()}`);
    l.limb(shaggy(chain(20, [add(sd.sh, [sd.out * -14, 4]), sd.el, sd.wr], [54, 46, 40]), 9, 9), sd.sh, sd.el, { fill: fur, thick: 48 });
    const d = unit(sub(sd.hand, sd.wr));
    l.paint(shaggy(blend(10, handShape(sd, 40, 50), thumb(sd, 15)), 4, 7), { fill: fur, thick: 36 });
    claws(l, add(sd.hand, mul(d, 22)), d, 1);
    return l;
  });
  const head = new Layer("head");
  head.paint(shaggy(ellipse([512, 300], 158, 96), 16, 9), { fill: (x, y) => mixc(furB, furA, fbm(x / 20, y / 6) * 0.6), thick: 60 });
  for (const s of [-1, 1]) {
    head.paint(round(poly([[512 + s * 52, 120], [512 + s * 128, 4], [512 + s * 118, 150]]), 8), { fill: furB, thick: 30 });
    head.paint(round(poly([[512 + s * 74, 116], [512 + s * 118, 36], [512 + s * 110, 132]]), 4), { fill: hex("#c98b7a"), ink: 0, thick: 20 });
  }
  head.paint(shaggy(ellipse([512, 205], 112, 116), 7, 8), { fill: fur, thick: 80 });
  head.paint(shaggy(ellipse([512, 150], 60, 34), 5, 6), { fill: furB, ink: 0, thick: 30 });
  head.paint(blend(20, ellipse([512, 278], 66, 54), ellipse([512, 240], 40, 40)), { fill: tan, thick: 50 });
  for (const s of [-1, 1]) {
    head.paint(ellipse([512 + s * 46, 196], 26, 15, s * 0.3), { fill: hex("#ffd23c"), ink: 4, thick: 12, glow: 0.35 });
    head.paint(ellipse([512 + s * 46, 196], 5, 13), { fill: INK, ink: 0, shade: false });
    head.paint(capsule([512 + s * 16, 172], [512 + s * 78, 160], 9, 5), { fill: furB, ink: 3, thick: 8 });
  }
  head.paint(ellipse([512, 246], 26, 17), { fill: hex("#1c1418"), ink: 3, thick: 16, gloss: 0.6 });
  head.paint(ring(S((x, y) => Math.hypot((x - 512) / 1.6, y - 250) - 42, [440, 200, 584, 300]), 5), { fill: INK, ink: 0, shade: false });
  head.paint(cut(ellipse([512, 300], 50, 22), box([512, 282], 60, 18)), { fill: hex("#7a1f2b"), ink: 4, thick: 14 });
  for (const s of [-1, 1]) head.paint(poly([[512 + s * 34, 296], [512 + s * 22, 296], [512 + s * 28, 322]]), { fill: claw, ink: 3, thick: 8, gloss: 0.4 });
  return { back, legs, torso, arms, head };
}

// --- robot: rounded metal parts, glowing joints and a screen face ---------------------------
function robot() {
  const metal = hex("#bcc6d0"), steel = hex("#8a96a4"), dark = hex("#4a535e"), cyan = hex("#4de1ff"), red = hex("#ff4d4d");
  const core = (l, at, r) => {
    l.paint(circle(at, r), { fill: dark, thick: r });
    l.paint(circle(at, r * 0.55), { fill: cyan, ink: 0, thick: r * 0.6, glow: 0.45, gloss: 0.4 });
  };
  const legs = LIMBS.map((sd) => {
    const l = new Layer(`leg_${sd.s.toLowerCase()}`);
    l.limb(capsule(add(sd.hip, [0, -10]), sd.kn, 48, 42), sd.hip, sd.kn, { fill: metal, thick: 44, gloss: 0.4 });
    l.paint(capsule(sd.kn, sd.an, 42, 34), { fill: steel, thick: 40, gloss: 0.4 });
    l.paint(ring(capsule(add(sd.kn, [0, 90]), add(sd.kn, [0, 200]), 22), 4), { fill: dark, ink: 0, shade: false, alpha: 0.6 });
    core(l, sd.kn, 40);
    l.paint(box(add(lerp(sd.an, sd.toe, 0.5), [0, 22]), 70, 28, 22), { fill: dark, thick: 28, gloss: 0.3 });
    core(l, sd.an, 26);
    return l;
  });
  const torso = new Layer("torso");
  torso.paint(round(poly([[350, 372], [674, 372], [640, 600], [384, 600]]), 30), { fill: metal, thick: 90, gloss: 0.45 });
  [640, 700, 760].forEach((y, i) => torso.paint(box([512, y], 118 - i * 4, 30, 20), { fill: steel, thick: 26, gloss: 0.35 }));
  torso.paint(box([512, 830], 150, 42, 28), { fill: dark, thick: 34, gloss: 0.3 });
  core(torso, [512, 470], 60);
  torso.paint(ring(circle([512, 470], 82), 6), { fill: steel, ink: 3, thick: 6 });
  for (const [x, y] of [[392, 400], [632, 400], [404, 570], [620, 570]]) torso.paint(circle([x, y], 9), { fill: steel, ink: 3, thick: 9, gloss: 0.6 });
  for (let i = 0; i < 3; i++) for (const s of [-1, 1]) torso.paint(capsule([512 + s * 100, 452 + i * 20], [512 + s * 128, 452 + i * 20], 4), { fill: dark, ink: 0, shade: false });
  const arms = LIMBS.map((sd) => {
    const l = new Layer(`arm_${sd.s.toLowerCase()}`);
    l.paint(capsule(sd.sh, sd.el, 36, 32), { fill: steel, thick: 34, gloss: 0.4 });
    l.paint(capsule(sd.el, sd.wr, 34, 42), { fill: metal, thick: 40, gloss: 0.45 });
    l.paint(ring(capsule(lerp(sd.el, sd.wr, 0.55), lerp(sd.el, sd.wr, 0.9), 30), 4), { fill: dark, ink: 0, shade: false, alpha: 0.5 });
    core(l, sd.el, 34);
    l.paint(circle(sd.sh, 56), { fill: metal, thick: 50, gloss: 0.5 });
    const d = unit(sub(sd.hand, sd.wr)), n = perp(d);
    for (const s of [-1, 0, 1]) {
      const b = add(lerp(sd.wr, sd.hand, 0.55), mul(n, s * 18));
      l.paint(chain(6, [b, add(b, add(mul(d, 34), mul(n, s * 10))), add(b, add(mul(d, 58), mul(n, s * 2)))], [10, 9, 7]), { fill: dark, ink: 3.5, thick: 9, gloss: 0.4 });
    }
    l.paint(circle(lerp(sd.wr, sd.hand, 0.4), 32), { fill: steel, thick: 30, gloss: 0.4 });
    return l;
  });
  const head = new Layer("head");
  head.paint(capsule([512, 290], [512, 372], 36), { fill: dark, thick: 30 });
  [310, 336].forEach((y) => head.paint(ring(capsule([476, y], [548, y], 0), 3), { fill: steel, ink: 0, shade: false }));
  head.paint(capsule([512, 96], [512, 46], 5), { fill: steel, ink: 3, thick: 5 });
  head.paint(circle([512, 40], 17), { fill: red, ink: 3.5, thick: 17, gloss: 0.6, glow: 0.2 });
  for (const s of [-1, 1]) core(head, [512 + s * 124, 214], 34);
  head.paint(box([512, 210], 124, 114, 50), { fill: metal, thick: 90, gloss: 0.5 });
  head.paint(box([512, 218], 94, 64, 28), { fill: hex("#14212d"), ink: 4, thick: 30, gloss: 0.35 });
  for (const s of [-1, 1]) head.paint(box([512 + s * 42, 206], 16, 20, 9), { fill: cyan, ink: 0, thick: 14, glow: 0.5 });
  for (let i = 0; i < 5; i++) head.paint(box([476 + i * 18, 254], 5, 8 - Math.abs(i - 2) * 2, 2.5), { fill: cyan, ink: 0, shade: false, alpha: 0.85 });
  return { back: new Layer("back"), legs, torso, arms, head };
}

// --- farmer: plaid shirt, dungarees, boots and a straw hat, with the player's own face --------
function farmer() {
  const denim = (x, y) => mixc(hex("#4373bb"), hex("#365f9f"), fbm(x / 3, y / 40) * 0.8);
  const plaid = (x, y) => {
    let c = hex("#c8423b");
    const mx = ((x % 52) + 52) % 52, my = ((y % 52) + 52) % 52;
    if (mx < 16) c = mul3(c, 0.72);
    if (my < 16) c = mul3(c, 0.72);
    if (mx > 33 && mx < 36) c = mixc(c, hex("#f0d58a"), 0.6);
    if (my > 33 && my < 36) c = mixc(c, hex("#f0d58a"), 0.6);
    return c;
  };
  const mul3 = (c, k) => c.map((v) => v * k);
  const straw = (x, y) => mixc(hex("#ecc865"), hex("#c99a3a"), smooth(0.4, 0.9, Math.abs(Math.sin(x / 5 + Math.sin(y / 9))) * 0.6 + fbm(x / 6, y / 6) * 0.4));
  const leather = hex("#b07a43"), boot = hex("#6b4226"), brass = hex("#e1b64a");
  const stitch = (l, a, b) => {
    const n = Math.floor(len(sub(b, a)) / 16);
    for (let i = 0; i < n; i++) l.paint(capsule(lerp(a, b, (i + 0.15) / n), lerp(a, b, (i + 0.6) / n), 2), { fill: hex("#f0c069"), ink: 0, shade: false });
  };
  const legs = LIMBS.map((sd) => {
    const l = new Layer(`leg_${sd.s.toLowerCase()}`);
    l.limb(chain(22, [add(sd.hip, [0, -30]), sd.kn, add(sd.an, [0, -10])], [60, 52, 48]), sd.hip, sd.kn, { fill: denim, thick: 54 });
    stitch(l, add(sd.hip, [sd.out * 50, 0]), add(sd.an, [sd.out * 42, -80]));
    l.paint(box(add(sd.an, [0, -64]), 52, 18, 10), { fill: hex("#5b87cc"), ink: 4, thick: 16 });
    l.paint(blend(18, capsule(add(sd.an, [0, -46]), sd.an, 46, 46), capsule(sd.an, add(sd.toe, [0, -8]), 44, 36)), { fill: boot, thick: 40, gloss: 0.3 });
    l.paint(clip(capsule(sd.an, add(sd.toe, [0, -8]), 44, 36), sole(sd, 44, 28, 14)), { fill: hex("#2e1d14"), ink: 3, thick: 10 });
    return l;
  });
  const torso = new Layer("torso");
  const body = torsoShape(10);
  torso.paint(body, { fill: plaid, thick: 100 });
  for (const s of [-1, 1]) torso.paint(round(poly([[512, 352], [512 + s * 70, 340], [512 + s * 52, 410]]), 4), { fill: plaid, ink: 4, thick: 20 });
  const bib = clip(torsoShape(14), poly([[408, 560], [616, 560], [660, 900], [364, 900]]));
  torso.paint(bib, { fill: denim, thick: 60 });
  for (const s of [-1, 1]) {
    const top = [512 + s * 92, 572], sh = [512 + s * 110, 372];
    torso.paint(capsule(top, sh, 17), { fill: denim, thick: 16 });
    torso.paint(circle(top, 12), { fill: brass, ink: 3, thick: 12, gloss: 0.6 });
  }
  torso.paint(box([512, 640], 56, 42, 8), { fill: denim, ink: 4, thick: 30 });
  stitch(torso, [460, 610], [564, 610]);
  stitch(torso, [420, 570], [420, 840]);
  stitch(torso, [604, 570], [604, 840]);
  const arms = LIMBS.map((sd) => {
    const l = new Layer(`arm_${sd.s.toLowerCase()}`);
    l.limb(chain(18, [add(sd.sh, [sd.out * -14, 4]), sd.el, sd.wr], [50, 44, 40]), sd.sh, sd.el, { fill: plaid, thick: 46 });
    const d = unit(sub(sd.wr, sd.el)), n = perp(d);
    l.paint(capsule(add(sub(sd.wr, mul(d, 22)), mul(n, 42)), sub(sub(sd.wr, mul(d, 22)), mul(n, 42)), 16), { fill: hex("#9f3530"), ink: 4, thick: 14 });
    l.paint(blend(10, handShape(sd, 34, 46), thumb(sd, 14)), { fill: leather, thick: 34, gloss: 0.15 });
    return l;
  });
  const head = new Layer("head");
  head.paint(ellipse([512, 130], 206, 48), { fill: straw, thick: 40 });
  head.paint(box([512, 78], 98, 60, 44), { fill: straw, thick: 60 });
  head.paint(clip(box([512, 78], 98, 60, 44), box([512, 116], 110, 13)), { fill: hex("#c8423b"), ink: 3, thick: 10 });
  // a stalk of wheat at the corner of the mouth
  head.paint(capsule([538, 274], [640, 300], 3.5), { fill: hex("#e8c35a"), ink: 2.5, shade: false });
  for (let i = 0; i < 5; i++) {
    const at = [640 + i * 10, 300 + i * 2.5];
    for (const s of [-1, 1]) head.paint(ellipse(add(at, [4, s * 7]), 8, 4, 0.25 + s * 0.5), { fill: hex("#e8c35a"), ink: 2, thick: 4 });
  }
  return { back: new Layer("back"), legs, torso, arms, head };
}

// --- side views: the costume's own limbs at the side pose, plus a profile torso, head and back -----
const SIDE_ART = {
  template() {
    const skin = hex("#d9d3ca");
    const torso = new Layer("torso").paint(sideTorso(), { fill: skin, thick: 80 });
    const head = new Layer("head").limb(blend(8, capsule([C - 14, 300], [C - 14, 372], 32),
      blend(16, ellipse([C - 4, 205], 94, 102), ellipse([C + 40, 266], 48, 46), circle(K.nose, 13)), ellipse(K.ear, 14, 24)), [C - 14, 352], [C - 14, 200], { fill: skin, thick: 70 });
    head.paint(ellipse(K.eye, 6, 7), { fill: hex("#5d5750"), ink: 0, shade: false });
    head.paint(capsule(add(K.mouth, [-14, -1]), K.mouth, 4), { fill: hex("#8f6f6a"), ink: 0, shade: false });
    return { back: new Layer("back"), torso, head };
  },
  astronaut() {
    const white = hex("#f3f2ee"), grey = hex("#a7aeb8"), dark = hex("#3a404a"), gold = hex("#e2b33c");
    const back = new Layer("back")
      .paint(box([C - 118, 560], 66, 214, 34), { fill: grey, thick: 50 })
      .paint(capsule([C - 172, 420], [C - 172, 700], 26), { fill: hex("#d5d9de"), thick: 26, gloss: 0.3 });
    const torso = new Layer("torso");
    const body = sideTorso(14);
    torso.paint(body, { fill: white, thick: 90 });
    torso.paint(clip(body, box([C, 800], 200, 22)), { fill: grey, ink: 4, thick: 18 });
    torso.paint(box([C + 92, 536], 16, 52, 8), { fill: dark, thick: 12, gloss: 0.35 });
    const head = new Layer("head");
    head.paint(ellipse([C, 352], 96, 40), { fill: grey, thick: 30 });
    const visor = ellipse([C + 70, 232], 76, 104);
    head.paint(cut(circle([C, 222], 160), visor), { fill: white, thick: 60, gloss: 0.25 });
    head.paint(clip(ring(visor, 12), circle([C, 222], 162)), { fill: gold, ink: 3, thick: 6, gloss: 0.5 });
    head.paint(clip(visor, circle([C, 222], 160)), { fill: hex("#8cc2ff"), ink: 0, shade: false, alpha: 0.13 });
    head.paint(clip(ring(ellipse([C + 70, 232], 58, 86), 12), poly([[C, 120], [C + 120, 120], [C + 100, 170], [C + 40, 230], [C, 260]])), { fill: [1, 1, 1], ink: 0, shade: false, alpha: 0.7 });
    head.paint(box([C - 60, 160], 26, 30, 8), { fill: grey, thick: 16 });
    head.paint(capsule([C - 40, 72], [C - 70, 16], 5), { fill: grey, ink: 3, thick: 5 });
    head.paint(circle([C - 72, 14], 12), { fill: hex("#ff4d4d"), ink: 3, thick: 12, gloss: 0.5 });
    return { back, torso, head };
  },
  werewolf() {
    const furA = hex("#5d3d27"), furB = hex("#3b2617"), tan = hex("#b8905f"), purple = hex("#6c40a3"), claw = hex("#f4eedf");
    const fur = (x, y) => mixc(furA, furB, smooth(0.35, 0.75, fbm(x / 22, y / 7)));
    const belly = (x, y) => mixc(tan, hex("#94704a"), smooth(0.3, 0.8, fbm(x / 18, y / 6)));
    const back = new Layer("back")
      .paint(shaggy(chain(30, [[C - 50, 790], [C - 150, 880], [C - 210, 990], [C - 196, 1070]], [34, 58, 50, 18]), 12, 10), { fill: fur, thick: 50 });
    const torso = new Layer("torso");
    torso.paint(shaggy(sideTorso(10), 10, 10), { fill: fur, thick: 90 });
    torso.paint(shaggy(ellipse([C + 58, 590], 40, 170), 8, 8), { fill: belly, ink: 0, thick: 40 });
    torso.paint(clip(sideTorso(14), S((x, y) => 778 - y + 6 * Math.sin(x / 9), [0, 0, W, H])), { fill: purple, thick: 60 });
    torso.paint(clip(sideTorso(14), box([C, 790], 220, 12)), { fill: hex("#4a2a75"), ink: 3, thick: 10 });
    const head = new Layer("head");
    head.paint(shaggy(ellipse([C - 20, 300], 128, 86), 16, 9), { fill: (x, y) => mixc(furB, furA, fbm(x / 20, y / 6) * 0.6), thick: 60 });
    head.paint(round(poly([[C - 50, 120], [C - 82, 0], [C + 20, 100]]), 8), { fill: furB, thick: 30 });
    head.paint(round(poly([[C - 36, 112], [C - 62, 36], [C + 2, 104]]), 4), { fill: hex("#c98b7a"), ink: 0, thick: 20 });
    head.paint(blend(26, shaggy(ellipse([C - 10, 205], 104, 110), 7, 8), capsule([C + 40, 248], [C + 128, 262], 46, 30)), { fill: fur, thick: 80 });
    head.paint(capsule([C + 50, 282], [C + 122, 284], 26, 18), { fill: tan, thick: 24 });
    head.paint(ellipse([C + 140, 252], 18, 14), { fill: hex("#1c1418"), ink: 3, thick: 12, gloss: 0.6 });
    head.paint(ellipse([C + 58, 194], 24, 14, 0.25), { fill: hex("#ffd23c"), ink: 4, thick: 12, glow: 0.35 });
    head.paint(ellipse([C + 64, 194], 5, 12), { fill: INK, ink: 0, shade: false });
    head.paint(capsule([C + 22, 170], [C + 90, 166], 9, 5), { fill: furB, ink: 3, thick: 8 });
    head.paint(capsule([C + 40, 288], [C + 132, 282], 2.5), { fill: INK, ink: 0, shade: false });
    head.paint(poly([[C + 100, 284], [C + 88, 284], [C + 94, 310]]), { fill: claw, ink: 3, thick: 8, gloss: 0.4 });
    return { back, torso, head };
  },
  robot() {
    const metal = hex("#bcc6d0"), steel = hex("#8a96a4"), dark = hex("#4a535e"), cyan = hex("#4de1ff"), red = hex("#ff4d4d");
    const back = new Layer("back").paint(box([C - 112, 490], 34, 80, 16), { fill: steel, thick: 26, gloss: 0.4 });
    const torso = new Layer("torso");
    torso.paint(box([C + 4, 480], 92, 112, 34), { fill: metal, thick: 80, gloss: 0.45 });
    [640, 700, 760].forEach((y) => torso.paint(box([C, y], 72, 28, 18), { fill: steel, thick: 24, gloss: 0.35 }));
    torso.paint(box([C, 830], 92, 40, 26), { fill: dark, thick: 30, gloss: 0.3 });
    torso.paint(ellipse([C + 94, 470], 12, 40), { fill: cyan, ink: 3, thick: 12, glow: 0.45 });
    const head = new Layer("head");
    head.paint(capsule([C, 290], [C, 372], 34), { fill: dark, thick: 30 });
    head.paint(capsule([C - 10, 96], [C - 10, 46], 5), { fill: steel, ink: 3, thick: 5 });
    head.paint(circle([C - 10, 40], 17), { fill: red, ink: 3.5, thick: 17, gloss: 0.6, glow: 0.2 });
    head.paint(box([C + 6, 210], 110, 114, 46), { fill: metal, thick: 90, gloss: 0.5 });
    head.paint(box([C + 92, 218], 30, 64, 16), { fill: hex("#14212d"), ink: 4, thick: 20, gloss: 0.35 });
    head.paint(box([C + 98, 206], 9, 20, 6), { fill: cyan, ink: 0, thick: 10, glow: 0.5 });
    head.paint(circle([C - 14, 214], 34), { fill: dark, thick: 34 });
    head.paint(circle([C - 14, 214], 19), { fill: cyan, ink: 0, thick: 20, glow: 0.45, gloss: 0.4 });
    return { back, torso, head };
  },
  farmer() {
    const denim = (x, y) => mixc(hex("#4373bb"), hex("#365f9f"), fbm(x / 3, y / 40) * 0.8);
    const plaid = (x, y) => {
      let c = hex("#c8423b");
      const mx = ((x % 52) + 52) % 52, my = ((y % 52) + 52) % 52;
      if (mx < 16) c = c.map((v) => v * 0.72);
      if (my < 16) c = c.map((v) => v * 0.72);
      if ((mx > 33 && mx < 36) || (my > 33 && my < 36)) c = mixc(c, hex("#f0d58a"), 0.6);
      return c;
    };
    const straw = (x, y) => mixc(hex("#ecc865"), hex("#c99a3a"), smooth(0.4, 0.9, Math.abs(Math.sin(x / 5 + Math.sin(y / 9))) * 0.6 + fbm(x / 6, y / 6) * 0.4));
    const torso = new Layer("torso");
    torso.paint(sideTorso(10), { fill: plaid, thick: 90 });
    torso.paint(clip(sideTorso(14), poly([[C - 10, 560], [C + 200, 560], [C + 200, 900], [C - 10, 900]])), { fill: denim, thick: 50 });
    torso.paint(clip(sideTorso(14), box([C, 840], 200, 64)), { fill: denim, thick: 50 });
    torso.paint(capsule([C + 30, 572], [C + 4, 372], 15), { fill: denim, thick: 14 });
    torso.paint(circle([C + 30, 572], 11), { fill: hex("#e1b64a"), ink: 3, thick: 11, gloss: 0.6 });
    const head = new Layer("head");
    head.paint(ellipse([C + 20, 130], 206, 44), { fill: straw, thick: 40 });
    head.paint(box([C, 78], 98, 60, 44), { fill: straw, thick: 60 });
    head.paint(clip(box([C, 78], 98, 60, 44), box([C, 116], 110, 13)), { fill: hex("#c8423b"), ink: 3, thick: 10 });
    head.paint(capsule([C + 66, 278], [C + 170, 302], 3.5), { fill: hex("#e8c35a"), ink: 2.5, shade: false });
    for (let i = 0; i < 5; i++) for (const s of [-1, 1]) head.paint(ellipse([C + 174 + i * 10, 304 + i * 2.5 + s * 7], 8, 4, 0.25 + s * 0.5), { fill: hex("#e8c35a"), ink: 2, thick: 4 });
    return { back: new Layer("back"), torso, head };
  },
};

// --- balls: painted inside BALL's circle, they replace the game's ball -----------------------------
const B = BALL.at;
const BALL_ART = {
  template: (l) => l.paint(circle(B, 88), { fill: hex("#d9d3ca"), thick: 88 }),
  // a lumpy space rock with craters
  astronaut(l) {
    const rock = (x, y) => mixc(hex("#8d8178"), hex("#5f554e"), smooth(0.3, 0.8, fbm(x / 26, y / 26)));
    l.paint(shaggy(circle(B, 82), 9, 30), { fill: rock, thick: 80, gloss: 0.05 });
    for (const [dx, dy, r] of [[-30, -26, 20], [28, 8, 14], [-6, 40, 11], [38, -36, 9], [-44, 22, 7]]) {
      l.paint(circle(add(B, [dx, dy]), r), { fill: hex("#4e4540"), ink: 0, thick: r, shade: true });
      l.paint(clip(ring(circle(add(B, [dx, dy]), r), 3), circle(add(B, [dx + r * 0.4, dy + r * 0.4]), r)), { fill: hex("#a89c92"), ink: 0, shade: false, alpha: 0.8 });
    }
  },
  // a glowing full moon
  werewolf(l) {
    l.paint(circle(B, 98), { fill: hex("#fff3b0"), ink: 0, shade: false, alpha: 0.25 });
    l.paint(circle(B, 84), { fill: (x, y) => mixc(hex("#fff6cf"), hex("#e8d790"), smooth(0.35, 0.75, fbm(x / 30, y / 30))), thick: 84, glow: 0.15 });
    for (const [dx, dy, r] of [[-26, -20, 18], [24, 14, 22], [-10, 38, 10], [36, -34, 8]]) l.paint(circle(add(B, [dx, dy]), r), { fill: hex("#d9c57a"), ink: 0, thick: r, alpha: 0.7 });
  },
  // a gear with a glowing hub
  robot(l) {
    const teeth = Array.from({ length: 10 }, (_, i) => box(add(B, mul([Math.cos((i * Math.PI) / 5), Math.sin((i * Math.PI) / 5)], 72)), 14, 18, 5, (i * Math.PI) / 5));
    l.paint(cut(blend(6, circle(B, 70), ...teeth), circle(B, 24)), { fill: hex("#b8c2cc"), thick: 60, gloss: 0.5 });
    l.paint(ring(circle(B, 46), 6), { fill: hex("#8a96a4"), ink: 2.5, thick: 6 });
    l.paint(ring(circle(B, 24), 8), { fill: hex("#4de1ff"), ink: 3, thick: 8, glow: 0.4 });
  },
  // the end of a round hay bale: straw rolled in a spiral, with loose wisps at the edge
  farmer(l) {
    const roll = (x, y) => {
      const dx = x - B[0], dy = y - B[1], spiral = Math.sin(Math.hypot(dx, dy) / 6 - Math.atan2(dy, dx));
      return mixc(hex("#e9c868"), hex("#b98d34"), smooth(0.2, 0.9, spiral * 0.5 + 0.5) * 0.6 + fbm(x / 5, y / 5) * 0.4);
    };
    l.paint(shaggy(circle(B, 86), 6, 4), { fill: roll, thick: 86 });
    l.paint(ring(circle(B, 70), 7), { fill: hex("#c8423b"), ink: 2.5, thick: 6, alpha: 0.85 });
  },
};

fs.mkdirSync(OUT, { recursive: true });
const only = process.argv[2];
for (const [name, make] of Object.entries({ template, astronaut, werewolf, robot, farmer })) {
  if (only && only !== name) continue;
  LIMBS = SIDES;
  const f = make();
  LIMBS = SIDE_LIMBS;
  const limbs = make(), s = SIDE_ART[name]();
  const [legFar, legNear] = limbs.legs, [armFar, armNear] = limbs.arms;
  legFar.darken(0.8);
  armFar.darken(0.8);
  const ball = new Layer("ball");
  BALL_ART[name](ball);
  // arms in front of the head (raised overhead or across the face); in the side view only the near arm
  writeCostume(name, [f.back, ...f.legs, f.torso, f.head, ...f.arms, ball], [armFar, legFar, s.back, s.torso, legNear, s.head, armNear], name === "template");
}
