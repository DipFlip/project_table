// Hand or body tracking off the main thread: game.js posts camera frames (ImageBitmaps), this
// worker runs MediaPipe on them and posts the landmarks back, so a slow detection never
// holds up drawing the ball. A body game can also ask for hands (`m.hands`): both run on each
// frame and hands come back alongside the bodies.
import { FilesetResolver, HandLandmarker, PoseLandmarker } from "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@1.1.1/vision_bundle.mjs";

let landmarker = null;
let handLandmarker = null; // optional, alongside the pose landmarker

// MediaPipe loads its WASM glue with importScripts, which module workers don't have; it then
// falls back to self.import(url). The glue is a classic script that defines a global
// ModuleFactory, so run it in the worker's global scope.
self.import = async (url) => {
  const src = await (await fetch(url)).text();
  (0, eval)(`${src}\n//# sourceURL=${url}`);
};

onmessage = async (e) => {
  const m = e.data;
  if (m.type === "init") {
    try {
      const vision = await FilesetResolver.forVisionTasks(m.wasm);
      let used;
      for (const delegate of m.delegates) {
        try {
          landmarker = await { hand: HandLandmarker, pose: PoseLandmarker }[m.task].createFromOptions(vision, { ...m.options, baseOptions: { modelAssetPath: m.model, delegate } });
          if (m.hands) handLandmarker = await HandLandmarker.createFromOptions(vision, { ...m.hands.options, baseOptions: { modelAssetPath: m.hands.model, delegate } });
          used = delegate;
          break;
        } catch (err) {
          if (delegate === "CPU") throw err;
        }
      }
      postMessage({ type: "ready", delegate: used });
    } catch (err) {
      postMessage({ type: "error", message: String(err && err.message || err) });
    }
    return;
  }
  // a frame
  try {
    const t0 = performance.now();
    const res = landmarker.detectForVideo(m.bitmap, m.t);
    const found = res.landmarks.map((lm) => lm.map((p) => [p.x, p.y, p.visibility ?? 1]));
    const hands = handLandmarker ? handLandmarker.detectForVideo(m.bitmap, m.t).landmarks.map((lm) => lm.map((p) => [p.x, p.y, 1])) : null;
    postMessage({ type: "found", t: m.t, ms: performance.now() - t0, found, hands });
  } catch (err) {
    postMessage({ type: "error", message: String(err && err.message || err) });
  } finally {
    m.bitmap.close();
  }
};
