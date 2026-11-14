// The costume template's rest poses: where each joint sits on the 2048 x 1536 template canvas
// (costumes/template.psd). The front view fills the left half, as seen on screen (the player's
// left is on the left); the side view, facing right, fills the right half and lives in the PSD's
// "side" group. Every costume is painted over these poses; in the game each layer is bent from
// here to the player's tracked pose. Plain data, so the costume generator can import it too.
export const SIZE = [2048, 1536];

export const REST = {
  head: [512, 215], earL: [434, 222], earR: [590, 222],
  eyeL: [478, 205], eyeR: [546, 205], nose: [512, 240], mouthL: [490, 272], mouthR: [534, 272],
  neck: [512, 335],
  shL: [380, 385], shR: [644, 385],
  elL: [318, 610], elR: [706, 610],
  wrL: [282, 820], wrR: [742, 820],
  handL: [270, 905], handR: [754, 905],
  hipL: [446, 820], hipR: [578, 820],
  knL: [436, 1120], knR: [588, 1120],
  anL: [430, 1405], anR: [594, 1405],
  toeL: [346, 1445], toeR: [678, 1445], // feet turned out to the sides
};

// The ball: painted in this circle (centre, radius) on a "ball" layer, it replaces the game's ball
// while the costume is on. The game draws it a little bigger than the ball it bounces.
export const BALL = { at: [890, 150], r: 100 };

// Bones: a rest segment between two joints. A layer's vertices follow the bones of its part,
// weighted by distance; `reach` widens or narrows a bone's pull. `uniform` bones scale the same
// across as along (the head keeps its shape); the rest scale across by the body's overall size.
// `rigid` bones ignore their own landmarks and move with their parent: the feet are drawn turned
// out to the sides, while a player facing the camera has toes that point at it.
export const BONES = {
  chest: { from: "shL", to: "shR" },
  pelvis: { from: "hipL", to: "hipR" },
  // the head follows a fit to all the face points the tracker gives (ears, eyes, nose, mouth), so
  // it tilts, nods and turns; art near the mouth is also pinned to the tracked mouth
  head: { from: "earL", to: "earR", uniform: true },
  mouth: { from: "mouthL", to: "mouthR" },
  upperL: { from: "shL", to: "elL" }, foreL: { from: "elL", to: "wrL" }, handL: { from: "wrL", to: "handL" },
  upperR: { from: "shR", to: "elR" }, foreR: { from: "elR", to: "wrR" }, handR: { from: "wrR", to: "handR" },
  thighL: { from: "hipL", to: "knL" }, shinL: { from: "knL", to: "anL" }, footL: { from: "anL", to: "toeL", rigid: true },
  thighR: { from: "hipR", to: "knR" }, shinR: { from: "knR", to: "anR" }, footR: { from: "anR", to: "toeR", rigid: true },
};

// Layer name -> the bones its pixels follow, with each bone's reach (bigger pulls from further).
// Limbs don't blend into the chest or pelvis: an arm raised overhead turns its shoulder end half
// a turn, and blending that with the unturned chest folds the mesh.
// A PSD layer (or a group's layers) belongs to the part its name starts with: "arm_l", "arm_l glove".
export const PARTS = {
  back: { chest: 1, pelvis: 1 },
  torso: { chest: 1, pelvis: 1 },
  head: { head: 1, mouth: 0.6, chest: 0.35 },
  arm_l: { upperL: 1, foreL: 1, handL: 0.8 },
  arm_r: { upperR: 1, foreR: 1, handR: 0.8 },
  leg_l: { thighL: 1, shinL: 1, footL: 0.8 },
  leg_r: { thighR: 1, shinR: 1, footR: 0.8 },
};

// --- side view: facing right, centred on x = 1536 -----------------------------------------------
// "N" is the near side (towards the camera, drawn in front of the body), "F" the far side. A
// player facing left gets the same art mirrored.
export const SIDE_CENTER = 1536;
export const REST_SIDE = {
  ear: [1518, 222], eye: [1570, 205], nose: [1604, 242], mouth: [1594, 276],
  sh: [1530, 392], hip: [1528, 820],
  elN: [1548, 610], wrN: [1566, 818], handN: [1576, 902],
  elF: [1512, 606], wrF: [1498, 814], handF: [1490, 898],
  knN: [1552, 1120], anN: [1534, 1405], toeN: [1622, 1440],
  knF: [1508, 1118], anF: [1494, 1402], toeF: [1582, 1437],
};

// side bones: rest joints and the tracked points they follow (N/F turn into the player's left or
// right landmarks by which way they face; shMid and hipMid are midpoints of both sides)
export const SIDE_BONES = {
  spine: { from: "sh", to: "hip", live: ["shMid", "hipMid"] },
  head: { from: "ear", to: "nose", live: ["earN", "nose"], uniform: true },
  mouth: { from: "mouth", to: "mouth", live: ["mouthN", "mouthN"] },
  upperN: { from: "sh", to: "elN", live: ["shN", "elN"] }, foreN: { from: "elN", to: "wrN", live: ["elN", "wrN"] }, handN: { from: "wrN", to: "handN", live: ["wrN", "handN"] },
  upperF: { from: "sh", to: "elF", live: ["shF", "elF"] }, foreF: { from: "elF", to: "wrF", live: ["elF", "wrF"] }, handF: { from: "wrF", to: "handF", live: ["wrF", "handF"] },
  thighN: { from: "hip", to: "knN", live: ["hipN", "knN"] }, shinN: { from: "knN", to: "anN", live: ["knN", "anN"] }, footN: { from: "anN", to: "toeN", rigid: true },
  thighF: { from: "hip", to: "knF", live: ["hipF", "knF"] }, shinF: { from: "knF", to: "anF", live: ["knF", "anF"] }, footF: { from: "anF", to: "toeF", rigid: true },
};

export const SIDE_PARTS = {
  back: { spine: 1 },
  torso: { spine: 1 },
  head: { head: 1, mouth: 0.6, spine: 0.35 },
  arm_near: { upperN: 1, foreN: 1, handN: 0.8 },
  arm_far: { upperF: 1, foreF: 1, handF: 0.8 },
  leg_near: { thighN: 1, shinN: 1, footN: 0.8 },
  leg_far: { thighF: 1, shinF: 1, footF: 0.8 },
};
