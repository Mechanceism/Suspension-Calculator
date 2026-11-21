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
- **Joints.** Click a joint for a menu right at the joint: type X/Y/Z, nudge ± in steps (0.1–25 mm), or move by an entered amount. Values accept units (`5in`, `1ft 2in`, `250 + 3in`).
- **Measure** (`📏` button or <kbd>M</kbd>): click two points (hardpoints, contact point, patch centroid, steering-axis ground point, roll center, IC) for distance, ΔX/ΔY/ΔZ and angle — it updates live as the suspension moves. <kbd>Esc</kbd> exits.
- **Browser** tab: show/hide parts and construction geometry, motion trails, ghosts at the travel limits, and camera follow. **All inputs** tab: every input in one list.
- **Viewport**: drag to orbit, right-drag to pan, scroll to zoom. Buttons lock to Front / Rear / Outboard / Inboard / Top / Bottom / Iso and switch orthographic ↔ perspective. Click empty space to deselect.
- **Motion bar** (bottom): *Kinematic* mode sets travel with the slider; *Loaded* mode settles the corner on its spring for the corner load × a load factor. Steering-wheel slider (rack travel from the c-factor), Play, travel range.
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
