# Suspension-Calculator
Calculates optimal suspension geometry based off of supplied information.

- Project plan and conventions: [GOALS.md](GOALS.md)
- Math specification: [docs/MATH.md](docs/MATH.md)

## Running the visualizer

Requires [Node.js](https://nodejs.org/) 20+.

```sh
npm install
npm run dev        # then open http://localhost:5173
```

- **Click to edit.** Click any part in the viewport (arm, upright, tie rod, rack, coilover, wheel, chassis) to open it in the **Inspector** (left): its settings, dimensions (e.g. arm length and pivot-axis angles — editing them moves the frame pivots, not the upright), its points, and chips for its connected (1st) and next (2nd) family parts.
- **Joints.** Click a joint to select it: small X / Y / Z arrows appear on it in the viewport — **drag an arrow** to move the joint along that axis (*Snap drag to grid*, 0.1–10 mm, keeps values round). The Inspector shows the position to type X/Y/Z, nudge ± in steps, or move by an amount. Values accept units (`5in`, `1ft 2in`, `250 + 3in`).
- **Move several at once.** <kbd>Shift</kbd>/<kbd>Ctrl</kbd> + click joints or parts to build a multi-selection; a selected **part** also gets arrows at its center. Dragging (or *Move together* / *Move whole part* in the Inspector) moves every point by the same amount — shared joints such as ball joints and the coilover mount move with their part.
- **Measure** (`📏` button or <kbd>M</kbd>): click two points (hardpoints, contact point, patch centroid, steering-axis ground point, roll center, IC) for distance, ΔX/ΔY/ΔZ and angle — it updates live as the suspension moves. <kbd>Esc</kbd> exits.
- **Browser** tab: show/hide parts and construction geometry, motion trails, ghosts at the travel limits, camera follow, and *Plain cylinder tire* (hides the shoulder radius in the drawing; the math still uses it). **All inputs** tab: every input in one list.
- **Viewport**: drag to orbit, right-drag to pan, scroll to zoom. Buttons lock to Front / Rear / Outboard / Inboard / Top / Bottom / Iso and switch orthographic ↔ perspective. Click empty space to deselect.
- **Motion bar** (bottom): **Travel** and **Load** sliders are both shown and linked through the spring — drag travel and the load slider shows the load that position implies; drag load and the corner settles on its spring while the travel slider follows (the one you touched is marked *input*). Quick buttons: travel *Droop / 0 / Bump*, load *0× / 1× / 2×*, steering *◀ Lock / 0 / Lock ▶*. **Steering wheel** slider (rack travel from the c-factor). Separate **▶ Travel/Load** and **▶ Steer** play buttons can run together.
- **Corner / Vehicle** switch (top). *Corner* is the single-corner workbench; the **Corner** box at the top of its sidebar picks which corner you edit (FL/FR/RL/RR), its settings (steers, powered) and the dimension links (front L/R same, rear L/R same, rear same as front). The corner load follows the vehicle CG by default (Inspector → Chassis can switch it to manual).
- **Vehicle** view: the whole car settles on its springs and tires. Inputs: mass, CG, wheelbase, brake bias, per-corner preload fitting, and **shared components per axle** (anti-roll bar: none / rate at wheel / torsion bar + drop links; heave spring: none / rate at wheel). Each corner's **brake** (outboard / inboard / none) is in the Corner box. Lateral acceleration, braking and steering sliders with Play. Results: corner loads, travel, inclination, roll / pitch / heave, ride heights, roll centers and roll axis, load transfer through links vs. springs, LLTD, rollover threshold. Double-click a corner to edit it.
- **File** menu (top left): New (default layout), Save (<kbd>Ctrl+S</kbd>), Save as (<kbd>Ctrl+Shift+S</kbd>), Recents (saved in this browser), Import from file, Export to file (`.susp.json`). The title shows • when there are unsaved changes.
- **Results / Curves** (right, collapsible): geometry, spring & ride, steering (angles, ratio, axis torque, tie-rod / rack force, steering-wheel torque, parking scrub torque), tire & patch; curves through travel and through steering.

URL options for sharing a specific view: `?preset=A&view=front&travel=30&rack=10&labels=1&projection=perspective&mode=loaded&load=1.5&tire=gas`.

## Development

```sh
npm test                  # run the test suite
npm run typecheck         # TypeScript type check
npm run build             # type check + production build to dist/
npm run compare:layouts   # print camber / roll center for the sample layouts
```

## Layout

| Path | Contents |
|---|---|
| `src/core/math` | L0 geometry: vectors, rotations, planes/lines, linear algebra |
| `src/core/solver` | Generic rigid-body constraint system (relations, not a chain) |
| `src/core/suspension` | Double wishbone kinematics and characteristics |
| `src/core/units` | Unit-aware value entry |
| `src/app` | Visualizer UI (React + Three.js); uses `src/core` only through its public functions |
| `src/examples` | Sample geometries |
| `scripts` | Command-line analysis scripts |
| `tests` | Vitest tests |
| `References` | Author's conceptual hand math and process notes |
