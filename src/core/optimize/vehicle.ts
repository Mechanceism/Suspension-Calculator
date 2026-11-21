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
import { DoubleWishbone, type DoubleWishboneGeometry } from '../suspension/doubleWishbone';
import { characteristics, deg, type Characteristics } from '../suspension/characteristics';
import { fitFreeLength } from '../suspension/spring';
import type { TireProfile } from '../tire/geometry';
import type { TireForceModel } from '../tire/model';
import { patchGrip, DEFAULT_GRIP, type GripModel, type PatchGrip } from '../tire/grip';
import { CornerTable } from '../vehicle/cornerTable';
import {
  CORNER_IDS, isFront, placement, poseFns, solveVehicle, staticCornerLoads, designGroundY,
  type AxleShared, type BrakeMount, type CornerId, type DriveMount, type VehicleCorner, type VehicleResult, type ChassisPose,
} from '../vehicle/vehicle';
import { boundedLeastSquares, type LsqResult } from './leastSquares';
import {
  withVariables, variableValue, sampleCorner, cornerGoalResiduals, goalValue, holdValue,
  type Variable, type Hold, type ProgressInfo,
} from './corner';

const G = 9.80665;

export type VehicleGoalKind =
  | 'grip' | 'contactArea' | 'inclination' | 'roll' | 'lltd' | 'pitch' | 'antiDive' | 'antiSquat' | 'bumpSteer';

export interface VehicleGoalMeta {
  short: string; label: string; unit: string; target: number; tolerance: number; hint: string; maximize?: boolean;
  /** Load case the goal is evaluated in. */
  uses: 'all' | 'lateral' | 'braking' | 'accel' | 'geometry';
}

export const VEHICLE_GOAL_META: Record<VehicleGoalKind, VehicleGoalMeta> = {
  grip: { short: 'Total grip', label: 'Total grip (largest)', unit: 'g', target: 0, tolerance: 0.01, maximize: true, uses: 'all', hint: 'Sum of the four tires\' friction capacity ÷ vehicle weight, averaged over the load cases. Uses the tire grip model: load sensitivity rewards even loads and even patch pressure.' },
  contactArea: { short: 'Total area', label: 'Total contact area (largest)', unit: 'cm²', target: 0, tolerance: 0.01, maximize: true, uses: 'all', hint: 'Sum of the four patch areas, averaged over the load cases. With the air-spring tire model the area is set mostly by load ÷ pressure; the stiffness model responds to inclination much more.' },
  inclination: { short: 'Outside incl.', label: 'Outside-tire inclination (cornering)', unit: '°', target: -1, tolerance: 0.05, uses: 'lateral', hint: 'Inclination to the ground of the two outside (loaded) tires in the cornering case. + = top outboard.' },
  roll: { short: 'Roll gradient', label: 'Roll gradient (cornering)', unit: '°/g', target: 1, tolerance: 0.02, uses: 'lateral', hint: 'Body roll per g of lateral acceleration.' },
  lltd: { short: 'LLTD front', label: 'Front share of lateral load transfer', unit: '%', target: 50, tolerance: 0.5, uses: 'lateral', hint: 'Above ~50% the car tends to understeer.' },
  pitch: { short: 'Brake pitch', label: 'Pitch under braking', unit: '°', target: 0.5, tolerance: 0.02, uses: 'braking', hint: 'Nose-down pitch in the braking case.' },
  antiDive: { short: 'Anti-dive', label: 'Anti-dive (front, braking)', unit: '%', target: 20, tolerance: 1, uses: 'geometry', hint: 'Classic geometric anti-dive at static height from the side-view IC, brake mount and bias.' },
  antiSquat: { short: 'Anti-squat', label: 'Anti-squat (rear, accelerating)', unit: '%', target: 30, tolerance: 1, uses: 'geometry', hint: 'Classic geometric anti-squat of the powered rear corners (needs powered rear corners).' },
  bumpSteer: { short: 'Bump steer', label: 'Bump steer (every design)', unit: '°', target: 0, tolerance: 0.01, uses: 'geometry', hint: 'Keeps every corner design free of bump steer over the travel range while the rest is optimized. Reported: worst deviation, °.' },
};
export const VEHICLE_GOAL_KINDS = Object.keys(VEHICLE_GOAL_META) as VehicleGoalKind[];

export interface VehicleGoal { kind: VehicleGoalKind; target: number; weight: number }
export type VehicleVariable = Variable & { root: CornerId };
export type VehicleHold = Hold & { root: CornerId };

export interface VehicleDesignIn {
  geometry: DoubleWishboneGeometry;
  profile: TireProfile;
  model: TireForceModel;
  springRate: number;
  freeLength: number;
  bumpStop?: { length: number; rate: number };
  unsprungMass: number;
}

export interface VehicleProblem {
  /** Corner designs keyed by root corner. */
  designs: Partial<Record<CornerId, VehicleDesignIn>>;
  /** Root (design) of each corner. */
  roots: Record<CornerId, CornerId>;
  settings: Record<CornerId, { brake: BrakeMount; drive: DriveMount }>;
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
  grip?: GripModel;
  keepClose?: number;
  maxIterations?: number;
  /** Corner-table samples per evaluation (fewer = faster). */
  tableSamples?: number;
}

export interface CaseEval {
  name: 'lateral' | 'braking' | 'accel';
  g: number;
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

/** Build the corners and run every load case for the given geometries. null = can't be assembled/solved. */
export function evaluateVehicle(p: VehicleProblem, geometries: Partial<Record<CornerId, DoubleWishboneGeometry>>, guesses?: Partial<Record<string, ChassisPose>>): VehicleEval | null {
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
  const cgRel = vec3(p.cg.x, p.cg.height, p.cg.z);
  const loads = staticCornerLoads(p.mass, cgRel, p.wheelbase, contactX);
  const tables = new Map<string, CornerTable>();
  const corners: VehicleCorner[] = [];
  for (const id of CORNER_IDS) {
    const root = p.roots[id];
    const d = p.designs[root]!;
    const dl = isFront(id) ? p.dropLinks.front : p.dropLinks.rear;
    const key = `${root}|${dl ? `${dl.x},${dl.y},${dl.z}` : '-'}`;
    let table = tables.get(key);
    if (!table) {
      try { table = new CornerTable(built.get(root)!, 0, range, n, dl ? { body: 'lca', point: dl } : undefined); } catch { return null; }
      tables.set(key, table);
    }
    const freeLength = p.autoPreload ? fitFreeLength(built.get(root)!, d.springRate, Math.max(0, loads[id] - d.unsprungMass * G)) : d.freeLength;
    corners.push({
      id, table, unsprungMass: d.unsprungMass, tire: { profile: d.profile, model: d.model },
      brake: p.settings[id].brake, drive: p.settings[id].drive,
      spring: { rate: d.springRate, freeLength, ...(d.bumpStop ? { bumpStopLength: d.bumpStop.length, bumpStopRate: d.bumpStop.rate } : {}) },
    });
  }
  const groundY = designGroundY(CORNER_IDS.map((id) => {
    const ds = designState.get(p.roots[id])!;
    const d = p.designs[p.roots[id]]!;
    return { contactY: ds.points.contact.y, profile: d.profile, model: d.model, staticLoad: loads[id], tilt: ds.spinAxis.y };
  }));
  const cg = vec3(p.cg.x, groundY + p.cg.height, p.cg.z);
  const grip = p.grip ?? DEFAULT_GRIP;

  const caseList: { name: CaseEval['name']; g: number; lateralG: number; brakingG: number; accelG: number }[] = [];
  if (p.cases.lateralG) caseList.push({ name: 'lateral', g: p.cases.lateralG, lateralG: p.cases.lateralG, brakingG: 0, accelG: 0 });
  if (p.cases.brakingG) caseList.push({ name: 'braking', g: p.cases.brakingG, lateralG: 0, brakingG: p.cases.brakingG, accelG: 0 });
  if (p.cases.accelG) caseList.push({ name: 'accel', g: p.cases.accelG, lateralG: 0, brakingG: 0, accelG: p.cases.accelG });

  const cases: CaseEval[] = [];
  for (const c of caseList) {
    const result = solveVehicle({
      corners, totalMass: p.mass, cg, wheelbase: p.wheelbase, groundY,
      lateralG: c.lateralG, brakingG: c.brakingG, brakeBias: p.brakeBias, accelG: c.accelG, driveSplit: p.driveSplit, shared: p.shared,
    }, { guess: guesses?.[c.name] });
    if (!result.converged) return null;
    if (guesses) guesses[c.name] = result.pose;
    const P = poseFns(result.pose);
    const g = {} as Record<CornerId, PatchGrip>;
    for (const id of CORNER_IDS) {
      const root = p.roots[id];
      const st = built.get(root)!.solve({ travel: result.corners[id].travel }, designState.get(root)!.poses);
      const pl = placement(id, p.wheelbase);
      const wc = P.point(pl.point(st.points.wheelCenter));
      const axis = P.rot(pl.dir(st.spinAxis));
      g[id] = patchGrip(wc, axis, { point: vec3(0, groundY, 0), normal: Y_AXIS }, p.designs[root]!.profile, result.corners[id].tireLoad, grip);
    }
    cases.push({ name: c.name, g: c.g, result, grip: g });
  }
  return { geometries, cases, chars };
}

const mean = (v: number[]) => (v.length ? v.reduce((a, b) => a + b, 0) / v.length : NaN);

function lltdOf(c: CaseEval): number | null {
  const r = c.result.corners;
  const tf = (r.FR.tireLoad - r.FL.tireLoad) / 2;
  const tr = (r.RR.tireLoad - r.RL.tireLoad) / 2;
  return tf + tr !== 0 ? (100 * tf) / (tf + tr) : null;
}

/** Outside corners in a left turn (lateral > 0 loads the right side). */
const OUTSIDE: CornerId[] = ['FR', 'RR'];

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
  const lat = e.cases.find((c) => c.name === 'lateral');
  const brk = e.cases.find((c) => c.name === 'braking');
  switch (kind) {
    case 'grip': return e.cases.length ? mean(e.cases.map((c) => CORNER_IDS.reduce((a, id) => a + c.grip[id].capacity, 0))) / (p.mass * G) : null;
    case 'contactArea': return e.cases.length ? mean(e.cases.map((c) => CORNER_IDS.reduce((a, id) => a + c.grip[id].area, 0))) / 100 : null;
    case 'inclination': return lat ? mean(OUTSIDE.map((id) => deg(lat.result.corners[id].inclination))) : null;
    case 'roll': return lat ? Math.abs(deg(lat.result.pose.roll)) / Math.abs(lat.g) : null;
    case 'lltd': return lat ? lltdOf(lat) : null;
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
    const lat = e.cases.find((c) => c.name === 'lateral');
    return lat ? OUTSIDE.map((id) => (deg(lat.result.corners[id].inclination) - goal.target) / meta.tolerance) : [];
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

export function optimizeVehicle(p: VehicleProblem, onIteration?: (info: ProgressInfo) => boolean | void): VehicleOptimizeResult {
  const goals = p.goals.filter((g) => g.weight > 0);
  const x0 = p.variables.map((v) => variableValue(p.designs[v.root]!.geometry, v));
  const lo = p.variables.map((v) => Math.min(v.lo, v.hi));
  const hi = p.variables.map((v) => Math.max(v.lo, v.hi));
  const holds = (p.holds ?? []).map((h) => ({ h, v0: holdValue(p.designs[h.root]!.geometry, h) }));
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
    return r;
  };

  const lsq = boundedLeastSquares(residuals, x0, lo, hi, {
    maxIterations: p.maxIterations ?? 40, step: 0.02, relTol: 1e-6,
    onIteration: onIteration ? (i) => onIteration({ iteration: i.iteration, cost: i.cost, cost0: i.cost0, evaluations: i.evaluations, x: i.x }) : undefined,
  });
  return { lsq, ...reportVehicle(p, lsq.x) };
}
