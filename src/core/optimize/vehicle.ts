/**
 * Whole-vehicle optimizer (L7): the same bounded least squares, but every evaluation rebuilds the
 * corners from the candidate hardpoints and runs the whole-car solve (L6) for each load case
 * (cornering, braking, accelerating). Goals are vehicle results: total grip and contact area of all
 * four tires, loaded-tire inclination, roll, lateral load-transfer split, braking pitch, anti-dive /
 * anti-squat, plus bump steer of every corner design so steering stays clean.
 *
 * Variables belong to a corner design (its root corner): with front and rear linked, moving a point
 * moves it on all four corners.
 */
import { vec3, Y_AXIS, type Vec3 } from '../math/vec3';
import type { SteeringSpec } from '../tests/steer';
import type { AeroModel } from '../vehicle/aero';
import type { Powertrain } from '../vehicle/powertrain';
import { DoubleWishbone, isBeam, solidAxleOf, twistBeamOf, type DoubleWishboneGeometry, type MountBody } from '../suspension/doubleWishbone';
import type { TrailerSpec } from '../vehicle/towing';
import { characteristics, deg, type Characteristics } from '../suspension/characteristics';
import { fitFreeLength } from '../suspension/spring';
import type { TireProfile } from '../tire/geometry';
import type { TireForceModel } from '../tire/model';
import { patchGrip, DEFAULT_GRIP, type GripModel, type PatchGrip } from '../tire/grip';
import { DEFAULT_MF, type TireGrip } from '../tire/magicFormula';
import { CornerTable } from '../vehicle/cornerTable';
import { AxleTable, AxleCornerTable } from '../vehicle/axleTable';
import { SolidAxle, axleCharacteristics, type SolidAxleGeometry, type AxleState, type TwoTravelAxle } from '../suspension/solidAxle';
import { TwistBeam } from '../suspension/twistBeam';
import type { BrakeThermal } from '../vehicle/brakeThermal';
import { lineThrough } from '../math/geom';
import {
  CORNER_IDS, isFront, isLeft, placement, poseFns, solveVehicle, staticCornerLoads, designGroundY, brakeOnChassis,
  type AxleShared, type BrakeMount, type CornerId, type DriveMount, type VehicleCorner, type VehicleResult, type ChassisPose, type DiffType, type VehicleInput, type DamperSpec,
} from '../vehicle/vehicle';
import { runStepsSync, type LsqResult } from './leastSquares';
import { multiStartSteps, latinHypercube, rng, sensitivity, type Sensitivity } from './search';
import type { RoadState } from '../tests/segments';
import { checkResiduals } from '../tests/checks';
import type { EffortSpec } from '../suspension/steeringEffort';
import type { BrakeSystem, BrakeDetail } from '../vehicle/brakes';
import { shimmyReport, type ShimmySpec } from './shimmyOf';
import {
  withVariables, variableValue, sampleCorner, cornerGoalResiduals, goalValue, holdValue, holdTarget, getPoint,
  type Variable, type Hold, type ProgressInfo,
} from './corner';

const G = 9.80665;

export type VehicleGoalKind =
  | 'grip' | 'lateralLimit' | 'contactArea' | 'inclination' | 'roll' | 'lltd' | 'rollStiffness' | 'pitch' | 'antiDive' | 'antiSquat' | 'bumpSteer' | 'testPass' | 'testReserve' | 'testTime'
  | 'steeringEffort' | 'parkingEffort' | 'scrubLimit' | 'shimmy';

export interface VehicleGoalMeta {
  short: string; label: string; unit: string; target: number; tolerance: number; hint: string; maximize?: boolean;
  /** Made as small as possible (no target; shown as “min”). */
  minimize?: boolean;
  /** A limit (the target is a maximum): only a value above it counts. */
  limit?: boolean;
  /** A floor (the target is a minimum): only a value below it counts. */
  atLeast?: boolean;
  /** Load case the goal is evaluated in ('limit': its own steady cornering cases up to the grip limit). */
  uses: 'all' | 'lateral' | 'braking' | 'accel' | 'geometry' | 'limit';
}

export const VEHICLE_GOAL_META: Record<VehicleGoalKind, VehicleGoalMeta> = {
  grip: { short: 'Total grip', label: 'Total grip (largest)', unit: 'g', target: 0, tolerance: 0.01, maximize: true, uses: 'all', hint: 'Sum of the four tires\' peak force in the direction each must push ÷ vehicle weight, averaged over the load cases. Uses the tire grip model (Magic Formula): load sensitivity rewards even loads, and a wheel leaning into the turn gains camber thrust.' },
  lateralLimit: { short: 'Cornering limit', label: 'Cornering limit (largest)', unit: 'g', target: 0, tolerance: 0.01, maximize: true, uses: 'limit', hint: 'The steady lateral g at which the first axle runs out of grip (front first = the car pushes wide, rear first = it spins), found by solving the whole car at rising g. Load transfer, camber, roll and the tires\' load sensitivity all count. Independent of the load cases above.' },
  contactArea: { short: 'Total area', label: 'Total contact area (largest)', unit: 'cm²', target: 0, tolerance: 0.01, maximize: true, uses: 'all', hint: 'Sum of the four patch areas, averaged over the load cases. With the air-spring tire model the area is set mostly by load ÷ pressure; the stiffness model responds to inclination much more.' },
  inclination: { short: 'Outside incl.', label: 'Outside-tire inclination (cornering)', unit: '°', target: -1, tolerance: 0.05, uses: 'lateral', hint: 'Inclination to the ground of the two outside (loaded) tires in the cornering case. + = top outboard.' },
  roll: { short: 'Roll gradient', label: 'Roll gradient (cornering)', unit: '°/g', target: 1, tolerance: 0.02, uses: 'lateral', hint: 'Body roll per g of lateral acceleration.' },
  lltd: { short: 'LLTD front', label: 'Front share of lateral load transfer', unit: '%', target: 50, tolerance: 0.5, uses: 'lateral', hint: 'Above ~50% the car tends to understeer.' },
  rollStiffness: { short: 'Roll stiff. front', label: 'Front share of roll stiffness', unit: '%', target: 50, tolerance: 0.5, uses: 'lateral', hint: 'Front axle\'s share of the load moved through the springs and anti-roll bars (the body-roll part of the transfer; roll centers from each design). More front = more understeer.' },
  pitch: { short: 'Brake pitch', label: 'Pitch under braking', unit: '°', target: 0.5, tolerance: 0.02, uses: 'braking', hint: 'Nose-down pitch in the braking case.' },
  antiDive: { short: 'Anti-dive', label: 'Anti-dive (front, braking)', unit: '%', target: 20, tolerance: 1, uses: 'geometry', hint: 'Classic geometric anti-dive at static height from the side-view IC, brake mount and bias.' },
  antiSquat: { short: 'Anti-squat', label: 'Anti-squat (rear, accelerating)', unit: '%', target: 30, tolerance: 1, uses: 'geometry', hint: 'Classic geometric anti-squat of the powered rear corners (needs powered rear corners).' },
  testReserve: { short: 'Test reserve', label: 'More grip reserve in the tests (largest)', unit: '%', target: 0, tolerance: 1, maximize: true, uses: 'all', hint: 'Lowers every state\'s worst tire grip use, weighted by test priority and segment weight (the worst states count most). Use it to improve a test that already passes. Placeholder grip model.' },
  testTime: { short: 'Test time', label: 'Fastest test time (speeds as maximums)', unit: '', target: 0, tolerance: 1, minimize: true, uses: 'all', hint: 'The tests whose speeds are maximums are scored on their time (the driver planning to its push, the ladder included) in the Tests optimize loop: its weight is how much time counts against the grip reserve and the ride (0: not at all; 1: 1 % faster ≈ 1 point of score; a Fail still costs 100, a warning nothing). Within each round the geometry is moved toward less grip use at the planned speeds (the same push then plans them faster). Shown in the optimize log as the time before → after.' },
  testPass: { short: 'Test passes', label: 'Every tire within its grip (test must pass)', unit: '%', target: 90, tolerance: 1, uses: 'all', hint: 'No tire in any load case may use more than this share of its grip (100% = sliding). With a test selected as the load cases, this makes the test pass with margin. Grip model is a placeholder until real tire data.' },
  steeringEffort: { short: 'Effort at speed', label: 'Steering effort at speed (steered designs)', unit: 'N·m', target: 8, tolerance: 0.2, limit: true, uses: 'geometry', hint: 'Steering-wheel torque to hold both front wheels at the lateral g set in the Steering panel (Effort check at), from the side force on the mechanical + pneumatic trail, through the steering ratio. Only above the limit counts. Reported: the heaviest steered design.' },
  parkingEffort: { short: 'Parking effort', label: 'Steering effort when parking (steered designs)', unit: 'N·m', target: 20, tolerance: 0.5, limit: true, uses: 'geometry', hint: 'Steering-wheel torque to turn both front wheels at standstill (patch twisted about the steering axis’s ground point). Grows with the scrub radius. Only above the limit counts.' },
  scrubLimit: { short: 'Scrub limit', label: 'Scrub radius limit (steered designs)', unit: 'mm', target: 50, tolerance: 1, limit: true, uses: 'geometry', hint: 'Keeps each steered design’s scrub radius (+ or −) under this size: a large one lets braking and bump forces kick the steering. Only above the limit counts.' },
  shimmy: { short: 'Shimmy margin', label: 'Shimmy margin with worn parts (least damping ratio)', unit: '', target: 0.05, tolerance: 0.005, atLeast: true, uses: 'geometry', hint: 'The least damping of the front wheels’ oscillation about their steering axes (4–25 Hz) at any speed up to the shimmy check’s fastest, with worn parts (free play, softer steering, a weaker damper). Below 0 the wheels shimmy (death wobble on a solid axle). Only a value below the target counts. Inputs: Vehicle → Inputs → Shimmy.' },
  bumpSteer: { short: 'Bump steer', label: 'Bump steer (every design)', unit: '°', target: 0, tolerance: 0.01, uses: 'geometry', hint: 'Keeps every corner design free of bump steer over the travel range while the rest is optimized. Reported: worst deviation, °.' },
};
export const VEHICLE_GOAL_KINDS = Object.keys(VEHICLE_GOAL_META) as VehicleGoalKind[];

export interface VehicleGoal { kind: VehicleGoalKind; target: number; weight: number }
export type VehicleVariable = Variable & { root: CornerId };
export type VehicleHold = Hold & { root: CornerId };

export interface RideSpec {
  /** Sprung-body inertia about the sprung CG, kg·m²: roll (about the car's long axis) and pitch. */
  rollInertia: number;
  pitchInertia: number;
  /** Tire vertical damping, N·s/m. */
  tireDamping: number;
  /** Whole-car yaw inertia about the CG, kg·m² (handling; default ≈ mass × (0.45 × wheelbase)²). */
  yawInertia?: number;
  /** Tire relaxation length, mm: the side force builds up over this distance rolled (handling; 0 = at once). */
  relaxation?: number;
}

export interface VehicleDesignIn {
  geometry: DoubleWishboneGeometry;
  profile: TireProfile;
  model: TireForceModel;
  springRate: number;
  freeLength: number;
  bumpStop?: { length: number; rate: number };
  unsprungMass: number;
  /** Damper at the damper (ride model). */
  damping?: DamperSpec;
}

/**
 * F28 (round 5): bounds on the characteristics — generic, wide, the same for every car — so optimizing for lap
 * time can't wander into what no one would build (F12: bump steer 9.5 °/100 mm, negative trail, 88 mm scrub).
 * Inside a bound nothing changes; past it the excess costs heavily (a wall). Per design (the steering ones for
 * steered designs only); anti-dive / anti-squat for the car.
 */
export type BoundKind = 'camberGain' | 'rollCenter' | 'bumpSteer' | 'trackChange' | 'kpi' | 'caster' | 'scrubRadius' | 'trail' | 'antiDive' | 'antiSquat';
export interface Bound { kind: BoundKind; min?: number; max?: number }
export const BOUND_META: Record<BoundKind, { label: string; unit: string; min: number; max: number; steered?: boolean; car?: boolean; hint: string }> = {
  camberGain: { label: 'Camber gain', unit: '°/100 mm', min: -6, max: 1, hint: 'Camber change per 100 mm of bump (− = top in).' },
  rollCenter: { label: 'Roll center height', unit: 'mm', min: -50, max: 250, hint: 'Static, above the ground.' },
  bumpSteer: { label: 'Bump steer', unit: '°/100 mm', min: -2, max: 2, hint: 'Toe change per 100 mm of travel: the wheel steering itself over bumps and in roll.' },
  trackChange: { label: 'Track change', unit: 'mm/100 mm', min: -20, max: 20, hint: 'The tire sliding sideways as the suspension moves (scrub).' },
  kpi: { label: 'KPI', unit: '°', min: 0, max: 20, steered: true, hint: 'Kingpin inclination (steered designs).' },
  caster: { label: 'Caster', unit: '°', min: -1, max: 12, steered: true, hint: 'Steered designs.' },
  scrubRadius: { label: 'Scrub radius', unit: 'mm', min: -40, max: 80, steered: true, hint: 'At the ground (steered designs): large values kick the steering.' },
  trail: { label: 'Mechanical trail', unit: 'mm', min: -10, max: 60, steered: true, hint: 'Steered designs: negative trail makes the steering want to turn further by itself.' },
  antiDive: { label: 'Anti-dive', unit: '%', min: -20, max: 100, car: true, hint: 'Front, braking.' },
  antiSquat: { label: 'Anti-squat', unit: '%', min: -20, max: 120, car: true, hint: 'Rear, accelerating.' },
};
export const BOUND_KINDS = Object.keys(BOUND_META) as BoundKind[];
/** A bound a design (or the car: root null) is at or past. */
export interface ActiveBound {
  root: CornerId | null; kind: BoundKind; side: 'min' | 'max'; value: number;
  /** The bound it is held at: the set one, or the start's value when the design started past it (`held`). */
  bound: number;
  /** Past the set bound from the start: held to no worse than its start value (`bound`), the set one being `set`. */
  held?: boolean; set?: number;
}

export interface VehicleProblem {
  /** Corner designs keyed by root corner. */
  designs: Partial<Record<CornerId, VehicleDesignIn>>;
  /** Root (design) of each corner. */
  roots: Record<CornerId, CornerId>;
  /** Steered designs (by root) and their steering-effort inputs, for the steering goals. */
  effort?: Partial<Record<CornerId, EffortSpec>>;
  settings: Record<CornerId, { brake: BrakeMount; drive: DriveMount; abs?: boolean }>;
  /** Differential per axle (chassis-driven axles). */
  diff?: { front?: DiffType; rear?: DiffType };
  /** Brake-based traction control on open differentials (round 5; off by default). */
  brakeTC?: boolean;
  /** Test states: when given, they replace the fixed load cases. */
  states?: RoadState[];
  /** Steered corners and the rack (tests: the rack travel a turn needs). */
  steering?: SteeringSpec;
  /** Ride model (Phase B): body inertias about the sprung CG (kg·m²) and tire damping (N·s/m). */
  ride?: RideSpec;
  /** Aerodynamics (applied at each test state's speed). Omit = none. */
  aero?: { model: AeroModel; rho: number };
  /** Motor / engine through one gear (round 4, F5): limits the drive at each speed. Omit = none (only the tires limit it). */
  powertrain?: Powertrain;
  /**
   * Static ride height (round 4, F21), mm: the chassis reference's height above the ground at the front / rear
   * axle at rest. The spring preload is fitted so the car rests there (the suspension at some travel). Omit = at
   * the design position.
   */
  rideHeight?: { front?: number; rear?: number };
  mass: number;
  /** CG: x (+ left), height above ground, z (from the front axle, + forward). */
  cg: { x: number; height: number; z: number };
  wheelbase: number;
  /** Front shares, 0–1. */
  brakeBias: number;
  driveSplit: number;
  autoPreload: boolean;
  shared: { front: AxleShared; rear: AxleShared };
  dropLinks: { front: Vec3 | null; rear: Vec3 | null };
  /** What each axle's drop links are fixed to (default the lower arm). */
  dropLinkOn?: { front?: MountBody; rear?: MountBody };
  droop: number;
  bump: number;
  /** Load cases (0 = off). Lateral is a left turn. */
  cases: {
    lateralG: number; brakingG: number; accelG: number;
    /** Braking in a turn: both at once (off when either is 0). */
    combined?: { lateralG: number; brakingG: number };
    /** Weight of each fixed case in the averaged goals (grip, contact area, test reserve) and in Test passes (default 1). */
    weights?: Partial<Record<FixedCaseKind, number>>;
  };
  goals: VehicleGoal[];
  /** F28: bounds on the characteristics (absent = none). */
  bounds?: Bound[];
  variables: VehicleVariable[];
  holds?: VehicleHold[];
  /** Contact-patch pressure model (contact-area goal). */
  grip?: GripModel;
  /** Tire grip model (Magic Formula): grip, slip and pass / fail. */
  tireGrip?: TireGrip;
  /** The rear tires' grip model when they differ from the front (default: the same). */
  tireGripRear?: TireGrip;
  /** Brake hydraulics: the most braking force per axle (N, at the tires) at the most pedal force (N). */
  brakeLimit?: { front: number; rear: number; maxPedal: number };
  /** Brake fade (with brakeLimit): the rotors heat through a test and the pads lose grip when hot. */
  brakeThermal?: BrakeThermal;
  /** Rolling resistance coefficient (force ÷ load, ≈ 0.012); 0 / omitted = none. */
  rollingResistance?: number;
  /** Pneumatic trail of the front tires, mm (steering kickback over time; 0 = estimated where needed). */
  pneumaticTrail?: number;
  /** Shimmy inputs (steering stiffness, damper, wear…); omitted = no shimmy model. */
  shimmy?: ShimmySpec;
  /** Detailed brake hydraulics (with brakeLimit): the system and its fluid volumes, for pedal travel in tests. */
  brakeDetail?: { system: BrakeSystem; detail: BrakeDetail };
  /** Towing a trailer (static). */
  trailer?: TrailerSpec;
  /**
   * Solid (beam) axles: the axle's two corners are its wheels (their designs give the tires, springs and
   * unsprung masses; their own linkage geometry is not used).
   */
  axles?: { front?: SolidAxleGeometry; rear?: SolidAxleGeometry };
  keepClose?: number;
  maxIterations?: number;
  /** Gradient runs: 1 = from the current design only; more = also from the best DOE samples (wider search). */
  starts?: number;
  /** Corner-table samples per evaluation (fewer = faster). */
  tableSamples?: number;
}

export type FixedCaseKind = 'lateral' | 'braking' | 'accel' | 'combined';

export interface CaseEval {
  /** 'lateral' | 'braking' | 'accel' | 'combined' for the fixed cases, or the test state's name. */
  name: string;
  kind: FixedCaseKind | 'state';
  g: number;
  /** Cornering and braking g of the case. */
  lateralG: number;
  brakingG: number;
  /** Weight in the averaged goals (test states: priority × segment weight). */
  weight: number;
  /** The road state solved (test states only). */
  state?: RoadState;
  result: VehicleResult;
  grip: Record<CornerId, PatchGrip>;
}

export interface VehicleEval {
  geometries: Partial<Record<CornerId, DoubleWishboneGeometry>>;
  cases: CaseEval[];
  /** Static (design) characteristics of each corner. */
  chars: Record<CornerId, Characteristics>;
  /** The cornering limit (only when a goal needs it). null = not found. */
  limit?: LateralLimit | null;
}

/**
 * The vehicle optimizer's variables beyond the points (round 5): a design's tire set pressure, an axle's static ride
 * height. The problem at x with them set (static camber / toe are in the geometry: geometriesFor).
 */
export function problemAt(p: VehicleProblem, x: number[]): VehicleProblem {
  let q = p;
  p.variables.forEach((v, i) => {
    const val = x[i]!;
    if (v.point === 'tirePressure') {
      const d = q.designs[v.root];
      if (!d || d.model.kind !== 'gas') return;
      q = { ...q, designs: { ...q.designs, [v.root]: { ...d, model: { ...d.model, conditions: { ...d.model.conditions, setPressure: val } } } } };
    } else if (v.point === 'rideHeight') {
      q = { ...q, rideHeight: { ...q.rideHeight, [isFront(v.root) ? 'front' : 'rear']: val } };
    }
  });
  return q;
}

/** A variable's value in the problem as it is (points, camber / toe from the geometry; pressure, ride height). */
export function vehicleVariableValue(p: VehicleProblem, v: VehicleVariable, designRide?: number): number {
  if (v.point === 'tirePressure') { const m = p.designs[v.root]?.model; return m && m.kind === 'gas' ? m.conditions.setPressure : NaN; }
  if (v.point === 'rideHeight') return (isFront(v.root) ? p.rideHeight?.front : p.rideHeight?.rear) ?? designRide ?? NaN;
  return variableValue(p.designs[v.root]!.geometry, v);
}

/** The design ride height (mm: the car at its design position, −ground Y) — what a ride-height variable starts from when none is set. */
export function designRideHeight(p: VehicleProblem): number {
  const geoms = Object.fromEntries(Object.entries(p.designs).map(([r, d]) => [r, d!.geometry])) as Partial<Record<CornerId, DoubleWishboneGeometry>>;
  const asm = assembleVehicle({ ...p, rideHeight: undefined }, geoms);
  return asm ? -asm.groundY : NaN;
}

const geometriesFor = (p: VehicleProblem, x: number[]) => {
  const out: Partial<Record<CornerId, DoubleWishboneGeometry>> = {};
  for (const root of Object.keys(p.designs) as CornerId[]) {
    const idx = p.variables.map((v, i) => (v.root === root ? i : -1)).filter((i) => i >= 0);
    out[root] = withVariables(p.designs[root]!.geometry, idx.map((i) => p.variables[i]!), idx.map((i) => x[i]!));
  }
  return out;
};

/** The car built from these geometries: corners, ground, CG. */
export interface AssembledVehicle {
  corners: VehicleCorner[];
  groundY: number;
  cg: Vec3;
  chars: Record<CornerId, Characteristics>;
  built: Map<CornerId, DoubleWishbone>;
  designState: Map<CornerId, ReturnType<DoubleWishbone['design']>>;
}

/** A solid-axle wheel's characteristics in its corner's frame (right wheel mirrored), for the rest of the car. */
function axleWheelChars(s: AxleState, c: ReturnType<typeof axleCharacteristics>, side: 'L' | 'R'): Characteristics {
  const m = (v: Vec3) => (side === 'R' ? vec3(-v.x, v.y, v.z) : v);
  const w = side === 'L' ? s.left : s.right;
  const wc = m(w.center), cp = m(w.contact);
  const sv = c.sideViewIC;
  const angle = (ref: Vec3) => (sv && Math.abs(ref.z - sv.z) > 1e-9 ? Math.atan((sv.y - ref.y) / (ref.z - sv.z)) : 0);
  return {
    camber: side === 'L' ? c.camber.left : c.camber.right, toe: side === 'L' ? c.toe.left : c.toe.right, caster: 0, kpi: 0,
    scrubRadius: NaN, mechanicalTrail: NaN, kingpinOffsetAtWheelCenter: NaN, casterOffsetAtWheelCenter: NaN,
    wheelCenter: wc, contactPoint: cp, groundY: cp.y, halfTrack: Math.abs(cp.x),
    steeringAxis: lineThrough(cp, vec3(cp.x, cp.y + 1, cp.z)), steeringAxisAtGround: null,
    instantAxis: null, frontViewIC: null, fvsa: Infinity,
    sideViewIC: sv ? vec3(wc.x, sv.y, sv.z) : null, svsa: sv ? cp.z - sv.z : Infinity,
    rollCenterHeight: c.rollCenterHeight, antiAngleContact: angle(cp), antiAngleWheelCenter: angle(wc),
  };
}

export function assembleVehicle(p: VehicleProblem, geometries: Partial<Record<CornerId, DoubleWishboneGeometry>>): AssembledVehicle | null {
  const range: [number, number] = [-Math.abs(p.droop), Math.abs(p.bump)];
  const n = p.tableSamples ?? 21;
  const built = new Map<CornerId, DoubleWishbone>();
  try {
    for (const root of Object.keys(geometries) as CornerId[]) built.set(root, new DoubleWishbone(geometries[root]!));
  } catch { return null; }
  const designState = new Map<CornerId, ReturnType<DoubleWishbone['design']>>();
  for (const [root, c] of built) {
    const d = c.design();
    if (d.solve.status !== 'converged') return null;
    designState.set(root, d);
  }
  const chars = {} as Record<CornerId, Characteristics>;
  const contactX = {} as Record<CornerId, number>;
  for (const id of CORNER_IDS) {
    chars[id] = characteristics(designState.get(p.roots[id])!);
    contactX[id] = chars[id].contactPoint.x;
  }
  // Solid axles: build them, and give their wheels the characteristics the rest of the car reads. A drop-link
  // anti-roll bar's mount is tracked on the axle (or each twist-beam arm).
  const axles: Partial<Record<'front' | 'rear', { axle: TwoTravelAxle; table: AxleTable; design: AxleState }>> = {};
  for (const which of ['front', 'rear'] as const) {
    // A beam-type design on this axle (the corner's root) makes it a solid axle too.
    const rootG = geometries[p.roots[which === 'front' ? 'FL' : 'RL']];
    const g = p.axles?.[which] ?? (rootG && isBeam(rootG.kind) ? solidAxleOf(rootG) : undefined);
    // A twist beam couples the two wheels too (its corners' characteristics already describe it).
    if (!g && rootG?.kind === 'twistBeam') {
      try {
        const axle = new TwistBeam(twistBeamOf(rootG));
        const design = axle.design();
        if (design.solve.status !== 'converged') return null;
        axles[which] = { axle, table: new AxleTable(axle, range, Math.max(9, Math.min(21, n - 4)), 0, p.dropLinks[which] ?? undefined), design };
      } catch { return null; }
      continue;
    }
    if (!g) continue;
    try {
      const axle = new SolidAxle(g);
      const design = axle.design();
      if (design.solve.status !== 'converged') return null;
      axles[which] = { axle, table: new AxleTable(axle, range, Math.max(9, Math.min(21, n - 4)), 0, p.dropLinks[which] ?? undefined), design };
      const ac = axleCharacteristics(axle, design);
      for (const id of (which === 'front' ? ['FL', 'FR'] : ['RL', 'RR']) as CornerId[]) {
        chars[id] = axleWheelChars(design, ac, isLeft(id) ? 'L' : 'R');
        contactX[id] = chars[id].contactPoint.x;
      }
    } catch { return null; }
  }
  const cgRel = vec3(p.cg.x, p.cg.height, p.cg.z);
  const loads = staticCornerLoads(p.mass, cgRel, p.wheelbase, contactX);
  // The ground at the design position (it depends only on the design and the static loads), and each axle's
  // travel at rest for a set ride height.
  const groundY = designGroundY(CORNER_IDS.map((id) => {
    const d = p.designs[p.roots[id]]!;
    const ax = axles[isFront(id) ? 'front' : 'rear'];
    if (ax) {
      const w = isLeft(id) ? ax.design.left : ax.design.right;
      return { contactY: w.contact.y, profile: d.profile, model: d.model, staticLoad: loads[id], tilt: w.spinAxis.y };
    }
    const ds = designState.get(p.roots[id])!;
    return { contactY: ds.points.contact.y, profile: d.profile, model: d.model, staticLoad: loads[id], tilt: ds.spinAxis.y };
  }));
  const restTravel = (id: CornerId) => staticTravelFor(groundY, isFront(id) ? p.rideHeight?.front : p.rideHeight?.rear, p.droop, p.bump).travel;
  const tables = new Map<string, CornerTable>();
  const corners: VehicleCorner[] = [];
  for (const id of CORNER_IDS) {
    const root = p.roots[id];
    const d = p.designs[root]!;
    const ax = axles[isFront(id) ? 'front' : 'rear'];
    if (ax) {
      // A wheel of a solid axle: preload from the axle's heave motion ratio (both sides move together).
      const side = isLeft(id) ? 'L' : 'R';
      const tr = restTravel(id);
      const s0 = ax.table.at(side, tr, tr);
      const mr = -(s0.dL + s0.dLX);
      const freeLength = p.autoPreload && Number.isFinite(s0.L) && mr > 1e-6 ? s0.L + Math.max(0, loads[id] - d.unsprungMass * G) / mr / d.springRate : d.freeLength;
      corners.push({
        id, table: new AxleCornerTable(ax.table, side), axle: { table: ax.table, side }, unsprungMass: d.unsprungMass,
        tire: { profile: d.profile, model: d.model, ...(p.tireGripRear && !isFront(id) ? { grip: p.tireGripRear } : {}) },
        brake: p.settings[id].brake, drive: p.settings[id].drive, abs: p.settings[id].abs ?? true,
        spring: { rate: d.springRate, freeLength, ...(d.bumpStop ? { bumpStopLength: d.bumpStop.length, bumpStopRate: d.bumpStop.rate } : {}) },
        ...(d.damping ? { damper: d.damping } : {}),
      });
      continue;
    }
    const dl = isFront(id) ? p.dropLinks.front : p.dropLinks.rear;
    const dlOn = (isFront(id) ? p.dropLinkOn?.front : p.dropLinkOn?.rear) ?? 'lca';
    const key = `${root}|${dl ? `${dl.x},${dl.y},${dl.z},${dlOn}` : '-'}`;
    let table = tables.get(key);
    if (!table) {
      try { table = new CornerTable(built.get(root)!, 0, range, n, dl ? { body: dlOn, point: dl } : undefined); } catch { return null; }
      tables.set(key, table);
    }
    const freeLength = p.autoPreload && d.geometry.kind !== 'rigid' ? fitFreeLength(built.get(root)!, d.springRate, Math.max(0, loads[id] - d.unsprungMass * G), restTravel(id)) : d.freeLength;
    corners.push({
      id, table, unsprungMass: d.unsprungMass, ...(d.geometry.kind === 'rigid' ? { rigid: true } : {}), tire: { profile: d.profile, model: d.model, ...(p.tireGripRear && !isFront(id) ? { grip: p.tireGripRear } : {}) },
      brake: p.settings[id].brake, drive: p.settings[id].drive, abs: p.settings[id].abs ?? true,
      spring: { rate: d.springRate, freeLength, ...(d.bumpStop ? { bumpStopLength: d.bumpStop.length, bumpStopRate: d.bumpStop.rate } : {}) },
      ...(d.damping ? { damper: d.damping } : {}),
    });
  }
  return { corners, groundY, cg: vec3(p.cg.x, groundY + p.cg.height, p.cg.z), chars, built, designState };
}

/**
 * The suspension's travel at rest (mm, + bump) for a set ride height (the chassis reference above the ground at
 * that axle): the design ride height is −groundY, so the car sits (design − target) into its travel; kept
 * 2 mm inside the droop / bump limits (`clamped` says so). No target: 0 (the design position).
 */
export function staticTravelFor(groundY: number, target: number | undefined, droop: number, bump: number): { travel: number; clamped: boolean; design: number } {
  const design = -groundY;
  if (target === undefined || !Number.isFinite(target)) return { travel: 0, clamped: false, design };
  const want = design - target;
  const lo = -Math.abs(droop) + 2, hi = Math.abs(bump) - 2;
  const travel = Math.min(hi, Math.max(lo, want));
  return { travel, clamped: travel !== want, design };
}

export interface CaseSpec {
  name: string; kind: CaseEval['kind']; g: number;
  lateralG: number; brakingG: number; accelG: number; gravityScale?: number; groundOffset?: Partial<Record<CornerId, number>>;
  state?: RoadState;
  weight?: number;
}

/** The load cases of a problem: its test states, or the fixed cornering / braking / accelerating cases. */
export function caseList(p: VehicleProblem): CaseSpec[] {
  if (p.states?.length) {
    return p.states.map((st) => ({
      name: st.name, kind: 'state' as const, g: Math.hypot(st.ay, st.ax),
      lateralG: st.lateralG, brakingG: st.brakingG, accelG: st.accelG, gravityScale: st.gravityScale, groundOffset: st.groundOffset, state: st,
    }));
  }
  const out: CaseSpec[] = [];
  const w = (k: FixedCaseKind) => Math.max(0, p.cases.weights?.[k] ?? 1);
  if (p.cases.lateralG) out.push({ name: 'lateral', kind: 'lateral', g: p.cases.lateralG, lateralG: p.cases.lateralG, brakingG: 0, accelG: 0, weight: w('lateral') });
  if (p.cases.brakingG) out.push({ name: 'braking', kind: 'braking', g: p.cases.brakingG, lateralG: 0, brakingG: p.cases.brakingG, accelG: 0, weight: w('braking') });
  if (p.cases.accelG) out.push({ name: 'accel', kind: 'accel', g: p.cases.accelG, lateralG: 0, brakingG: 0, accelG: p.cases.accelG, weight: w('accel') });
  const cb = p.cases.combined;
  if (cb && cb.lateralG && cb.brakingG) out.push({ name: 'combined', kind: 'combined', g: Math.hypot(cb.lateralG, cb.brakingG), lateralG: cb.lateralG, brakingG: cb.brakingG, accelG: 0, weight: w('combined') });
  return out;
}

/** The whole-car solver's input for a load case on an assembled car. */
export const vehicleInputOf = (p: VehicleProblem, asm: AssembledVehicle, c: Omit<CaseSpec, 'name' | 'kind' | 'g'> & { speed?: number }): VehicleInput => ({
  ...(p.aero && (c.speed ?? c.state?.speed ?? 0) > 0 ? { aero: { model: p.aero.model, rho: p.aero.rho, speed: c.speed ?? c.state?.speed ?? 0 } } : {}),
  corners: asm.corners, totalMass: p.mass, cg: asm.cg, wheelbase: p.wheelbase, groundY: asm.groundY,
  lateralG: c.lateralG, brakingG: c.brakingG, brakeBias: p.brakeBias, accelG: c.accelG, driveSplit: p.driveSplit, shared: p.shared,
  gravityScale: c.gravityScale, groundOffset: c.groundOffset, tireGrip: p.tireGrip ?? DEFAULT_MF, diff: p.diff,
  ...(p.brakeLimit ? { brakeLimit: p.brakeLimit } : {}),
  ...(p.trailer ? { trailer: p.trailer } : {}),
  ...(p.rollingResistance && (c.speed ?? c.state?.speed ?? 0) > 0 ? { rollingResistance: p.rollingResistance } : {}),
  ...((c.speed ?? c.state?.speed ?? 0) > 0 ? { speed: c.speed ?? c.state?.speed ?? 0 } : {}),
  ...(p.brakeTC ? { brakeTC: true } : {}),
});

/** Solve one load case on an assembled car. null = didn't converge. */
export function solveCase(p: VehicleProblem, asm: AssembledVehicle, c: CaseSpec, guess?: ChassisPose): CaseEval | null {
  const grip = p.grip ?? DEFAULT_GRIP;
  const result = solveVehicle(vehicleInputOf(p, asm, c), { guess });
  if (!result.converged) return null;
  const P = poseFns(result.pose);
  const g = {} as Record<CornerId, PatchGrip>;
  for (const id of CORNER_IDS) {
    const root = p.roots[id];
    // The solved wheel (world): wheel center and spin axis.
    const wc = result.corners[id].wheelCenter;
    const axis = result.corners[id].axisWorld;
    g[id] = patchGrip(wc, axis, { point: vec3(0, result.corners[id].groundY, 0), normal: Y_AXIS }, p.designs[root]!.profile, result.corners[id].tireLoad, grip);
  }
  return { name: c.name, kind: c.kind, g: c.g, lateralG: c.lateralG, brakingG: c.brakingG, weight: c.state?.weight ?? c.weight ?? 1, state: c.state, result, grip: g };
}

/** Where the car runs out of cornering grip: the lateral g, the axle that goes first and the other axle's grip use then. */
export interface LateralLimit { g: number; axle: 'front' | 'rear'; other: number; pose: ChassisPose; solves: number }

/**
 * The steady cornering limit (left turn, no braking): the lateral g at which the front or rear axle's grip use
 * reaches 1. Secant steps on the worst axle's use from a first guess of 1 g, kept inside a bracket.
 */
export function lateralLimit(p: VehicleProblem, asm: AssembledVehicle, warm?: { g: number; pose?: ChassisPose }): LateralLimit | null {
  let guess = warm?.pose, solves = 0;
  const use = (g: number) => {
    solves++;
    const e = solveCase(p, asm, { name: 'limit', kind: 'lateral', g, lateralG: g, brakingG: 0, accelG: 0 }, guess);
    if (!e?.result.grip) return null;
    guess = e.result.pose;
    const a = e.result.grip.axles;
    return { u: Math.max(a.front, a.rear), a };
  };
  let lo = 0, hi = 5;
  let g0 = warm && warm.g > 0.05 && warm.g < hi ? warm.g : 1, r0 = use(g0);
  if (!r0) return null;
  let g1 = Math.min(hi, Math.max(0.05, g0 / Math.max(r0.u, 1e-3)));
  for (let i = 0; i < 10; i++) {
    if (r0.u < 1) lo = Math.max(lo, g0); else hi = Math.min(hi, g0);
    const r1 = use(g1);
    if (!r1) return null;
    if (Math.abs(r1.u - 1) < 1e-7 || hi - lo < 1e-7) return { g: g1, axle: r1.a.front >= r1.a.rear ? 'front' : 'rear', other: Math.min(r1.a.front, r1.a.rear), pose: guess!, solves };
    if (r1.u < 1) lo = Math.max(lo, g1); else hi = Math.min(hi, g1);
    const slope = (r1.u - r0.u) / (g1 - g0);
    let g2 = slope > 1e-6 ? g1 + (1 - r1.u) / slope : (lo + hi) / 2;
    if (!(g2 > lo && g2 < hi)) g2 = (lo + hi) / 2;
    g0 = g1; r0 = r1; g1 = g2;
  }
  return null;
}

/** The last cornering limit found per guesses object (warm start). */
const lastLimit = new WeakMap<object, { g: number; pose: ChassisPose }>();

/**
 * Build the corners and run every load case for the given geometries. null = can't be assembled/solved.
 * `guesses`: warm starts per case (and the cornering limit's); updated with the solved poses unless `frozen`.
 */
export function evaluateVehicle(p: VehicleProblem, geometries: Partial<Record<CornerId, DoubleWishboneGeometry>>, guesses?: Partial<Record<string, ChassisPose>>, frozen = false): VehicleEval | null {
  const asm = assembleVehicle(p, geometries);
  if (!asm) return null;
  const cases: CaseEval[] = [];
  for (const c of caseList(p)) {
    const e = solveCase(p, asm, c, guesses?.[c.name]);
    if (!e) return null;
    if (guesses && !frozen) guesses[c.name] = e.result.pose;
    cases.push(e);
  }
  // The cornering limit, only when a goal asks for it (several solves).
  let limit: LateralLimit | null | undefined;
  if (p.goals.some((g) => VEHICLE_GOAL_META[g.kind].uses === 'limit')) {
    // Warm start from the last limit found with these guesses (an optimizer step moves it only a little).
    const last = guesses ? lastLimit.get(guesses) : undefined;
    limit = lateralLimit(p, asm, last ?? { g: 1, pose: guesses?.lateral });
    if (guesses && limit && !frozen) lastLimit.set(guesses, { g: limit.g, pose: limit.pose });
  }
  return { geometries, cases, chars: asm.chars, ...(limit !== undefined ? { limit } : {}) };
}

const mean = (v: number[]) => (v.length ? v.reduce((a, b) => a + b, 0) / v.length : NaN);

function lltdOf(c: CaseEval): number | null {
  const r = c.result.corners;
  const tf = (r.FR.tireLoad - r.FL.tireLoad) / 2;
  const tr = (r.RR.tireLoad - r.RL.tireLoad) / 2;
  return tf + tr !== 0 ? (100 * tf) / (tf + tr) : null;
}

/** Front share of the spring-path (elastic) transfer: total minus the roll-center part, per axle. */
function rollStiffnessShareOf(c: CaseEval, chars: Record<CornerId, { rollCenterHeight: number | null }>): number | null {
  const r = c.result.corners;
  const part = (l: CornerId, rr: CornerId) => {
    const total = Math.abs(r[rr].tireLoad - r[l].tireLoad) / 2;
    const track = Math.abs(r[l].contact.x - r[rr].contact.x);
    const h = chars[l].rollCenterHeight ?? 0;
    return total - (track > 0 ? (Math.abs(r[l].lateralForce + r[rr].lateralForce) * h) / track : 0);
  };
  const f = part('FL', 'FR'), b = part('RL', 'RR');
  return f + b > 0 ? (100 * f) / (f + b) : null;
}

/** Outside corners: a left turn (lateral > 0) loads the right side. */
const outsideOf = (c: CaseEval): CornerId[] => (c.result.corners.FR.tireLoad >= c.result.corners.FL.tireLoad ? ['FR', 'RR'] : ['FL', 'RL']);
/** The most-cornering and the hardest-braking case (fixed or test states). */
const latGOf = (c: CaseEval) => c.lateralG;
const brakeGOf = (c: CaseEval) => c.brakingG;
/** Weighted mean over the load cases. */
const wmean = (e: VehicleEval, f: (c: CaseEval) => number) => {
  const tw = e.cases.reduce((a, c) => a + c.weight, 0);
  return tw > 0 ? e.cases.reduce((a, c) => a + c.weight * f(c), 0) / tw : mean(e.cases.map(f));
};
const latCase = (e: VehicleEval) => e.cases.filter((c) => Math.abs(latGOf(c)) > 0.05).sort((a, b) => Math.abs(latGOf(b)) - Math.abs(latGOf(a)))[0];
const brakeCase = (e: VehicleEval) => e.cases.filter((c) => brakeGOf(c) > 0.05).sort((a, b) => brakeGOf(b) - brakeGOf(a))[0];

function antiOf(p: VehicleProblem, e: VehicleEval, kind: 'antiDive' | 'antiSquat'): number | null {
  const h = p.cg.height;
  if (kind === 'antiDive') {
    const ids = (['FL', 'FR'] as CornerId[]).filter((id) => p.settings[id].brake !== 'none');
    if (!ids.length) return null;
    return mean(ids.map((id) => {
      const ch = e.chars[id];
      const th = brakeOnChassis(p.settings[id].brake) ? ch.antiAngleWheelCenter : ch.antiAngleContact;
      return Math.tan(th) * (p.wheelbase / h) * p.brakeBias * 100;
    }));
  }
  const rear = (['RL', 'RR'] as CornerId[]).filter((id) => p.settings[id].drive !== 'none');
  const front = (['FL', 'FR'] as CornerId[]).filter((id) => p.settings[id].drive !== 'none');
  if (!rear.length) return null;
  const share = front.length ? 1 - p.driveSplit : 1;
  return mean(rear.map((id) => {
    const ch = e.chars[id];
    const th = p.settings[id].drive === 'hub' ? ch.antiAngleContact : ch.antiAngleWheelCenter;
    return -Math.tan(th) * (p.wheelbase / h) * share * 100;
  }));
}

const bumpOpts = (p: VehicleProblem) => ({ droop: -Math.abs(p.droop), bump: Math.abs(p.bump), samples: 9, goals: [{ kind: 'bumpSteer' as const, target: 0, weight: 1 }] });

const STEER_GOALS = { steeringEffort: 'steeringEffort', parkingEffort: 'parkingEffort', scrubLimit: 'scrubLimit' } as const;
/** Each steered design's value of a steering goal (at ride height), or null for a design that can't be solved. */
function steeredValues(kind: keyof typeof STEER_GOALS, p: VehicleProblem, e: VehicleEval): (number | null)[] {
  return Object.entries(p.effort ?? {}).flatMap(([root, spec]) => {
    const g = e.geometries[root as CornerId];
    const d = p.designs[root as CornerId];
    if (!g || !spec || !d) return [];
    const s = sampleCorner(g, { droop: 0, bump: 0, samples: 3, goals: [{ kind: STEER_GOALS[kind], target: 0, weight: 1 }], steering: { ...spec, tire: spec.tire ?? { profile: d.profile, model: d.model } } });
    return [s ? goalValue(STEER_GOALS[kind], s) : null];
  });
}

/** Reported value of a vehicle goal. */
export function vehicleGoalValue(kind: VehicleGoalKind, p: VehicleProblem, e: VehicleEval): number | null {
  const lat = latCase(e);
  const brk = brakeCase(e);
  switch (kind) {
    // Peak force each tire can carry in the direction it must push (Magic Formula, camber thrust included).
    case 'grip': return e.cases.length ? wmean(e, (c) => CORNER_IDS.reduce((a, id) => a + (c.result.grip?.corners[id].capacity ?? 0), 0)) / (p.mass * G) : null;
    case 'lateralLimit': return e.limit?.g ?? null;
    case 'contactArea': return e.cases.length ? wmean(e, (c) => CORNER_IDS.reduce((a, id) => a + c.grip[id].area, 0)) / 100 : null;
    case 'inclination': return lat ? mean(outsideOf(lat).map((id) => deg(lat.result.corners[id].inclination))) : null;
    case 'roll': return lat ? Math.abs(deg(lat.result.pose.roll)) / Math.abs(latGOf(lat)) : null;
    case 'testPass': return e.cases.length ? 100 * Math.max(...e.cases.map((c) => c.result.grip?.maxUtilization ?? 0)) : null;
    case 'testReserve': return e.cases.length ? 100 * wmean(e, (c) => 1 - (c.result.grip?.maxUtilization ?? 1)) : null;
    case 'testTime': return null; // measured by the test runs (the optimize loop), not here
    case 'lltd': return lat ? lltdOf(lat) : null;
    case 'rollStiffness': return lat ? rollStiffnessShareOf(lat, e.chars) : null;
    case 'pitch': return brk ? deg(brk.result.pose.pitch) : null;
    case 'antiDive': case 'antiSquat': return antiOf(p, e, kind);
    case 'shimmy': return shimmyReport(p, e.geometries, 15)?.worn.minZeta ?? null;
    case 'steeringEffort': case 'parkingEffort': case 'scrubLimit': {
      const v = steeredValues(kind, p, e);
      if (!v.length) return null;
      return v.some((x) => x === null) ? NaN : Math.max(...(v as number[]));
    }
    case 'bumpSteer': {
      let worst = 0;
      for (const g of Object.values(e.geometries)) {
        const s = sampleCorner(g!, bumpOpts(p));
        if (!s) return null;
        worst = Math.max(worst, goalValue('bumpSteer', s) ?? 0);
      }
      return worst;
    }
  }
}

/** The bounded characteristics' values now: per design (one travel sweep each), and the car's anti-dive / anti-squat. */
export function boundValues(p: VehicleProblem, e: VehicleEval): { root: CornerId | null; kind: BoundKind; value: number | null }[] {
  const bounds = p.bounds ?? [];
  if (!bounds.length) return [];
  const out: { root: CornerId | null; kind: BoundKind; value: number | null }[] = [];
  const cornerKinds = bounds.filter((b) => !BOUND_META[b.kind].car).map((b) => b.kind as Exclude<BoundKind, 'antiDive' | 'antiSquat'>);
  if (cornerKinds.length) {
    for (const [root, g] of Object.entries(e.geometries) as [CornerId, DoubleWishboneGeometry][]) {
      if (!g) continue;
      const steered = CORNER_IDS.some((id) => p.roots[id] === root && !!p.steering?.steered[id]);
      const kinds = cornerKinds.filter((k) => !BOUND_META[k].steered || steered);
      if (!kinds.length) continue;
      const sm = sampleCorner(g, { droop: -Math.abs(p.droop), bump: Math.abs(p.bump), samples: 5, goals: kinds.map((k) => ({ kind: k, target: 0, weight: 1 })) });
      for (const k of kinds) out.push({ root, kind: k, value: sm ? goalValue(k, sm) : null });
    }
  }
  for (const b of bounds) if (BOUND_META[b.kind].car) out.push({ root: null, kind: b.kind, value: vehicleGoalValue(b.kind as 'antiDive' | 'antiSquat', p, e) });
  return out;
}

/**
 * Past a bound, the excess (scaled to 1 % of the bound's span, × 3): effectively a wall; inside, nothing. A design
 * already past a bound at the start (`start`, by `${root}.${kind}`) is held to no worse than it was, not forced back.
 */
function boundResiduals(p: VehicleProblem, e: VehicleEval, start?: Map<string, number>): number[] {
  const bounds = new Map((p.bounds ?? []).map((b) => [b.kind, b]));
  return boundValues(p, e).map(({ root, kind, value }) => {
    const b = bounds.get(kind)!;
    if (value === null || !Number.isFinite(value)) return 0;
    const span = Math.max(1e-6, (b.max ?? BOUND_META[kind].max) - (b.min ?? BOUND_META[kind].min));
    const s0 = start?.get(`${root}.${kind}`);
    const hi = Math.max(b.max ?? Infinity, s0 ?? -Infinity), lo = Math.min(b.min ?? -Infinity, s0 ?? Infinity);
    const over = Math.max(0, value - hi) + Math.max(0, lo - value);
    return (3 * over) / (0.01 * span);
  });
}

/** The bounds a result is at (within 2 % of the span) or past. */
export function activeBounds(p: VehicleProblem, e: VehicleEval, start?: Map<string, number>): ActiveBound[] {
  const bounds = new Map((p.bounds ?? []).map((b) => [b.kind, b]));
  const out: ActiveBound[] = [];
  for (const { root, kind, value } of boundValues(p, e)) {
    const b = bounds.get(kind);
    if (!b || value === null || !Number.isFinite(value)) continue;
    const setLo = b.min ?? -Infinity, setHi = b.max ?? Infinity;
    // A design past a bound at the start is held at its start value (as the objective does).
    const s0 = start?.get(`${root}.${kind}`);
    const hi = Math.max(setHi, s0 ?? -Infinity), lo = Math.min(setLo, s0 ?? Infinity);
    const tol = 0.02 * (Number.isFinite(setHi - setLo) ? setHi - setLo : 1);
    if (value >= hi - tol) out.push({ root, kind, side: 'max', value, bound: hi, ...(hi > setHi ? { held: true, set: setHi } : {}) });
    else if (value <= lo + tol) out.push({ root, kind, side: 'min', value, bound: lo, ...(lo < setLo ? { held: true, set: setLo } : {}) });
  }
  return out;
}

/** The bounded values at the start (x0), by `${root}.${kind}`. */
function boundStartValues(p: VehicleProblem, x0: number[], start: VehicleEval | null): Map<string, number> {
  const m = new Map<string, number>();
  if (p.bounds?.length && start) for (const b of boundValues(problemAt(p, x0), start)) if (b.value !== null && Number.isFinite(b.value)) m.set(`${b.root}.${b.kind}`, b.value);
  return m;
}

const BAD = 1e3;

function vehicleResiduals(goal: VehicleGoal, p: VehicleProblem, e: VehicleEval, ref: number | null | undefined): number[] {
  const meta = VEHICLE_GOAL_META[goal.kind];
  if (goal.kind === 'testReserve' || goal.kind === 'testTime') {
    // Lower grip use everywhere; squares make the worst states count most. (Test time: at the planned speeds,
    // less grip use lets the same push plan them faster — the time itself is scored on the test runs.)
    // Before the generic "maximize" goals: as one ratio to the start (ref / value) a 1 % gain weighed less
    // than the keep-close term for a few mm, so rounds stalled after one tiny step.
    return e.cases.map((c) => (Math.sqrt(c.weight) * (c.result.grip?.maxUtilization ?? 1)) / 0.05);
  }
  if (meta.maximize) {
    const v = vehicleGoalValue(goal.kind, p, e);
    return [v === null || !(v > 0) || !ref ? BAD : (ref / v) / Math.sqrt(meta.tolerance)];
  }
  if (goal.kind === 'inclination') {
    const lat = latCase(e);
    return lat ? outsideOf(lat).map((id) => (deg(lat.result.corners[id].inclination) - goal.target) / meta.tolerance) : [];
  }
  if (goal.kind === 'testPass') {
    // Test states: each state's pass rules (Fail = hard, Warning = soft), × √(priority × segment weight).
    // Fixed cases: every tire at or under the allowed grip use.
    return e.cases.flatMap((c) => {
      if (c.state?.checks) return checkResiduals(c.result, c.state.checks).map((v) => v * Math.sqrt(c.state!.weight ?? 1) * 3);
      const limit = goal.target / 100;
      return CORNER_IDS.map((id) => (Math.sqrt(c.weight) * Math.max(0, (c.result.grip?.corners[id].utilization ?? 0) - limit)) / (meta.tolerance / 100));
    });
  }
  if (meta.limit && (goal.kind === 'steeringEffort' || goal.kind === 'parkingEffort' || goal.kind === 'scrubLimit')) {
    // Every steered design under the limit; only the excess counts.
    return steeredValues(goal.kind, p, e).map((v) => (v === null || !Number.isFinite(v) ? BAD : Math.max(0, v - goal.target) / meta.tolerance));
  }
  if (meta.atLeast) {
    const v = vehicleGoalValue(goal.kind, p, e);
    if (v === null) return [];
    return [Number.isFinite(v) ? Math.max(0, goal.target - v) / meta.tolerance : BAD];
  }
  if (goal.kind === 'bumpSteer') {
    const r: number[] = [];
    for (const g of Object.values(e.geometries)) {
      const s = sampleCorner(g!, bumpOpts(p));
      if (!s) return [BAD];
      r.push(...cornerGoalResiduals({ kind: 'bumpSteer', target: goal.target, weight: 1 }, s));
    }
    return r;
  }
  const v = vehicleGoalValue(goal.kind, p, e);
  // A goal whose load case is off (or that doesn't apply, e.g. anti-squat with no powered rear) adds nothing.
  if (v === null) return [];
  return [Number.isFinite(v) ? (v - goal.target) / meta.tolerance : BAD];
}

export interface VehicleGoalReport { kind: VehicleGoalKind; target: number; before: number | null; after: number | null }
export interface VehicleReport {
  geometries: Partial<Record<CornerId, DoubleWishboneGeometry>>;
  variables: (VehicleVariable & { before: number; after: number; atLimit: boolean })[];
  goals: VehicleGoalReport[];
  /** F28: the characteristic bounds the result is at or past. */
  atBounds?: ActiveBound[];
}
export interface VehicleOptimizeResult extends VehicleReport { lsq: LsqResult }

export function reportVehicle(p: VehicleProblem, x: number[]): VehicleReport {
  const geometries = geometriesFor(p, x);
  const ride0 = p.variables.some((v) => v.point === 'rideHeight') ? designRideHeight(p) : undefined;
  const x0 = p.variables.map((v) => vehicleVariableValue(p, v, ride0));
  const before = evaluateVehicle(problemAt(p, x0), geometriesFor(p, x0));
  const after = evaluateVehicle(problemAt(p, x), geometries);
  return {
    geometries,
    variables: p.variables.map((v, i) => {
      const a = x[i]!;
      const onLimit = a <= Math.min(v.lo, v.hi) + 1e-9 || a >= Math.max(v.lo, v.hi) - 1e-9;
      return { ...v, before: x0[i]!, after: a, atLimit: onLimit && Math.abs(a - x0[i]!) > 1e-6 };
    }),
    goals: p.goals.map((g) => ({
      kind: g.kind, target: g.target,
      before: before ? vehicleGoalValue(g.kind, p, before) : null,
      after: after ? vehicleGoalValue(g.kind, p, after) : null,
    })),
    ...(p.bounds?.length && after ? { atBounds: activeBounds(problemAt(p, x), after, boundStartValues(p, x0, before)) } : {}),
  };
}

/** The vehicle optimizer's objective: residuals of the goals, holds, keep-close and packaging at x. */
export function vehicleObjective(p: VehicleProblem) {
  const goals = p.goals.filter((g) => g.weight > 0);
  const ride0 = p.variables.some((v) => v.point === 'rideHeight') ? designRideHeight(p) : undefined;
  const x0 = p.variables.map((v) => vehicleVariableValue(p, v, ride0));
  const lo = p.variables.map((v) => Math.min(v.lo, v.hi));
  const hi = p.variables.map((v) => Math.max(v.lo, v.hi));
  const holds = (p.holds ?? []).map((h) => ({ h, v0: holdTarget(p.designs[h.root]!.geometry, h) }));
  const keep = Math.sqrt(p.keepClose ?? 0.01);
  const guesses: Partial<Record<string, ChassisPose>> = {};
  const start = evaluateVehicle(problemAt(p, x0), geometriesFor(p, x0), guesses);
  const refs = new Map(goals.filter((g) => VEHICLE_GOAL_META[g.kind].maximize).map((g) => [g.kind, start ? vehicleGoalValue(g.kind, p, start) : null]));
  const boundStart = boundStartValues(p, x0, start);

  // Every evaluation warm-starts from the start's solved poses, never from the last point evaluated (round 5):
  // with a pool of workers each kept its own last poses, so a point's residuals depended on which worker got it
  // (up to 6e-5, ≈ 0.3 % of a slope over the 0.02 mm Jacobian step) and identical runs ended differently
  // (default car, Autocross (simple): 14.01 vs 13.96 s after one round).
  const residuals = (x: number[]): number[] | null => {
    const geoms = geometriesFor(p, x);
    const e = evaluateVehicle(problemAt(p, x), geoms, guesses, true);
    if (!e) return null;
    const r: number[] = [];
    for (const goal of goals) {
      const w = Math.sqrt(goal.weight);
      for (const v of vehicleResiduals(goal, p, e, refs.get(goal.kind))) r.push(w * v);
    }
    for (const { h, v0 } of holds) r.push((holdValue(geoms[h.root]!, h) - v0) / 1e-3);
    x.forEach((v, i) => r.push((keep * (v - x0[i]!)) / 10));
    r.push(...packagingResiduals(p, geoms, e));
    // F28: the characteristic bounds (a wall past each).
    if (p.bounds?.length) r.push(...boundResiduals(p, e, boundStart));
    return r;
  };
  return { goals, x0, lo, hi, residuals, guesses };
}

export function optimizeVehicle(p: VehicleProblem, onIteration?: (info: ProgressInfo) => boolean | void): VehicleOptimizeResult {
  const { residuals } = vehicleObjective(p);
  const lsq = runStepsSync(vehicleSteps(p, onIteration), residuals);
  return { lsq, ...reportVehicle(p, lsq.x) };
}

/** The free variables' start and range (without evaluating anything). */
export function vehicleBounds(p: VehicleProblem): { x0: number[]; lo: number[]; hi: number[] } {
  return {
    x0: (() => { const ride0 = p.variables.some((v) => v.point === 'rideHeight') ? designRideHeight(p) : undefined; return p.variables.map((v) => vehicleVariableValue(p, v, ride0)); })(),
    lo: p.variables.map((v) => Math.min(v.lo, v.hi)),
    hi: p.variables.map((v) => Math.max(v.lo, v.hi)),
  };
}

/**
 * The vehicle optimizer's search as batches of points to evaluate (`vehicleObjective(p).residuals` at each),
 * so they can be spread over workers; `parallel` damping trials per batch (leastSquares.ts).
 */
export function vehicleSteps(p: VehicleProblem, onIteration?: (info: ProgressInfo) => boolean | void, parallel = 1) {
  const { x0, lo, hi } = vehicleBounds(p);
  return multiStartSteps(x0, lo, hi, {
    maxIterations: p.maxIterations ?? 40, step: 0.02, relTol: 1e-6, parallel,
    onIteration: onIteration ? (i) => onIteration({ iteration: i.iteration, cost: i.cost, cost0: i.cost0, evaluations: i.evaluations, x: i.x }) : undefined,
  }, { starts: p.starts ?? 1 });
}

export interface VehicleSensitivity {
  /** Effects on the optimizer's total miss (lower = better), and on each goal's value. */
  cost: Sensitivity;
  goals: { kind: VehicleGoalKind; s: Sensitivity }[];
  samples: number;
}

/**
 * What matters most (DOE): Latin-hypercube samples over the free ranges, then a linear fit with the
 * strongest pairwise interactions of the total miss and of each goal's value (search.ts § sensitivity).
 */
export function vehicleSensitivity(p: VehicleProblem, samples: number, onSample?: (k: number, n: number) => boolean | void): VehicleSensitivity | null {
  const obj = vehicleObjective(p);
  const { us, xs } = sensitivityPlan(p, samples);
  const out: SensitivitySample[] = [];
  for (let k = 0; k < xs.length; k++) {
    out.push(sensitivitySample(p, obj, xs[k]!));
    if (onSample?.(k + 1, xs.length) === false) return null;
  }
  return sensitivityResult(p, us, out);
}

/** The DOE points of the sensitivity report (unit samples and the points in the free ranges). */
export function sensitivityPlan(p: VehicleProblem, samples: number): { us: number[][]; xs: number[][] } {
  const { lo, hi } = vehicleBounds(p);
  const us = latinHypercube(Math.max(8, Math.round(samples)), lo.length, rng(23));
  return { us, xs: us.map((u) => u.map((v, i) => lo[i]! + v * (hi[i]! - lo[i]!))) };
}

export interface SensitivitySample { cost: number; values: number[] }

/** One DOE point: the optimizer's total miss and each goal's value (NaN where it can't be evaluated). */
export function sensitivitySample(p: VehicleProblem, obj: ReturnType<typeof vehicleObjective>, x: number[]): SensitivitySample {
  const r = obj.residuals(x);
  const e = r ? evaluateVehicle(problemAt(p, x), geometriesFor(p, x), obj.guesses, true) : null;
  return {
    cost: r ? 0.5 * r.reduce((a, v) => a + v * v, 0) : NaN,
    values: obj.goals.map((g) => (e ? vehicleGoalValue(g.kind, p, e) ?? NaN : NaN)),
  };
}

/** The sensitivity report from the DOE points' samples. */
export function sensitivityResult(p: VehicleProblem, us: number[][], out: SensitivitySample[]): VehicleSensitivity | null {
  const goals = p.goals.filter((g) => g.weight > 0);
  const costs = out.map((o) => o.cost);
  const values = goals.map((_, j) => out.map((o) => o.values[j] ?? NaN));
  const cost = sensitivity(us, costs);
  if (!cost) return null;
  return {
    cost, samples: cost.samples,
    goals: goals.map((g, j) => ({ kind: g.kind, s: sensitivity(us, values[j]!) })).filter((x): x is { kind: VehicleGoalKind; s: Sensitivity } => !!x.s),
  };
}

/**
 * Packaging limits for free points (until real packaging zones exist): a moved point may not sit inside
 * the tire (with 10 mm clearance) or within 20 mm of the ground at ride height. Penalty per mm.
 */
export function packagingResiduals(p: VehicleProblem, geoms: Partial<Record<CornerId, DoubleWishboneGeometry>>, e: VehicleEval): number[] {
  const out: number[] = [];
  const seen = new Set<string>();
  for (const v of p.variables) {
    const key = `${v.root}.${v.point}`;
    if (seen.has(key) || v.point === 'wheelCenter') continue;
    seen.add(key);
    const g = geoms[v.root]!;
    const pt = variablePoint(g, v.point);
    if (!pt) continue;
    const d = p.designs[v.root]!;
    const c = g.wheel.center;
    const a = g.wheel.spinAxis;
    const al = Math.hypot(a.x, a.y, a.z) || 1;
    const rel = { x: pt.x - c.x, y: pt.y - c.y, z: pt.z - c.z };
    const axial = (rel.x * a.x + rel.y * a.y + rel.z * a.z) / al;
    const radial = Math.sqrt(Math.max(0, rel.x ** 2 + rel.y ** 2 + rel.z ** 2 - axial ** 2));
    const inAxial = d.profile.width / 2 + 10 - Math.abs(axial);
    const inRadial = d.profile.radius + 10 - radial;
    // Ball joints and tie-rod ends live inside the rim: only the tread band (outside the rim) is off limits.
    const inTread = radial > d.profile.rimRadius;
    if (inAxial > 0 && inRadial > 0 && inTread) out.push(Math.min(inAxial, inRadial));
    const groundY = e.chars[v.root]?.contactPoint.y ?? -Infinity;
    out.push(Math.max(0, groundY + 20 - pt.y));
  }
  return out;
}

const variablePoint = (g: DoubleWishboneGeometry, id: VehicleVariable['point']) => getPoint(g, id);
