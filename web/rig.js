// Costumes on the players: each costume is a layered PSD painted over the template's rest pose
// (costumes/template.psd, joints in rest.js). Every layer becomes a mesh whose vertices are weighted
// to the bones of its part (smooth falloff, so joints bend softly instead of creasing), and each
// frame the bones are moved to the player's tracked pose and the meshes are skinned and drawn with
// WebGL. Layers draw in the PSD's order; hidden layers and "guide" are skipped. The c key cycles
// the costume; ?skin=astronaut (werewolf, robot, farmer, template, mix) starts with one.
import { add, sub, mul, norm, OneEuro } from "./common.js";
import { SIZE, REST, BONES, PARTS } from "./rest.js";

export const SKINS = ["none", "astronaut", "werewolf", "robot", "farmer", "template", "mix"];
const CAST = ["astronaut", "werewolf", "robot", "farmer"];
const AG_PSD = "https://cdn.jsdelivr.net/npm/ag-psd@31.0.3/dist/bundle.js"; // same version as tools/costumes
const VIS = 0.5; // landmark visibility that counts a joint as tracked
const GRACE_S = 0.4; // keep drawing a body this long after it drops out of tracking
const SAME = 0.25; // a body this close (x screen width) to one drawn last frame is the same player
const GRID = 12; // mesh cell size on the template, px
const SOFT = 10; // px added to every bone distance: how gently weights blend near a joint
const FALLOFF = 4; // weight = 1 / (distance + SOFT)^FALLOFF, then the strongest 3 kept

// joint -> MediaPipe pose landmark(s) (an array is their midpoint)
const LANDMARK = {
  earL: 7, earR: 8, shL: 11, shR: 12, elL: 13, elR: 14, wrL: 15, wrR: 16, handL: [17, 19], handR: [18, 20],
  hipL: 23, hipR: 24, knL: 25, knR: 26, anL: 27, anR: 28, toeL: 31, toeR: 32,
};
// a bone whose joints aren't tracked carries on rigidly from its parent (an arm hangs from the chest)
const PARENT = {
  pelvis: "chest", head: "chest", upperL: "chest", foreL: "upperL", handL: "foreL", upperR: "chest", foreR: "upperR", handR: "foreR",
  thighL: "pelvis", shinL: "thighL", footL: "shinL", thighR: "pelvis", shinR: "thighR", footR: "shinR",
};
const BONE_NAMES = Object.keys(BONES);
const REST_SHOULDERS = norm(sub(REST.shR, REST.shL));
const REST_TORSO = norm(sub(mul(add(REST.hipL, REST.hipR), 0.5), mul(add(REST.shL, REST.shR), 0.5)));

const distToSeg = (p, a, b) => {
  const ab = sub(b, a), t = Math.max(0, Math.min(1, ((p[0] - a[0]) * ab[0] + (p[1] - a[1]) * ab[1]) / ((ab[0] ** 2 + ab[1] ** 2) || 1)));
  return norm(sub(p, add(a, mul(ab, t))));
};

// --- loading a costume --------------------------------------------------------------------
let agPsd = null;
async function readPsd(url) {
  if (!agPsd) {
    await import(AG_PSD);
    agPsd = window.agPsd;
  }
  const buf = await (await fetch(url, { cache: "no-cache" })).arrayBuffer(); // pick up a re-saved PSD on reload
  return agPsd.readPsd(buf, { useImageData: true, skipCompositeImageData: true, skipThumbnail: true, skipLinkedFilesData: true });
}

// PSD layers (groups flattened, bottom to top) that belong to a part, by their own or a group's name
function partLayers(nodes, inherited = null, out = []) {
  for (const n of nodes || []) {
    if (n.hidden) continue;
    const word = (n.name || "").trim().toLowerCase().split(/\s+/)[0];
    const part = PARTS[word] ? word : inherited;
    if (n.children) partLayers(n.children, part, out);
    else if (part && n.imageData && n.imageData.width > 0) out.push({ part, layer: n });
  }
  return out;
}

// a grid mesh over a layer's painted pixels, each vertex weighted to its part's bones
function buildMesh(layer, part) {
  const { left, top, imageData: img } = layer, w = img.width, h = img.height;
  const cols = Math.ceil(w / GRID), rows = Math.ceil(h / GRID);
  const solid = (cx, cy) => {
    for (let y = Math.max(0, cy * GRID - 1); y < Math.min(h, (cy + 1) * GRID + 1); y++)
      for (let x = Math.max(0, cx * GRID - 1); x < Math.min(w, (cx + 1) * GRID + 1); x++) if (img.data[(y * w + x) * 4 + 3] > 4) return true;
    return false;
  };
  const vid = new Map(), rest = [], uv = [], idx = [];
  const vert = (gx, gy) => {
    const k = gy * (cols + 1) + gx;
    if (!vid.has(k)) {
      const x = Math.min(gx * GRID, w), y = Math.min(gy * GRID, h);
      vid.set(k, rest.length / 2);
      rest.push(left + x, top + y);
      uv.push(x / w, y / h);
    }
    return vid.get(k);
  };
  for (let cy = 0; cy < rows; cy++) for (let cx = 0; cx < cols; cx++) {
    if (!solid(cx, cy)) continue;
    const a = vert(cx, cy), b = vert(cx + 1, cy), c = vert(cx, cy + 1), d = vert(cx + 1, cy + 1);
    idx.push(a, b, c, b, d, c);
  }
  // weights: inverse distance to each bone of the part (scaled by its reach), strongest 3 kept
  const bones = Object.entries(PARTS[part]).map(([name, reach]) => ({ i: BONE_NAMES.indexOf(name), a: REST[BONES[name].from], b: REST[BONES[name].to], reach }));
  const n = rest.length / 2, wb = new Uint8Array(n * 3), ww = new Float32Array(n * 3);
  for (let v = 0; v < n; v++) {
    const p = [rest[2 * v], rest[2 * v + 1]];
    const ws = bones.map((bn) => ({ i: bn.i, w: 1 / Math.pow(distToSeg(p, bn.a, bn.b) / bn.reach + SOFT, FALLOFF) }))
      .sort((x, y) => y.w - x.w).slice(0, 3);
    const sum = ws.reduce((s, x) => s + x.w, 0);
    ws.forEach((x, k) => {
      wb[v * 3 + k] = x.i;
      ww[v * 3 + k] = x.w / sum;
    });
  }
  return { rest: new Float32Array(rest), uv: new Float32Array(uv), idx: new Uint16Array(idx), wb, ww, img, out: new Float32Array(rest.length) };
}

// --- posing -------------------------------------------------------------------------------
// The affine map taking a bone from its rest segment (a0 -> b0) onto its live one (a -> b): along
// the bone it stretches with the bone's tracked length, across it scales with the body's size
// (so a limb pointing at the camera foreshortens without getting thinner). As [m00, m01, m10, m11, tx, ty].
function boneMap(a0, b0, a, b, across, uniform) {
  const d0 = sub(b0, a0), L0 = norm(d0), t0 = mul(d0, 1 / L0), n0 = [-t0[1], t0[0]];
  const d = sub(b, a), L = Math.max(norm(d), 1e-3), t = mul(d, 1 / L), n = [-t[1], t[0]];
  const k = L / L0, c = uniform ? k : across;
  const m00 = k * t[0] * t0[0] + c * n[0] * n0[0], m01 = k * t[0] * t0[1] + c * n[0] * n0[1];
  const m10 = k * t[1] * t0[0] + c * n[1] * n0[0], m11 = k * t[1] * t0[1] + c * n[1] * n0[1];
  return [m00, m01, m10, m11, a[0] - (m00 * a0[0] + m01 * a0[1]), a[1] - (m10 * a0[0] + m11 * a0[1])];
}

// tracked joints (court px, visibility) -> one affine map per bone, or null without shoulders
function poseBones(P) {
  const joint = (name) => {
    const l = LANDMARK[name];
    if (Array.isArray(l)) {
      const [p, q] = l.map((j) => P[j]);
      return p[2] >= VIS && q[2] >= VIS ? mul(add(p, q), 0.5) : null;
    }
    return P[l][2] >= VIS ? P[l].slice(0, 2) : null;
  };
  const shL = joint("shL"), shR = joint("shR");
  if (!shL || !shR) return null;
  // body size: shoulder width, or the torso's length when the player turns side-on
  const hipL = joint("hipL"), hipR = joint("hipR");
  let size = norm(sub(shR, shL)) / REST_SHOULDERS;
  if (hipL && hipR) size = Math.max(size, (0.85 * norm(sub(mul(add(hipL, hipR), 0.5), mul(add(shL, shR), 0.5)))) / REST_TORSO);
  const maps = {};
  for (const name of BONE_NAMES) {
    const bone = BONES[name], a = joint(bone.from), b = joint(bone.to);
    // the shoulder-to-elbow and hip-to-knee bones start where the chest and pelvis put them
    if (a && b && norm(sub(b, a)) > 2) maps[name] = boneMap(REST[bone.from], REST[bone.to], a, b, size, bone.uniform);
    else maps[name] = maps[PARENT[name]];
  }
  return BONE_NAMES.map((n) => maps[n]);
}

function skin(mesh, maps) {
  const { rest, wb, ww, out } = mesh, n = rest.length / 2;
  for (let v = 0; v < n; v++) {
    const x = rest[2 * v], y = rest[2 * v + 1];
    let ox = 0, oy = 0;
    for (let k = 0; k < 3; k++) {
      const w = ww[v * 3 + k];
      if (!w) continue;
      const m = maps[wb[v * 3 + k]];
      ox += w * (m[0] * x + m[1] * y + m[4]);
      oy += w * (m[2] * x + m[3] * y + m[5]);
    }
    out[2 * v] = ox;
    out[2 * v + 1] = oy;
  }
  return out;
}

// --- drawing ------------------------------------------------------------------------------
const VERT = `attribute vec2 pos; attribute vec2 uv; uniform vec2 res; varying vec2 vUv;
void main() { vUv = uv; gl_Position = vec4(pos / res * vec2(2.0, -2.0) + vec2(-1.0, 1.0), 0.0, 1.0); }`;
const FRAG = `precision mediump float; varying vec2 vUv; uniform sampler2D tex; uniform float alpha;
void main() { gl_FragColor = texture2D(tex, vUv) * alpha; }`;

class GL {
  constructor() {
    this.canvas = document.createElement("canvas");
    const gl = (this.gl = this.canvas.getContext("webgl", { premultipliedAlpha: true, antialias: true }));
    if (!gl) return;
    const sh = (type, src) => {
      const s = gl.createShader(type);
      gl.shaderSource(s, src);
      gl.compileShader(s);
      return s;
    };
    const p = (this.prog = gl.createProgram());
    gl.attachShader(p, sh(gl.VERTEX_SHADER, VERT));
    gl.attachShader(p, sh(gl.FRAGMENT_SHADER, FRAG));
    gl.linkProgram(p);
    gl.useProgram(p);
    this.loc = { pos: gl.getAttribLocation(p, "pos"), uv: gl.getAttribLocation(p, "uv"), res: gl.getUniformLocation(p, "res"), alpha: gl.getUniformLocation(p, "alpha") };
    this.posBuf = gl.createBuffer();
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, true);
  }
  // upload a mesh's texture, uvs and triangles once
  upload(mesh) {
    const gl = this.gl;
    mesh.tex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, mesh.tex);
    const { width, height, data } = mesh.img;
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, width, height, 0, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array(data.buffer, data.byteOffset, data.byteLength));
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    mesh.uvBuf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, mesh.uvBuf);
    gl.bufferData(gl.ARRAY_BUFFER, mesh.uv, gl.STATIC_DRAW);
    mesh.idxBuf = gl.createBuffer();
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, mesh.idxBuf);
    gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, mesh.idx, gl.STATIC_DRAW);
  }
  begin(W, H) {
    const gl = this.gl, dpr = Math.min(devicePixelRatio || 1, 2);
    const cw = Math.round(W * dpr), ch = Math.round(H * dpr);
    if (this.canvas.width !== cw || this.canvas.height !== ch) [this.canvas.width, this.canvas.height] = [cw, ch];
    gl.viewport(0, 0, cw, ch);
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);
    gl.uniform2f(this.loc.res, W, H);
  }
  draw(mesh, pos, alpha) {
    const gl = this.gl, L = this.loc;
    gl.bindBuffer(gl.ARRAY_BUFFER, this.posBuf);
    gl.bufferData(gl.ARRAY_BUFFER, pos, gl.DYNAMIC_DRAW);
    gl.enableVertexAttribArray(L.pos);
    gl.vertexAttribPointer(L.pos, 2, gl.FLOAT, false, 0, 0);
    gl.bindBuffer(gl.ARRAY_BUFFER, mesh.uvBuf);
    gl.enableVertexAttribArray(L.uv);
    gl.vertexAttribPointer(L.uv, 2, gl.FLOAT, false, 0, 0);
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, mesh.idxBuf);
    gl.bindTexture(gl.TEXTURE_2D, mesh.tex);
    gl.uniform1f(L.alpha, alpha);
    gl.drawElements(gl.TRIANGLES, mesh.idx.length, gl.UNSIGNED_SHORT, 0);
  }
}

// --- players ------------------------------------------------------------------------------
class Body {
  constructor(n) {
    this.filters = Array.from({ length: 33 }, () => new OneEuro(1.2, 0.02, 2.0));
    this.P = null;
    this.t = null;
    this.seen = -1e9;
    this.at = null;
    this.skin = CAST[n % CAST.length]; // for "mix"
  }
}

export class Costumes {
  constructor(skin) {
    this.skin = SKINS.includes(skin) ? skin : "none";
    this.gl = new GL();
    this.costumes = {}; // name -> [mesh] once loaded, a promise while loading
    this.bodies = [];
    this.frameN = -1;
    this.made = 0;
    this.changedAt = -1e9;
    this.load(this.skin);
  }

  load(name) {
    const names = name === "mix" ? CAST : name === "none" ? [] : [name];
    for (const n of names) {
      if (this.costumes[n] || !this.gl.gl) continue;
      this.costumes[n] = readPsd(`costumes/${n}.psd`).then((psd) => {
        const meshes = partLayers(psd.children).map(({ part, layer }) => {
          const m = buildMesh(layer, part);
          m.alpha = layer.opacity ?? 1;
          this.gl.upload(m);
          return m;
        });
        this.costumes[n] = meshes;
      }).catch((e) => {
        console.error(`costume ${n}:`, e);
        this.costumes[n] = [];
      });
    }
  }

  next(now) {
    this.skin = SKINS[(SKINS.indexOf(this.skin) + 1) % SKINS.length];
    this.changedAt = now;
    this.load(this.skin);
  }

  // follow each body from the newest tracking frame, smoothing its landmarks
  update(frame, toCourt, W) {
    if (this.skin === "none" || !frame || frame.n === this.frameN) return;
    this.frameN = frame.n;
    const found = frame.found.map((lm) => lm.map((q) => [...toCourt(q), q[2]]));
    const anchor = (P) => mul(add(P[11], P[12]), 0.5);
    const pairs = [];
    found.forEach((P, i) => this.bodies.forEach((b, j) => pairs.push([norm(sub(anchor(P), b.at)), i, j])));
    pairs.sort((x, y) => x[0] - y[0]);
    const matched = new Map(), taken = new Set();
    for (const [d, i, j] of pairs) {
      if (d > SAME * W || matched.has(i) || taken.has(j)) continue;
      matched.set(i, this.bodies[j]);
      taken.add(j);
    }
    found.forEach((P, i) => {
      let b = matched.get(i);
      if (!b) this.bodies.push((b = new Body(this.made++)));
      const dt = b.t === null ? 0 : frame.t - b.t;
      b.P = P.map((p, j) => [...b.filters[j].filter(p.slice(0, 2), dt), p[2]]);
      b.t = b.seen = frame.t;
      b.at = anchor(P).slice(0, 2);
    });
    this.bodies = this.bodies.filter((b) => frame.t - b.seen <= GRACE_S);
  }

  draw(c, now, W, H) {
    if (this.skin !== "none" && this.gl.gl && this.bodies.length) {
      this.gl.begin(W, H);
      let drew = false;
      for (const b of this.bodies) {
        const meshes = this.costumes[this.skin === "mix" ? b.skin : this.skin];
        if (!Array.isArray(meshes)) continue;
        const maps = poseBones(b.P);
        if (!maps) continue;
        const fade = Math.min(1, Math.max(0, 1 - (now - b.seen - GRACE_S * 0.5) / (GRACE_S * 0.5)));
        for (const m of meshes) this.gl.draw(m, skin(m, maps), m.alpha * fade);
        drew = true;
      }
      if (drew) c.drawImage(this.gl.canvas, 0, 0, W, H);
    }
    // the costume's name for a moment after it changes
    const age = now - this.changedAt;
    if (age < 1.5) {
      c.save();
      c.globalAlpha = Math.min(1, 1.5 - age);
      c.font = `bold ${Math.round(H * 0.06)}px system-ui, sans-serif`;
      c.textAlign = "center";
      c.lineWidth = 6;
      c.strokeStyle = "black";
      c.fillStyle = "white";
      const text = this.skin === "none" ? "no costume" : this.skin;
      c.strokeText(text, W / 2, H * 0.2);
      c.fillText(text, W / 2, H * 0.2);
      c.restore();
    }
  }
}
