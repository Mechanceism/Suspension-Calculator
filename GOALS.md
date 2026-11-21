# Suspension Calculator: Project Goals

## Problem
Most people set suspension geometry by guess-and-check using general assembly rules of thumb. Problems only show up once the suspension moves, so testing gets slow and painful. Calculating geometry by hand and copying values back and forth into CAD (e.g. Fusion 360) is tedious and error-prone.

## Solution
A standalone tool that:
1. **Calculates** suspension kinematics through the full range of travel.
2. **Visualizes** the linkage in 3D, so the numbers make sense once you see how they're applied.
3. **Tunes**: the user adjusts dimensions and sees the characteristics update live.
4. **Optimizes**: it solves for the remaining unknowns from whatever values and limits the user provides.

Calculating and visualizing come first. **Later:** export to modeling software (Fusion 360, Blender, others) so the design carries into the user's 3D model.

---

## Guiding Principles
- **A system of relations, not a chain.** The original hand math got stuck because it was one long fixed chain. A chain can only be solved in one direction, and it can't be rearranged once the same variable appears dozens of times. Here, the geometry is a **set of independent relations between variables**: lengths, point coincidences, angles, and definitions of the characteristics. No direction is built in.
- **The user's inputs set the solve order.** Whatever the user provides (locked values, ranges) counts as known. The solver works out which unknowns can be found from those knowns and in what order. Anything that can't be isolated step by step is solved numerically as a coupled group (root-finding, least-squares). It works like a Fusion sketch: the constraints you add decide what is driven and what is free.
- **Tell the user what's missing or conflicting.** The solver should report when the inputs leave the system under-constrained (more freedom than values given), over-constrained (conflicting values), or solved.
- **Through-travel, not static.** Every characteristic is evaluated across the motion range (bump/droop, roll, steer), not only at ride height.
- **Full 3D.** All geometry is 3D. Simplified 2D views exist only for viewing.
- **Each corner is its own system.** A corner is a self-contained linkage that interacts with the outside only through simple, defined connections (chassis motion, shared sway bar, shared shock, etc.). Corners do not have to match: FL can be SLA while FR is MacPherson.
- **CAD-agnostic and standalone.** The tool must not require Fusion 360. Fusion is one optional integration among several.
- **Math built layer by layer.** The author's original hand-derived process ([References/](References/)) is reviewed one layer at a time and recorded in [docs/MATH.md](docs/MATH.md). Each layer becomes a set of relations in the system rather than a step in a fixed sequence. Each layer is verified (against Fusion demonstrations where needed) before the next is added.

---

## Roadmap

| Phase | Goal | Status |
|---|---|---|
| 0 | Fundamentals and characteristic hierarchy (leaders vs. followers) | ✅ Done |
| 1 | **Math core**: single corner, double wishbone (SLA), full motion through travel. Spec: [docs/MATH.md](docs/MATH.md) | ✅ Kinematics (L0–L2) and tire (L3–L4) done; load-driven corner (L5) next |
| 2 | **Visualizer**: 3D view of the core components, driven by the math core | ✅ First version (`npm run dev`) |
| 3 | **More variables**: add the remaining characteristics to both the math and the UI | |
| 4 | **Constraints and optimizer**: lock / range / free per variable; solve for free values once the visualizer and math agree | |
| 5 | **Export and integration** (only after calculating and visualizing are solid): file exports and an optional Fusion 360 add-in (Python + HTML panel) | |
| 6 | **Multi-corner**: add more corners, inter-corner interactions (sway bars, shared shocks, pushrods/rockers) | |
| 7 | **Other suspension types**: MacPherson, multilink, etc., plus user-defined linkages | |

Note: the tool simulates whatever linkage the user builds, including ones whose camber motion is far from ideal. Motion quality is judged from the motion itself (IC, characteristic curves, toggle positions), not from a linkage classification; "optimal" is defined by the user's chosen objectives.

All suspension types are treated as linkages that produce a desired wheel motion. Double wishbone comes first because the original math was built for it. The architecture must not hard-code SLA assumptions into the core.

---

## Characteristic Hierarchy (Design Flow)

Top-down (synthesis) flow. In analysis (forward) flow the direction reverses: hardpoints lead and characteristics follow. Some items switch roles depending on the flow.

| Tier | Items | Role |
|---|---|---|
| Constraints | Wheel/tire size, offset, track, wheelbase, ride height, upright/brake packaging, chassis pickup zones | Fixed inputs |
| Leaders | Roll center height and migration, camber gain (heave and roll), KPI, scrub radius, caster, mechanical trail, anti-dive / anti-squat % | Targets chosen from vehicle goals |
| Derived | Front-view instant center, side-view instant center | Pinned down by the leaders |
| Followers | Inner/outer A-arm pivots, tie-rod location (bump-steer target), pushrod/rocker geometry, motion ratio | Solved for |
| Outcomes | Track change/scrub, Ackermann %, wheel rate, roll stiffness | Checked and iterated |

More variables will be added as the math is reviewed layer by layer.

---

## Coordinate System

Reference corner: **front driver's-side corner (driver on the left), viewed from the front of the vehicle.**
**Right-handed** coordinate system, matching Fusion, Blender and Three.js.

| Axis | Origin (0) | Positive direction |
|---|---|---|
| X | Chassis centerline | Outboard, from center toward the tire |
| Y | Lowest point of the frame, at the chassis centerline | Up |
| Z | Hub centerline with the vehicle at static ride height on flat, level ground. Locked to the frame from then on. | **Forward**, in the direction the vehicle travels |

**All origins are fixed to the chassis.** The ground, tire and wheel move through travel, so none of them can serve as a datum. As a result:
- Ground is a **moving plane** in this frame. Ride height = distance from the chassis datum (Y = 0) down to the ground plane.
- Values measured from the ground (roll center height, etc.) are calculated against the current ground plane and reported relative to it.
- Hub-to-hub dimensions stay simple: track width = 2 × wheel-center X (for a symmetric pair).

---

## Units
- **Internal base units:** length in **mm**, angles in **degrees** (radians internally where the math needs them), force in N.
- **Fusion-style entry:** a value with no unit uses the current default (`1` → 1 mm). A value with a unit suffix is converted (`5in` → 127 mm internally).
- **Display preserves user entry:** if the user typed `5in`, it shows as `5in` even though it's stored as 127 mm.
- **Expressions allowed:** e.g. `5in + 3mm`, `track/2`, references to other parameters (like Fusion user parameters).
- **User-definable defaults:** the default display unit per quantity type (length, angle, etc.) is a user setting. Nothing is hard-coded to mm in the UI.

---

## Variable / Constraint Model
Every input in the UI is a variable with:

| Field | Meaning |
|---|---|
| `value` | Current value (with the unit the user entered) |
| `mode` | **Locked** (hard-set), **Ranged** (min/max allowed), or **Free** (whatever the calculation or optimizer outputs) |
| `min` / `max` | Limits when Ranged. Applies to positions, lengths, angles, etc. |

All options are available for manual adjustment and placement. The lock/range control is an optional checkbox or dropdown per variable. The optimizer (Phase 4) only moves Free and Ranged variables.

### Special Inputs
- **Tire size:** a dropdown of tire-number formats (metric `225/45R17`, flotation `31x10.50R15`, racing `20.5x7.0-13`) that are parsed into dimensions, or **simple** entry (outer diameter, width, rim). Every parsed value can be overridden.
- **Environment:** altitude (or ambient pressure directly) and temperature, for both the condition the tire pressure was set at and the operating condition.
- **Model toggles:** e.g. "Apply tire volume change" so the user can see how much a modeling assumption affects the results.

### Optimizer Objectives
Maximum contact area is a proxy, not the same as maximum grip. Objectives are selectable and can be weighted: target inclination under load (default), maximum contact area, or maximum friction force from a tire model. See [docs/MATH.md](docs/MATH.md#l7-optimizer-objectives-later).

---

## Visualizer Requirements
- **3D viewport** showing the core components only (arms, upright, tie rod, wheel/tire, spring/damper, chassis pickup points). No detailed CAD.
- **View locks:** the 6 standard orthographic views (front, back, left, right, top, bottom) plus free orbit.
- **Camera focus/lock** on a selected component or linkage (orbit around it, follow it through travel).
- **Fusion-style browser:** a component tree with visibility toggles per part and group.
- **Hierarchy view (experimental):** a parent/child "family tree" or node graph showing how parts connect and how values feed each other. To be tested; may not be needed.
- **Motion controls:** sweep through bump/droop, roll and steer, with plots of characteristics vs. travel.
- **Motion trail toggle:** draw the paths of selected points and bodies (ball joints, knuckle, wheel center, contact patch) through the full travel in one view, as ghosted positions and/or traced curves.

---

## Parameter Naming (proposal, to be finalized)
Names should be short, clear, and show the parent → child chain. Underscores only, because Fusion parameter names cannot contain dots or spaces.

```
<Corner>_<Assembly>_<Point/Feature>_<Axis>

FL_UCA_Fwd_X    Front-left, upper control arm, forward inboard pivot, X
FL_LCA_Out_Y    Front-left, lower control arm, outboard ball joint, Y
FL_TR_In_Z      Front-left, tie rod, inboard point, Z
FL_Whl_Dia      Front-left, wheel, diameter
```

**Corner codes:** `FL`, `FR`, `RL`, `RR` (front/rear, left/right as seen by the driver).

**Assembly codes (draft):**

| Code | Part | What it is / key points |
|---|---|---|
| `Chs` | Chassis / frame | Fixed reference body. Holds all inboard mounting points. |
| `UCA` | Upper control arm | Upper A-arm (wishbone). Two inboard pivots on the chassis (`Fwd`, `Aft`) and one outboard ball joint on the upright (`Out`). |
| `LCA` | Lower control arm | Lower A-arm. Same point layout as the UCA. |
| `Upr` | Upright / knuckle | The part that carries the hub. Connects the UCA and LCA ball joints and the tie-rod outer end. The UCA–LCA ball-joint line is the steering (kingpin) axis. |
| `TR` | Tie rod | Steering link from the rack (`In`) to the upright steering arm (`Out`). Its geometry sets bump steer. |
| `Hub` | Hub / spindle | Wheel bearing axis on the upright. Defines the wheel center and spin axis. |
| `Whl` | Wheel (rim) | Diameter, width, offset. |
| `Tire` | Tire | Outer diameter, width, and contact patch location. |
| `Sprg` | Spring | Spring mounts and rate. |
| `Dmp` | Damper (shock) | Damper mounts, length and travel limits. Often shares mounts with the spring (coilover). |
| `PR` | Pushrod / pullrod | Link from a control arm (or upright) to the rocker. Used for inboard spring/damper layouts. |
| `Rkr` | Rocker / bellcrank | Pivoting lever on the chassis that redirects pushrod motion into the spring/damper. Sets the motion ratio. |
| `ARB` | Anti-roll (sway) bar | Bar and drop links. Can connect corners (future). |

**Point codes (draft):**

| Code | Meaning |
|---|---|
| `Fwd` | Forward inboard pivot of an arm (larger Z, toward the front of the vehicle) |
| `Aft` | Rearward inboard pivot of an arm (smaller Z, toward the rear) |
| `In` | Inboard end of a single link (tie rod, pushrod) |
| `Out` | Outboard end or ball joint |
| `Ctr` | Center (e.g. wheel center) |
| `Piv` | Pivot (e.g. rocker pivot) |

Avoid codes that look like numeric error values (`Inf`, `NaN`, `Err`, `Null`).

---

## Technical Approach (proposed)

| Layer | Choice | Why |
|---|---|---|
| Language | **TypeScript** | One language for math and UI. Runs in any browser and can later be embedded in Fusion's HTML panel unchanged. |
| Math core | Pure TS module with **no UI dependencies** | Testable on its own, reusable by the UI, the optimizer and the exporters. |
| Testing | **Vitest** | Each math layer gets tests against known/hand-calculated values. |
| UI | **React** + **Vite** | Good fit for the browser tree, parameter tables and plots. |
| 3D | **Three.js** via react-three-fiber / drei | Orthographic view locks, camera controls, gizmos and object focus come mostly built in. |
| Units/expressions | **mathjs** (or a small custom parser) | Parses units and expressions like `5in + 3mm`. |
| Solver | Newton / Levenberg–Marquardt in TS | Small nonlinear systems; fast enough to run live. |
| Plots | Lightweight charting (e.g. uPlot / Recharts) | Characteristic vs. travel curves. |
| Distribution | Static web app first; optional desktop wrapper (Tauri) later | No install needed; works offline when packaged. |

### Export / Integration (Phase 5, after calculating and visualizing)
1. **File exports** (no CAD needed): project JSON, hardpoint CSV, Fusion user-parameter CSV, Blender Python script.
2. **Fusion 360 add-in:** thin Python add-in that pushes parameters into Fusion. Trade-offs to decide later:
   - *Embedded HTML panel* (the UI runs inside Fusion): tight loop, but a Fusion crash takes the session with it.
   - *External app + bridge* (the standalone tool sends parameters to Fusion): the tool survives Fusion crashes, but it needs a local connection.
   - Push updates on demand or debounced, so Fusion doesn't recompute on every slider tick.

---

## Open Decisions
1. **Mirroring for other corners.** Each corner gets its own local frame using the same rules (X always outboard), mapped to a shared vehicle frame. Confirm when multi-corner work starts.
2. **Fusion integration style:** embedded panel vs. external bridge (see above).
3. **Hierarchy view:** browser tree vs. node graph vs. both. Decide after experimenting.

### Resolved
- **Handedness:** right-handed system. X outboard, Y up, Z forward.
- **Y origin:** fixed to the chassis at the lowest point of the frame on the centerline. Ground is a moving plane.
- **Z origin:** hub centerline with the vehicle at static ride height on flat, level ground (the traditional condition for measuring hub-to-hub). That position is then locked to the frame, so the coordinate system does not move with the tires through travel.
- **Point codes:** `Fwd` / `Aft` replace `InF` / `InR`, because `InF` reads like the numeric error value `Inf` (infinity).
