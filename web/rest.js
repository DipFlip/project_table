// The costume template's rest pose: where each joint sits on the 1024 x 1536 template canvas
// (costumes/template.psd). Every costume is painted over this pose; in the game each layer is
// bent from here to the player's tracked pose. Front view, as seen on screen: the player's left
// is on the left. Plain data, so the costume generator (tools/costumes) can import it too.
export const SIZE = [1024, 1536];

export const REST = {
  head: [512, 215], earL: [434, 222], earR: [590, 222],
  neck: [512, 335],
  shL: [380, 385], shR: [644, 385],
  elL: [318, 610], elR: [706, 610],
  wrL: [282, 820], wrR: [742, 820],
  handL: [270, 905], handR: [754, 905],
  hipL: [446, 820], hipR: [578, 820],
  knL: [436, 1120], knR: [588, 1120],
  anL: [430, 1405], anR: [594, 1405],
  toeL: [404, 1478], toeR: [620, 1478],
};

// Bones: a rest segment between two joints. A layer's vertices follow the bones of its part,
// weighted by distance; `reach` widens or narrows a bone's pull. `uniform` bones scale the same
// across as along (the head keeps its shape); the rest scale across by the body's overall size.
export const BONES = {
  chest: { from: "shL", to: "shR" },
  pelvis: { from: "hipL", to: "hipR" },
  head: { from: "earL", to: "earR", uniform: true },
  upperL: { from: "shL", to: "elL" }, foreL: { from: "elL", to: "wrL" }, handL: { from: "wrL", to: "handL" },
  upperR: { from: "shR", to: "elR" }, foreR: { from: "elR", to: "wrR" }, handR: { from: "wrR", to: "handR" },
  thighL: { from: "hipL", to: "knL" }, shinL: { from: "knL", to: "anL" }, footL: { from: "anL", to: "toeL" },
  thighR: { from: "hipR", to: "knR" }, shinR: { from: "knR", to: "anR" }, footR: { from: "anR", to: "toeR" },
};

// Layer name -> the bones its pixels follow, with each bone's reach (bigger pulls from further).
// Limbs don't blend into the chest or pelvis: an arm raised overhead turns its shoulder end half
// a turn, and blending that with the unturned chest folds the mesh.
// A PSD layer (or a group's layers) belongs to the part its name starts with: "arm_l", "arm_l glove".
export const PARTS = {
  back: { chest: 1, pelvis: 1 },
  torso: { chest: 1, pelvis: 1 },
  head: { head: 1, chest: 0.35 },
  arm_l: { upperL: 1, foreL: 1, handL: 0.8 },
  arm_r: { upperR: 1, foreR: 1, handR: 0.8 },
  leg_l: { thighL: 1, shinL: 1, footL: 0.8 },
  leg_r: { thighR: 1, shinR: 1, footR: 0.8 },
};
