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
| 1 | **Math core**: single corner, double wishbone (SLA), full motion through travel. Spec: [docs/MATH.md](docs/MATH.md) | ✅ Kinematics (L0–L2), tire (L3–L4) and loaded corner with coilover (L5) done. Pushrod/rocker spring layout planned. |
| 2 | **Visualizer**: 3D view of the core components, driven by the math core | ✅ First version (`npm run dev`) |
| 3 | **More variables**: add the remaining characteristics to both the math and the UI | ✅ First set: caster / KPI gain, roll camber, track change (scrub), roll-center migration, Ackermann % and the classic Ackermann lines, roll stiffness per axle, roll gradient; KPI and trail plots; caster gain, track change, Ackermann and the roll-stiffness split as optimizer goals; coilover length / angles / position along the arm as typed values. ✅ Since then: compliance steer and camber from arm bushings, KPI and caster in roll. |
| 4 | **Constraints and optimizer**: lock / range / free per variable; solve for free values once the visualizer and math agree | ✅ Locks (values, coordinates, points, whole parts, derived dimensions; Locks tab). Corner optimizer: free coordinates with ranges, weighted goals (bump steer, camber gain, roll inclination, RC, KPI, caster, scrub, trail, anti angle, motion ratio, **contact area and grip per tire**), presets, Apply / Undo. **Vehicle optimizer** through the whole-car solve in cornering / braking / accelerating / braking-in-a-turn cases, weighted (total grip and area, **cornering limit** (axle saturation), loaded-tire inclination, roll, LLTD, pitch, anti-dive/squat, bump steer). Since then: setup values and length ranges as variables, ghost preview, cornering limit, braking in a turn, case weights. Next steps listed in MATH.md (spring / bar rates in the steady stage, damper settings as variables, power-on exit case). |
| 5 | **Export and integration** (only after calculating and visualizing are solid): file exports and an optional Fusion 360 add-in (Python + HTML panel) | |
| 6 | **Multi-corner**: add more corners, inter-corner interactions (sway bars, shared shocks, pushrods/rockers) | ✅ Four independent corners, whole-car equilibrium, brakes, drive (chassis diff or hub motor), anti-roll bars and heave springs, force arrows in the view (L6). Scale-weight CG utility later. |
| 7 | **Other suspension types**: MacPherson, multilink, etc., plus user-defined linkages | ✅ MacPherson strut, five-link multilink and no suspension (rigid) (per design: Inspector / Inputs → Type, setup wizard, presets M and L), mixed on one car through the vehicle, ride, handling and optimizers. Since then: single arm (swing / trailing arm), solid axle (4-link, 3-link + Panhard, leaf springs), twist beam, pushrod / rocker spring layouts, custom (user-defined) linkages. |
| 8 | **Tests workspace** (alongside Corner and Vehicle, sharing one design): chainable / combinable test segments (speed change over distance, straight / left / right turn with radius, flat / grade / bank / bumps / potholes / lumpy), per-tire grip use and slip detection, speed limits, test goals for the optimizer | Phase A done: segments with speed / path / road (rough height maps, placed bumps), pass / warning / fail rules and profiles, test (A, B…) and segment (P1, P2…) priorities, enable / run all, optimize one or all tests until they pass (widening ranges up to a chosen maximum) / improve / preview wider ranges, steering through turns (steering lock check), track map, playback, export in parts. Phase B done: ride over time (7 DOF: body heave / roll / pitch + four wheels, dampers, tire damping, road at speed, transients at segment changes), checked by the pass rules, played back with real body motion. Phase C done: handling over time (a driver steers along the path through the car's steering kinematics with a lag, a rate limit and the rack limit; each tire's side force from its slip angle; yaw and sideslip; checks for running off the line and spinning; playback shows the line actually driven). Aero done (generic values or imported characteristics) |

## Current status and handoff (2026-11-23)
Read this first when picking the work up again; the details of each item are in the sections below and in [docs/MATH.md](docs/MATH.md).

**Branch.** Items 1–14 are **merged to main** (`5b79062`, the merge of `feature/pending-goals`, 2026-11-23). **Round 3** (list below) is on `feature/round-3`; merge it when the user asks (they merge at milestones). 432 tests pass (`npm test`, about 2 min); `npm run typecheck` is clean. Project file format: `FORMAT_VERSION = 41`.

**How the user wants the work done.**
- Finish one item at a time: implement, test (unit tests plus a check in the running app for anything visual), update the docs (docs/MATH.md, README.md, GOALS.md), then commit and push. Work through the pending list in order.
- Commit and push after each finished step; tests must pass first. Merge to main only when asked.
- Any change to saved values bumps `FORMAT_VERSION` with a migration step and a test (see *Project Files*).
- Conventions: X outboard (left corner frame), Y up, Z forward; mm, N, kg, deg in the UI.
- In the Vehicle view, moves on mirrored (linked) corners are mirrored; only moves that would make a mirrored pair differ are blocked (e.g. X of an Ackermann crossing), with a notice.

**Pending list (in the user's order).**

| # | Item | Status | Commit(s) |
|---|---|---|---|
| 1 | Solid axle: Watt's linkage, steered solid axle | ✅ | 2253335 |
| 2 | Custom linkage: sliding joints, drag points in the view, optimizer moves its points | ✅ | c676bdd |
| 3 | Anti-roll bar drop links on the rocker / either arm / knuckle; rocker ratio editor | ✅ | 55910d6 |
| 4 | Steering: measured ratio curve; pitman / idler arm with a center link | ✅ | 9e83338, b6965ef |
| 5 | Compliance steer and camber from arm bushings; KPI and caster in roll | ✅ | 2e0a9cd |
| 6 | Towing: hitch rating and light-tongue checks | ✅ | 334c8fe, 77c3be3 |
| 7 | Tires: aligning moment, combined-slip / Mz fitting, relaxation length | ✅ | 77bbf97, 550b592, 34d46d8 |
| 8 | Driver works the pedals; racing line with a track width | ✅ | 1d3f1e1 |
| 9 | Aero: side force with sideslip, roll sensitivity, moving center of pressure | ✅ | 691e61b |
| 10 | Dampers: dyno curves and a clicker | ✅ | 9752ba8 |
| 11 | Corner optimizer: static camber / toe and tire pressure as variables; length ranges | ✅ | 77e0007 |
| 12 | Corner optimizer: ghost preview of the result before applying | ✅ | f78d339 |
| 13 | Vehicle optimizer: cornering-limit goal (axle saturation); braking-in-a-turn case; case weights | ✅ | 617b3a0 |
| 14 | Basic car profiles: road car, FSAE car, kart, trophy truck (File → New from car profile) | ✅ | 1a45298 |
| — | Fix: car "flipping" under hard braking (solver robustness) and the solid-axle preset crash | ✅ | cf7331c |
| — | Fix (bug report): a solid axle / twist beam is one part under both wheels (one solve for both corners, drawn once, left / right always linked) | ✅ | 1defe8a |
| — | Fix (bug report): a steered leaf axle had no steering; ticking Steers on a solid axle makes it steered; a twist beam says it doesn't steer | ✅ | 7d8960d |
| — | Fix: a drop-link anti-roll bar on a solid axle / twist beam acts through its mounts on the axle (was: at the wheel centers) | ✅ | 5f12613 |
| — | Twist beam: steering turned off on choosing it, offered back after; no steering axis without steering; no stray motion trails | ✅ | c011062 |
| 15 | Enter hardpoints inside the setup wizard | on hold (round 3 first) | |
| 16 | Export / integration (Phase 5: hardpoint CSV, Fusion parameters, Blender script, Fusion add-in) | skipped for now (user) | |
| 17 | Phone companion app (probe to capture real 3D points) | skipped for now (user) | |

### Round 3 (agreed 2026-11-23, branch `feature/round-3`)
Discussed with the user item by item; do them in this order.

| # | Item | Status | Commit(s) |
|---|---|---|---|
| R1 | **Lock the setup wizard's values.** *Apply and next* locks what the user entered so no optimizer moves it: tire size / rim / offset / pressure, track and wheelbase (the wheel centers' X and Z), weight and CG, unsprung weight, spring rates, damper rates and the anti-roll bar, steering, inertias. Shown in the Locks tab marked "setup wizard" and unlockable; *Use an estimate* frees that step's locks; the user's own locks are never touched. Also fixed: the corner optimizer ignored locks on static camber / toe and tire pressure, and rate tuning ignored anti-roll bar locks. Format 37 (`wizardLocks`). The *Suspension points* step locks nothing (it only opens the point table; locking every point would leave the optimizer nothing to move). | ✅ | 90d47f8 |
| R2 | **Second autocross preset.** The current one is now *Autocross (simple)*; new *Autocross (complex)*: flat (no bank, no grade), launch, a slalom (R 25 m at 30 mph ≈ 0.7 g, cones ≈ 15 m apart: half / full / full… / half arcs), two mirrored sets of offset gates (R 18 m at 25 mph), a 90° sweeper each way (R 40 m at 35 mph), a stop box. The same seven turns (radius, length, speed) to the left as to the right; every sequence ends on its starting heading. Passes on the default car (grip use ≤ 73 %). | ✅ | 304b58d |
| R3 | **Steering effort goals.** New limit goals (≤ target; only the excess counts) in the corner **and** vehicle optimizer (so the Tests' *Optimize until it passes* / *Improve* can use them): **Parking effort** and **Effort at speed** (steering-wheel torque for both front wheels by virtual work through the steering kinematics: patch scrub at standstill; side force at the *Effort check at* lateral g on the mechanical + pneumatic trail) and a **Scrub radius limit** (\|scrub\| ≤ target). New steering input *Effort check at (lateral g)*, default 0.5 g (format 38). Note: with zero caster trail and the default 0 mm pneumatic trail the at-speed effort is 0; set the pneumatic trail (20–40 mm is typical). Kickback comes with R6. | ✅ | 8294072 |
| R4 | **Speed: more cores, smoother playback.** A worker pool (one per spare core, up to 8) for the vehicle / Tests optimizer (Jacobian columns and damping trials in batches), *What matters most*, spring / damper tuning (Bayesian batches) and *Run all* (several tests at once). The search algorithms yield batches (same result as one at a time). Balanced *Improve*: 442 s → 143 s on 24 cores. GPU ruled out. Playback: drei's Line disposed its material on every point change (shader recompiled every frame); replaced by an in-place line; one store update per frame; per-frame model cache; corner model and Tests panels no longer re-render per frame (main-thread busy 4.5 s → 1.6 s per 6 s). | ✅ | da06780 |
| R5 | **Brakes.** Drum brakes per axle (wheel cylinder, drum, shoe brake factor; fade sensitivity BF ∝ μ^k); largest rotor / drum that fits the rim; *what would fix it* from the last test runs (each single change that is enough, and whether it fits); **Hydraulics: Simple / Detailed** (fluid: pad / shoe clearance + circuit swell → master-cylinder and pedal travel; checks *Long pedal* (Warning) and *Master cylinder runs out* (Fail)); **brake ladder** (Tests → Optimize → Brakes (step ladder), also inside the optimize loop): smallest step keeping the reserve (default 25 %), more pistons first, larger rotors last, steps down, keeps the own brakes when the ladder has nothing smaller, skips steps the pedal can't take, bias held (balance bar re-set / nearest tandem pair), drum → disc only with permission (asks when drums run out). Format 39. | ✅ | d372e5b |
| R6 | **Speed from forces.** With the driver working the pedals the speed follows u̇ = (F_tires − drag − grade − rolling resistance − bump push) / m; the tires give what the driver asks within grip and pedals; segments can **Coast** (no pedals). Bumps push back (F_z · road slope through the wheel center; its work equals the energy into the vertical motion). **Rolling resistance** input (default 0.012, older files 0) in the steady solve and over time. **Kickback** check (Warning > 5 N·m): front tires' forces about the steering axes (scrub radius, trail, axis tilt, kingpin offset at the hub) × the steering ratio, the jolt above its 0.3 s mean. Validated: exact coasting, coast-down √(v₀² − 2μ_r g d), bump work = KE loss ≈ damper + tire dissipation (within 15 %). Format 40. Joint / bearing friction left out (small). | ✅ | 5e954ad |
| R7 | **Tire choice.** Tests → Optimize → *Tires (choose a size)*: candidates from a catalog or typed, per axle or both, ranked on the tests in scope (passing first, then the priority-weighted score), the current tire as reference, *Use* applies. A .tir approximated at each size (dimensionless coefficients kept; FNOMIN by the load-capacity ratio L ∝ S^1.39 (D_rim + S); radius / width / rim; vertical stiffness), marked with the size change (⚠ > 20 %); the generic model rescaled only when both axles change. Tire + wheel mass estimate into the unsprung mass; room (taller / wider) and rim rules; optional geometry re-optimization per candidate. | ✅ | ab14d95 |
| R8 | **Shimmy / death wobble.** Linear model: front wheels' steer, the steering wheel behind the steering stiffness, tire side force with relaxation, and on a steered solid axle its tramp with gyroscopic coupling; eigenvalue scan to the fastest speed (least damping in 4–25 Hz, onset speed), new and worn (free play as a describing-function stiffness, softer, weaker damper); kick test in time with the real dead zone and wheel imbalance (agrees with the scan's onset). *Shimmy margin* vehicle goal (worn, every iteration) with a final worn kick check before the result (target +0.03 and continue, ≤ 2×); *Shimmy* test check (Fail). Inputs in Vehicle → Inputs → Shimmy (format 41); pneumatic trail / relaxation estimated when 0. Limit: the car's path is held straight, so the slow hands-off steering response isn't judged. | ✅ | e6d2fa4 |
| V1 | **Labels: one checkbox, shown only with their item.** The View menu's *Marker labels* and *Point labels* are one **Labels** checkbox (on by default; older settings: on if either was). A label shows only when Labels is on **and** its item is shown (CG (sprung) with the CG, roll centers, Ackermann, anti-roll bar links; a hardpoint's name while a part it belongs to is shown; ball joints with their arm or the upright). Force values stay their own checkbox. Also fixed: 3D labels mounted into the element receiving the canvas events, which changes once the controls connect, so the first label (FL_UCA_Fwd) never showed and switching Corner ↔ Vehicle threw a removeChild error; they now mount into the canvas's own container, and the switch waits until they are gone. | ✅ | 4ee85ee |
| V2 | **Tests: Static and Dynamic views** (one or the other, a switch at the top of the view). *Static* = the car in place (as before). *Dynamic* = the course in 3D from the segments (exact arcs, grade heights, bank, the road's rough surface / bumps / potholes shaded across its width, the path dashed, the line driven colored per segment by result) with the car (the Vehicle view's own model, posed by the playback) driving it; frames placed on the course by distance along (+ the driver's offset and sideslip), interpolated between frames. Road width: a segment's track width, else 150 % / 200 % of the car's overall width. Cameras: chase (default), overhead, free. Ghost cars from other frame sets ready for R9. | ✅ | 0da1b11 |
| — | Fixes (user review of V2): view buttons in a column (clear of the Static / Dynamic switch); Dynamic view without jitter (car and camera read one pose; no re-render per tick); chase orbits round the car and moves with it (*Chase* resets), overhead closer, free orbit about a fixed point; **locked axle**: forces from equal wheel speeds (against the yaw) instead of split by load (into the turn), which spun the kart on Autocross (complex); **Driver lifts** also lowers the speed over time and in playback. | ✅ | 779fad3 |
| — | Dynamic view, user review 2: overhead works like chase but straight down (orbit, carried along, click to reset); *Follow: Vehicle / Track* (track = the center line's point nearest the car); free orbits about the track's center with no panning (zoom always works); its own ground grid below the course's lowest point and the car's grid off (no clipping with the road); camera controls in three rows. | ✅ | 9401775 |
| — | User review 3: smooth camera sweeps in the Dynamic view (orbiting round the target) and between Corner / Vehicle / Tests; each view remembers its camera, and a new view starts from the last one's camera around the car; free view over the whole track with panning along it and zoom to the cursor; ground drawn with a logarithmic depth buffer, fading with distance (no flicker); Driver lifts fixed (the limit is a share of the speed; judged at the lifted speed; slowed further over time where it still fails); car profiles keep the tests; playback *Motion* exaggeration (display only). | ✅ | 2b00215 |
| — | Fix: the dev server served a half-written `run.ts` (the file was written in steps and Vite cached a middle one), so *Driver lifts* failed with "LIFT_HELPS is not defined". Reloaded; no code change. | ✅ | |
| U4a | **No flash on changing tabs / views** (user review 4): keep each 3D view alive while hidden (not rendering) instead of rebuilding it, and start the camera sweep on its first drawn frame (the blank canvas while it rebuilt was hiding the sweep). | ✅ | 7ea022e |
| U4b | **Free camera: pivot on the track** — it orbits a point kept on the track's center line; dragging slides that point along the track ("scrolling" along the course), orbit and zoom like chase; starts close, not over the whole track. | ✅ | 94252de |
| U4c | **Units everywhere**: finding / message text (e.g. *Too tight for the steering … rack 26.0 mm, limit ±25 mm*, *34 km/h at the end instead of 48*) and every other displayed value in the display units; an audit of the whole UI. | ✅ | 2028fed |
| U4d | **Clearer driver messages**: the pedal driver's "lifted to stay on the line" is not the *Driver lifts* option (reword: *eased off*); report the lowest speed in the segment, not only its end speed; when the car is recovering off the line (steering on a straight), say so instead of *Too tight for the steering*. | ✅ | 09a7953 |
| U4h | **Faster ladder** (user review 6): the ride is resumed from the car's state saved at a segment's start; the ladder fixes segments in order, driving only from where the plan changed up to the failing segment, then on to the next. Kart in the app: *Balanced* 21 → 13 s, *Autocross (complex)* 63 → 25 s. | ✅ | 86580ff |
| U4i | **Gate speeds:** braking for a segment at a lower push keeps that push (the slowing done on the straight before, not hard in the turn before); halfway back up toward the lowest failing push (twice at most); a segment that slowing doesn't cure goes back to where its failures began; *Grip target* shown as *Driver push (% of the grip)*. Kart *Autocross (complex)*: only the two right-hand gates lowered (52 %, 31 km/h), 25 s run. | ✅ | 6548343 |
| U4j | **Optimizers score on time** (speeds as maximums): the *Test time* goal (Vehicle → Optimize, or *Score on time* + weight in the Tests' Optimize box) adds weight · 100 · T ÷ T₀ to the test score (a Fail still 100, warnings 0); the optimize loop runs the ladder per design; tire choice too; the geometry rounds use the planned speeds' states; a round that scores worse is undone. | ✅ | |
| U4g | **Cameras, user review 6:** changing view fades the new view in over the old with the camera's sweep (the old one drawn under it, its camera following, so the car stays put); changing again mid-sweep turns from where the camera is (views hand on where the camera is, keep where it is heading); the Dynamic view with no test chosen still sweeps (the car at the origin). | ✅ | 7921ed7 |
| U4f | **Cameras, user review 5:** Free unlocks where the camera is (no jump back to where Free was first used); the Dynamic view is orthographic or perspective like the others (*Ortho / Persp* top right); the camera's scale (visible height at the target) is carried between views, so orthographic ↔ perspective hand-overs don't jump in size. | ✅ | bfb7736 |
| U4e | **Speeds as maximums** (details below): planner (grip target, brake earlier, per-axle / inside-wheel grip ellipse), the ladder (other ways, then lower targets with a finding), time and average speed, *Maximums / Hold exactly* per test (format 42). Still to do: optimizers scoring on time (U4j); the gates' speeds (U4i). | ✅ | 61348fc |
| R9 | **Snapshots and compare** (agreed, details below). | after U4 | |

**R9, snapshots (agreed 2026-11-23).** A snapshot is **another design** (model, tests and their last results) saved as its own file in the normal project format (results become an optional section); any project file can be imported as a snapshot. It is not stored inside the current project. **Compare** runs all four pairings in the current app — model A / B on tests A / B — so they are always comparable, with the snapshot's saved scores shown as "last run". The compare window shows a ghost overlay of the other design in 3D, a table of the values that differ, overlaid characteristic plots and test scores side by side.

**R9, decided with V2 (2026-11-23).**
- **What each file holds** (the user's rule): a *tests* file only the tracks (the tests' segments); a *model* file only the model; a *model and tests* file the model, the tracks used and the final results (scores). **No paths or playback frames are saved**: re-running the same inputs gives the same run, and if a run comes out different it is because the calculator was updated, so the results should be refreshed anyway.
- **Compare** re-runs both designs in the current app (as agreed) and recomputes playback frames when *Play* is pressed (a few seconds per test with the worker pool).
- **The compare window uses both test views:** *Static* with the 3D ghost overlay; *Dynamic* races the current design and the snapshot on the same course, the snapshot as a ghost car (V2 draws several runs at once). The differences table and the test scores follow the playhead (the segment being driven).

**U4e, speeds as maximums (agreed 2026-11-24).** Found on *Balanced* with the kart: *Brake 50–30* asks ≈ 0.64 g, more than its rear-only brakes (no ABS) can take, so the rears lock, it enters *Left turn 1* sliding, runs 4–7 m wide and spends the next straights at full lock recovering (the "steering when it shouldn't"); *Driver lifts* also scaled a segment's start speed without the segment before it, so the target speed jumped. Agreed:
- Each test: **Speeds: maximums** (default, also for presets) or **hold exactly** (today's behavior, to check a car can do a given speed).
- **Maximums:** a segment's set speeds are the most the driver may go; the driver **plans the speed ahead** to a **grip target** (default **95 %**, per test): no faster than the turns allow at that grip, braking **earlier** (in the segments before) to arrive at it, accelerating out as grip allows (tires, brakes and their system, drive, lockup without ABS).
- **Scoring:** the safety checks still fail (spin, off the line, wheel lift, rollover, bottoming, lockup, …); **lap time and average speed** are reported and scored (the optimizer can go for time); running below a set speed is no longer a failure.
- **Before failing, the driver tries the ways of taking a segment:** hold the speed, brake in / accelerate out, coast in / accelerate out, and their combinations (changing the forces involved); only when none of them works is it a real failure. *Driver lifts* goes away: **decided (2026-11-24)** — as the last try the driver may plan to a lower grip target (90 %, 85 %, …), **with a finding saying it had to lower the target** (and to what).

**Item 15, what it means.** The wizard's *Suspension points* step (`src/app/panels/SetupWizard.tsx`, step `points` in `SETUP_STEPS`, `src/app/store.ts`) today only opens the point table. It should let the user enter each corner's hardpoints in the wizard itself: per design (respecting the front / rear / left / right links), only the points the corner's type uses (`activePointKeys`), with units as typed, a small picture or highlight of which point is which, *Use an estimate* (keep the preset's points, marked estimated like the other steps) and *Apply and next*.

**Open points to confirm with the user.**
- Trophy-truck profile: built with long-travel double wishbones in front and a 4-link solid rear axle (the common real layout). An earlier note mentioned "long-arm MacPhersons"; switch the front if that is what they meant.
- Trophy truck brake bias is 72 % front; at 1 g the rear locks (real for that bias; the ideal at 1 g is about 77 %).

**Known limits / caveats.**
- One whole-car solve takes about 0.3–1.5 s; the *Cornering limit* goal needs 2–4 solves per evaluation, so vehicle optimizer runs with it are slow.
- The full test suite takes about 2.5 min (the vehicle optimizer and cornering-limit tests are the slow ones).
- The generic tire grip model is relative to its nominal load / pressure (Fz0, p0); a design not made from a car profile keeps 1000 N / 83 kPa, so heavy cars should set Fz0 to their static tire load (Optimize → Tire grip model).

**Development notes.**
- Node is at `C:\Program Files\nodejs` (add it to PATH in Git Bash). `npm run dev` serves the app at http://localhost:5173.
- Checks in the running app were done with `puppeteer-core` driving the installed Chrome (headless, `--use-angle=swiftshader`): click through the UI, read the results tables, take screenshots. The app's live store can be reached in the page with `await import(<the exact /src/app/store.ts?t=… URL from performance.getEntriesByType('resource')>)` then `useApp.getState()` (a plain `import('/src/app/store.ts')` gives a separate copy).


### Tests workspace: requested changes (noted 2026-11-22)
1. **Segment list.** Replace the collapsible segment cards with a plain, always-visible ordered list (number, name, one-line summary) where segments can be added, reordered (drag or ↑/↓) and removed; selecting one opens its editor.
2. **Playback.** A ▶ play button and a time slider to play the car through the test after a run (speed, g's, grip use per tire shown as it goes), with the car moving along the test's path. Bumps and potholes need a position and length within a segment for this.
3. **Physics bug: velocity changes must come from the tires.** Acceleration only from powered wheels; braking only from braked wheels or from sliding tires (a sliding tire's friction acts against its sliding direction: a tire sliding sideways scrubs speed, it never pushes the car forward). Today a segment that speeds up with no powered wheels passes silently (the solver ignores the acceleration and only notes it), and braking with no braked wheels is not enforced. Such segments must fail with the reason. Later, aero drag adds to braking.
4. **Passing is not the end.** After a test passes, offer "do better": optimize for more grip reserve and higher passing speeds.
5. **Optimizer from the Tests workspace.**
   - A button to free **all available (unlocked) coordinates** at once instead of clicking each.
   - **Run until it passes:** optimize, apply to the design, re-run the test, repeat until it passes, with **stuck / no-improvement detection** and an explanation of what blocks it.
   - **Test priority (weight)** per test, e.g. 80% paved-road tests, 20% rough-road tests; the optimizer weighs tests by it.
   - **Other selected goals stay on** (e.g. total grip) while optimizing for a test, so the test optimization doesn't undo them.
   - **Range exploration:** one extra pass with the min/max ranges relaxed to see whether a better design lies outside them; show what would change and **ask the user** before using it.
6. **Save and export.** Tests are saved with the model; Export / Import get three options: **model and tests**, **model only**, **tests only**. Unsaved-change tracking per part (model, tests), with a prompt on close or New / Open when a part changed since its last save or export.

### Tests workspace: requested changes, round 2 (noted 2026-11-22) ✅
1. **Segment presets:** the drop-down next to *+ Add segment* is labeled "Preset:" and starts with **Empty**.
2. **Priorities that don't mix up:** tests use letters (**A**, B, C…; A = most important), segments use **P1**, P2… Both stay separate from the order.
3. **Run individually or all:** each test has an **enable** checkbox (untick to skip), a ▶ to run just that test, and **Run all** runs every enabled test in order with a status (✓ / ⚠ / ✗) per test. **Optimize** for *This test* or *All enabled tests* (weighted by test priority).
4. **Track map while building:** a top-view minimap of the test drawn from the segments (distance, turn radius), numbered, click to select, colored by the last run, bumps / potholes marked, rough road dashed.
5. **Space** plays / pauses playback.
6. **Steering in tests:** the wheels steer through the turns (rack travel from the radius and the steering kinematics); a turn tighter than the rack allows **fails (Steering lock)**.
7. **The optimizer keeps trying:** when it stops making progress it widens the ranges step by step up to a user-chosen **Max widening** (my ranges only, ×2, ×3, ×4, ×5, ×10, no limit). *Preview wider ranges* tries the maximum once and asks before using it.
8. **What's running is always visible:** a spinner pill with Stop in the top bar (test runs, Run all, the optimize loop, playback preparation, Corner / Vehicle optimizer) and a moving strip along the top of the window.

### Tests: decisions (noted 2026-11-22)
- **Rough roads:** each segment can have a seeded random road surface (height map): seed, max height, scale (bump size / spacing, i.e. how many), coverage (smooth vs. rough patches). A preview shows the map with the four wheel paths and the height profile under each wheel. Single bumps / potholes stay available as positioned features (position and length within the segment). Phase A playback samples the map at each wheel; Phase B uses it dynamically.
- **Priorities:** a priority rank per test (A, B, C…) and per segment (P1, P2…), most important first, equal ranks allowed, separate from the run order; weight = n + 1 − rank.
- **Improve after passing:** if nothing fails, maximize the priority-weighted average (grip reserve, passing speed); if something fails, the failing segments get extra weight until they pass.
- **Pass / Warning / Fail** ("passing fail" = Warning: reported, the test still passes). Every check has a user-selectable severity and, where it makes sense, a threshold, editable in the Tests workspace:
  near the grip limit (Warning, reserve %), understeer (Fail, allowed % over), oversteer / drift (Fail; allowed % over with front reserve to catch it), wheelspin (Fail, allowed % over), ABS active (**Warning**, allowed shortfall %), lock-up (Fail), speed not reached (Fail), bump-stop contact (Warning), bottoming / topping out (Fail), wheel lift (Warning), steering lock (Fail), rollover (always Fail), no solution (always Fail).
- **Profiles** set all severities at once (Street strict, Track, Drift, Off-road, plus user-saved custom profiles); chosen per test with per-segment overrides. The optimizer treats Fail checks as hard requirements, Warning checks as soft penalties, and ignores Pass checks.
- **Settings export / import:** a settings file with all user preferences (units, view options, custom failure profiles and defaults), separate from model and tests.

### Next: official tire model, then Phase B (decided 2026-11-22)
1. ✅ **Official tire model = Magic Formula (Pacejka).** Lateral and longitudinal force vs. slip angle / slip ratio with load sensitivity, camber (thrust and its effect on peak grip), tire pressure and the peak → sliding drop. No tire data yet: start from a **generic coefficient set** (clearly labeled generic, every coefficient editable); importing `.tir` files or fitting test data comes later. The contact-patch pressure model stays for the contact-area goal; grip, slip and pass / fail use the Magic Formula. It also gives each tire's slip angle, which Phase C builds on.
2. ✅ **Phase B = full-car ride over time, 7 degrees of freedom:** body heave, pitch and roll plus each wheel bouncing on its tire, using the real nonlinear suspension geometry, the bump / rebound damper rates, tire vertical stiffness and the road surface fed in at the car's speed. Playback becomes real dynamics (body motion, wheel hop, tire-load changes, bump-stop hits, wheel lift over time) checked by the pass rules. Steady accelerations still come from the segments; handling (yaw, path following) is Phase C.

### Next after Phase B (noted 2026-11-22)
- ✅ **Optimizer strategies by cost** (decided 2026-11-22): gradient search for geometry on steady states, with an optional **wide search** (multi-start seeded by a design of experiments); a **What matters most** report (DOE + response surface: effects and interactions); **Bayesian optimization** for springs, dampers and anti-roll bars on the ride over time, also used inside *Optimize until it passes* when failures only show over time. Genetic algorithms only later, for trade-off curves.
- ✅ **Two-stage dampers:** linear (one rate per direction) by default with generic values; optionally two-stage (low-speed rate, knee, high-speed rate per direction). ✅ Since then: dyno curves (force vs shaft speed per direction) and a clicker between full soft and full firm.
- ✅ **Tire data: `.tir` import:** full Magic Formula 6.1 / 6.2 (and 5.2) forces from the published equations (camber stiffness, shifts, pressure, combined slip), the simple model kept for hand editing; the user loads `.tir` files themselves (none are bundled; e.g. the obscured FSAE TTC fit published with the GPL-3.0 MATLAB library teasit/magic-formula-tyre-library), and the loaded model saves with the project. ✅ Also done: a fitting tool for measured data (table of slip angle / ratio, load, camber, pressure and forces → MF 6.1 force coefficients, R² / error, download as `.tir`), different tires front / rear, the tire size from a file's dimensions, and File → Import → Tire (.tir).

### Setup wizard: entering the car's values (noted 2026-11-22) ✅ first version
Most inputs have to come from the user, and many are hard to find. A **value wizard** walks the user through them, starting with the easy values and leading to the harder ones. Every page allows "I don't know yet: use an estimate"; estimated values stay marked, so the results can say which of them they depend on. Proposed order:
1. **Suspension type** for each of the four corners.
2. **Wheels and tires:** wheel and tire sizes.
3. **Overall size:** track width (tire to tire) and wheelbase (wheel center to wheel center).
4. **Weight and CG:** enter the total weight and place the CG directly, or use the **corner-scale CG calculator** (the scale-weight CG utility from the notes): weigh the four corners on level ground for the CG's front / rear and left / right position, then lift one axle by a known height and weigh again for the CG height, giving the CG in 3D.
5. **Unsprung weight:** tire, wheel, hub, brake and upright (plus a share of the arms, spring and damper), so the sprung / unsprung split and the sprung CG follow.
6. **Suspension points:** the hardpoints of each corner (today's Corner view), with the steering rack.
7. **Springs:** the rate from the spring's label, or a **spring-rate tool**: add a known weight to one corner of the parked car and measure the change in ride height; with the motion ratio from the geometry that gives the wheel rate and the spring rate.
8. **Harder values:** dampers (generic, then the damper's settings or dyno curve), anti-roll bars, steering ratio and rack travel, tire pressures and tire data (generic, a `.tir` file, or fitted data), body inertias (estimated from the mass and size).

Done: File → Setup wizard (and Vehicle → Inputs), eleven steps with a step list and summary (steering and tire grip on separate pages; steering from turns lock to lock / center to lock and the wheel angle, giving the rack travel, the max steering angle and the tightest turn; a diagram for track vs overall width and wheelbase; rim width and wheel offset on the tires page); each step *Apply and next* (your values) or *Use an estimate* (marked; Vehicle and Test results show "Based on estimated values: …" with a link back). Tools: corner-scale CG calculator (level + one axle lifted), unsprung-weight sum, spring rate from an added weight (tire and motion ratio taken out), generic damper rates from damping ratios, body-inertia estimate, tire `.tir` import. Still to come: entering the points through the wizard itself (it opens the point table; **next, item 15**), and the phone companion app (skipped for now).

**Future: phone companion app.** A separate app that runs on a phone and uses its sensors and cameras, with a physical touch point (probe) on the phone, so the user can touch points on the suspension and capture their real 3D positions to send to this tool.

### Requested next (evaluated 2026-11-22)
**Small, done:** wizard pages for steering / drive / brakes and the tire pressure's set conditions (with the no-load conversion); rack ahead of / behind the axle and the rack length; classic Ackermann lines; coilover / strut length, angles and mount position as numbers (knuckle mount for the double wishbone); no-suspension corners; the new variables as optimizer goals.

**Medium (next, after confirmation):**
- ✅ **Single arm, knuckle on the arm:** swing arm (pivot line along the car: the long-travel trophy-truck layout, knuckle locked to the long lower arm, steering on a kingpin bushing on the arm, IC at the arm's frame pivot), trailing arm (across the car), semi-trailing (angled). Presets *S* and *T*. The other trophy-truck option, a MacPherson with a long lower arm, is the MacPherson type with longer arm points.
- ✅ **Basic car profiles** (File → *New from car profile*): road car (MacPherson front, multilink rear, front drive), FSAE car (double wishbones, LSD), kart (stiff springs for the frame, solid rear axle, rear brake only) and trophy truck (long-travel double wishbones front, 4-link solid rear). Each sets every corner's type and points, springs, dampers, tires, travel, bars and the vehicle inputs at once.
- ✅ **Pushrod / pullrod with a rocker:** rocker on a chassis pivot, pushrod from an arm or the knuckle, spring from the rocker to the chassis (motion ratio from the linkage). ✅ Since then: anti-roll bar drop links on the rocker (or either arm or the knuckle), and a rocker-ratio editor.
- ✅ **Steering without a rack:** steering arm / plate on a pivot axis (ATV plate on the column, steering box pitman / idler arm with a center link), input in degrees, arm torque; variable ratio (geared cam / variable-ratio rack: the ratio at full lock). ✅ Since then: a pitman arm / idler arm / center link mechanism, and a measured ratio curve.
- ✅ **Maximum brake force:** brake hydraulics from pedal force, pedal ratio, booster, master cylinders (tandem or a balance bar), caliper pistons, pad μ, rotor radius and tire radius: line pressure, torque, most braking force per axle and g, hydraulic bias (optionally used as the bias), pedal force needed, the *Brakes too weak* pass rule.
- ✅ **Towing, static:** hitch point, tongue weight and the trailer's pull / push and side force at the hitch while cornering, braking and accelerating (with / without trailer brakes), in the steady solve, the ride and handling. ✅ Since then: a hitch-rating check (*Hitch overloaded*) and a *Light tongue* warning.

**Large (after the medium ones):**
- ✅ **Solid axle, twist beam and leaf springs:** solid axle with a 4-link, 3-link + Panhard rod or leaf springs, and the twist beam (two travels; heave about the bushing line, roll about bushing → shear center), through kinematics, the whole car, ride, app and presets (*A4*, *A3*, *LF*, *TB*). ✅ Since then: Watt's linkage (*AW*) and a steered solid axle (kingpins on the axle ends, cross tie rod, drag link; *AS*). Originally: both wheels on one body located by links (4-link, 3-link + Panhard, Watt's, leaf springs); a twist beam as two trailing arms joined by a twisting beam. A leaf spring locates the axle as well as springing it, so it comes with the solid axle.
- ✅ **Brake fade:** rotor temperature over a test (brake energy into a lumped rotor, speed-dependent cooling), pad μ vs temperature scaling the hydraulics' capacity, a *Brake fade* check and *Brakes too weak* when faded; temperatures in the test table and playback.
- ✅ **Trailer sway:** the trailer as a second yawing body in the handling model (its own axle and tires, coupled at the hitch; pushing when braking without trailer brakes), sway measured against a no-slip trailer, a *Trailer sway* pass rule with jackknife detection, the trailer's yaw radius as an input, articulation and sway in playback.
- ✅ **User-defined linkages:** the *Custom linkage* type: an editor for bodies and joints (ball joints, hinges / bushings, rods) to the frame, the steering rack and the knuckle, with a freedom count and messages; instant and steering axes from the motion; drawn in both views; saved with the project. ✅ Since then: its points drag in the viewport, sliding joints (slide and turn, slider), and the corner optimizer can move its points.

### Vehicle view editing (noted 2026-11-22) ✅
- **Ackermann lines for every steered corner** (per axle, with the crossing and its target), **draggable**: a line's handle or the crossing turns the steering arms (moves the outer tie-rod joints); click the crossing for X / Y / Z arrows (Y = both outer tie-rod joints up / down, keeping the crossing in top view; Z = forward / back). Only moves that would make a mirrored pair differ are blocked (its crossing's X), and a notice names the linked corners that move.
- **Select, move and measure in the Vehicle view:** any corner's joints (moves on linked corners are mirrored, with a notice); measure between joints, contact patches, the CG and roll centers across corners.
- **View menu:** CG, anti-roll bar links can be turned off; the markers are labeled (one Labels checkbox, round 3 V1).

### Future goals (noted 2026-11-22)
- **Tire data for the grip model.** Done: generic coefficients, `.tir` files, fitting to measured data, front / rear tires. ✅ Since then: the aligning moment (MF 6.1), fitting the combined-slip and aligning-moment coefficients, and a tire relaxation length in handling.
- ✅ **Aero.** Off (negligible) by default; generic values (CdA, downforce area front / rear, drag height, air from altitude and temperature) or **imported characteristics**: constants or an aero map over front / rear ride height, as JSON (`suspension-aero`, docs/MATH.md § Aerodynamics) or a CSV grid. Drag acts on the body (the tires drive against it; up high it moves load rearward); lift / downforce acts on the body at each axle, so it loads the tires and pitches the car. Speed comes from the test segments (and a slider in the Vehicle view). **Future:** a separate aerodynamic-flow (CFD) project will export this format, so real values can replace the generic ones; ✅ since then: side force and yaw moment with sideslip, roll sensitivity, and a center of pressure that moves (balance shift with sideslip; shown in the results).
- ✅ **Handling (Phase C).** A driver model steers the car along the path over time (preview, lag, steering-rate and rack limits); tires give side force from their slip angles; yaw inertia is a vehicle input (estimated in the wizard). Tire relaxation length ✅. ✅ Since then: the driver working the pedals (speeds as targets, braking ahead of bends the tires can't take, lifting when running wide) and the racing line through turns with a track width.

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
- **User-definable defaults:** the default display unit per quantity type (length, angle, etc.) is a user setting. Nothing is hard-coded to mm in the UI. ✅ Units menu: Metric / Imperial / Custom per quantity (display and typed plain numbers; the math stays in base units).

---

- **Values inside sentences (user review 4, U4c):** findings, notes, notices, optimizer logs and error lines are written by the core in base units (`rack 26.0 mm`, `34 km/h`); `localizeText` (`src/app/units.ts`) re-expresses every "number(s) + unit" in them in the display units (single values, ranges `12–30 mm`, `±`, the minus sign; precision kept), leaving units it doesn't own (`kg/m³`, `m/s²`, `g`, `%`, `°`) alone. Panels use `Val` / `Local` (`UnitText.tsx`) instead of writing a unit after `fmt(…)`; pass-rule thresholds are typed in display units. (Damper velocities stay in m/s: there is no velocity-of-a-part quantity yet.)

## Variable / Constraint Model
Every input in the UI is a variable with:

| Field | Meaning |
|---|---|
| `value` | Current value (with the unit the user entered) |
| `mode` | **Locked** (hard-set), **Ranged** (min/max allowed), or **Free** (whatever the calculation or optimizer outputs) |
| `min` / `max` | Limits when Ranged. Applies to positions, lengths, angles, etc. |

All options are available for manual adjustment and placement. The lock/range control is an optional checkbox or dropdown per variable. The optimizer (Phase 4) only moves Free and Ranged variables.

**Locking must be simple and work at every level** (noted 2026-11-21): a whole part, single hardpoints, single coordinates, or derived values (arm length, pivot angle…). Users often work from something already built, so the optimizer must work around whatever is locked. One required optimizer option: **move the tie-rod mounts to minimize bump steer**.

### Special Inputs
- **Tire size:** a dropdown of tire-number formats (metric `225/45R17`, flotation `31x10.50R15`, racing `20.5x7.0-13`) that are parsed into dimensions, or **simple** entry (outer diameter, width, rim). Every parsed value can be overridden.
- **Environment:** altitude (or ambient pressure directly) and temperature, for both the condition the tire pressure was set at and the operating condition.
- **Model toggles:** e.g. "Apply tire volume change" so the user can see how much a modeling assumption affects the results.

### Optimizer Objectives
Maximum contact area is a proxy, not the same as maximum grip. Objectives are selectable and can be weighted: target inclination under load (default), maximum contact area, or maximum friction force from a tire model. The tire grip model is the Magic Formula (generic coefficients until fitted to tire data). See [docs/MATH.md](docs/MATH.md#l7-optimizer-objectives-and-requirements).

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

### Project Files ✅
- **In-app library** (File → Save / Save as / Recents) kept in the browser; **Export / Import** as `.susp.json` files to share or back up.
- Every file records `formatVersion` (file layout) and `appVersion` (app that wrote it). On import, older files are upgraded through migration steps (`src/app/project.ts` → `MIGRATIONS`), values this version doesn't know are ignored with a note, and missing values fall back to defaults with a note.
- Hardpoints and wheel scalars are keyed by their parameter names (`FL_UCA_Fwd`, `FL_Whl_Camber`…), the same names planned for CAD parameters; each value keeps the text as typed (`5in`) plus its base-unit value.
- **Rule for future changes:** any change to saved variables bumps `FORMAT_VERSION` and adds a migration step + test.

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
