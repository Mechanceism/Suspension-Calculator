# Math Specification

The math the code implements, reviewed one layer at a time against the author's hand-derived process ([References/Suspension Calc Operations.txt](../References/Suspension%20Calc%20Operations.txt) and [References/Conceptual Hand Math.pdf](../References/Conceptual%20Hand%20Math.pdf), conceptual only).

Coordinate system and units are defined in [GOALS.md](../GOALS.md): right-handed, **X outboard, Y up, Z forward**, origin fixed to the chassis, base units mm / deg / N.

Status key: ✅ agreed · 🔶 open / under discussion

---

## Approach

- The geometry is a **set of relations** (fixed lengths, coincident points, rigid bodies, definitions of the characteristics), not a fixed chain of equations.
- The user's inputs (locked, ranged, free) decide what is known. The solver decides the solve order, and solves coupled groups numerically.
- Functions here are written in their "forward" form (state → quantity). **Back-solving** (quantity → state) uses numerical root-finding or least-squares on these forward functions. They are never rearranged algebraically.
- Every function must be **continuous and monotonic where possible** so back-solving converges reliably. Places where that breaks (first contact, toggle positions, bottoming out) are detected and reported rather than silently returning bad values.

---

## Layer Order

| Layer | Contents | Status |
|---|---|---|
| L0 Geometry | Vectors, frames, rotations, planes, lines, intersections | ✅ implemented + tested (`src/core/math`) |
| L1 Corner kinematics | Constraint solve for upright/wheel position from travel and steer inputs | ✅ implemented + tested (`src/core/solver`, `src/core/suspension/doubleWishbone.ts`) |
| L2 Characteristics | Camber, toe, caster, KPI, offsets, IC, RC, anti %, bump steer, motion ratio | ✅ implemented + tested (`src/core/suspension/characteristics.ts`, `fourBar.ts`) |
| L3 Tire geometry | Patch area, centroid, displaced volume (slice method) | ✅ implemented + tested (`src/core/tire/geometry.ts`) |
| L4 Tire force | Gas-law model, stiffness model | ✅ implemented + tested (`src/core/tire/model.ts`, `src/core/suspension/loaded.ts`) |
| L5 Quasi-static corner | Load-driven equilibrium with spring and tire | ✅ implemented + tested, coilover option 1 (`src/core/suspension/spring.ts`) |
| L6 Vehicle | Mass, CG, four corners, roll centers, load transfer | ✅ implemented + tested (`src/core/vehicle/`) |
| L7 Optimizer | Objectives and constraint handling | ✅ corner optimizer, first version (`src/core/optimize/`); vehicle-level goals later |

Build order: **L0 → L1 → L2** (drives the visualizer), then **L3 → L4**, then L5+.

---

## L0: Geometry Primitives
- 3D vectors, unit vectors, dot/cross products.
- Rigid-body frames (origin + rotation). Rotations via **Rodrigues' formula / quaternions**.
- Lines (point + direction), planes (point + normal), with line–plane, plane–plane and closest-approach intersections.
- All angles are stored internally in radians and displayed in degrees.

---

## L1: Corner Kinematics (Double Wishbone)

**Bodies:** chassis (fixed), UCA, LCA, upright (knuckle), tie rod.

**Hardpoints (per corner):**
`UCA_Fwd`, `UCA_Aft`, `UCA_Out` · `LCA_Fwd`, `LCA_Aft`, `LCA_Out` · `TR_In`, `TR_Out` · `Hub_Ctr` + spin axis.

**Constraints:**
| Constraint | Equations |
|---|---|
| UCA ball joint stays at fixed distances from both UCA inboard pivots (rotates about the UCA pivot axis) | 2 |
| LCA ball joint, same | 2 |
| Tie-rod outer stays at fixed length from tie-rod inner (which moves with rack travel) | 1 |
| Upright is rigid (UCA_Out, LCA_Out, TR_Out, hub fixed relative to each other) | built into the upright pose |

Upright pose = 6 DOF, minus 5 constraints = **1 DOF = suspension travel**. Rack travel is a second input that moves `TR_In`.

**Inputs that drive the solve:** wheel travel (wheel-center Y displacement relative to the chassis, or arm angle) and rack travel.

**Notes:**
- **Pivot axes are not assumed parallel to Z**, and ball joints are not assumed centered between pivots. All of this is handled in full 3D. Side-view inclination of the pivot axes creates anti-dive/anti-squat; plan-view angle affects caster and toe change.
- **Steering jacking is not a separate formula.** Moving the rack rotates the upright about the UBJ–LBJ line (the steering axis), and the constraint solve produces the resulting height change of the tire directly. Rodrigues' rotation is used inside the solve. Finding the lowest tire point relative to the ground is a short formula once the wheel pose is known.
- **Toggle detection:** report when any two connected links approach a straight line (transmission angle near 0° or 180°) within the travel range.

---

## L2: Characteristics

Definitions follow the normal SAE J670 / ISO 8855 terms. Signs use the GOALS.md axes (X outboard, Z forward).

| Characteristic | Definition | Positive when |
|---|---|---|
| Camber | Front-view angle of the wheel plane from vertical | Top of the wheel leans **outboard** (+X) |
| Inclination angle | Angle of the wheel plane from the **ground normal** (camber + body roll + steer effects) | Same sense as camber. This is the value the tire layer uses. |
| Toe | Plan-view angle of the wheel plane from Z | Toe-in: front of the wheel points inboard |
| Caster | Side-view angle of the steering axis from vertical | Top of the axis leans **rearward** (−Z) |
| Kingpin inclination (KPI) | Front-view angle of the steering axis from vertical | Top of the axis leans **inboard** (−X) |
| Scrub radius (kingpin offset at ground) | Front-view distance at the ground from the steering-axis intercept to the contact center | Axis intercept is **inboard** of the contact center |
| Mechanical trail (caster trail at ground) | Side-view distance at the ground from the steering-axis intercept to the contact center | Axis intercept is **ahead** (+Z) of the contact center |
| Kingpin offset at wheel center | Front-view distance from the wheel center to the steering axis, measured at wheel-center height | Axis is inboard of the wheel center |
| Caster offset at wheel center | Side-view distance from the wheel center to the steering axis, measured at wheel-center height | Axis is ahead of the wheel center |

**Caster and trail are reported separately.** They usually share a sign but are not locked together, because caster offset at the wheel center can move the trail independently of the caster angle.

**Scrub radius and trail are reported two ways:**
1. **Geometric:** measured to where the wheel center plane meets the ground (standard, comparable with published values).
2. **Effective:** measured to the actual contact-patch centroid from L3 (changes with inclination and load).

**Instant center / instant axis:**
- Each A-arm defines a plane (its pivot axis + its ball joint). The two planes intersect in the **instant axis**.
- **Front-view IC** = where the instant axis passes through the transverse vertical plane at the contact center. **FVSA** = distance from the IC to the contact center. Camber gain ≈ 1 / FVSA (rad per mm of travel).
- **Side-view IC** = where the instant axis passes through the longitudinal vertical plane at the wheel center. **SVSA** is defined the same way.
- **Roll center:** the line from the contact center to the front-view IC, intersected with the opposite corner's line. A single corner uses a **mirrored** opposite side until multi-corner support arrives.

**Anti features (side view):**
- Anti-dive % (front, outboard brakes) = tan(θ) · (L / h_CG) · (front brake fraction) × 100, where θ is the angle of the line from the contact center to the side-view IC.
- Inboard brakes / inboard drive: use the line from the **wheel center** instead of the contact center.
- Anti-squat (driven axles) is defined the same way with drive-force fractions.

**Other outputs:** bump steer (toe change vs. travel), track change / scrub, camber gain vs. travel, motion ratio (spring/damper length change ÷ wheel travel), Ackermann % (with steering).

### Arm Dimensions as Design Variables ✅
Besides raw coordinates, each A-arm has derived variables that can be read **and edited** (`src/core/suspension/armGeometry.ts`):
| Variable | Definition |
|---|---|
| Length | Ball joint → pivot axis, perpendicular (the arm's swing radius) |
| Pivot-axis inclination | Side-view angle of the pivot axis, + = front pivot higher (anti-dive style) |
| Pivot-axis plan angle | Top-view angle, + = front pivot further outboard |
| Front leg / rear leg / pivot spacing / front-view angle | Read-only |

**Editing a derived variable moves only the frame pivots** and keeps the ball joint fixed, so the upright, wheel and track width at static height don't change (decided 2026-11-20). Length slides both pivots along the ball-joint → axis direction; the angles re-aim the axis while holding the length, pivot spacing and ball joint exactly.

### Linkage Motion Quality ✅
How good the knuckle's path is gets judged directly from the motion, not from a linkage classification:
- **Instant center / FVSA:** first-order camber gain (and roll center).
- **Characteristic curves through travel:** camber, toe (bump steer), roll center height and migration, track change. Arm proportions shape these away from design.
- **Toggle detection:** the solver's conditioning flags positions where links approach a straight line.

**Grashof's law was evaluated and dropped** (decided 2026-11-20). The Grashof class (double crank, crank-rocker, etc.) describes whether links can fully rotate. It did not predict the camber path over real travel in a controlled comparison (below). Not every suspension type produces "ideal" camber motion, and that's fine. The tool simulates whatever linkage the user builds; "optimal" is defined by the user's chosen objectives (L7).

**Controlled comparison** (`npm run compare:layouts`, layouts in `src/examples/sampleLayouts.ts`). Same upright, wheel and tie rod in all four. A–C have their pivots on the same ball-joint → IC lines, so they share one static IC (FVSA 2000 mm, RC 50 mm). D keeps C's pivot X positions with FVSA 1000 mm.

| Layout | Class | Camber @ −50 mm | @ +50 mm | Camber gain @ 0 | RC @ −50 / +50 mm |
|---|---|---|---|---|---|
| A near-equal arms | double crank | +1.43° | −1.46° | −0.0286 °/mm | 135 / −34 |
| B short upper arm | crank-rocker | +0.79° | −2.10° | −0.0286 °/mm | 94 / 11 |
| C unequal arms | triple rocker (non-Grashof) | +1.27° | −1.63° | −0.0286 °/mm | 121 / −19 |
| D unequal arms, FVSA 1000 | double crank | +2.68° | −3.10° | −0.0573 °/mm | 118 / −15 |

Observations:
1. All four pass through zero camber from positive (droop) to negative (bump), including the non-Grashof layout C.
2. The static IC sets the first-order camber gain: A–C are identical at design, and halving the FVSA (D) doubles it.
3. Arm proportions shape the curve away from design (progressive camber, RC migration). This is not ordered by Grashof class: non-Grashof C stays within 0.17° of double-crank A, while Grashof crank-rocker B differs by 0.65°.
4. Moving only the IC flipped the class (C → D) without changing the character of the curve.

---

## L3: Tire Geometry (Slice Method) ✅

Purpose: for a given wheel pose and ground plane, compute **contact-patch area, patch centroid, and displaced volume** without case splits (no special rectangle vs. ellipse handling).

**Why only two inputs matter:** the tire is radially symmetric, so the patch depends only on the distance from the axle to the ground and the **inclination angle γ** (wheel plane vs. ground normal). Rotation about the axle and yaw about the ground normal don't change the shape.

**Setup (tire frame):**
- Wheel center `c`, axle unit vector `a`, ground plane with point `g₀` and up normal `n`.
- Slice position across the tread `s ∈ [−W/2, +W/2]`. Slice radius `R(s)`.
- Slice center height above ground: `h(s) = n·(c − g₀) + s·(n·a)`, where `n·a = sin γ`.
- Distance from the slice center to the ground chord, within the slice plane: `d(s) = h(s) / cos γ`.
- A slice touches the ground where `d(s) < R(s)`.

**Per-slice quantities:**
- Chord length: `L(s) = 2·√(R(s)² − d(s)²)`
- Circular segment area: `A_seg(s) = R² · acos(d/R) − d·√(R² − d²)`

**Results:**
- Patch area: `A = (1 / cos γ) · ∫ L(s) ds`
- Displaced volume: `V_disp = ∫ A_seg(s) ds`
- Patch centroid: chord midpoints weighted by `L(s)`
- **Center of pressure** (for steering torque): starts equal to the centroid. A pressure-weighted version can be added later.

**Rounded tire edge (shoulder radius r_e):**
- Flat across the middle: `R(s) = R` for `|s| ≤ W/2 − r_e`.
- Quarter-circle shoulder: `R(s) = (R − r_e) + √(r_e² − (|s| − (W/2 − r_e))²)` for `W/2 − r_e < |s| ≤ W/2`.
- So the radius drops from `R` at the start of the shoulder to `R − r_e` at the edge **along a circular arc, not a linear ramp**. A user-defined profile can replace this later.

**Back-solving (e.g. "what deflection gives this area?"):**
- For a fixed γ, area and displaced volume **increase monotonically** with penetration depth, so each target has exactly one solution. Use a **bracketed** solver (Brent / bisection-Newton hybrid), not plain Newton.
- At first contact, area grows like √(depth) (infinite slope at zero). Bracketing handles this.
- Integrate only over the **contact range** of `s` (found analytically on the flat portion, numerically on the shoulders), so results stay smooth as slices enter or leave contact.
- Two-variable inverses (depth and γ together) can have multiple solutions. These are handled by the optimizer with user ranges.
- **Report:** bottoming out (penetration beyond the sidewall height → rim contact) and loss of contact.

**Implementation notes:** contact intervals are found by sign changes of R(s) − d(s) between profile breakpoints (refined by bisection); each interval is integrated with a cosine change of variable + 24-point Gauss–Legendre, which cancels the √ behaviour at the patch edges. Verified against an independent ground-plane grid count (< 1%) and exact level-tire formulas.

**Effective scrub / trail (loaded):** in kinematic mode with a tire load, the level ground rises until the tire force equals the load; scrub radius and trail are then also reported to the patch centroid on that loaded ground. Positive camber loads the outer tread edge (centroid outboard); negative camber loads the inner edge.

**Caveat:** a rigid-cylinder intersection is a geometric approximation of the real patch (real tires flatten and wrap). It's suitable for comparing designs; it can be calibrated later.

---

## L4: Tire Force ✅

The tire model is **swappable**. All models share the L3 geometry.

### Model A: Gas law (author's model, corrected)
- Gas law uses **absolute** pressure: `P_abs = P_gauge + P_amb`.
- Isothermal or temperature-corrected state change (n, R constant):
  `P₂_abs = P₁_abs · (V₁ / V₂) · (T₂ / T₁)`
- **Force balance uses gauge pressure:** `F_tire = (P₂_abs − P_amb) · A` (+ optional carcass stiffness term later).
- Equilibrium: find the penetration depth where `F_tire = F_load` (1-D bracketed root find).
- Author's derivation `A₂/V₂ = M·a·T₁ / (P₁·V₁·T₂)` is algebraically correct for the absolute-pressure form. The gauge correction makes it non-separable, which is fine because it's solved numerically.

**Ambient pressure:** an input, derived from **altitude** (standard atmosphere) or entered directly.
- `P_amb = 101 325 · (1 − 2.25577×10⁻⁵ · h)^5.25588` Pa, with h in m.
- Separate "set" and "operating" conditions (pressure set at one altitude and temperature, driven at another).

**Air volume V₁:** an **annulus** between the rim diameter and the tire outer diameter (not a full cylinder), reduced by the shoulder profile.

**Volume change (toggle):** a real tire bulges at the sidewalls, so its volume drops only by a few percent and pressure barely rises.
- `V₂ = V₁ − k_v · V_disp`
- **Checkbox:** "Apply volume change". Off: `V₂ = V₁` (constant pressure). On: uses `k_v`.
- `k_v` is the fraction of the geometric displaced volume actually lost from the air (0–1). Default 1 (the author's original rigid-cylinder assumption); a real tire is lower because it bulges. A fixed "3%" would not scale with load, so it's a factor on the displaced volume instead.
- Observed: at typical loads the displaced volume is < 0.1% of the air volume, so the toggle changes pressure very little, which matches real tires.

### Model B: Vertical stiffness
- `F_tire = k_t · deflection` (N/mm). Simple, standard, and good for early kinematic-plus-load work.

### Tire Size Input
Dropdown of formats. The tire number is parsed into dimensions, and every value can be overridden with measured values.

| Format | Example | Gives |
|---|---|---|
| Metric (ISO) | `225/45R17` | Section width 225 mm, aspect 45% → sidewall 101.25 mm, rim 17 in → OD = 17·25.4 + 2·101.25 = 634.3 mm |
| Flotation / inch | `31x10.50R15` | OD 31 in, width 10.5 in, rim 15 in |
| Racing / off-road | `20.5x7.0-13` | OD 20.5 in, width 7.0 in, rim 13 in |
| Simple | OD, width, rim | Direct entry when only general size is known |

Not given by the tire number (entered separately, with defaults): shoulder radius, pressure, carcass stiffness.

---

## Steering Torque ✅
Moment of the tire force about the **steering axis** (not about the axis's ground point):

`T_steer = û · ((p − q) × F) + (û · n) · M_z`

- `û` = steering-axis unit vector, `q` = any point on the axis, `p` = force application point (contact center / center of pressure), `F` = tire force vector, `M_z` = tire aligning moment.
- Covers: vertical load acting through KPI/caster (jacking, self-centering), longitudinal force acting through scrub radius (brake/torque steer), lateral force acting through trail, and low-speed parking scrub (patch friction torque, page 1 of the hand math).

---

## Steering ✅ (`src/core/suspension/steering.ts`)
- **Input:** steering-wheel angle → rack travel via the c-factor (rack mm per steering-wheel revolution).
- **Road-wheel angle:** change in wheel heading versus straight ahead at the same arm position (+ = front of the wheel toward outboard; a left turn for FL).
- **Steering ratio:** steering-wheel degrees per road-wheel degree at the current position.
- **Steer sweep:** at the current arm position (LCA angle held), across the rack range: road-wheel angle, camber, jacking (contact drop = body rise) and the self-centering torque from the vertical load.
- **Tire forces at the patch:** vertical (from the tire model / corner load), lateral (+ outboard), longitudinal (+ drive, − braking); the lateral force acts a pneumatic trail behind the patch center.
- **Torque about the steering axis:** `T = û · ((p − q) × F)` summed over the force components.
- **Tie rod / rack / steering wheel:** for an SLA with the spring on an arm, the ball-joint forces act on the steering axis, so only the tie rod resists rotation about it: `f = −T / (û · ((r_TR − q) × d))` (d = outer → inner, f = tension). Rack force = `f · (d · rack axis)`. Steering-wheel torque = `F_rack · c / 2π`. Values are for this corner; the other front corner adds its share.
- **Parking (standstill) scrub torque** (page 1 of the hand math, generalized): the patch twists about the steering axis's ground point against friction μ with the load spread evenly: `T = μ · (F_z / A) · ∫ |r| dA`, integrated over the actual patch shape; converted to rack force and steering-wheel torque the same way.
- **Verified:** hand-checkable vertical-axis case (braking × scrub, lateral × pneumatic trail, 120 mm steering arm), KPI self-centering sign, parking torque → μ·F·d far from the axis.

## L5: Quasi-Static Corner ✅
Two operating modes:
1. **Kinematic:** the user sets travel and steer; geometry is reported. No spring needed (a tire load is optional).
2. **Loaded (settle on spring):** the user sets the corner load; the solver finds the travel where the spring carries it, then the tire carries the load on the ground.

**Spring layouts**
- **Option 1 (implemented): coilover** from a chassis mount to a mount on the LCA or UCA (`FL_Dmp_Chs`, `FL_Dmp_Arm`).
- **Option 2 (planned): pushrod / pullrod + rocker.** The spring code only needs the two spring mount points, so a rocker body (revolute to the chassis, pushrod as a fixed-length link to an arm or the upright) supplies them without changing the equilibrium math.

**Relations (virtual work, chassis fixed, 1 DOF = travel q)**
- Spring force (compression only): `F_s = k · max(0, L_free − L(q))`
- Motion ratio: `MR = −dL / dy_c` (spring compression per mm of contact-point travel)
- Wheel force: `F_w = F_s · MR` — the vertical force the spring supports at the contact patch
- Wheel rate: `k_w = dF_w / dy_c` (≈ k · MR², plus the effect of MR changing with travel)
- Equilibrium: `F_w(q) = W_s`, where `W_s = (corner load − unsprung mass · g) × load factor`. Solved by bracketed Illinois root-finding over the travel range; reports **droop limit** / **bump limit** when the load can't be balanced in range.
- The tire carries the full corner load (sprung + unsprung) × load factor; the spring and tire act in series, so the vertical balance needs no iteration at corner level. Coupling (roll, load transfer, the "settle repeatedly" loop) enters at vehicle level (L6).
- Ride rate: `1 / (1/k_w + 1/k_t)`, tire rate `k_t` from the tire model (∞ for rigid). Ride frequency `f = √(k_ride / m_s) / 2π` with the **static** sprung corner mass (the load factor is extra g, not extra mass).
- **Fit free length:** `L_free = L(q₀) + W_s / (MR(q₀) · k)` puts the static equilibrium at the design position q₀ = 0.

**Travel limits:** damper fully-extended / fully-compressed mount-to-mount lengths give the droop / bump limits (found by sweeping and bisection); a bump stop adds `k_bs · max(0, L_bs − L)` to the spring force. In loaded mode the settle range is tightened to the damper stroke.

**Switching the lower mount between arms** moves the coilover as a unit (same relative spot on the other arm, chassis mount shifted by the same amount), so the installed length/angle and the damper settings stay valid; the free length is refitted.

**Verification:** energy check — ∫ F_w dy_c over travel equals the spring energy change ½k·Δ(compression²) to 0.2%; equilibrium, fitted free length and limit reporting tested.

---

## L6: Vehicle ✅ (`src/core/vehicle/`)

**Corners.** Four corners, each its own system (all double wishbone for now). Each keeps its local frame (X outboard, Y up, Z forward from its own axle); left corners map X as-is, right corners mirror X, rear corners shift Z by −wheelbase. Dimensions can be linked ("front L/R same", "rear L/R same", "rear same as front"); unlinking gives a corner its own copy. Per-corner settings (never linked): steered / locked, powered / passive. Defaults: all passive, fronts steer.

**Inputs.** Total mass (incl. unsprung), the whole-car CG (X, height above ground, Z) at static ride height, wheelbase, unsprung mass per corner, lateral acceleration (g), steering. Static corner weights follow from the CG (each axle as a beam: front/rear by CG Z, left/right by CG X).

**Design ground.** The hardpoints describe the car at static ride height on level ground, so the ground plane includes the average static tire compression.

**Ride-height preload (default on).** Each corner's spring free length is fitted to its own static weight — like setting each coilover's collar — so the static car sits at its design ride height. Off = each corner's own free length.

**Equilibrium (relations, solved together).**
- Unknowns: chassis heave, roll (about +Z) and pitch (about +X) relative to the design pose.
- For a chassis pose, each corner settles independently: the travel q where the virtual work along its one degree of freedom balances —
  `F_tire·dy_c + F_lat·dx_c − m_u·g·dy_wc − m_u·a_y·dx_wc + F_spring·dL = 0`
  (tire vertical force from the tire model at that height and tilt; lateral force at the patch; unsprung weight and inertia at the wheel center; spring incl. bump stop). Jacking forces through the instant centers come out of this automatically — no roll-center formula is used in the solve.
- **Where the tire forces act (corrected 2026-11-21):** the virtual displacement used for the tire forces is that of the *material point of the wheel/upright touching the ground*, not the path of the wheel's lowest point (which slides around the tire as the wheel rises and tilts). Checked against the side-view instant center: the material point's dz/dy matches tan θ of the IC (0.071 vs 0.068 on a 2.5 mm grid), the lowest-point path had the opposite sign.
- Whole car: Σ vertical tire force = total weight; roll and pitch moments of tire forces, weights and lateral inertia (sprung at the sprung CG, unsprung at the wheel centers) = 0. Newton on (heave, roll, pitch) with a line search.
- Lateral tire forces are shared in proportion to each tire's vertical load (equal grip use), updated alongside Newton.
- Speed: each corner is solved once on a grid of travel and interpolated (Catmull–Rom, smooth values and slopes); the whole-car solve then takes milliseconds.

**Brakes (per corner).** None / outboard / inboard, plus a vehicle brake bias (front share). Braking deceleration (g) gives a total braking force m·a, shared front/rear by the bias and within each axle by tire load among braked corners. An **outboard** brake reacts its torque through the upright, so the braking force does virtual work at the contact patch; an **inboard** brake reacts into the chassis, so the force acts at the wheel center. Unsprung and sprung inertia act forward at their CGs. Results: load moved onto the front axle (statics check: ΔW·L = m·a·h), pitch, and the classic geometric anti-dive (front) / anti-lift (rear) % = tan θ · (L/h) · axle brake share, θ from the side-view IC to the contact patch (outboard) or wheel center (inboard). Verified: inboard vs. outboard changes the dive in the direction those angles predict.

**Drive (powered corners).** Each corner is powered or passive; a powered corner is driven from a **chassis-mounted** diff (halfshaft) or a **hub motor**. Acceleration (g) gives a total drive force m·a, split front/rear by the drive split (front share; all to whichever axle has powered corners if only one does) and equally between the powered corners of an axle (open differential). A **chassis** drive reacts its torque into the chassis, so the drive force does virtual work at the **wheel center**; a **hub** motor reacts into the upright, so it acts at the **contact patch** (the same rule as inboard/outboard brakes). Inertia acts rearward at the sprung and unsprung CGs. Results: load moved to the rear axle, pitch (squat), and the classic anti-squat (rear) / anti-lift (front) % = tan θ · (L/h) · axle drive share, θ from the side-view IC to the wheel center (chassis drive) or contact patch (hub). If no corner is powered, acceleration is ignored and the results say so. Verified: the statics check ΔW·L = m·a·h; RWD loads the rear; hub vs. chassis drive changes the squat in the direction the angles predict.

**Force display.** Every force in the vehicle solve can be drawn as an arrow where it acts (toggle per kind, with values and a size control): tire vertical, lateral and brake/drive forces at the patch centroid, spring forces on the body and on the arm, anti-roll bar / heave forces at the wheel center (equivalent wheel force), unsprung and sprung weights, and the d'Alembert inertia at the CG.

**Shared components (per axle), each optional and with a type.**
- *Anti-roll bar:* none · **rate at the wheel** (N/mm of left/right travel difference) · **torsion bar + drop links** (bar rate N·m/deg, arm length, drop-link mount on the lower arm — tracked through travel; twist = left/right mount height difference ÷ arm length). Verified: the torsion bar matches a wheel-rate bar of the equivalent rate (bar rate · link motion ratio² ÷ arm²).
- *Heave spring:* none · **rate at the wheel** on the average travel of the two corners (adds heave/pitch stiffness, no roll stiffness, nothing at static).
- Coupled corners are settled **together** (2-unknown Newton on left/right travel, limits handled), so the whole-car Newton sees the bar's roll stiffness. Stable even for a near-rigid bar at 1.6 g.

**Results.** Corner loads and Δ from static, travel, inclination to ground, toe; roll, pitch, heave, ride height front/rear; front and rear **roll centers from the actual left/right corners** (no mirrored assumption; lateral position too) and the roll axis; lateral load transfer per axle split into *through the links* (`F_lat,axle · h_RC / track`) and *through the springs* (the rest), and the front share (LLTD); rigid rollover threshold (half track ÷ CG height).

**Verified.** Static car with fitted preload sits at design height with no roll and ~0 pitch, loads matching the CG split; at 1 g the outside tires gain load, the body rolls to the outside, Σ lateral force = m·a, and ΣΔW·track agrees with m·a·h (within the small shift from roll); CG offset loads that side; the axle roll center from two mirrored corners equals the single-corner value.

**Background (classic formulas, for cross-checking).** Total lateral transfer per axle `ΔW = m·a_y·h_CG/t`; the roll center splits it into geometric `m·a_y·h_RC/t` and elastic `m·a_y·(h_CG − h_RC)/t`. Roll moment = sprung mass · a_y · roll moment arm (sprung CG to roll axis). Rollover threshold depends on CG height and track, not the roll center.

### Planned for later (noted 2026-11-21)
- **More shared-component types:** monoshock / roll-decoupled layouts, pushrods across corners, anti-roll bar geometry with chassis-mounted bar ends.
- **CG from scales (page 6 of the hand math):** a utility to find the CG from four corner scale weights level and with one axle raised (tilt). For now the CG is entered directly.
- **Other suspension types per corner** (MacPherson, multilink, user linkages) and pushrod / rocker spring layouts.
- Steering jacking and centrifugal roll can be balanced against each other for specific conditions (e.g. a known track).

---

## L7: Optimizer — corner, first version ✅ (`src/core/optimize/`)

**What moves.** Free variables are single hardpoint coordinates, each with its own range (min/max, absolute mm). Everything else stays where it is, so locked values are respected by never becoming variables: a locked coordinate, point or part is simply skipped. Locked **derived** dimensions (arm length, pivot-axis inclination / plan angle) are held by stiff penalty residuals (tolerance 0.001 mm / 0.001°). Static camber and toe are set by the design spin axis, so moving points never changes them.

**Goals → residuals.** Each goal is a miss divided by its tolerance, times √weight; the optimizer minimizes ½·Σr². The corner is swept over 9 travel samples from droop to bump (the motion-bar range), plus extra sweeps where a goal needs them.

| Goal | Residuals | Tolerance |
|---|---|---|
| Bump steer | toe(t) − toe(0) − slope·t at every sample (slope = target, °/100 mm; 0 = none); optionally also with the rack at ± a set travel | 0.01° |
| Camber gain in heave | camber(t) − camber(0) − gain·t at every sample | 0.02° |
| Outside-wheel inclination in roll | camber(t_φ) + φ − target, with t_φ = half track · tan φ (the outside wheel rises that much relative to the body). Checked against the whole-car solve: inclination = camber at the actual travel + body roll | 0.05° |
| Roll-center height / migration | RC(0) − target; RC(t) − RC(0) − slope·t | 2 mm |
| KPI, caster, anti angle (static) | value − target | 0.1° |
| Scrub radius, mechanical trail (static) | value − target | 1 mm |
| Motion ratio (static) | −ΔL_damper/Δy_contact at ±1 mm − target | 0.005 |
| Prefer small changes | √w·Δx/10 mm per variable (default w = 0.01) | — |

The small-change term matters when the goals don't pin the answer down (six free tie-rod coordinates for one toe curve): it picks the nearest design that meets the goals.

**Solver.** Bounded Levenberg–Marquardt (`boundedLeastSquares`): forward-difference Jacobian (0.01 mm steps, stepping inward at an upper bound), Marquardt diagonal damping, and a projected step with a simple active set (variables on a bound whose gradient points outward are held for that step). A design the linkage can't assemble counts as infinitely bad, so the step is rejected and damping raised. It reports which variables ended **on their range limit** (widen the range or free more coordinates). Tested: Rosenbrock with and without an active bound; bump steer 2.16° → 0.001° in 12 iterations (~0.3 s) moving six tie-rod coordinates; camber-gain target with the UCA length held to < 0.01 mm; RC height + KPI targets together.

**Bump steer by tie-rod placement.** The preset frees the classic knobs: inner tie-rod X (tie-rod length, along the rack) and Y, and outer tie-rod Y (heights), ±25 mm, unless locked. Outer X/Z are left fixed by default because they also change the steering arm (ratio, Ackermann); free them if you want.

### Contact area and grip ✅ (`src/core/tire/grip.ts`)
The main optimizer goal: the largest contact area, then the highest friction at the patch, for the best grip. Both are goals per tire (corner optimizer) and for all four tires together (vehicle optimizer).

**Pressure over the patch.** The patch is sampled with the slice method (L3). The air carries load evenly; the carcass and belt carry load where the tire is pushed in most. A share β of the load follows the local deflection δ (how far the undeformed tire would sink below the ground at that point):

    p(x) = (1 − β)·Fz / A  +  β·Fz·δ(x) / ∫δ dA

A level wheel gives a fairly even pressure; an inclined one gives a wedge of δ, so one shoulder carries much more.

**Load-sensitive friction.** μ(p) = μ_ref·(p / p_ref)^(−n); friction capacity F = ∫ μ(p)·p dA. Because p^(1−n) is concave, for a given load F is largest when the pressure is even and the area large, so "largest area, then highest friction" is one number. Defaults (placeholders until there is tire data, all editable in *Tire grip model*): μ_ref = 1.0 at 100 kPa, n = 0.2, β = 0.5. Tested: even pressure with n = 0 gives exactly μ_ref·Fz; grip peaks with the wheel level and falls symmetrically with inclination; more load per tire gives a lower effective μ.

**What the tire model implies.** With the **air-spring** tire the area is set by load ÷ pressure (the gas law fixes it), so geometry hardly changes one tire's area (< 1 % from 0° to 2° inclination); grip then changes only through the pressure distribution (~0.4 %). With the **stiffness** tire the patch shrinks quickly with inclination (about 45 % less area at 2°), so area and grip respond strongly. Real tires sit in between: calibrate β and n against tire data when available. Camber thrust (most tires peak slightly negative) is not in this model; use the inclination goal for that.

**Corner goals.** *Contact area* and *Grip* are averaged over two cases: static (travel 0, static corner load) and the outside wheel in roll (travel = half track · tan φ, ground tilted φ relative to the body, load = static × the *outside-wheel load in roll* factor, default 1.5). The tire's ground height is re-solved for each load. Maximized goals use the residual (start ÷ value)/√tol (tol = 1 %), so a 1 % gain counts about as much as removing one tolerance of miss on a target goal.

## L7: Vehicle optimizer ✅ (`src/core/optimize/vehicle.ts`)
Same solver; every evaluation rebuilds the corners from the candidate hardpoints (corner tables with 21 samples) and runs the whole-car solve (L6) for each load case that is on: **cornering** (left turn, g), **braking** (g), **accelerating** (g). Springs are re-fitted to the static loads when *preload per corner* is on, so ride height stays at design. Variables belong to a corner design (root corner): with front and rear linked, one move applies to all four corners.

| Goal | Value | Tolerance |
|---|---|---|
| Total grip (max) | Σ friction capacity of the four tires ÷ vehicle weight (g), averaged over the cases | 1 % |
| Total contact area (max) | Σ patch areas, averaged over the cases | 1 % |
| Outside-tire inclination | inclination to the ground of the two loaded tires in cornering (residual per tire) | 0.05° |
| Roll gradient | body roll ÷ lateral g | 0.02°/g |
| LLTD front | front share of lateral load transfer | 0.5 % |
| Brake pitch | nose-down pitch in the braking case | 0.02° |
| Anti-dive / anti-squat | classic geometric % at static height (brake / drive mount, bias / split) | 1 % |
| Bump steer (every design) | as in the corner optimizer, for every design | 0.01° |

Because load sensitivity rewards evenly loaded tires, the grip goal also cares how load transfer is split. Front/rear differences (LLTD) need separate front and rear designs (untick *Rear same dimensions as front*). Tested: identical front and rear give LLTD ≈ the weight split (50.4 %); moving the four UCA pivot heights reaches a 55 % target within the ranges in ~2 s; one evaluation (two cases, two designs) takes ~0.1 s.

### Possible next steps for the optimizer
- **Ranges for other values**: spring rate and length, tire pressure, static camber/toe, and **derived-dimension ranges** (e.g. arm length between A and B), not only hardpoint coordinates.
- **Ghost preview** of the optimized geometry in the viewport before applying.
- **Tire data**: fit μ_ref, n and β (or a full Pacejka-style model with camber thrust) from measured data, per tire.
- **Per-tire grip model** (different tires front and rear) instead of one shared model.
- **Steady-state cornering balance**: find the lateral g where the front or rear axle saturates (friction limit) and maximize it, instead of a fixed g.
- **Combined cases**: braking in a turn, a weighted mix of cases, and a track-specific case list.
- **Multi-start / global search** for problems with several local optima (the solver is local).
- Optimize anti-roll bar rate and spring rates along with geometry.

## L7: Optimizer objectives and requirements

### Requirements (noted 2026-11-21)
- **Bump-steer minimization by tie-rod placement** ✅: an option to optimize the tie-rod mounting points (inner and/or outer, within user limits) so bump steer (toe change through travel) is reduced as far as possible.
- **Simple locking** ✅ (the optimizer reads it): any component or value can be locked — a whole part (e.g. the lower arm), individual hardpoints, single coordinates, or derived values such as an arm length — and the optimizer must work around everything locked. Users often start from something already built, so the optimizer has to respect the parts they can't or won't change. Ranges ("between A and B") are the in-between option.
- **Lock keys** (`src/app/locks.ts`, saved in the project file from format v4): `FL.point.trInner.y` (one coordinate), `FL.part.uca` (every point of a part, including the coilover mount on the arm that carries it), `FL.derived.uca.length` / `inclination` / `planAngle`, `FL.spring|damper|tire|scalar.<key>`, `vehicle.<key>`, `shared.<axle>.<key>` (and `shared.front.dropLink.x`), `steer.<key>`. Linked corners share one design, so they share its locks; unlinking a corner copies them. A locked value can still be typed by hand; dragging and nudging a locked coordinate is blocked.

### Objectives
Maximum contact area is a useful proxy, but it is **not** the same as maximum grip:
- Rubber friction depends on contact pressure (**load sensitivity:** μ drops as load per area rises). This is why area helps, but the relationship isn't 1:1.
- Most tires make peak cornering force at **slightly negative inclination**, not at 0°. Maximizing area alone pushes toward 0°.
- At the vehicle level, total grip is higher when load transfer is spread evenly across tires (also load sensitivity).

Selectable objectives:
1. **Target inclination under load** (default; e.g. hold −0.5° to −2° on the loaded tire).
2. **Maximum contact area** (current proxy).
3. **Maximum friction force** using a load-sensitive / camber-aware tire model (when the user has tire data).

Multiple objectives can be weighted. All objectives respect lock / range / free settings.

---

## Open Items
- Calibrate `k_v` and the patch model against measured tire data (the rigid-cylinder patch under-predicts deflection: ~2 mm at 900 N / 12 psi for a 20.5x7.0-13, where real tires deflect more because the tread flattens).
- Default shoulder radius as a fraction of section width.
- Carcass stiffness term for Model A.
