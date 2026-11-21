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

- **Hardpoints** (left): edit any point. Values are mm unless a unit is typed (`5in`, `1ft 2in`, `250 + 3in`). Press Enter to apply; invalid entries turn red and are ignored.
- **Browser** (left): show/hide parts and construction geometry, focus the camera on a part (◎), and toggle motion trails, ghost positions at the travel limits, and camera follow.
- **Viewport**: drag to orbit, right-drag to pan, scroll to zoom. Buttons lock to Front / Rear / Outboard / Inboard / Top / Bottom / Iso and switch orthographic ↔ perspective.
- **Motion bar** (bottom): travel and rack sliders (double-click to reset), Play to sweep droop ↔ bump, travel range, and whether travel is measured at the wheel center or contact patch.
- **Characteristics / Through travel** (right): live values at the current position and curves across the travel range.

URL options for sharing a specific view: `?preset=A&view=front&travel=30&rack=10&labels=1&projection=perspective`.

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
