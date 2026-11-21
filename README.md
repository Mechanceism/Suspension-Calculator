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
- **View** menu (top bar): show/hide parts and construction geometry in **every** viewport (Corner and Vehicle), motion trails, ghosts at the travel limits, camera follow, and *Plain cylinder tire* (hides the shoulder radius in the drawing; the math still uses it). ✎ selects a part for editing. **Inputs** tab: every input in one list.
- **Fit**: *⤢ Fit* (top right of the view) or **double middle-click** in a viewport fits everything in view.
- **Resize panels**: drag the edge between a side panel and the viewport (double-click the edge to reset). Sizes reset on reload.
- **Viewport**: drag to orbit, right-drag to pan, scroll to zoom. Buttons lock to Front / Rear / Outboard / Inboard / Top / Bottom / Iso and switch orthographic ↔ perspective. Click empty space to deselect.
- **Motion bar** (bottom): **Travel** and **Load** sliders are both shown and linked through the spring — drag travel and the load slider shows the load that position implies; drag load and the corner settles on its spring while the travel slider follows (the one you touched is marked *input*). Quick buttons: travel *Droop / 0 / Bump*, load *0× / 1× / 2×*, steering *◀ Lock / 0 / Lock ▶*. **Steering wheel** slider (rack travel from the c-factor). Separate **▶ Travel/Load** and **▶ Steer** play buttons can run together.
- **Locks** 🔓/🔒: next to values, joint coordinates, points (all three axes) and parts (*Lock part*), and derived dimensions such as arm length. Locked values are what the optimizer will have to work around — lock what you've already built or bought. Locked inputs have an amber edge, locked joints are drawn yellow, and the drag arrows / nudges of a locked axis are disabled (typing still works). The **Locks** tab (and the Locks section in the Vehicle view) lists everything locked with its current value; click an item to jump to it — it's selected in the viewport and its row flashes in the Inspector — or ✕ to unlock.
- **Optimize** tab (Corner): pick goals (bump steer, camber gain, outside-wheel inclination in roll, roll-center height and migration, KPI, caster, scrub, trail, anti angle, motion ratio, **contact area** and **grip** of the tire), each with a target (or *max*) and weight, and the **free coordinates**, each with a min/max range (*Pick coordinates…*, with the chosen list below it; locked ones show 🔒 and are skipped, locked arm dimensions are held). The **Now** column shows the current value. Presets: **Bump steer → tie-rod mounts**, **Grip → arm geometry**. *Tire grip model* sets the friction model (μ, reference pressure, load sensitivity, carcass share).
- **Optimize** tab (Vehicle): the same for every corner design at once, judged by the whole-car solve in **load cases** (cornering, braking, accelerating g): total grip and contact area of all four tires, outside-tire inclination, roll gradient, front share of load transfer, brake pitch, anti-dive / anti-squat, bump steer. Presets: **Grip → arm geometry**, **Load-transfer split → roll centers**. A run takes seconds to a minute. *▶ Optimize* runs in the background (*Stop* keeps the best so far); the result shows each goal before → after and every coordinate's move (⚠ *limit* = it hit its range). **Apply to design** (then *Undo*) or *Discard*. Optimizer setups are saved with the project.
- **Corner / Vehicle** switch (top). *Corner* is the single-corner workbench; the **Corner** box at the top of its sidebar picks which corner you edit (FL/FR/RL/RR), its settings (steers, powered) and the dimension links (front L/R same, rear L/R same, rear same as front). The corner load follows the vehicle CG by default (Inspector → Chassis can switch it to manual).
- **Vehicle** view: the whole car settles on its springs and tires. Inputs: mass, CG, wheelbase, brake bias, drive split, per-corner preload fitting, and **shared components per axle** (anti-roll bar: none / rate at wheel / torsion bar + drop links; heave spring: none / rate at wheel). Each corner's **brake** (outboard / inboard / none) and, for powered corners, **drive** (chassis diff + halfshaft / hub motor) is in the Corner box. Lateral acceleration, longitudinal (braking ← → acceleration) and steering sliders with Play. The **Forces** box in the view draws the forces as arrows where they act — tire vertical / lateral / brake-drive, springs, anti-roll bar / heave, weights, inertia — with optional values and a size slider. Results: corner loads, travel, inclination, roll / pitch / heave, ride heights, roll centers and roll axis, load transfer through links vs. springs, LLTD, rollover threshold. Double-click a corner to edit it.
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
