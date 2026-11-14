# Drawing a new character

1. Copy `template.psd` and rename it, e.g. `pirate.psd`.
2. Paint on the empty part layers, over the grey mannequin in the `template` group. The game
   ignores that group, so you can leave it or delete it.
3. Add the name to `SKINS` in `../rig.js`, then reload the game and press `c` to find it.

- **The front view (left half) matters most.** It's what players see most of the time.
- **The side view** (right half, `side` group, facing right) shows when a player turns side-on.
  It's optional: leave its layers empty and the game uses only the front.
- **Keep the layer names.** Each layer bends with the body part it's named after (`arm_l`,
  `leg_r`, `head`…; `_l` is the left of the picture; in the side view, `near` is the side facing
  the camera). Extra layers work too if their name starts with a part name, like `arm_l glove`.
- **Layers draw in the order they're in the PSD**, bottom first. Hidden layers are skipped.
- **Keep each part's paint around its own bones.** Turn on the hidden `guide` layer to see them.
- **Leave the face empty** in `head` to show the player's real face (like the astronaut's visor).
- **Don't outline the end of an arm or leg** where it tucks under the body: it swings into view.
- **Feet point out to the sides** in the front view, and forward in the side view.
