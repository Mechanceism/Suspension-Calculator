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
import { DoubleWishbone, isBeam, solidAxleOf, twistBeamOf, type DoubleWishboneGeometry } from '../suspension/doubleWishbone';
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
  CORNER_IDS, isFront, isLeft, placement, poseFns, solveVehicle, staticCornerLoads, designGroundY,
  type AxleShared, type BrakeMount, type CornerId, type DriveMount, type VehicleCorner, type VehicleResult, type ChassisPose, type DiffType, type VehicleInput, type DamperSpec,
} from '../vehicle/vehicle';
import { type LsqResult } from './leastSquares';
import { multiStartLeastSquares, latinHypercube, rng, sensitivity, type Sensitivity } from './search';
import type { RoadState } from '../tests/segments';
import { checkResiduals } from '../tests/checks';
import {
  withVariables, variableValue, sampleCorner, cornerGoalResiduals, goalValue, holdValue, holdTarget, getPoint,
  type Variable, type Hold, type ProgressInfo,
} from './corner';

const G = 9.80665;

export type VehicleGoalKind =
  | 'grip' | 'contactArea' | 'inclination' | 'roll' | 'lltd' | 'rollStiffness' | 'pitch' | 'antiDive' | 'antiSquat' | 'bumpSteer' | 'testPass' | 'testReserve';

export interface VehicleGoalMeta {
  short: string; label: string; unit: string; target: number; tolerance: number; hint: string; maximize?: boolean;
  /** Load case the goal is evaluated in. */
  uses: 'all' | 'lateral' | 'braking' | 'accel' | 'geometry';
}

export const VEHICLE_GOAL_META: Record<VehicleGoalKind, VehicleGoalMeta> = {
  grip: { short: 'Total grip', label: 'Total grip (largest)', unit: 'g', target: 0, tolerance: 0.01, maximize: true, uses: 'all', hint: 'Sum of the four tires\' peak force in the direction each must push ÷ vehicle weight, averaged over the load cases. Uses the tire grip model (Magic Formula): load sensitivity rewards even loads, and a wheel leaning into the turn gains camber thrust.' },
  contactArea: { short: 'Total area', label: 'Total contact area (largest)', unit: 'cm²', target: 0, tolerance: 0.01, maximize: true, uses: 'all', hint: 'Sum of the four patch areas, averaged over the load cases. With the air-spring tire model the area is set mostly by load ÷ pressure; the stiffness model responds to inclination much more.' },
  inclination: { short: 'Outside incl.', label: 'Outside-tire inclination (cornering)', unit: '°', target: -1, tolerance: 0.05, uses: 'lateral', hint: 'Inclination to the ground of the two outside (loaded) tires in the cornering case. + = top outboard.' },
  roll: { short: 'Roll gradient', label: 'Roll gradient (cornering)', unit: '°/g', target: 1, tolerance: 0.02, uses: 'lateral', hint: 'Body roll per g of lateral acceleration.' },
  lltd: { short: 'LLTD front', label: 'Front share of lateral load transfer', unit: '%', target: 50, tolerance: 0.5, uses: 'lateral', hint: 'Above ~50% the car tends to understeer.' },
  rollStiffness: { short: 'Roll stiff. front', label: 'Front share of roll stiffness', unit: '%', target: 50, tolerance: 0.5, uses: 'lateral', hint: 'Front axle\'s share of the load moved through the springs and anti-roll bars (the body-roll part of the transfer; roll centers from each design). More front = more understeer.' },
  pitch: { short: 'Brake pitch', label: 'Pitch under braking', unit: '°', target: 0.5, tolerance: 0.02, uses: 'braking', hint: 'Nose-down pitch in the braking case.' },
  antiDive: { short: 'Anti-dive', label: 'Anti-dive (front, braking)', unit: '%', target: 20, tolerance: 1, uses: 'geometry', hint: 'Classic geometric anti-dive at static height from the side-view IC, brake mount and bias.' },
  antiSquat: { short: 'Anti-squat', label: 'Anti-squat (rear, accelerating)', unit: '%', target: 30, tolerance: 1, uses: 'geometry', hint: 'Classic geometric anti-squat of the powered rear corners (needs powered rear corners).' },
  testReserve: { short: 'Test reserve', label: 'More grip reserve in the tests (largest)', unit: '%', target: 0, tolerance: 1, maximize: true, uses: 'all', hint: 'Lowers every state\'s worst tire grip use, weighted by test priority and segment weight (the worst states count most). Use it to improve a test that already passes. Placeholder grip model.' },
  testPass: { short: 'Test passes', label: 'Every tire within its grip (test must pass)', unit: '%', target: 90, tolerance: 1, uses: 'all', hint: 'No tire in any load case may use more than this share of its grip (100% = sliding). With a test selected as the load cases, this makes the test pass with margin. Grip model is a placeholder until real tire data.' },
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

export interface VehicleProblem {
  /** Corner designs keyed by root corner. */
  designs: Partial<Record<CornerId, VehicleDesignIn>>;
  /** Root (design) of each corner. */
  roots: Record<CornerId, CornerId>;
  settings: Record<CornerId, { brake: BrakeMount; drive: DriveMount; abs?: boolean }>;
  /** Differential per axle (chassis-driven axles). */
  diff?: { front?: DiffType; rear?: DiffType };
  /** Test states: when given, they replace the fixed load cases. */
  states?: RoadState[];
  /** Steered corners and the rack (tests: the rack travel a turn needs). */
  steering?: SteeringSpec;
  /** Ride model (Phase B): body inertias about the sprung CG (kg·m²) and tire damping (N·s/m). */
  ride?: RideSpec;
  /** Aerodynamics (applied at each test state's speed). Omit = none. */
  aero?: { model: AeroModel; rho: number };
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
  droop: number;
  bump: number;
  /** Load cases (0 = off). Lateral is a left turn. */
  cases: { lateralG: number; brakingG: number; accelG: number };
  goals: VehicleGoal[];
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

export interface CaseEval {
  /** 'lateral' | 'braking' | 'accel' for the fixed cases, or the test state's name. */
  name: string;
  kind: 'lateral' | 'braking' | 'accel' | 'state';
  g: number;
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
  // Solid axles: build them, and give their wheels the characteristics the rest of the car reads.
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
        axles[which] = { axle, table: new AxleTable(axle, range, Math.max(9, Math.min(21, n - 4))), design };
      } catch { return null; }
      continue;
    }
    if (!g) continue;
    try {
      const axle = new SolidAxle(g);
      const design = axle.design();
      if (design.solve.status !== 'converged') return null;
      axles[which] = { axle, table: new AxleTable(axle, range, Math.max(9, Math.min(21, n - 4))), design };
      const ac = axleCharacteristics(axle, design);
      for (const id of (which === 'front' ? ['FL', 'FR'] : ['RL', 'RR']) as CornerId[]) {
        chars[id] = axleWheelChars(design, ac, isLeft(id) ? 'L' : 'R');
        contactX[id] = chars[id].contactPoint.x;
      }
    } catch { return null; }
  }
  const cgRel = vec3(p.cg.x, p.cg.height, p.cg.z);
  const loads = staticCornerLoads(p.mass, cgRel, p.wheelbase, contactX);
  const tables = new Map<string, CornerTable>();
  const corners: VehicleCorner[] = [];
  for (const id of CORNER_IDS) {
    const root = p.roots[id];
    const d = p.designs[root]!;
    const ax = axles[isFront(id) ? 'front' : 'rear'];
    if (ax) {
      // A wheel of a solid axle: preload from the axle's heave motion ratio (both sides move together).
      const side = isLeft(id) ? 'L' : 'R';
      const s0 = ax.table.at(side, 0, 0);
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
    const key = `${root}|${dl ? `${dl.x},${dl.y},${dl.z}` : '-'}`;
    let table = tables.get(key);
    if (!table) {
      try { table = new CornerTable(built.get(root)!, 0, range, n, dl ? { body: 'lca', point: dl } : undefined); } catch { return null; }
      tables.set(key, table);
    }
    const freeLength = p.autoPreload && d.geometry.kind !== 'rigid' ? fitFreeLength(built.get(root)!, d.springRate, Math.max(0, loads[id] - d.unsprungMass * G)) : d.freeLength;
    corners.push({
      id, table, unsprungMass: d.unsprungMass, ...(d.geometry.kind === 'rigid' ? { rigid: true } : {}), tire: { profile: d.profile, model: d.model, ...(p.tireGripRear && !isFront(id) ? { grip: p.tireGripRear } : {}) },
      brake: p.settings[id].brake, drive: p.settings[id].drive, abs: p.settings[id].abs ?? true,
      spring: { rate: d.springRate, freeLength, ...(d.bumpStop ? { bumpStopLength: d.bumpStop.length, bumpStopRate: d.bumpStop.rate } : {}) },
      ...(d.damping ? { damper: d.damping } : {}),
    });
  }
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
  return { corners, groundY, cg: vec3(p.cg.x, groundY + p.cg.height, p.cg.z), chars, built, designState };
}

export interface CaseSpec {
  name: string; kind: CaseEval['kind']; g: number;
  lateralG: number; brakingG: number; accelG: number; gravityScale?: number; groundOffset?: Partial<Record<CornerId, number>>;
  state?: RoadState;
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
  if (p.cases.lateralG) out.push({ name: 'lateral', kind: 'lateral', g: p.cases.lateralG, lateralG: p.cases.lateralG, brakingG: 0, accelG: 0 });
  if (p.cases.brakingG) out.push({ name: 'braking', kind: 'braking', g: p.cases.brakingG, lateralG: 0, brakingG: p.cases.brakingG, accelG: 0 });
  if (p.cases.accelG) out.push({ name: 'accel', kind: 'accel', g: p.cases.accelG, lateralG: 0, brakingG: 0, accelG: p.cases.accelG });
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
  return { name: c.name, kind: c.kind, g: c.g, state: c.state, result, grip: g };
}

/** Build the corners and run every load case for the given geometries. null = can't be assembled/solved. */
export function evaluateVehicle(p: VehicleProblem, geometries: Partial<Record<CornerId, DoubleWishboneGeometry>>, guesses?: Partial<Record<string, ChassisPose>>): VehicleEval | null {
  const asm = assembleVehicle(p, geometries);
  if (!asm) return null;
  const cases: CaseEval[] = [];
  for (const c of caseList(p)) {
    const e = solveCase(p, asm, c, guesses?.[c.name]);
    if (!e) return null;
    if (guesses) guesses[c.name] = e.result.pose;
    cases.push(e);
  }
  return { geometries, cases, chars: asm.chars };
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
const latGOf = (c: CaseEval) => (c.kind === 'state' ? c.state!.lateralG : c.kind === 'lateral' ? c.g : 0);
const brakeGOf = (c: CaseEval) => (c.kind === 'state' ? c.state!.brakingG : c.kind === 'braking' ? c.g : 0);
const latCase = (e: VehicleEval) => e.cases.filter((c) => Math.abs(latGOf(c)) > 0.05).sort((a, b) => Math.abs(latGOf(b)) - Math.abs(latGOf(a)))[0];
const brakeCase = (e: VehicleEval) => e.cases.filter((c) => brakeGOf(c) > 0.05).sort((a, b) => brakeGOf(b) - brakeGOf(a))[0];

function antiOf(p: VehicleProblem, e: VehicleEval, kind: 'antiDive' | 'antiSquat'): number | null {
  const h = p.cg.height;
  if (kind === 'antiDive') {
    const ids = (['FL', 'FR'] as CornerId[]).filter((id) => p.settings[id].brake !== 'none');
    if (!ids.length) return null;
    return mean(ids.map((id) => {
      const ch = e.chars[id];
      const th = p.settings[id].brake === 'inboard' ? ch.antiAngleWheelCenter : ch.antiAngleContact;
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

/** Reported value of a vehicle goal. */
export function vehicleGoalValue(kind: VehicleGoalKind, p: VehicleProblem, e: VehicleEval): number | null {
  const lat = latCase(e);
  const brk = brakeCase(e);
  switch (kind) {
    // Peak force each tire can carry in the direction it must push (Magic Formula, camber thrust included).
    case 'grip': return e.cases.length ? mean(e.cases.map((c) => CORNER_IDS.reduce((a, id) => a + (c.result.grip?.corners[id].capacity ?? 0), 0))) / (p.mass * G) : null;
    case 'contactArea': return e.cases.length ? mean(e.cases.map((c) => CORNER_IDS.reduce((a, id) => a + c.grip[id].area, 0))) / 100 : null;
    case 'inclination': return lat ? mean(outsideOf(lat).map((id) => deg(lat.result.corners[id].inclination))) : null;
    case 'roll': return lat ? Math.abs(deg(lat.result.pose.roll)) / Math.abs(latGOf(lat)) : null;
    case 'testPass': return e.cases.length ? 100 * Math.max(...e.cases.map((c) => c.result.grip?.maxUtilization ?? 0)) : null;
    case 'testReserve': {
      if (!e.cases.length) return null;
      const w = e.cases.map((c) => c.state?.weight ?? 1);
      const tw = w.reduce((a, b) => a + b, 0) || 1;
      return (100 * e.cases.reduce((a, c, i) => a + w[i]! * (1 - (c.result.grip?.maxUtilization ?? 1)), 0)) / tw;
    }
    case 'lltd': return lat ? lltdOf(lat) : null;
    case 'rollStiffness': return lat ? rollStiffnessShareOf(lat, e.chars) : null;
    case 'pitch': return brk ? deg(brk.result.pose.pitch) : null;
    case 'antiDive': case 'antiSquat': return antiOf(p, e, kind);
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

const BAD = 1e3;

function vehicleResiduals(goal: VehicleGoal, p: VehicleProblem, e: VehicleEval, ref: number | null | undefined): number[] {
  const meta = VEHICLE_GOAL_META[goal.kind];
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
      return CORNER_IDS.map((id) => Math.max(0, (c.result.grip?.corners[id].utilization ?? 0) - limit) / (meta.tolerance / 100));
    });
  }
  if (goal.kind === 'testReserve') {
    // Lower grip use everywhere; squares make the worst states count most.
    return e.cases.map((c) => (Math.sqrt(c.state?.weight ?? 1) * (c.result.grip?.maxUtilization ?? 1)) / 0.05);
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
}
export interface VehicleOptimizeResult extends VehicleReport { lsq: LsqResult }

export function reportVehicle(p: VehicleProblem, x: number[]): VehicleReport {
  const geometries = geometriesFor(p, x);
  const x0 = p.variables.map((v) => variableValue(p.designs[v.root]!.geometry, v));
  const before = evaluateVehicle(p, geometriesFor(p, x0));
  const after = evaluateVehicle(p, geometries);
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
  };
}

/** The vehicle optimizer's objective: residuals of the goals, holds, keep-close and packaging at x. */
function vehicleObjective(p: VehicleProblem) {
  const goals = p.goals.filter((g) => g.weight > 0);
  const x0 = p.variables.map((v) => variableValue(p.designs[v.root]!.geometry, v));
  const lo = p.variables.map((v) => Math.min(v.lo, v.hi));
  const hi = p.variables.map((v) => Math.max(v.lo, v.hi));
  const holds = (p.holds ?? []).map((h) => ({ h, v0: holdTarget(p.designs[h.root]!.geometry, h) }));
  const keep = Math.sqrt(p.keepClose ?? 0.01);
  const guesses: Partial<Record<string, ChassisPose>> = {};
  const start = evaluateVehicle(p, geometriesFor(p, x0), guesses);
  const refs = new Map(goals.filter((g) => VEHICLE_GOAL_META[g.kind].maximize).map((g) => [g.kind, start ? vehicleGoalValue(g.kind, p, start) : null]));

  const residuals = (x: number[]): number[] | null => {
    const geoms = geometriesFor(p, x);
    const e = evaluateVehicle(p, geoms, guesses);
    if (!e) return null;
    const r: number[] = [];
    for (const goal of goals) {
      const w = Math.sqrt(goal.weight);
      for (const v of vehicleResiduals(goal, p, e, refs.get(goal.kind))) r.push(w * v);
    }
    for (const { h, v0 } of holds) r.push((holdValue(geoms[h.root]!, h) - v0) / 1e-3);
    x.forEach((v, i) => r.push((keep * (v - x0[i]!)) / 10));
    r.push(...packagingResiduals(p, geoms, e));
    return r;
  };
  return { goals, x0, lo, hi, residuals, guesses };
}

export function optimizeVehicle(p: VehicleProblem, onIteration?: (info: ProgressInfo) => boolean | void): VehicleOptimizeResult {
  const { x0, lo, hi, residuals } = vehicleObjective(p);
  const lsq = multiStartLeastSquares(residuals, x0, lo, hi, {
    maxIterations: p.maxIterations ?? 40, step: 0.02, relTol: 1e-6,
    onIteration: onIteration ? (i) => onIteration({ iteration: i.iteration, cost: i.cost, cost0: i.cost0, evaluations: i.evaluations, x: i.x }) : undefined,
  }, { starts: p.starts ?? 1 });
  return { lsq, ...reportVehicle(p, lsq.x) };
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
  const { goals, lo, hi, residuals, guesses } = vehicleObjective(p);
  const n = Math.max(8, Math.round(samples));
  const us = latinHypercube(n, lo.length, rng(23));
  const costs: number[] = [];
  const values: number[][] = goals.map(() => []);
  for (let k = 0; k < us.length; k++) {
    const x = us[k]!.map((u, i) => lo[i]! + u * (hi[i]! - lo[i]!));
    const r = residuals(x);
    costs.push(r ? 0.5 * r.reduce((a, v) => a + v * v, 0) : NaN);
    const e = r ? evaluateVehicle(p, geometriesFor(p, x), guesses) : null;
    goals.forEach((g, j) => values[j]!.push(e ? vehicleGoalValue(g.kind, p, e) ?? NaN : NaN));
    if (onSample?.(k + 1, us.length) === false) return null;
  }
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
