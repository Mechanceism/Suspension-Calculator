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

### Other suspension types ✅ (`src/core/suspension/doubleWishbone.ts`, decided 2026-11-22)
Every type is the same kind of relation system on the same point names; `kind` picks the relations.

| Type | Moving bodies | Relations | Steering axis |
|---|---|---|---|
| Double wishbone | UCA, LCA, upright | two revolutes (5 + 5), two ball joints (3 + 3), tie rod 1, travel 1 = 18 | UBJ – LBJ |
| MacPherson strut | LCA, upright (with the strut tube) | revolute 5, ball joint 3, **strut axis through the top mount** 2 (the top mount is a point on the chassis that must stay on the line through the strut's two upright-fixed points; the strut slides and turns on it), tie rod 1, travel 1 = 12 | LBJ – strut top mount |
| Multilink (5 links) | upright | five rods with ball ends, each a fixed length between a chassis point and an upright point (upper front / rear, lower front / rear, tie rod or toe link) 5, travel 1 = 6 | virtual: through the points where each pair of links passes closest |
| Single arm (swing / trailing arm; knuckle on the arm) | arm, upright | arm revolute on the frame pivots 5, kingpin revolute between arm and knuckle 5 (`UCA_Out` top, `LCA_Out` bottom, both fixed to the arm), tie rod 1, travel 1 = 12 | the kingpin on the arm (tilts with the arm) |
| Solid axle, 4-link / 3-link + Panhard rod (`src/core/suspension/solidAxle.ts`) | the axle (both wheels) | four rods with ball ends (4-link: lower and upper per side; 3-link: lower per side, one upper in the middle, a Panhard rod), two travels (left, right) = 6 | none (doesn't steer here) |
| Solid axle on leaf springs | the axle (both wheels) | the SAE 3-link equivalent: per side a link from ¼ of the way from the front eye to the seat, a stiff center link that keeps the axle's pitch, a long virtual lateral link at seat height = 4, two travels = 6 | none |
| Twist beam (`src/core/suspension/twistBeam.ts`) | each arm (with its hub) | two parameters, heave θ and twist ψ, from the two travels (Newton, 2 × 2); as a corner: the arm's revolute on the bushing line 5, travel 1 = 6 | none |
| Custom linkage (`src/core/suspension/customLinkage.ts`) | the knuckle + any bodies you add | ball joints 3, hinges 5, rods 1 each, travel 1: 6 · bodies + 1 | from the motion: the knuckle's screw axis when the rack moves |
| No suspension (rigid, e.g. a kart) | upright (on a carrier that only takes the travel input as a vertical shift) | kingpin revolute 5 (`UCA_Out` top, `LCA_Out` bottom), tie rod 1 = 6 | the kingpin |

- **MacPherson:** the strut is the spring / damper: `Dmp_Chs` = top mount, `Dmp_Arm` = a point on the strut axis fixed to the upright (the upper arm's points are unused). Motion ratio ≈ 1 (the strut shortens about as much as the wheel rises).
- **Multilink:** the arm pivots become the links' chassis ends, `UCA_Out` / `LCA_Out` the front links' upright ends and `UCA_Out2` / `LCA_Out2` the rear links'. A double wishbone is the special case where each pair meets at one ball joint, and the solver reproduces it exactly. A coilover mounts on the upright (there is no arm body; an anti-roll-bar drop link "on the lower arm" goes on the upright too).
- **Single arm:** the knuckle and arm move as one, except for steering on the kingpin bushing on the arm. The instant axis is the arm's pivot line, fixed to the frame, so the front-view IC stays at the pivot through travel. Camber gain ≈ −1 / (distance from the wheel to the pivot line). The pivot line's direction sets the layout:
  - Along the car: swing arm (long-travel, trophy-truck style). Preset *S*: FVSA 520 mm, roll center 185 mm, −0.11 °/mm camber gain.
  - Across the car: trailing arm. Preset *T*: no camber change, roll center at the ground, side-view IC at the pivot.
  - Angled: semi-trailing.

  Bump steer depends on how close the inner tie-rod joint is to the pivot line. The coilover mounts on the arm or the knuckle. Switching from a double wishbone puts the kingpin through the old ball joints, so KPI and caster stay the same.
- **Solid axle:** one rigid axle carries both wheels; the links leave it two freedoms, the left and right wheel travel.
  - **Results:** roll center = the axle's front-view instant center when it rolls relative to the body (left up, right down), e.g. the Panhard rod's height. Side-view IC = its instant center in heave (where the link lines cross in side view). Also roll steer (axle yaw per degree of axle roll), wind-up (pitch per mm of heave) and the Panhard rod's sideways shift.
  - **Whole car** (`src/core/vehicle/axleTable.ts`): the axle is tabulated over a grid of both travels (tensor Catmull–Rom with both partial derivatives); each wheel is a corner whose motion also depends on the other side's travel. Its forces do virtual work on both travels (*cross work*), so the two travels settle together in the steady solve. In the ride model they are coupled through the forces, the dampers, the axle's mass and tire damping. Preload is fitted with the axle's heave motion ratio, −(∂L/∂q_own + ∂L/∂q_other).
  - **In the app:** the type spans the axle: left and right share the design, and an axle that shared its design with the other axle gets its own first. Point names: lower link `LCA_Fwd` (frame) → `LCA_Out` (axle); upper link(s) `UCA_Fwd` → `UCA_Out` (4-link: per side; 3-link: in the middle); Panhard rod `PH_Chs` → `PH_Axle`; coilovers `Dmp_Chs` → `Dmp_Arm` on the axle. Switching to it builds working links from the hub (the coilover keeps its length). The Corner view shows the left wheel as the axle heaves, with the whole axle drawn. Presets *A4*, *A3*.
  - **Tested:**
    - kinematics: the 3-link + Panhard roll center is at the rod's height, the side-view IC is at the link lines' crossing, each wheel tilts with the axle in roll, angled links give roll steer, a missing link is caught;
    - whole car: a 3-link + Panhard rear settles at design height, corners about its roll center (a bigger share of the rear transfer goes through the links), and a bump under one rear wheel moves the other;
    - in the browser, switching the rear to a solid axle passes the Balanced test.
  - **Cost:** about twice an independent corner pair per state.
  - **Watt's linkage** (type *Solid axle, 3-link + Watt's linkage*, preset *AW*): instead of a Panhard rod, a bar on a pivot on the axle (`PH_Axle`, turning about the car's length) with its top end linked to the frame on one side (`PH_Chs`) and its bottom end to the frame on the other (mirrored: the bar's ends are as far above / below the pivot as the top link's frame end). Bar body 6 − pivot 5 − two links 2 = it takes one freedom from the axle, like the Panhard rod. Its pivot moves straight up and down, so the roll center is at the pivot and the axle doesn't shift sideways in heave. Tested: roll center at the pivot height, no sideways shift (less than a Panhard rod's).
  - **Steered axle** (*Steered axle* under the type, for any solid axle; on by default when a steered corner becomes a solid axle; preset *AS*): each wheel on a knuckle turning on a kingpin at the axle end (`UCA_Out2` top, `LCA_Out2` bottom; the right one mirrored). A cross tie rod joins the knuckle arms (`TR_Out` and its mirror), and a drag link runs from the steering (`TR_In`, moved by the rack along X) to the left arm. Unknowns: axle 6 + two knuckles 12 = 18; equations: links 4 + kingpins 10 + cross tie rod 1 + drag link 1 + two travels 2 = 18.
    - The kingpin is the steering axis: KPI, caster, scrub and trail as for any corner. Arms behind the kingpins pointing in toward the rear axle give Ackermann (the inside wheel turns more). The drag link's arc against the axle's motion gives the bump steer.
    - In the vehicle view the axle's table is built at the current rack.
    - Tested: the rack turns both wheels the same way with the inside one more, the axle doesn't move when steering, KPI and caster match the kingpin, the corner steers and has some bump steer, the app switches a steered corner to a steered axle (7° KPI), and it saves and loads.
    - In the browser: a steered Watt's front axle reads KPI 7.1°, caster 3.8°, roll center 304 mm, and passes the Balanced test.
- **Leaf springs:** the leaf both locates and springs the axle. Points: front eye `LCA_Fwd`, spring seat `LCA_Out` (on the axle), rear shackle `LCA_Aft`.
  - **Model:** the SAE 3-link equivalent. The front half of the leaf acts like a link from a pivot a quarter of the way from the eye to the seat, so the seat moves on a ¾-length arc. A stiff center link parallel to those links keeps the axle's pitch (no kinematic wind-up). The leaves are stiff sideways: a long virtual lateral link at seat height, so the roll center ≈ the seat height. The leaf rate acts as a vertical spring at each seat (rate = the design's spring rate, the leaf rate at the seat; its installed length = the coilover's, so free length, damper stroke and bump stop still fit).
  - **Everything else** is the solid axle above (the car, the ride model, the app). Preset *LF*.
  - **Tested:** roll center at the seat height, no wind-up, the spring shortens by the travel; a car with it at the rear corners; in the browser it passes the Balanced test.
- **Twist beam:** two trailing arms, each on a bushing (`LCA_Fwd`), joined by a beam that is stiff in bending and soft in torsion. Its shear center `LCA_Aft` sits on the centerline. Coilovers `Dmp_Chs` → `Dmp_Arm` on the arms.
  - **Model:** the usual kinematic one, with two parameters. In heave θ both arms swing about the line through the two bushings: plain trailing arms, no camber or toe change. In twist ψ each arm turns about the line from its bushing to the shear center (where that point is after the heave), the left by ψ and the right by −ψ. So in roll each wheel moves like a semi-trailing arm about bushing → shear center: moving the shear center back (or down) adds roll camber, roll steer and roll center height. θ and ψ come from the two travels by Newton (2 × 2, numeric Jacobian).
  - **Results:** roll center from the roll axis (bushing → shear center) as for a single arm; side-view IC at the bushing (heave); roll camber from the twist motion (not from the heave camber gain, which is 0). Preset *TB*: roll center 200 · 600 / 1560 = 77 mm, roll camber 0.62 °/°.
  - **Whole car:** the twist beam is tabulated like a solid axle (each wheel's material contact follows its own arm), so the two rear wheels are coupled. The beam's twist stiffness is the axle's anti-roll bar (Shared components); switching to a twist beam starts it at 15 N/mm at the wheel if the axle has none.
  - **Tested:** any pair of travels is reached; heave keeps camber and toe; with the shear center level with the bushings it is two trailing arms (no roll camber); the corner's roll center and side-view IC match the hand values; a car with it at the rear settles and corners; in the browser it passes the Balanced test.
- **Custom linkage:** your own bodies and joints (Inspector → *Linkage*, with nothing selected).
  - **Joints:** between the frame, the steering rack, the knuckle (which carries the wheel) and any bodies you add:
    - a **ball joint** (a shared point; 3 equations);
    - a **hinge / bushing** (a common axis through two points; 5);
    - a **rod** (a fixed-length link with ball ends; 1);
    - **slide and turn** (cylindrical: the two bodies slide along and turn about a common axis; 4), e.g. a strut tube or a sliding pillar;
    - a **slider** (prismatic: they only slide along it; 5). A MacPherson built from a lower arm, a top-mount body on a ball joint and a slider along the strut moves exactly like the built-in MacPherson (camber and toe to 1e−7). With *slide and turn* instead, the top mount could spin freely: the freedom count says 2.
  - **Freedom:** a corner needs exactly one free motion with the steering held, 6 · moving bodies − equations = 1. The editor counts it and says what to add or remove, and finds bodies joined to nothing.
  - **Results from the motion itself**, at each solved state, by central differences (two extra solves each):
    - Instant axis: the knuckle's twist (ω, v) for ±0.25 mm of travel. As for the multilink: the planes through two points on the steering axis normal to their velocities, so the bump-steer part is left out; components within the differencing noise snap to zero (an axis along the car has SVSA ∞).
    - Steering axis: the knuckle's screw axis for ±0.1 mm of rack, between the ground and 150 mm above the wheel center. It is taken with the wheel center held at its height; for a double wishbone this is within ~0.5 mm of the ball-joint line (KPI and caster agree to 0.01°). Without a rod or joint to the rack, the corner doesn't steer.
    - So camber / toe curves, KPI, caster, scrub, trail, the instant centers and the roll center work as for the built-in types.
  - **Coilover:** `Dmp_Chs` on the frame, `Dmp_Arm` on the body you choose.
  - **Moving its points:** click a joint's point in the Corner view for X / Y / Z arrows. Free coordinates in the corner optimizer include *Linkage points* (variables `custom:<joint>:<p|q>`), applied back into the linkage.
  - **Whole car:** like any other type: tables, the vehicle solve, ride, handling, tests and the optimizer (its free points are the hub and coilover points; the linkage's own points are edited in the Linkage editor).
  - **Switching to it** starts from the current arms (hinged arm bodies, ball joints to the knuckle, the tie rod as a rod from the rack), so it moves the same. Switching away and back keeps your linkage. Saved with the project (format 27).
  - **Tested:**
    - built from a double wishbone it matches camber and toe to 1e−8, KPI and caster to 0.001 rad, and the roll center and FVSA;
    - five rods reproduce the multilink;
    - a layout of its own (a lower arm with two rods to the knuckle top) solves, cambers and steers;
    - under- and over-constrained or unconnected linkages are explained;
    - a car with it in front corners;
    - it saves and loads.
  - **In the browser:** the readouts match the double wishbone's (roll center 49.9 vs 50.0 mm).
- **No suspension:** no spring or damper. The vehicle solve holds the corner's travel at 0 and the ride model drops its travel degree of freedom, so only the tire is compliant. Body roll then comes from the tires alone: 0.09° at 0.8 g on the default car made rigid, with roll stiffness ≈ 3 500 N·m/° per axle. In the Corner view, travel lifts the whole corner with no camber or toe change, and there is no roll center.
- **Switching type** keeps the lower arm, tie rod, hub and tire. To MacPherson: the strut's lower point goes inboard of the tire, between the ball joints; the top mount goes 330 mm above the upper ball joint and 60 mm inboard. To multilink: each link's upright end slides 35 mm inboard along its own line, so each pair still passes through the old ball joint. That gives the same virtual pivots and instant axis, so the motion is the same at ride height and within a few hundredths of a degree through travel. Back to a double wishbone: the links rejoin at their virtual pivot; a strut becomes a coilover on the lower arm.

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
- **Other types** use two planes that the upright's motion is confined to in the same way. **MacPherson:** the lower-arm plane, and the plane through the strut top mount normal to the strut (the strut slides along itself there). **Multilink:** the planes through the two virtual steering pivots normal to their velocities. The velocities come from the upright's twist (ω, v) that keeps all five link lengths (d_i · (v + ω × q_i) = 0, five equations in six unknowns; the null vector by cofactors). Points on the steering axis aren't moved by steering, and for joined link ends these planes are exactly the arm planes. The full screw axis (with the tie rod's small turn about the steering axis) is also available.
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

### More variables ✅ (`src/core/suspension/derived.ts`, 2026-11-22)
- **Caster gain, KPI gain** (°/mm of bump), **track change / scrub** (half-track change per mm of bump, + = contact moves outboard) and **roll-center migration** (RC height change per mm of heave): central differences at the current travel (±0.5 mm). KPI and mechanical trail are also plotted through travel.
- **Roll camber** (outside wheel, camber change to the ground per degree of body roll): Δγ/Δφ = 1 + (dγ/dz) · half track, with dγ/dz in rad/mm. Rolling by φ moves the outside wheel into bump by ≈ φ · half track and tilts it with the body by φ. 1 = the wheel leans with the body, 0 = it stays upright to the ground (like a solid axle), < 0 = it leans into the turn. Double wishbone sample C: 0.70.
- **Ackermann %** = (δ_inside − δ_outside) / (δ_inside,ideal − δ_outside) × 100, with the ideal from cot δ_o − cot δ_i = track / wheelbase. The two wheels come from the corner and its mirror image at ± rack travel, the track is between the steering axes at the ground, and the wheelbase is the vehicle input. 100 % = ideal Ackermann, 0 % = parallel steer, < 0 = anti-Ackermann. Shown at the current steering position and at full lock, and plotted against steering-wheel angle.
- **Roll stiffness** per axle (vehicle, from the solved cornering state) = load moved through the springs (total − F_y · h_RC / track) × track ÷ body roll, in N·m/°. It counts the springs, anti-roll bar and heave spring, in series with the tires. The front share and the **roll gradient** (body roll per g) are shown too. Checked against wheel rate (in series with the tire) × track² / 2: within 10 % on the default car (325 vs 318 N·m/°).


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
- **Set pressure = cold, no load** (V₁ is the unloaded air volume). A reading taken with the car on its wheels is a little higher (less air volume), so the setup wizard converts it with `unloadedSetPressure`. A fixed point finds the no-load pressure that, loaded to the corner's static load at the set conditions, reads the measured value. Tested: loading the result again reads the measured pressure to 0.001 kPa.

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
- **Steering mechanism** (Steering → *Mechanism*, the same for every corner because the input's units are shared):
  - **Rack and pinion:** the inner tie-rod joint slides along the rack axis; the input is rack travel (mm).
  - **Steering arm / plate:** the inner joint swings about a pivot axis (`Str_Piv1` → `Str_Piv2`) by the input angle (°). This covers an ATV-style plate on the steering column and a steering box's pitman / idler arm carrying a center link (each inner joint then moves on its arm's circle). The ratio is arm degrees per steering-wheel turn (360 °/rev = 1 : 1 handlebars; a steering box is about 20 °/rev). The tie rod's pull gives the torque on the arm about its axis, T_arm = û · ((TR_In − pivot) × F); steering-wheel torque = T_arm · c / 360. Parking torque goes through the overall ratio (virtual work).
  - Tested: the inner joint stays on its circle; the arm torque and the rack force both equal the tire torque about the steering axis × the steering angle per unit of input (virtual work), within 10 %.
  - Each mechanism keeps its own ratio, ratio at full lock and limit (mm for the rack, degrees for the arm). Switching saves the current ones with the mechanism and puts the other's back; the first time it uses typical values (rack 75 mm/rev ±30 mm, arm 360 °/rev ±40°). The unused set is saved with the project (format 23).
  - Switching starts from a pivot 120 mm ahead of the inner joint, so the joint swings across the car much like on a rack. In the browser, 1 : 1 with 20° of arm gives 20.5° at the road wheel.
- **Variable ratio** (variable-ratio rack or geared cam): the input per steering-wheel turn goes from c₀ at center to c₁ at full lock, linearly with |input| / limit:
  `c(r) = c₀ + (c₁ − c₀)·|r|/L,   θ_sw(r) = 360 · L / (c₁ − c₀) · ln(c(r)/c₀)`
  Its inverse sets the input from the steering wheel. The local ratio c(r) is used for the steering ratio and torques; 0 = constant. Tested: the map round-trips, and with c₁ > c₀ fewer steering-wheel degrees reach full lock.
- **Rack ahead of / behind the axle** (`flipRackSide`). The steering arm is reflected through the steering axis in top view: K = the steering axis at the outer tie-rod joint's height, TR_out' = 2K − TR_out in X and Z. The arm stays on the same line, so the classic Ackermann line is unchanged. The tie rod keeps its length and direction (the inner joint moves with the outer one), and the rack now moves the other way for the same turn. Bump steer changes sign (e.g. +0.008 → −0.008 °/mm), and Ackermann % keeps its sign. Flipping twice returns the original.
- **Rack length** = the distance between the inner ball joints, 2 · |TR_In X| for mirrored corners. It can be typed (moves TR_In X) and locked with that coordinate; the tie-rod length follows.
- **Classic Ackermann lines** (Vehicle view, View → *Ackermann lines*). In top view, a line runs from each front steering axis (at the outer tie-rod joint's height) through that joint. Near straight ahead, 100 % Ackermann puts their crossing on the rear axle's centerline (the rear diff on a rear-drive car, but the rule is about the axle line). The readout gives the crossing's distance ahead of (+) or behind (−) the rear axle, or *parallel*. The sample car crosses 3.3 m behind the rear axle, matching its 15 % Ackermann at full lock. The rule only holds near straight ahead; Ackermann % shows what the linkage really does at larger angles.

## L5: Quasi-Static Corner ✅
Two operating modes:
1. **Kinematic:** the user sets travel and steer; geometry is reported. No spring needed (a tire load is optional).
2. **Loaded (settle on spring):** the user sets the corner load; the solver finds the travel where the spring carries it, then the tire carries the load on the ground.

**Spring layouts**
- **Option 1 (implemented): coilover** from a chassis mount to a mount on the LCA, the UCA or the knuckle (`FL_Dmp_Chs`, `FL_Dmp_Arm`). A knuckle mount moves about as much as the wheel (motion ratio ≈ 0.9–1); an arm mount moves less.
- **Placement as numbers** (`src/core/suspension/coilover.ts`):
  - Installed length (mount to mount) and the angles from vertical: front view (+ = top inboard) and side view (+ = top rearward). Editing any of these moves only the top / chassis mount; the lower mount stays.
  - The lower mount's position along its arm, from 0 (on the pivot axis, measured from its closest point to the ball joint) to 100 % (at the ball joint). Editing it moves the whole coilover along the arm, keeping its length and angles.
  - Locked coordinates are respected. Example: 29° → 10° and 80 % → 60 % on sample C keeps 387.7 mm, and the motion ratio drops from 0.68 to 0.58.
- **Option 2 ✅: pushrod / pullrod + rocker** (any type but MacPherson and rigid). The rocker is a body on a frame pivot axis (`Rkr_Piv1`–`Rkr_Piv2`, revolute 5). The pushrod is a fixed-length link from `PR_Arm` (on the lower arm, upper arm or knuckle) to `PR_Rkr` on the rocker (1). Together that's 6, so the rocker adds no freedom. The spring / damper runs from the rocker (`Dmp_Arm`) to the frame (`Dmp_Chs`). The spring code only needs the two spring ends, so the motion ratio, wheel rate, travel limits, the vehicle solve and the ride model all follow from the linkage with no other change. A pullrod is the same relations with the link in tension.
  - **Starting layout** (`rockerFromCoilover`) when switching from a coilover. The pushrod starts at the old lower mount and goes to a rocker a quarter of the coilover's length below its top, on a fore-aft axis. The pushrod lever (60 mm) is square to the pushrod. The spring lever (50 mm) is square to the spring, which keeps its length and runs up and inboard at 45°. The levers' sides are chosen so the spring compresses in bump. On sample C the motion ratio goes from 0.68 to 0.59. Back to a coilover: from the pushrod's lower end to the rocker pivot.
  - Tested: the pushrod keeps its length and the rocker turns; the spring shortens in bump; the whole car settles at its design height with the preload fitted; a rocker on a MacPherson is refused; files before format 19 get a rocker built from their coilover, quietly.

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
- *Anti-roll bar:* none · **rate at the wheel** (N/mm of left/right travel difference) · **torsion bar + drop links** (bar rate N·m/deg, arm length, drop-link mount on the lower arm, upper arm, knuckle or **the rocker** (pushrod layouts: the bar then works through the rocker's ratio; a corner without a rocker puts it on the knuckle) — tracked through travel; twist = left/right mount height difference ÷ arm length). Verified: the torsion bar matches a wheel-rate bar of the equivalent rate (bar rate · link motion ratio² ÷ arm²).
- *Rocker ratio* (Spring panel, pushrod layouts): the spring end's lever about the rocker's pivot axis ÷ the pushrod end's (distances from the axis). Typing a ratio slides the spring's rocker end along its arm (same direction from the axis) and moves the coilover's frame end with it, so the coilover keeps its length and angle; the spring's motion scales by the same factor. Tested: the ratio is set exactly and the motion ratio scales by it.
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

## Brakes: hydraulics ✅ (`src/core/vehicle/brakes.ts`)
Off by default (the brakes can always make the braking asked; only grip limits it). On (Vehicle → Inputs → *Brake system*): the most braking force the brakes make, from the pedal to the tire, independent of grip.

    master cylinder force   F_mc = F_pedal · pedal ratio · booster gain · (balance-bar share with two master cylinders)
    line pressure           p = F_mc / (π/4 · bore²)
    friction per caliper    F_f = 2 · μ_pad · p · A_pistons        (A = one side's piston area; two pads)
    torque, tire force      T = F_f · r_eff,   F_tire = T / r_tire  (per wheel; r_tire from each axle's tire)

- One tandem master cylinder: both circuits get the same pressure. Two on a balance bar: the pedal force splits front : rear.
- **Hydraulic bias** = F_front / (F_front + F_rear). It can be used as the brake bias (*Brake bias from the hydraulics*).
- **Pedal force needed** for a braking case: everything is linear in the pedal force, so per axle it is (demand ÷ capacity) × the most pedal force; the larger axle sets it. More than the most pedal force → the new pass rule **Brakes too weak** (Fail by default; no suspension change can fix it).
- Defaults: 500 N pedal, 4 : 1, no booster, 3/4" master cylinder, 2 × 32 mm pistons per side front, 1 × 28 mm rear, μ 0.45, 100 / 90 mm effective radius. That gives 7.0 MPa, 7.8 / 2.7 kN per axle, 3.6 g of brake capacity on the default car and a 74 % hydraulic bias; a 1.2 g stop needs 262 N of pedal.
- Tested: the hand-calculated pressure, torque and tire force; the balance-bar split; linear pedal force; a 1.2 g stop beyond weak brakes fails *Brakes too weak* and is fine with strong ones; the axle that needs more pedal sets the pedal force.

### Brake fade ✅ (`src/core/vehicle/brakeThermal.ts`)
With the hydraulics on, *Brake fade in tests* heats the rotors through a test. One lumped rotor per wheel:

    C dT/dt = P − hA(v) (T − T_air)       C = rotor mass · 460 J/(kg·K) (cast iron)
    P       = braking force at the wheel · v   (all the braking energy into the rotor)
    hA(v)   = cooling · (0.2 + 0.8 · v / 27.8 m/s)   (cooling given at 100 km/h; a fifth of it at a stop)
    exact step for constant P, v:  T(t) = T∞ + (T0 − T∞) e^(−hA t / C),  T∞ = T_air + P / hA

- **Pads:** μ = μ0 below the fade start, falling linearly to μ0 · (1 − loss) at the fade end, then staying there. Each axle's braking capacity scales with its pads.
- **In a test:** each segment's brake energy per axle = the samples' mean braking force × the distance (∫ F v dt = ∫ F ds), over the segment's time (distance ÷ mean speed). Every sample is then checked at the hottest the segment gets (the larger of its start and end temperatures):
  - **Brake fade** (Warning by default): the pads have lost more than the allowed share (10 %).
  - **Brakes too weak** (Fail): the faded brakes can't make the braking at the most pedal force (when the cold ones could).
- **Results:** the rotor temperatures (front / rear) at the end of each segment in the test table, and in playback (state-to-state playback integrates frame by frame with each frame's braking force; the ride over time estimates it from the deceleration and grade, m·g·(−a_x − sin grade), split by the brake bias).
- **Defaults:** 2.5 / 2 kg rotors, 25 W/K cooling at 100 km/h, fade from 400 °C to 650 °C losing 40 %, air 20 °C, rotors at 50 °C at the start.
- **Tested:** the exact step (steady temperature, time constant), the pad curve; a stop heats each rotor by its share of the kinetic energy; repeated hard stops on light rotors and early-fading pads build heat stop to stop, warn of fade and then fail *Brakes too weak* while the same test without fade passes; playback frames carry the temperatures; the project saves it, and older files load with it off (format 25). In the browser, the Balanced test on the default car with 0.8 kg rotors reaches 94 °C front.

## Towing (static) ✅ (`src/core/vehicle/towing.ts`)
Off by default. On (Vehicle → Inputs → *Towing*): a trailer on a ball hitch behind the car that follows the car's accelerations (no sway). Its forces on the car at the hitch come from its own balance. m_t = trailer mass, τ = static tongue share (its CG sits τ·L_t ahead of its axle), L_t = hitch to axle, h_h and h_cg = hitch and CG heights, β = the share of its braking its own brakes make.

    lateral       F_x = −m_t · a_y · τ                                   (pulls the hitch outward)
    along         F_trailer = m_t · a_x − (braking ? β · m_t · a_x : 0),   F_z = −F_trailer
    tongue load   V = m_t · g · τ + (h_h · F_trailer − h_cg · m_t · a_x) / L_t,   F_y = −V

- The force acts on the body at the hitch (vertical load, plus roll and pitch moments).
- The tires must also give what the hitch takes:
  - drive / braking: tire net g − F_z / (m·g)
  - side force: m·a_y − F_x
  - front / rear split from the yaw balance about the front axle: F_rear · (−L) + F_x · z_hitch = m·a_y·z_cg, so the rear tires take more.
- Handling over time, below walking pace (3 m/s): the trailer's tongue share of mass follows the car sideways, F_x = −m_t·τ·ΣF_tires / (m + m_t·τ), and yaws it about the CG. Faster, the trailer is its own body (sway, below).
- Results: tongue load, push / pull and side force at the hitch.
- Tested:
  - the hitch forces by hand; the tongue weight adds to the tire loads (the rear gains more than it, the front loses some, since the hitch is behind the rear axle);
  - braking at 0.5 g the car's brakes stop the trailer too (+ m_t · 0.5 g), and trailer brakes remove that push;
  - cornering, the tires give the trailer's tongue share of side force, mostly at the rear;
  - a test with handling is driven within 0.6 m of the line.
- In the browser: 400 kg at 10 % → 392 N tongue load; braking at 0.5 g → 1961 N push and 556 N on the tongue.
- Still to come: a tongue-weight limit check.

### Trailer sway ✅ (`src/core/tests/trailerSway.ts`)
In tests with *Ride over time* and *Handling* (the driver steering), the trailer is a second yawing body on the hitch ball with its own axle and tires. Car frame (x forward, y left); articulation φ = trailer heading − car heading; r_t = r + φ̇. The hitch is c behind the car's CG, the trailer's CG d = L_t·(1 − τ) behind the hitch, its axle L_t. Unknowns: v̇, ṙ, ṙ_t and F (the hitch's side force on the trailer, along its left axis n = (−sin φ, cos φ)). The pull along its axis e = (cos φ, sin φ) is F_t = m_t·a_x, less the trailer brakes' share when braking.

    car lateral       m (v̇ + u r) = ΣF_y + m g_bank − F cos φ − F_t sin φ
    car yaw           I ṙ = M_z + c (F cos φ + F_t sin φ)
    trailer lateral   m_t (a_hitch · n − d ṙ_t) = F + Y_t + m_t g_bank cos φ,   a_hitch = (a_x + c r², v̇ + u r − c ṙ)
    trailer yaw       I_t ṙ_t = d F − (L_t − d) Y_t                 I_t = m_t k² (k = yaw radius of gyration)
    trailer tires     Y_t = μ F_z tanh(C α / (μ F_z)),  C = 7 F_z /rad,  F_z = m_t g (1 − τ),  α from the axle's velocity

- **Solving:** a 4 × 4 linear solve per sub-step; the car's state then takes the solved accelerations, and the trailer integrates r_t and φ.
- **Jackknife effect:** braking without trailer brakes, F_t < 0 pushes along the trailer's axis, and F_t sin φ turns the car.
- **Sway** is measured against a kinematic trailer driven by the same car (its axle never slips sideways): φ̇_k = (−u sin φ_k + (v − c r) cos φ_k) / L_t − r. The tires' steady slip offset is removed by a 1 s low pass:
  - sway = |(φ − φ_k) − LP(φ − φ_k)|;
  - more than 30° from the kinematic trailer = jackknifed.
- **New pass rule** *Trailer sway* (Fail above ±5° by default, or on a jackknife).
- **Results:** in playback, the trailer's articulation and sway, and the trailer drawn behind the car on the track map.
- **Input:** *Trailer yaw radius of gyration* (default 1350 mm; ≈ 0.3 × a box trailer's length). Format 26; older files with a trailer get the default quietly.
- **Tested:**
  - a well-loaded trailer (12 %) at 15 m/s swings under 2.5° through an S-bend and settles;
  - in a slow steady turn it sits at the kinematic articulation, sin φ + c_r κ cos φ = −L_t κ (c_r = hitch behind the rear axle), within 10 %;
  - less tongue weight or more speed sways more;
  - a negative tongue weight at 25 m/s fails *Trailer sway* and jackknifes.
- **In the browser:** the HUD and the track map show the trailer.

## Aerodynamics ✅ (`src/core/vehicle/aero.ts`)
Off by default (negligible for slow cars). On: forces on the **body**, never through the tires, at the car's speed V (tests: each moment's speed; Vehicle view: the *Speed* slider) and air density ρ (from altitude and temperature: standard-atmosphere pressure, dry air).

    drag   D = ½ρV²·CdA                         rearward, at the drag height above the ground
    lift   L_f = ½ρV²·ClA_f,  L_r = ½ρV²·ClA_r   at the front / rear axle (+ = lift, − = downforce)

- **Where they act:** lift / downforce on the body at each axle (so it loads the tires, compresses the springs and pitches the car with the aero balance); drag on the body at its height (rearward: up high it moves load rearward), and the tires must drive against it: drag adds to the drive force needed (or takes from the braking needed) while the car's own acceleration stays what the segment asks.
- **Generic values** (editable, clearly generic): CdA 0.8 m², downforce areas 0.3 m² front and 0.4 m² rear, drag at 400 mm.
- **Aero map:** the coefficients can be tables over front and rear ride height (bilinear, held at the map's edges), so rake and ride height change downforce and balance as the body moves (in the steady solve and over time). Ride height = the body reference plane's height above the ground at that axle, absolute (mm) or as the change from the design ride height.
- **Exchange format** (for a separate aero / CFD tool; File → Import → Aero data, or the Aerodynamics panel), JSON:

      { "format": "suspension-aero", "version": 1, "name": "…",
        "CdA": 0.9, "ClAf": -0.6, "ClAr": -0.9, "dragHeight": 450,          constants (m², mm), or
        "rideHeightRef": "absolute" | "change",
        "map": { "rhFront": [mm…], "rhRear": [mm…],
                 "CdA": [[…]], "ClAf": [[…]], "ClAr": [[…]] } }               tables [front index][rear index]

  `ClA` with `balance` (front share of the downforce, 0–1) can stand in for ClAf / ClAr. Or CSV with a header row `rhF, rhR, CdA, ClAf, ClAr`, one row per ride-height pair forming a grid (ride heights absolute; drag at 400 mm). The imported model is saved in the project.
- Readouts: drag, downforce per axle and the aero balance (front share) in the Vehicle results; at 100 km/h in the panel.
- Tested: downforce adds ½ρV²·ClA to the tire loads, split by axle; at constant speed the driven tires push exactly the drag, and drag up high moves load rearward; the map interpolates bilinearly and holds at its edges; JSON (also `ClA` + `balance`) and CSV grids read, incomplete files are refused with the reason; air density 1.225 kg/m³ at sea level and 15 °C. In the browser: generic values at 144 km/h give 771 N drag and 289 / 385 N downforce (42.9 % front); an imported map raises downforce as the ride height drops.

## Editing tools: driving dimensions (`src/core/math/dimension.ts`)
Set dimension (Measure tool) moves one point; the other is fixed. With d = B − A:
- **Distance:** B′ = A + L·d/|d| (or A′ = B − L·d/|d|).
- **ΔX/ΔY/ΔZ:** replace one component of d.
- **View angles** from the horizontal: front atan2(ΔY, |ΔX|), side atan2(ΔY, |ΔZ|), top atan2(ΔZ, |ΔX|), slope atan2(ΔY, √(ΔX²+ΔZ²)). Setting one keeps the line's length in that view and the coordinate out of that view (slope keeps the 3D length and plan direction).
- **Along a line:** p′ = p + s·(q − p)/|q − p| (s > 0 toward q).
- **Held dimensions** (`src/core/suspension/dimensions.ts`): a measure between two hardpoints held at a travel position (0 = ride height; evaluated on the solved corner at that travel) or permanently (on the design itself; only offered when it can't change through travel: a distance within one rigid part, or anything between chassis points). After an edit, `resolveDimensions` moves the free coordinates of the points involved (not the edited or locked ones) by bounded least squares: residuals (value − held)/(10⁻⁴ mm or °), plus 10⁻³·Δx so the smallest move wins. A dimension it can't meet is reported (drawn red). Both optimizers hold them as stiff penalties (tolerance 0.001).
- **Arm front-view angle (static):** the pivot axis swings around the ball joint (Rodrigues rotation of the foot → ball-joint vector about the axis direction), keeping the axis direction, arm length and pivot spacing; solved by bisection. Lockable and held by the optimizer like the other arm dimensions.

## Grip and slip (whole car) ✅ (`src/core/vehicle/vehicle.ts`)
- **Cornering force split.** In a steady turn the axles' shares of m·a_y are fixed by yaw balance: front = b/L, rear = a/L (a, b = CG to front / rear axle). An axle can't hand cornering force to the other one.
- **Within an axle** both tires use the same fraction u of their grip: Σ √((u·Cᵢ)² − Fxᵢ²) = |F_axle| (friction circle with each tire's braking / drive force Fx and capacity C from the patch grip model). This is how force a saturating tire can't carry moves to its partner. u > 1 for the axle = understeer (front) / oversteer (rear).
- **Braking** split by bias, then by load; **drive** by the split, then by the differential: open = equal (the weaker tire limits the axle), locked = by load, limited-slip = by load with at most the torque bias ratio (2.5) between sides.
- **Grip use** per tire √(Fx² + Fy²)/C. States: braked past C → **ABS limit** (holds peak force) or **locked** without ABS (sliding friction, no steering grip); driven past C → **wheelspin**; otherwise > 1 → **sliding**. Deliverable force when over: peak (ABS) or sliding ratio × C (0.8 by default; peak → sliding friction). The shortfall is reported. What the car then does (drifts, spins, runs wide) needs the handling model (Phase C).
- **Road.** Grade θ and bank φ tilt gravity in the road frame: the tires must supply m·(a_x + g·sin θ) along the road and m·(a_y − g·sin φ) across it, and m·g·cos θ·cos φ presses the car down. Bumps / potholes: a ground-height offset under a wheel (the body lifts and tilts onto it; with no anti-roll bar a 30 mm bump moved that corner's suspension ~7 mm).
- **Aero** is not modeled yet (future goal: drag on the body as a braking force, lift / downforce at a center of pressure).

## Tests, Phase A: steady-state segments ✅ (`src/core/tests/`)
- **Segment** = speed (v₀ → v₁ over distance d: a = (v₁² − v₀²)/2d, or a g override) + path (straight / left / right with radius R: a_y = v²/(g·R), or a lateral-g override) + road (grade, bank, bumps). Combined layers act together; a test chains segments.
- **States:** each segment is sampled at 3 speeds across its range (1 if constant); every sample is one whole-car steady state. Chain order doesn't change steady states (transients are Phase B).
- **Grade and bank** (exact, `roadEffective`): the car's acceleration and gravity resolved in the road plane (g): lateral = a_y·cos θ − sin θ·cos φ, along = a_x·cos φ + sin φ, normal = cos θ·cos φ + a_y·sin θ − a_x·sin φ (bank θ, + = left side lower; grade φ, + = uphill). Turning on a bank toward the inside needs less side grip and presses the car into the road: at the balance speed a_y = tan θ the side force is zero and the load is 1/cos θ (tested). Before, the bank was taken as a_y − sin θ with load cos θ, which missed the extra load at speed on steep banking.
- **Pass rules** (`checks.ts`): each check has a severity (Pass / Warning / Fail) and thresholds: near the grip limit (reserve %), understeer (front axle > 1 + allowed), oversteer (rear axle > 1 + allowed, or rear > 1 while the front has less than its reserve left to catch it), wheelspin, ABS active (with an allowed braking shortfall; beyond it also *speed not reached*), lock-up, speed not reached (acceleration without powered wheels, braking without brakes: velocity changes only through the tires), bump-stop contact, bottoming / topping out, wheel lift (< 25 N), rollover (|a_y| > half track ÷ CG height), no solution, and **beyond the tires** (requested combined g > the tires' total grip at rest, an upper bound since load transfer only lowers it: no suspension can pass). A segment is the worst severity of its samples; it passes with no Fail.
- **Steering** (`steer.ts`): a turn of radius R needs the low-speed (Ackermann) road-wheel angle δ = atan(wheelbase ÷ R). The steered axle's angle is the mean heading change of its two wheels, each from the corner solved with the rack moved (left corner +r, mirrored right corner −r); a secant search finds the rack travel r that gives δ. More than the rack limit (or no steered wheels) fails **Steering lock** at any speed. Front steer turns toward the turn, rear-only steer the other way. Slip angles (more or less steer at speed: under / oversteer) come with Phase C. The rack travel (clamped to the limit) poses the wheels in the 3D view during playback and when a state is shown.
- **Solver start:** each state starts from the previous state's pose; when that doesn't converge (a very different state, e.g. a dip under one wheel) it is solved again from the design pose.
- **Speed limit:** bisection on a speed scale k (g overrides scale with k²) for the fastest k with no Fail.
- **Road surface** (`road.ts`): seeded value noise (3 octaves, feature size = scale, stretched so peaks reach the max height), masked to rough patches by a coarser noise (coverage); placed bumps / potholes are cosine profiles (position, length, height, side). Wheel heights: front axle at s, rear a wheelbase behind, left / right at ± half track. Each segment adds steady states at its worst spots (highest wheel, lowest wheel, largest diagonal twist (FL + RR) − (FR + RL), scanned every 0.1 m) at the speed the car has there.
- **Playback** (`playbackFrames`): constant acceleration per segment (v from v₀ to v₁ over the distance), a frame every 0.1 s (at most 600), track position integrated from heading (dθ = ds / R for turns) and grade; each frame solved and classified like a test state.
- **Track map** (`trackPath`): the test drawn from its segments alone: straights, and arcs x = x₀ + (sin θ − sin θ₀)/κ, y = y₀ − (cos θ − cos θ₀)/κ with θ = θ₀ + κs, κ = ±1/R.
- **Optimizer:** one test or all enabled tests (weighted by priority × segment weight) can be the vehicle optimizer's load cases. *Test passes*: each state's pass rules become one-sided residuals (≈ 1 per 1 % over a grip rule; bump stop, bottoming and wheel lift as fixed penalties), × 1 for Fail rules, × 0.3 for Warnings, × √weight; failures geometry can't change (no drive / brakes, beyond the tires, steering lock, rollover) are left out. *Test reserve* (improve): √weight · (worst grip use of the state) / 0.05 per state, so the worst states count most. Packaging: a free point may not move into the tire's tread band (10 mm clearance) or within 20 mm of the ground.
- **Loop** (Tests workspace), for one test or all enabled tests: test → optimize (25 iterations) → apply → re-test, until everything passes. When two rounds improve < 1 % (or nothing moves), the free ranges are widened about their centers ×2, ×3, ×4, ×5, ×10, ×20, … up to the user's maximum (always containing the current value), and stored ranges grow to include points moved outside them (+5 mm); it stops when stuck at the maximum widening (or after 40 rounds). Score = 100 · (fixable Fail findings) + 10 · Σ grip use over 100 % (+ average grip use when improving); with several tests, the priority-weighted mean (weight n + 1 − rank).
- **What geometry can change:** in a steady turn both axles reach their limit together and the total is set by μ·W, so with the old placeholder tires geometry only shifted load transfer (a 31 mph, 20 m turn: 94.8 % → 94.7 % grip use). With the Magic Formula the inclination counts too: leaning into the turn adds camber thrust, leaning out costs grip, so camber gain and roll now change the grip.
- Tested: rack travel grows with tighter turns and flips sign left / right, too tight a turn and no steered wheels fail Steering lock, a 90° arc ends R across and R ahead, every built-in test settles in every state, CG front/rear split, equal grip use within an axle, uphill drive force = m·g·sin θ, bump loading, understeer at 1.6 g, ABS limit vs lock-up, open vs locked diff in a powered turn, segment kinematics, a failing turn's speed limit and the lifted re-run passing.

## Tests, Phase B: ride over time ✅ (`src/core/tests/ride.ts`)
The whole car driven through a test as a dynamic system with 7 degrees of freedom: body heave h, roll φ, pitch θ (the steady solve's pose) and each corner's wheel travel q.

    M(x)·ẍ = Q(x, ẋ, t)

- **Generalized forces Q** reuse the steady solve: tire forces at the contacts, weight and the steady inertia (segment accelerations) of every mass give the body's net vertical force and roll / pitch moments about the origin (`bodyResidual`) and, by virtual work along each travel, the corner's force (`cornerWork`: tire, spring, bump stop, anti-roll bar / heave spring, jacking). Springs, bump stops, bars and dampers are internal: they only act along the travels.
- **Dampers** (coaxial with the spring): the damper force F(L̇) acts along the travel as −(dL/dq)·F(L̇), L̇ = (dL/dq)·q̇. **Linear** (default): F = c·L̇, c = bump rate while the damper shortens, rebound rate while it extends. **Two-stage** (digressive when the high-speed rate is lower, as most road and race dampers): F = c_low·v up to the knee shaft speed v_k, then c_low·v_k + c_high·(v − v_k), per direction. Generic two-stage defaults: half the low-speed rate past a 0.1 m/s knee.
- **Ride measures** (for tuning): wheel-lift time (Σ over wheels, s), bump-stop time (s), tire-load variation (RMS of each tire's load around its 0.5 s running mean ÷ its static load: grip lost to bouncing) and the body's vertical acceleration RMS (m/s², comfort).
- **Tire:** vertical force from the tire model at the road height under each wheel (tabulated once per tire over wheel-center height and tilt for speed), plus tire damping c_t·(ġ − ẏ_wc) while in contact; a wheel off the ground carries nothing. Lateral, braking and drive forces are shared as in the steady solve (yaw balance front / rear, equal grip use within an axle, brake bias, drive split, differential) from the latest tire loads.
- **Mass matrix M** from the kinetic energy: the sprung mass at its CG and its roll / pitch inertia about it (*Body roll / pitch inertia*), plus each unsprung mass moving with the body and along its wheel path (velocity Jacobians of the CG and wheel centers: ∂p/∂h = ŷ, ∂p/∂φ = ẑ × r, ∂p/∂θ = x̂ × r, ∂wc/∂q = the wheel-center path). Small angles; no gyroscopic terms.
- **Road input at speed:** front wheels at the car's position s, rear wheels a wheelbase behind, left / right at ± half track, on the rough surface and placed bumps / potholes (plus held bumps).
- **Driving:** constant acceleration per segment (as in the steady playback); the lateral / longitudinal accelerations, grade and bank change smoothly (smoothstep) over 0.3 s at each segment boundary, so turning in, braking and the like cause transients.
- **Integration:** RK4, 2 ms step, from the steady state at t = 0. Travel limits are hard stops (the travel velocity into the stop is removed; flagged as bottoming / topping out).
- **Checks** every 10 ms with the pass rules, like steady states. Grip problems (near the limit, sliding, under / oversteer, ABS, wheelspin) count only when they last ≥ 0.1 s (a tire overloaded for a few milliseconds as a bump unloads it doesn't make the car slide); wheel lift, bump-stop contact and bottoming count at once. One finding per check and segment, with when it first happened and how often. A segment that passes as steady states but fails over time is marked so (no speed limit is offered for it).
- **Playback** (25 frames/s) poses the 3D car directly from the simulated body pose and travels (`vehicleAt`), with roll and pitch in the readout; a run with *Ride over time* on keeps its frames, so Play starts at once.
- **Cost:** about 1 s of computing per 10 s of driving (browser / Node); a three-test Run all with steady states and the ride takes ≈ 5 s.
- Tested: a smooth straight at constant speed stays at the steady state; turning in, the body rolls and settles at the steady roll and travel for that cornering; a bump moves the wheel and the motion dies out, settling faster with more damping; every built-in test runs over time without going unstable; files before format 10 take the default ride inputs quietly.

## Tests, Phase C: handling over time ✅ (`src/core/tests/handling.ts`)
With *Handling* on (per test, default on with the ride), a driver steers the car along the path during the ride over time (Phase B) and each tire's side force comes from its own slip angle, so the car can run wide, cut in, slide and spin instead of following the path by definition.

**Planar states** (on top of Phase B's 7): lateral velocity v (+ left), yaw rate r, distance off the path e_y (+ left), heading error to the path e_ψ, and the steering. The forward speed u follows the test's speed profile.

    slip angle      α_i = δ_i − atan2(v + r·a_i, u − r·y_i)            a_i forward, y_i left of the CG (contact patches)
    side force      F_y,i = MF(α_i, F_z,i, γ_i, p_i) · √(1 − (F_x,i / F_x,peak)²)
    lateral         v̇ = Σ (F_y,i cos δ_i + F_x,i sin δ_i) / m + g·sin(bank)·cos(grade) − u·r
    yaw             I_z·ṙ = Σ (a_i·F_y,i^veh − y_i·F_x,i^veh)
    path            ė_y = u·sin e_ψ + v·cos e_ψ,     ė_ψ = r − u·κ(s)

- **Tires:** each tire's Magic Formula (its own model front / rear), at its load and inclination from the ride model at that moment and its pressure. The braking / drive force (shared as in the steady solve) takes its share of the friction ellipse; a wheel braked past its peak keeps 20 % of its side grip (ABS), a locked one (no ABS) none.
- **Coupling to the ride:** the lateral acceleration the ride model feels is what the tires give, a_y = ΣF_y / m (road plane; resolved with the bank and grade exactly as in Phase A), and each tire's lateral force in the ride model is its own handling force. So roll, jacking and load transfer follow the real side forces, including the transients of turning in and the front / rear split while the car yaws.
- **Steering kinematics:** a table of each wheel's steer angle vs rack travel (from the car's own corners, at ride height: Ackermann / anti-Ackermann included). The driver asks for an effective angle (mean steered front − mean steered rear); the rack is found by inverting the table and stops at the rack limit (*full lock*). Without steering data both front wheels take the commanded angle.
- **Driver (single-point preview):** looks D = max(5 m, u·0.7 s) ahead, predicts where the car will be if it keeps its course, x = e_y + D·sin χ (χ = e_ψ + atan(v/u), the direction of travel to the path) and steers so it would arrive on the path there: e = y_path(D) − x, κ_cmd = 2e/D², δ_cmd = atan(L·κ_cmd) + K·(u²·κ_cmd − g_bank)/g. y_path(D) is the path's own offset D ahead in the frame of its tangent (integrated over the coming segments, so the driver turns in early). K is the understeer the driver has learned: (mean front slip − mean rear slip) ÷ lateral g, averaged over about 1 s while cornering above 0.15 g, limited to −0.05 … 0.15 rad/g, started from the steady state. The steering follows the command with a 0.05 s lag and at most 0.9 rad/s (≈ 50°/s) at the road wheels; the command is limited to a little past full lock. Tuning (preview 0.7 s, lag 0.05 s) on the built-in tests: the most the default car gets off the line is 0.7 m (autocross: curvature changes in a step that no car can follow exactly, so the driver cuts the corner slightly); a shorter preview cuts less but became unstable at oval speeds (0.5 s), a longer one cuts more.
- **Slow (below 3 m/s):** the tires barely slip; the car follows its steering geometrically (kinematic bicycle: r = u·tan δ / L, no slip at the rear axle) and the side forces are what that motion needs, shared by the yaw balance and the loads.
- **Start:** from the steady state at t = 0, then 1.5 s of driving held at the first moment (same speed and curve) so the driver and the car settle before the clock starts.
- **Integration:** two explicit sub-steps (1 ms) per ride step, with the loads and inclinations of the ride step (velocities first, then the path errors). Past ≈ 40° of sideslip the model is held there (the spin check failed long before).
- **Checks** (pass rules, every 10 ms): *Off the line* (Fail beyond 1 m, a threshold) and *Spin / slide* (sideslip, Fail beyond 12°) count at once; the Drift profile warns instead (2 m, 45°). With the driver, *Steering lock* means the driver needed more than full lock for at least 0.1 s (a moment at full lock catching a slide is fine). Grip: a tire past its peak slip angle counts as sliding (its force can't exceed the peak, so force use alone wouldn't show it), and the axles' grip use comes from the forces they actually give.
- **Ride measures:** the largest distance off the line and the largest sideslip, added to the tuning score (2 per m, 0.1 per degree).
- **Playback** places the car on the line it actually drove, heading along its own yaw; the track map draws the driven line colored by result over the path (grey, dashed); the readout shows the distance off the line, sideslip, the road-wheel steer angle and *(full lock)*.
- **Yaw inertia** (vehicle input, whole car about the CG): default ≈ mass × (0.45 × wheelbase)²; the setup wizard's inertia step estimates it.
- **Cost:** about the same as the ride alone (a Run all of two presets with steady states, ride and handling: ≈ 4.5 s in the browser).
- Tested: the steering table inverts and stops at full lock; a steady 30 m turn at 12 m/s is followed with yaw rate u/R, lateral u²/(gR), steering within 0.5° of the steady steering need and < 0.1 m error (< 0.5 m through turn-in and out), and passes; right turns mirror left turns; too fast for the grip (18 m/s) the front slides, the driver goes to full lock and the car runs wide (fails *Off the line*); a rear with much less grip slides out (oversteer / spin, sideslip > 3°); without steered wheels a turn can't be followed; starting from rest through a turn (slow mode) stays on the line; every built-in test is driven by the default car without leaving the line or spinning.

## Setup wizard: measuring the car ✅ (`src/core/setup/measure.ts`)
- **Corner-scale CG:** level weights W_FL…W_RR → mass m = ΣW, front share f = (W_FL + W_FR)/m, CG z = −(1 − f)·L behind the front axle, lateral x = [(W_FL − W_FR)·t_F/2 + (W_RL − W_RR)·t_R/2] / m. Height: raise one axle by H at its wheel centers (suspension locked) and weigh the other axle again; it gains ΔW: h = r + L·ΔW / (m·tan θ), sin θ = H/L, r = wheel-center height. Exact for a rigid body pivoting at the grounded wheel centers (tested).
- **Spring rate from an added weight** over one wheel: ride rate k_ride = m·g / Δh (body drop at that wheel); the tire is in series, 1/k_wheel = 1/k_ride − 1/k_tire (k_tire from the tire model at the static load); spring rate = k_wheel / MR², MR = spring travel per wheel travel from the geometry. Approximate (the rest of the car shares a little of the load).
- **Unsprung mass** per corner = wheel + tire + hub / bearing / upright + brake + other + ½·(arms + spring / damper + halfshaft).
- **Body inertias** (estimate): radius of gyration 0.35 × average track (roll) and 0.4 × wheelbase (pitch), times the sprung mass.
- **Track change** moves each corner sideways as a whole (every point of its design by Δ = new half track − wheel-center X), so arm lengths and angles stay.
- **Generic dampers** from damping ratios: c = ζ·2·√(k_wheel·m_corner) / MR² (bump 0.3, rebound 0.5 by default).
- **Steering from two measurements:** steering-wheel turns (lock to lock, or center to lock) and one front wheel's angle (full left to full right = inside + outside angle, or straight to full lock with the wheel on the inside). The rack travel each way comes from the front corner's own steering kinematics (bisection on the rack travel, `rackForWheelAngle`); rack travel per steering-wheel turn = rack travel ÷ turns center to lock. Reported: inside / outside angles at full lock (Ackermann), overall ratio (steering-wheel degrees ÷ mean road-wheel degrees), tightest turn radius ≈ wheelbase ÷ tan(mean angle).
- **Wheel offset (ET)** per design: the stored wheel-center point (FL_Hub_Ctr) is the hub mounting face; the tire's centerline is ET inboard of it along the spin axis (ET 0 = the same point, as before format 15).
- **Rim width** per design: the tire's section width is quoted on its measuring rim (≈ 0.8 × section width, to the nearest ½"); mounted width = section width + 0.4 × (rim width − measuring rim) (about 5 mm per ½"). Blank = the measuring rim (no change).

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
| Caster change in heave | caster(t) − caster(0) − slope·t at every sample (°/100 mm) | 0.05° |
| Track change (scrub) in heave | half track(t) − half track(0) − slope·t at every sample (mm/100 mm) | 0.5 mm |
| Ackermann | Ackermann % with the mirrored corner at the bump-steer check rack travel (or 20 mm), the vehicle wheelbase and the steering-axis track − target | 2 % |
| Prefer small changes | √w·Δx/10 mm per variable (default w = 0.01) | — |

Tested: moving the tie-rod joints' X reaches an Ackermann target of 60 % within 5 %; moving the upper pivots' heights reaches a caster gain of 2°/100 mm; a front anti-roll bar raises the front roll-stiffness share by more than 10 points.

The small-change term matters when the goals don't pin the answer down (six free tie-rod coordinates for one toe curve): it picks the nearest design that meets the goals.

**Solver.** Bounded Levenberg–Marquardt (`boundedLeastSquares`): forward-difference Jacobian (0.01 mm steps, stepping inward at an upper bound), Marquardt diagonal damping, and a projected step with a simple active set (variables on a bound whose gradient points outward are held for that step). A design the linkage can't assemble counts as infinitely bad, so the step is rejected and damping raised. It reports which variables ended **on their range limit** (widen the range or free more coordinates). Tested: Rosenbrock with and without an active bound; bump steer 2.16° → 0.001° in 12 iterations (~0.3 s) moving six tie-rod coordinates; camber-gain target with the UCA length held to < 0.01 mm; RC height + KPI targets together.

**Bump steer by tie-rod placement.** The preset frees the classic knobs: inner tie-rod X (tie-rod length, along the rack) and Y, and outer tie-rod Y (heights), ±25 mm, unless locked. Outer X/Z are left fixed by default because they also change the steering arm (ratio, Ackermann); free them if you want.

### Tire grip: Magic Formula ✅ (`src/core/tire/magicFormula.ts`)
The official tire grip model (decided 2026-11-22): Pacejka's Magic Formula, a compact subset of MF 5.2 / 6.1.

    F(s) = D·sin(C·atan(B·s − E·(B·s − atan(B·s)))) + S_V

- **Lateral** (s = slip angle α): dfz = (Fz − Fz0)/Fz0, dp = (p − p0)/p0, D = (pDy1 + pDy2·dfz)(1 + ppy3·dp)(1 − pDy3·γ²)·Fz, cornering stiffness K = pKy1·Fz0·sin(2·atan(Fz/(pKy2·Fz0)))·(1 − pKy3·|γ|)(1 + ppy1·dp), C = pCy1, B = K/(C·D), E = pEy1 + pEy2·dfz (≤ 1), camber thrust S_V = pVy3·γ·Fz.
- **Longitudinal** (s = slip ratio κ): D = (pDx1 + pDx2·dfz)(1 + ppx3·dp)(1 − pDx3·γ²)·Fz, K = pKx1·Fz, C = pCx1, E = pEx1.
- **γ** is the inclination to the road, signed toward the force: a wheel whose top leans into the turn gets camber thrust on top of its peak; leaning out loses it. The best lean ≈ pVy3 ÷ (2·pDy1·pDy3).
- **Peak** (C ≥ 1) = D + S_V; far past it the force falls to D·sin(C·π/2): the **sliding share** (C = 1.3 → 89 %, 1.5 → 71 %). Slip at the peak: solve C·atan(X(s)) = π/2.
- **Combined slip:** friction ellipse (Fx/Dx)² + (Fy/Dy)² ≤ u², u = grip use. Within an axle the cornering force is shared so both tires reach the same u. A tire past its peak slides at the sliding share of its peak along its force direction; ABS holds the peak.
- **Slip the tire needs:** the pure-slip force equivalent on the ellipse (Fy / √(1 − (Fx/Dx)²)) inverted on the rising part of the curve (NaN past the peak). Steering in a turn = atan(L/R) + (mean front α − mean rear α).
- **Pressure** comes from the air-spring tire model's set pressure (the stiffness tire uses p0).
- **Defaults are generic** (a plausible tire, not fitted): Fz0 1000 N, p0 83 kPa, pCy1 1.3, pDy1 1.0, pDy2 −0.1, pDy3 12, pEy1 −0.5, pKy1 22, pKy2 1.7, pKy3 0.5, pVy3 1.0, ppy3 −0.1, pCx1 1.5, pDx1 1.05, pDx2 −0.1, pDx3 5, pKx1 20, ppx3 −0.1: peak side μ 1.0 at 8.3° slip, best lean 2.4° into the turn (+2.1 %). Files from format 8 with a friction coefficient μ ≠ 1 scale pDy1 and pDx1 by it.
- **Used for:** grip use, slip states and pass / fail (whole car and tests), the corner optimizer's *grip* goal (peak lateral force, static and outside wheel in roll) and the vehicle optimizer's *total grip* (peak force along each tire's force direction).
- Tested: peak = pDy1·Fz0, odd in α when level, sliding share = sin(C·π/2), small-slip slope = K, load sensitivity, best lean and losing grip leaning out, inversion round trip and NaN past the peak, pressure, left / right mirror in the car, lean toward the turn from the solved inclination, steering = atan(L/R) + slip difference, file round trip and format-8 μ migration.

### Tire grip: `.tir` files (full Magic Formula) ✅ (`src/core/tire/tir.ts`)
A fitted Magic Formula model of a real tire, loaded from a `.tir` tire property file, replaces the simple model while it is loaded.
- **Equations:** MF 6.1 / 6.2 steady-state forces, written from Pacejka, *Tire and Vehicle Dynamics* (3rd ed.) and the MF-Tyre 6.1 equation manual (not from any other implementation): pure longitudinal force Fx0(κ) with shifts S_Hx, S_Vx, load (dfz) and pressure (dpi) dependence; pure lateral force Fy0(α) with cornering stiffness K_yα = pKy1·Fz0'·(1 + pPy1·dpi)·(1 − pKy3·|γ*|)·sin(pKy4·atan(Fz / ((pKy2 + pKy5·γ*²)(1 + pPy2·dpi)·Fz0'))), camber stiffness K_yγ0 = Fz·(pKy6 + pKy7·dfz)(1 + pPy5·dpi), S_Vyγ = Fz·(pVy3 + pVy4·dfz)·γ*, S_Hy = pHy1 + pHy2·dfz + (K_yγ0·γ* − S_Vyγ)/K_yα, E_y = (pEy1 + pEy2·dfz)(1 + pEy5·γ*² − (pEy3 + pEy4·γ*)·sgn α_y), γ* = sin γ; combined slip Fx = G_xα·Fx0, Fy = G_yκ·Fy0 + S_Vyκ with the cosine weighting functions (rBx, rCx, rEx, rHx; rBy, rCy, rEy, rHy, rVy). Scaling factors λ (LMUX, LMUY, LKY, …) default 1; missing coefficients 0; pKy4 2. Files with MF 5.2 coefficients (camber in K_y via pKy3, shift pHy3·γ, S_Vy with pVy3/pVy4·γ, no pressure terms) use the 5.2 equations. FITTYP alone isn't trusted (some MF 6 files say 6): MF 6-only coefficients (pKy4–7, pEy5, pPy, pPx) decide, unless the file has pHy3.
- **Not included:** aligning, overturning and rolling moments; turn slip; transient (relaxation length) behavior.
- **File reading:** `KEY = value` lines in `[SECTIONS]`, `$` and `!` comments, quoted strings; units from `[UNITS]` (meter / mm, newton / kN; pressure = force ÷ length²), FNOMIN and NOMPRES converted to N and kPa; angles must be radians. FNOMIN and the core force coefficients are required; anything else missing is reported.
- **For the car:** fitted tires are asymmetric (ply steer, conicity) and use ISO signs, so the car uses each tire's force *toward the direction it pushes*, with its lean measured toward that direction, averaged over both directions (left and right tires are mirror images): side force at slip angle α = ½ Σ_{d=±1} d·Fy0(d·s_K·α, d·s_γ·γ), s_K = sign of the cornering stiffness, s_γ = sign of the camber thrust. Peaks (largest force over 0–0.6 rad of slip angle, 0–0.5 of slip ratio, then a golden-section refine), sliding share (force at 69° or κ = 1 ÷ peak) and stiffnesses are tabulated over load (0–4·Fz0) and lean (±0.15 rad) per pressure and interpolated, so the ride stays fast. Combined grip in the car keeps the friction ellipse of these peaks.
- **Grip scales** λμy and λμx are editable (e.g. to go from a test rig's belt to a real road).
- **Checked against** the obscured FSAE TTC fit published with the GPL-3.0 MATLAB library teasit/magic-formula-tyre-library (loaded locally, not included): MF 6.1, FNOMIN 2750 N, peak side μ 1.08 at FNOMIN (= its PDY1), 1.14 at half load, peak at 14.5° slip, cornering stiffness ≈ 810 N/deg, peak braking μ 1.10. In that fit, camber toward the turn gives thrust at small slip but slightly lowers the peak (best lean −1.5°, +0.9 %).
- Tested (synthetic files): reading, units, missing values; Fy0 against the hand-computed equation; ISO signs; camber thrust ≈ pKy6·Fz·sin γ; peak = D at Fz0; inversion round trip; cached peaks within 1 % of a direct scan; pressure; combined slip (braking takes side force, cornering takes braking force); 6.1 vs 5.2 detection; the whole car on a file model; saving with the project (format 12).

### Tire grip: front / rear tires and fitting to data ✅ (`src/core/tire/fit.ts`)
- **Front and rear** can use different tire grip models (simple, or each its own `.tir` / fitted model): each corner carries its axle's model; capacities and slip use the corner's own model.
- **Tire size from a file:** UNLOADED_RADIUS, WIDTH and RIM_RADIUS (when present) can set the tire diameter, width and rim of the designs on that axle.
- **Fitting:** a table of measurements (comma / semicolon / tab / space separated; the header row names the columns SA, SL, FZ, IA, P, FX, FY or common aliases; an optional units row: angles deg / rad, pressure kPa / psi / bar / Pa; loads taken as magnitudes, so SAE-negative loads work). Pure-cornering rows (|SL| < 0.02) fit PCY1, PDY1, PDY2, PEY1, PEY2, PKY1, PKY2, PHY1, PVY1 (+ PDY3, PKY6, PVY3 with camber data; PPY1, PPY3 with pressure data); pure braking / driving rows (|SA| < 0.6°) fit PCX1, PDX1, PDX2, PEX1, PKX1, PKX2, PHX1, PVX1 (+ PDX3, PPX1, PPX3). Bounded Levenberg–Marquardt on (model − measured) ÷ Fz0, at most 2500 rows each (evenly thinned); starting values from the data (peak μ, small-slip cornering stiffness and its sign). FNOMIN = median load, NOMPRES = median pressure. Reported: rows, RMS error (N), R². The data's own sign convention is kept. The result can be used for both axles / front / rear, or written as a `.tir` file (MF 6.1 force coefficients).
- Tested: fitting noisy synthetic data (±5 N) from a known tire recovers its curves within 2 % (R² > 0.999); the written `.tir` reads back to the same forces; tables it can't use are reported; a stickier rear tire raises only the rear corners' peaks.

### Contact area and patch pressure ✅ (`src/core/tire/grip.ts`)
The contact-area goal: the largest contact area per tire (corner optimizer) and for all four tires together (vehicle optimizer). Until format 9 this model also gave the grip (load-sensitive rubber friction over the patch); grip now comes from the Magic Formula, and this model keeps the area and the pressure spread.

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
| Roll stiffness front share | front share of the spring-path transfer (total − F_y · h_RC / track per axle, roll centers from each design) | 0.5 % |
| Brake pitch | nose-down pitch in the braking case | 0.02° |
| Anti-dive / anti-squat | classic geometric % at static height (brake / drive mount, bias / split) | 1 % |
| Bump steer (every design) | as in the corner optimizer, for every design | 0.01° |

Because load sensitivity rewards evenly loaded tires, the grip goal also cares how load transfer is split. Front/rear differences (LLTD) need separate front and rear designs (untick *Rear same dimensions as front*). Tested: identical front and rear give LLTD ≈ the weight split (50.4 %); moving the four UCA pivot heights reaches a 55 % target within the ranges in ~2 s; one evaluation (two cases, two designs) takes ~0.1 s.

### Optimizer strategies ✅ (`src/core/optimize/search.ts`, `rates.ts`; decided 2026-11-22)
Matched to how expensive one evaluation is:
- **Geometry on steady states** (many variables, cheap): bounded Levenberg–Marquardt (gradient). **Search: wide** runs it from the current design and from the best of a Latin-hypercube DOE (8 samples per start, at least 12; each range cut into n strata, one sample per stratum, shuffled per variable) and keeps the lowest miss: less likely to stop at a nearby, merely good design. Corner and vehicle optimizers and the Tests loop.
- **What matters most** (DOE + small response surface): Latin-hypercube samples over the free ranges (at least 2 per coordinate + 8), then least squares of the miss (and each goal) on the coded variables (−1…+1): main effects = change across each whole range; pairwise products of the four strongest give the interactions (main effects then come from that fuller fit). R² says how much of the spread the fit explains.
- **Springs, dampers and anti-roll bars on the ride** (few variables, ~0.5–5 s per test): **Bayesian optimization**. A Gaussian process (Matérn 5/2 kernel, length scale by maximum likelihood over a grid, standardized costs) models the score from every try; the next try maximizes the expected improvement (1500 random candidates + perturbations of the best five, then a short local polish). First tries: the current rates, then a Latin hypercube. Rates are searched on a log scale between value ÷ spread and value × spread. Score per test (tests/score.ts): 100 · fixable Fail findings + 10 · Σ grip use over 100 % (+ average grip use when improving) + 10 · wheel-lift time + 5 · bump-stop time + 20 · load variation + 0.2 · heave acceleration RMS; several tests: priority-weighted mean. The best rates are applied only when they score better (one undo step).
- **Tests loop**: geometry rounds (gradient, widening ranges as before); springs / dampers are tuned when the remaining failures only show over time, or when geometry stops helping (once per stall), then geometry continues.
- **Genetic algorithm**: not used (thousands of evaluations); a candidate later for grip-vs-comfort trade-off curves.
- Tested: Latin-hypercube strata, multi-start finding the deeper of two valleys a single run misses, sensitivity recovering known effects and an interaction (R² > 0.99), Bayesian optimization beating as many random tries on a 2-D function, tuning far-too-soft dampers on a rough road improving the score.

### Possible next steps for the optimizer
- **Ranges for other values**: tire pressure, static camber/toe, and **derived-dimension ranges** (e.g. arm length between A and B), not only hardpoint coordinates and rates.
- **Ghost preview** of the optimized geometry in the viewport before applying.
- **Tire data**: fit μ_ref, n and β (or a full Pacejka-style model with camber thrust) from measured data, per tire.
- **Per-tire grip model** (different tires front and rear) instead of one shared model.
- **Steady-state cornering balance**: find the lateral g where the front or rear axle saturates (friction limit) and maximize it, instead of a fixed g.
- **Combined cases**: braking in a turn, a weighted mix of cases, and a track-specific case list.
- Spring and bar rates in the steady geometry stage too (today they are tuned on the ride).
- Damper knees and dyno curves as tuning variables; clicker positions when a damper's settings are known.

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
