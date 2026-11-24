/**
 * App side of the optimizers: turns the setups (free coordinates + ranges, goals, locks) into a
 * CornerProblem or a VehicleProblem, and runs them in a Web Worker so the UI stays responsive.
 */
import { blendCurves, parseDamperCurve } from '../core/vehicle/vehicle';
import { brakeCapacity, type BrakeSystem, type BrakeCapacity, type BrakeAxle, type BrakeDetail, type WheelRoom } from '../core/vehicle/brakes';
import type { BrakeThermal } from '../core/vehicle/brakeThermal';
import type { TrailerSpec } from '../core/vehicle/towing';
import {
  GOAL_KINDS, GOAL_META, reportCorner, variableValue,
  type CornerProblem, type CornerReport, type HardpointId, type ProgressInfo, type Variable, type Hold,
} from '../core/optimize/corner';
import {
  VEHICLE_GOAL_KINDS, VEHICLE_GOAL_META, reportVehicle, vehicleSteps, vehicleBounds, sensitivityPlan, sensitivityResult,
  type SensitivitySample, type VehicleProblem, type VehicleReport, type VehicleVariable, type VehicleHold,
} from '../core/optimize/vehicle';
import type { GripModel } from '../core/tire/grip';
import type { MFCoeffs, TireGrip } from '../core/tire/magicFormula';
import type { TirModel } from '../core/tire/tir';
import { airDensity, type AeroModel } from '../core/vehicle/aero';
import type { TireSample, TireFitResult } from '../core/tire/fit';
import type { TireForceModel } from '../core/tire/model';
import { CORNER_IDS, tirePressure, type AxleShared, type CornerId, type DamperSpec } from '../core/vehicle/vehicle';
import { vec3 } from '../core/math/vec3';
import type { EffortSpec } from '../core/suspension/steeringEffort';
import { shimmyKicks, type ShimmySpec } from '../core/optimize/shimmyOf';
import { inputPerRev } from '../core/tests/steer';
import { ratioSpecOf, layoutOf,
  POINT_KEYS, rootOf, toGeometry, toProfile, toForceModel, mergedCorners, vehicleStaticLoads, defaultOptimizerSetup, GRIP_KEYS, MF_KEYS,
  DEFAULT_DAMPER_CURVE, type DamperCurveText, type AppState, type FadeKey, type PointKey, type OptimizerSetup, type SharedDesign, type GripKey, type MFKey, type Field, type DamperKey, type DamperMode,
  type BrakeKey, type BrakeMoreKey,
} from './store';
import { STATE_KEY } from './anchors';
import { lockKeys, pointAxisLocked } from './locks';
import { toSpec } from './heldDimensions';
import type { SegmentSpec } from '../core/tests/segments';
import type { TestRun, TestRunOptions, PlaybackFrame } from '../core/tests/run';
import type { VehicleSensitivity } from '../core/optimize/vehicle';
import { rateSteps, type RateVar, type RateTest, type RateProgress, type RateResult } from '../core/optimize/rates';
import { runSteps } from '../core/optimize/leastSquares';
import { POOL_SIZE, createPool } from './workerPool';
import { statesForTests } from './tests';

const AXES = ['x', 'y', 'z'] as const;
export const varKey = (k: PointKey, axis: 0 | 1 | 2) => `${k}.${AXES[axis]}`;
export function parseVarKey(key: string): { k: PointKey; axis: 0 | 1 | 2 } | null {
  const [k, a] = key.split('.');
  const axis = AXES.indexOf(a as 'x');
  return (POINT_KEYS as readonly string[]).includes(k!) && axis >= 0 ? { k: k as PointKey, axis: axis as 0 | 1 | 2 } : null;
}
/** Custom linkage joint points: `custom.<joint>.<p|q>.<x|y|z>` ↔ the optimizer's `custom:<joint>:<p|q>`. */
export const customVarKey = (joint: string, which: 'p' | 'q', axis: 0 | 1 | 2) => `custom.${joint}.${which}.${AXES[axis]}`;
export function parseCustomVarKey(key: string): { joint: string; which: 'p' | 'q'; axis: 0 | 1 | 2 } | null {
  const m = /^custom\.(.+)\.(p|q)\.([xyz])$/.exec(key);
  return m ? { joint: m[1]!, which: m[2] as 'p' | 'q', axis: AXES.indexOf(m[3] as 'x') as 0 | 1 | 2 } : null;
}
/** The joint and point of a `custom:<joint>:<p|q>` optimizer variable (null for a hardpoint). */
export function customOfVariable(id: string): { joint: string; which: 'p' | 'q' } | null {
  if (!id.startsWith('custom:')) return null;
  const [, joint, which] = id.split(':');
  return { joint: joint!, which: which === 'q' ? 'q' : 'p' };
}
/** Vehicle optimizer keys carry the design (root corner): `FL.trInner.y`. */
export const vehVarKey = (root: CornerId, k: PointKey, axis: 0 | 1 | 2) => `${root}.${varKey(k, axis)}`;
export function parseVehVarKey(key: string): { root: CornerId; k: PointKey; axis: 0 | 1 | 2 } | null {
  const i = key.indexOf('.');
  const root = key.slice(0, i);
  const rest = parseVarKey(key.slice(i + 1));
  return (CORNER_IDS as string[]).includes(root) && rest ? { root: root as CornerId, ...rest } : null;
}
const POINT_OF: Record<HardpointId, PointKey> = Object.fromEntries(
  Object.entries(STATE_KEY).map(([pk, hp]) => [hp, pk]),
) as Record<HardpointId, PointKey>;
export const pointKeyOf = (id: HardpointId): PointKey => POINT_OF[id];

export const setupOf = (s: AppState): OptimizerSetup => s.optimizer[rootOf(s.activeCorner, s.links)] ?? defaultOptimizerSetup();

/** A "rigid" tire is modelled as a very stiff one so every corner has a defined tire force. */
export const RIGID_TIRE: TireForceModel = { kind: 'stiffness', rate: 1e5 };

/** Magic Formula coefficients from their fields. */
/** Aerodynamics for the solver (undefined when off): the imported model or the generic values, and the air density. */
/** The brake system from the inputs (front / rear tire radii from the designs on each axle). */
export interface BrakesModel {
  system: BrakeSystem;
  capacity: BrakeCapacity;
  thermal?: BrakeThermal;
  /** Detailed hydraulics (fluid and pedal travel), when chosen. */
  detail?: BrakeDetail;
  /** Room for the brakes inside each axle's wheel. */
  room: { front: WheelRoom; rear: WheelRoom };
  /** Tire radius per axle, mm. */
  tireRadius: { front: number; rear: number };
}

export function brakesOf(s: Pick<AppState, 'brakes'> & Parameters<typeof mergedCorners>[0]): BrakesModel | null {
  const b = s.brakes;
  if (!b?.on) return null;
  const v = (k: BrakeKey | BrakeMoreKey) => b[k].value;
  const axle = (side: 'F' | 'R', drum: boolean): BrakeAxle => ({
    kind: drum ? 'drum' : 'disc',
    mcBore: v(`mcBore${side}`), pistonDiameter: v(`pistonDia${side}`), pistonsPerSide: v(`pistons${side}`), padMu: v(`padMu${side}`), rotorRadius: v(`rotorR${side}`),
    wheelCylinder: v(`wcBore${side}`), drumRadius: v(`drumR${side}`), brakeFactor: v(`brakeFactor${side}`), fadeSensitivity: drum ? v('drumFadeK') : 1,
  });
  const system: BrakeSystem = {
    maxPedalForce: v('maxPedalForce'), pedalRatio: v('pedalRatio'), boost: v('boost'), dualMc: b.dualMc, balanceFront: v('balanceFront') / 100,
    front: axle('F', !!b.drumF), rear: axle('R', !!b.drumR),
  };
  const all = mergedCorners(s);
  const g = (id: CornerId) => all[rootOf(id, s.links)].geom.scalars;
  const r = (id: CornerId) => g(id).tireDiameter.value / 2;
  const room = (id: CornerId): WheelRoom => ({ rimDiameter: g(id).rimDiameter.value, clearance: v('brakeRoom'), padHeight: v('padHeight') });
  const f = (k: FadeKey) => b[k].value;
  const thermal: BrakeThermal | undefined = b.fade ? {
    rotorMass: { front: f('rotorMassF'), rear: f('rotorMassR') }, cooling: f('cooling'),
    fadeStart: f('fadeStart'), fadeEnd: f('fadeEnd'), fadeLoss: f('fadeLoss') / 100, air: f('fadeAir'), start: f('fadeStartTemp'),
    sensitivity: { front: system.front.fadeSensitivity ?? 1, rear: system.rear.fadeSensitivity ?? 1 },
  } : undefined;
  const detail: BrakeDetail | undefined = b.detail ? {
    mcStroke: v('mcStroke'), maxPedalTravel: v('maxPedalTravel'), padClearance: v('padClearance'), shoeClearance: v('shoeClearance'),
    compliance: { front: v('complianceF'), rear: v('complianceR') },
  } : undefined;
  const tireRadius = { front: r('FL'), rear: r('RL') };
  return { system, capacity: brakeCapacity(system, tireRadius), ...(thermal ? { thermal } : {}), ...(detail ? { detail } : {}), room: { front: room('FL'), rear: room('RL') }, tireRadius };
}

/** The trailer from the towing inputs, or undefined when not towing. */
export function trailerOf(s: Pick<AppState, 'tow'>): TrailerSpec | undefined {
  const t = s.tow;
  if (!t?.on) return undefined;
  return {
    mass: t.trailerMass.value, tongueShare: t.tongueShare.value / 100, hitchHeight: t.hitchHeight.value, hitchBehindRear: t.hitchBehindRear.value,
    hitchToAxle: t.hitchToAxle.value, cgHeight: t.trailerCgHeight.value, brakeShare: t.trailerBrakes.value / 100, yawRadius: t.trailerYawRadius.value,
    ...(t.tongueLimit.value > 0 ? { tongueLimit: t.tongueLimit.value * 9.80665 } : {}),
  };
}

export function aeroOf(s: Pick<AppState, 'aero'>): { model: AeroModel; rho: number } | undefined {
  const a = s.aero;
  if (!a?.on) return undefined;
  // The side force, roll sensitivity and balance shift (generic values) also apply to an imported model that has none.
  const extra = {
    ...(a.CsA.value ? { CsA: a.CsA.value, sideCp: a.sideCp.value } : {}),
    ...(a.rollSensF.value || a.rollSensR.value ? { rollSens: { front: a.rollSensF.value, rear: a.rollSensR.value } } : {}),
    ...(a.yawBalance.value ? { yawBalance: a.yawBalance.value } : {}),
  };
  const model: AeroModel = a.file ? { ...extra, ...a.file } : { name: 'generic', CdA: a.CdA.value, ClAf: -a.downF.value, ClAr: -a.downR.value, rideHeightRef: 'absolute', dragHeight: a.dragHeight.value, ...extra };
  return { model, rho: airDensity(a.altitude.value, a.temperature.value) };
}

/** The tire grip model of an axle: the rear's own setting, or the front / both-axle model. */
export function tireGripFor(s: Pick<AppState, 'tireGrip' | 'tireFile' | 'tireFileRear'>, axle: 'front' | 'rear'): TireGrip {
  if (axle === 'rear' && s.tireFileRear) return s.tireFileRear === 'simple' ? tireGripOf(s.tireGrip) : s.tireFileRear;
  return tireGripOf(s.tireGrip, s.tireFile);
}

/** The tire grip model in use: a loaded `.tir` file, or the simple coefficients. */
export const tireGripOf = (g: Record<MFKey, Field>, file?: TirModel | null): TireGrip =>
  file ?? (Object.fromEntries(MF_KEYS.map((k) => [k, g[k].value])) as unknown as MFCoeffs);

export const gripModelOf = (g: Record<GripKey, Field>): GripModel =>
  Object.fromEntries(GRIP_KEYS.map((k) => [k, g[k].value])) as unknown as GripModel;

/** Shared components of an axle, in solver units. */
export const toAxleShared = (a: SharedDesign): AxleShared => ({
  antiRollBar: a.antiRollBar === 'wheelRate' ? { kind: 'wheelRate', rate: a.arbRate.value }
    : a.antiRollBar === 'torsionBar'
      // N·m/deg → N·mm/rad
      ? { kind: 'torsionBar', barRate: a.barRate.value * 1000 * (180 / Math.PI), lever: a.lever.value }
      : { kind: 'none' },
  heaveSpring: a.heaveSpring === 'wheelRate' ? { kind: 'wheelRate', rate: a.heaveRate.value } : { kind: 'none' },
});

const holdsFor = (s: AppState, root: CornerId): Hold[] => {
  const out: Hold[] = s.dimensions.filter((d) => d.root === root).map((d) => ({ dimension: toSpec(d) }));
  for (const arm of ['uca', 'lca'] as const) {
    for (const which of ['length', 'inclination', 'planAngle', 'frontViewAngle'] as const) {
      if (s.locks[lockKeys.derived(root, arm, which)]) out.push({ arm, which });
    }
  }
  return out;
};

export interface BuiltProblem<P> {
  problem: P;
  /** Free coordinates skipped because they're locked (or belong to a design that no longer exists). */
  skippedLocked: string[];
  /** Why it can't run yet (no goals, no variables…). */
  blockers: string[];
}

export function buildProblem(s: AppState): BuiltProblem<CornerProblem> {
  const o = setupOf(s);
  const root = rootOf(s.activeCorner, s.links);
  const geometry = toGeometry(s.geom);
  const variables: Variable[] = [];
  const skippedLocked: string[] = [];
  for (const [key, r] of Object.entries(o.ranges)) {
    // Setup values: static camber / toe (deg), the tire's set pressure (kPa).
    const sv = key.startsWith('scalar.') ? key.slice(7) : null;
    if (sv) {
      // Locked setup values (by hand, or entered in the setup wizard) stay as they are.
      const lockKey = sv === 'tirePressure' ? lockKeys.field(root, 'tire', 'pressure') : lockKeys.field(root, 'scalar', sv);
      if (s.locks[lockKey]) { skippedLocked.push(key); continue; }
      if (sv === 'staticCamber' || sv === 'staticToe' || (sv === 'tirePressure' && s.tireModel === 'gas')) variables.push({ point: sv, axis: 0, lo: r.lo.value, hi: r.hi.value });
      continue;
    }
    const cv = parseCustomVarKey(key);
    if (cv) {
      // A custom linkage's joint point (only while the design is one).
      if (s.geom.kind === 'custom' && s.geom.custom?.joints.some((j) => j.id === cv.joint)) variables.push({ point: `custom:${cv.joint}:${cv.which}`, axis: cv.axis, lo: r.lo.value, hi: r.hi.value });
      continue;
    }
    const v = parseVarKey(key);
    if (!v) continue;
    if (pointAxisLocked(s.locks, root, v.k, v.axis, s.geom.damperArm, s.geom.kind, layoutOf(s.geom), s.geom.steerMechanism, s.geom.steeredAxle)) { skippedLocked.push(key); continue; }
    variables.push({ point: STATE_KEY[v.k] as HardpointId, axis: v.axis, lo: r.lo.value, hi: r.hi.value });
  }
  const goals = GOAL_KINDS.filter((k) => o.goals[k].on).map((k) => ({ kind: k, target: o.goals[k].target.value, weight: o.goals[k].weight.value }));
  const rack = Math.abs(o.rackCheck.value);
  const model = toForceModel(s.tireModel, s.tire, s.volumeChange);
  const staticLoad = s.cornerLoadMode === 'vehicle'
    ? vehicleStaticLoads(s.vehicle, mergedCorners(s), s.links)[s.activeCorner]
    : s.spring.cornerLoad.value;
  const problem: CornerProblem = {
    geometry, droop: -Math.abs(s.droop), bump: Math.abs(s.bump), samples: 9,
    rackPositions: rack > 0 && s.settings[s.activeCorner].steered ? [-rack, rack] : [],
    rollAngle: o.rollAngle.value, wheelbase: s.vehicle.wheelbase.value, goals, variables, holds: holdsFor(s, root), keepClose: Math.max(0, o.keepClose.value), starts: o.starts ?? 1,
    ranges: (['uca', 'lca', 'tieRod'] as const).flatMap((k) => {
      const r = o.lengthRanges?.[k];
      if (!r) return [];
      const hold: Hold = k === 'tieRod' ? { dimension: { a: 'trInner', b: 'trOuter', measure: 'distance', value: 0, travel: null } } : { arm: k, which: 'length' };
      return [{ hold, lo: r.lo.value, hi: r.hi.value }];
    }),
    tire: model ? { profile: toProfile(s.geom), model, staticLoad, rollLoadFactor: o.rollLoadFactor.value, grip: gripModelOf(s.grip), tireGrip: tireGripFor(s, s.activeCorner === 'FL' || s.activeCorner === 'FR' ? 'front' : 'rear'), pressure: tirePressure(model) } : undefined,
    ...(s.settings[s.activeCorner].steered && s.geom.kind !== 'twistBeam' ? { steering: effortSpecOf(s, staticLoad) } : {}),
  };
  const blockers: string[] = [];
  if (!goals.length) blockers.push('Turn on at least one goal.');
  if (!variables.length) blockers.push(skippedLocked.length ? 'Every free coordinate is locked.' : 'Add at least one free coordinate.');
  if (goals.length && goals.every((g) => g.weight <= 0)) blockers.push('Every goal has weight 0.');
  if (!model && goals.some((g) => GOAL_META[g.kind].maximize)) blockers.push('Contact area and grip need a tire model (Tire: stiffness or air spring).');
  return { problem, skippedLocked, blockers };
}

/** The steering-effort goals' inputs: ratio at center, parking μ, pneumatic trail, the check's lateral g, the tire load. */
export function effortSpecOf(s: Pick<AppState, 'steer' | 'steerCurve'>, load: number): EffortSpec {
  return {
    cFactor: inputPerRev(0, ratioSpecOf(s)), mu: s.steer.mu.value, load,
    lateralG: s.steer.effortG.value, pneumaticTrail: s.steer.pneumaticTrail.value,
  };
}

/** Steering-effort inputs for each steered design (by root corner), with that corner's static tire load. */
function effortByDesign(s: AppState): Partial<Record<CornerId, EffortSpec>> {
  const all = mergedCorners(s);
  const loads = vehicleStaticLoads(s.vehicle, all, s.links);
  const out: Partial<Record<CornerId, EffortSpec>> = {};
  for (const { root, corners } of designRoots(s)) {
    if (all[root].geom.kind === 'twistBeam' || !corners.some((id) => s.settings[id].steered)) continue;
    out[root] = effortSpecOf(s, loads[root]);
  }
  return out;
}

/** The shimmy inputs (angles to rad, shares to fractions; the imbalance at the front rim, kg·m). */
export function shimmySpecOf(s: AppState): ShimmySpec {
  const m = s.shimmy;
  const rim = mergedCorners(s)[rootOf('FL', s.links)].geom.scalars.rimDiameter.value / 2000;
  return {
    stiffness: Math.max(1, m.shimStiffness.value), damper: Math.max(0, m.shimDamper.value), steeringWheelInertia: Math.max(1e-4, m.swInertia.value),
    handsOn: m.handsOn, maxSpeed: Math.max(5, m.shimMaxSpeed.value), imbalance: (Math.max(0, m.imbalance.value) / 1000) * rim, check: m.check,
    wear: { freePlay: (Math.max(0, m.freePlay.value) * Math.PI) / 180, stiffness: Math.max(0.01, m.wornStiffness.value / 100), damper: Math.max(0, m.wornDamper.value / 100) },
  };
}

/** The corner designs in use (root corners) and which corners share each. */
export function designRoots(s: Pick<AppState, 'links'>): { root: CornerId; corners: CornerId[] }[] {
  const roots = [...new Set(CORNER_IDS.map((id) => rootOf(id, s.links)))];
  return roots.map((root) => ({ root, corners: CORNER_IDS.filter((id) => rootOf(id, s.links) === root) }));
}

/** A design's damper for the ride model (high-speed rates and knees only for two-stage dampers). */
export function damperOf(d: { damper: Record<DamperKey, Field>; damperMode: DamperMode; damperCurve?: DamperCurveText }): DamperSpec {
  const v = (k: DamperKey) => Math.max(0, d.damper[k].value);
  const base = { bump: v('bumpDamping'), rebound: v('reboundDamping') };
  if (d.damperMode === 'curve') {
    // Dyno curves, at the clicker's position between full soft and full firm.
    const c = d.damperCurve ?? DEFAULT_DAMPER_CURVE;
    const t = c.clicks > 0 ? Math.min(1, Math.max(0, c.click / c.clicks)) : 0;
    const curve = (soft: string, firm: string) => blendCurves(parseDamperCurve(soft).pts, parseDamperCurve(firm).pts, t);
    const bump = curve(c.softBump, c.firmBump), rebound = curve(c.softRebound, c.firmRebound);
    // The low-speed slope stands in for the rate where a single rate is needed (damping ratios).
    const slope = (pts: [number, number][], fallback: number) => (pts.length ? pts[0]![1] / Math.max(pts[0]![0], 1e-6) : fallback);
    return { bump: slope(bump, base.bump), rebound: slope(rebound, base.rebound), curve: { bump, rebound } };
  }
  return d.damperMode === 'twoStage'
    ? { ...base, bumpHigh: v('bumpDampingHigh'), reboundHigh: v('reboundDampingHigh'), bumpKnee: v('bumpKnee'), reboundKnee: v('reboundKnee') }
    : base;
}

/** `caseSource` overrides the optimizer's load-case source (a test id or 'all'), e.g. for the Tests optimize loop. */
export function buildVehicleProblem(s: AppState, over: { caseSource?: string } = {}): BuiltProblem<VehicleProblem> {
  const brakes = brakesOf(s);
  const brk = brakes ? {
    limit: { front: brakes.capacity.axleForce.front, rear: brakes.capacity.axleForce.rear, maxPedal: brakes.system.maxPedalForce },
    useBias: s.brakes.useBias && Number.isFinite(brakes.capacity.bias) ? brakes.capacity.bias : undefined,
  } : null;
  const o = { ...s.vehicleOptimizer, ...(over.caseSource ? { caseSource: over.caseSource } : {}) };
  const all = mergedCorners(s);
  const roots = designRoots(s).map((r) => r.root);
  const designs: VehicleProblem['designs'] = {};
  for (const root of roots) {
    const d = all[root];
    designs[root] = {
      geometry: toGeometry(d.geom), profile: toProfile(d.geom), model: toForceModel(d.tireModel, d.tire, d.volumeChange) ?? RIGID_TIRE,
      springRate: d.spring.springRate.value, freeLength: d.spring.freeLength.value, unsprungMass: d.spring.unsprungMass.value,
      damping: damperOf(d),
      bumpStop: d.bumpStop ? { length: d.damper.bumpStopLength.value, rate: d.damper.bumpStopRate.value } : undefined,
    };
  }
  const variables: VehicleVariable[] = [];
  const skippedLocked: string[] = [];
  for (const [key, r] of Object.entries(o.ranges)) {
    const v = parseVehVarKey(key);
    if (!v) continue;
    if (!roots.includes(v.root) || pointAxisLocked(s.locks, v.root, v.k, v.axis, all[v.root].geom.damperArm, all[v.root].geom.kind, layoutOf(all[v.root].geom), all[v.root].geom.steerMechanism, all[v.root].geom.steeredAxle)) { skippedLocked.push(key); continue; }
    variables.push({ root: v.root, point: STATE_KEY[v.k] as HardpointId, axis: v.axis, lo: r.lo.value, hi: r.hi.value });
  }
  const holds: VehicleHold[] = roots.flatMap((root) => holdsFor(s, root).map((h) => ({ ...h, root })));
  const goals = VEHICLE_GOAL_KINDS.filter((k) => o.goals[k].on).map((k) => ({ kind: k, target: o.goals[k].target.value, weight: o.goals[k].weight.value }));
  const v = s.vehicle;
  const dl = (a: SharedDesign) => (a.antiRollBar === 'torsionBar' ? vec3(a.dropLink[0].value, a.dropLink[1].value, a.dropLink[2].value) : null);
  const problem: VehicleProblem = {
    designs,
    roots: Object.fromEntries(CORNER_IDS.map((id) => [id, rootOf(id, s.links)])) as Record<CornerId, CornerId>,
    settings: Object.fromEntries(CORNER_IDS.map((id) => [id, {
      brake: s.settings[id].brake, drive: s.settings[id].powered ? s.settings[id].drive : 'none', abs: s.settings[id].abs,
    }])) as VehicleProblem['settings'],
    diff: { front: s.settings.FL.diff, rear: s.settings.RL.diff },
    steering: {
      steered: Object.fromEntries(CORNER_IDS.map((id) => [id, s.settings[id].steered])),
      rackLimit: Math.abs(s.steer.rackLimit.value), cFactor: s.steer.cFactor.value, cFactorLock: s.steer.cFactorLock.value,
      ...(ratioSpecOf(s).curve ? { curve: ratioSpecOf(s).curve } : {}),
    },
    ...(goals.some((g) => VEHICLE_GOAL_META[g.kind].limit) ? { effort: effortByDesign(s) } : {}),
    ride: { rollInertia: Math.max(0.1, v.rollInertia.value), pitchInertia: Math.max(0.1, v.pitchInertia.value), yawInertia: Math.max(0.1, v.yawInertia.value), tireDamping: Math.max(0, v.tireDamping.value), relaxation: Math.max(0, v.relaxation.value) },
    mass: v.mass.value, cg: { x: v.cgX.value, height: v.cgY.value, z: v.cgZ.value }, wheelbase: v.wheelbase.value,
    rollingResistance: Math.max(0, v.rollingResistance.value), pneumaticTrail: s.steer.pneumaticTrail.value,
    shimmy: shimmySpecOf(s),
    brakeBias: brk?.useBias ?? v.brakeBias.value / 100, driveSplit: v.driveSplit.value / 100, autoPreload: s.autoPreload,
    ...(brk ? { brakeLimit: brk.limit } : {}),
    ...(brakes?.thermal ? { brakeThermal: brakes.thermal } : {}),
    ...(brakes?.detail ? { brakeDetail: { system: brakes.system, detail: brakes.detail } } : {}),
    ...(trailerOf(s) ? { trailer: trailerOf(s)! } : {}),
    shared: { front: toAxleShared(s.shared.front), rear: toAxleShared(s.shared.rear) },
    dropLinks: { front: dl(s.shared.front), rear: dl(s.shared.rear) },
    dropLinkOn: { front: s.shared.front.dropLinkOn ?? 'lca', rear: s.shared.rear.dropLinkOn ?? 'lca' },
    droop: Math.abs(s.droop), bump: Math.abs(s.bump),
    cases: {
      lateralG: Math.max(0, o.lateralG.value), brakingG: Math.max(0, o.brakingG.value), accelG: Math.max(0, o.accelG.value),
      ...(o.combinedLatG && o.combinedBrakeG ? { combined: { lateralG: Math.max(0, o.combinedLatG.value), brakingG: Math.max(0, o.combinedBrakeG.value) } } : {}),
      ...(o.caseWeights ? { weights: o.caseWeights } : {}),
    },
    states: o.caseSource && (o.caseSource === 'all' || s.tests.some((x) => x.id === o.caseSource))
      ? statesForTests(s.tests, o.caseSource, { wheelbase: v.wheelbase.value, halfTrack: Math.abs(toGeometry(all[rootOf('FL', s.links)].geom).wheel.center.x) }) : undefined,
    goals, variables, holds, aero: aeroOf(s), grip: gripModelOf(s.grip), tireGrip: tireGripFor(s, 'front'), ...(s.tireFileRear ? { tireGripRear: tireGripFor(s, 'rear') } : {}), keepClose: Math.max(0, o.keepClose.value), starts: o.starts ?? 1,
  };
  const blockers: string[] = [];
  if (!goals.length) blockers.push('Turn on at least one goal.');
  if (!variables.length) blockers.push(skippedLocked.length ? 'Every free coordinate is locked.' : 'Add at least one free coordinate.');
  if (goals.length && goals.every((g) => g.weight <= 0)) blockers.push('Every goal has weight 0.');
  const c = problem.cases;
  const anyCase = c.lateralG || c.brakingG || c.accelG || (c.combined && c.combined.lateralG && c.combined.brakingG);
  if (!problem.states?.length && !anyCase && goals.some((g) => !['geometry', 'limit'].includes(VEHICLE_GOAL_META[g.kind].uses))) {
    blockers.push('Turn on at least one load case (cornering, braking, accelerating or braking in a turn).');
  }
  return { problem, skippedLocked, blockers };
}

export type RunResult<R> = R & { status: string; iterations: number; cost0: number; cost: number };
export interface RunHandle<R> {
  stop(): void;
  done: Promise<{ result: RunResult<R>; stopped: boolean }>;
}

type Msg<R> = { type: 'progress'; info: ProgressInfo } | { type: 'done'; result: R & { lsq: { status: string; iterations: number; cost0: number; cost: number } } } | { type: 'error'; message: string };

function run<P, R>(kind: 'corner' | 'vehicle', problem: P, onProgress: (p: ProgressInfo) => void, reportAt: (x: number[] | null) => R): RunHandle<R> {
  const worker = new Worker(new URL('./optimizer.worker.ts', import.meta.url), { type: 'module' });
  let last: ProgressInfo | null = null;
  let finish: (v: Awaited<RunHandle<R>['done']>) => void = () => {};
  let fail: (e: unknown) => void = () => {};
  const done = new Promise<Awaited<RunHandle<R>['done']>>((res, rej) => { finish = res; fail = rej; });
  worker.onmessage = (e: MessageEvent) => {
    const m = e.data as Msg<R>;
    if (m.type === 'progress') { last = m.info; onProgress(m.info); return; }
    worker.terminate();
    if (m.type === 'error') { fail(new Error(m.message)); return; }
    const r = m.result;
    finish({ result: { ...r, status: r.lsq.status, iterations: r.lsq.iterations, cost0: r.lsq.cost0, cost: r.lsq.cost }, stopped: false });
  };
  worker.onerror = (e) => { worker.terminate(); fail(new Error(e.message || 'Optimizer worker failed')); };
  worker.postMessage({ kind, problem });
  return {
    done,
    stop: () => {
      worker.terminate();
      // Best point so far (or the start, if no iteration finished yet).
      const report = reportAt(last?.x ?? null);
      finish({ result: { ...report, status: 'stopped', iterations: last?.iteration ?? 0, cost0: last?.cost0 ?? NaN, cost: last?.cost ?? NaN }, stopped: true });
    },
  };
}

export const runOptimizer = (problem: CornerProblem, onProgress: (p: ProgressInfo) => void): RunHandle<CornerReport> =>
  run('corner', problem, onProgress, (x) => reportCorner(problem, x ?? problem.variables.map((v) => variableValue(problem.geometry, v))));

const runVehicleOnce = (problem: VehicleProblem, onProgress: (p: ProgressInfo) => void): RunHandle<VehicleReport> =>
  POOL_SIZE > 1 && problem.variables.length > 1
    ? runVehicleParallel(problem, onProgress)
    : run('vehicle', problem, onProgress, (x) => reportVehicle(problem, x ?? problem.variables.map((v) => variableValue(problem.designs[v.root]!.geometry, v))));

/**
 * The vehicle optimizer. With the Shimmy margin goal, a final check before the result is offered: the worn
 * kick test (real free play, imbalance) at the fastest speeds; if the wheels still wobble the margin asked
 * for goes up by 0.03 and the optimizer continues from there (at most twice).
 */
export function runVehicleOptimizer(problem: VehicleProblem, onProgress: (p: ProgressInfo) => void): RunHandle<VehicleReport> {
  if (!problem.shimmy || !problem.goals.some((g) => g.kind === 'shimmy')) return runVehicleOnce(problem, onProgress);
  let cur = runVehicleOnce(problem, onProgress);
  let stopped = false;
  const wobbles = (geoms: VehicleReport['geometries']) => [1, 0.8, 0.6].some((k) => shimmyKicks(problem, problem.shimmy!.maxSpeed * k, geoms as never)?.worn.shimmies);
  const done = (async () => {
    let q = problem;
    let out = await cur.done;
    for (let k = 0; k < 2 && !out.stopped && !stopped && wobbles(out.result.geometries); k++) {
      const geoms = out.result.geometries as Partial<Record<CornerId, import('../core/suspension/doubleWishbone').DoubleWishboneGeometry>>;
      q = {
        ...q, goals: q.goals.map((g) => (g.kind === 'shimmy' ? { ...g, target: g.target + 0.03 } : g)),
        designs: Object.fromEntries(Object.entries(q.designs).map(([r, d]) => [r, { ...d!, geometry: geoms[r as CornerId] ?? d!.geometry }])),
      };
      cur = runVehicleOnce(q, onProgress);
      const next = await cur.done;
      // Report against the original start (the moves add up).
      const rep = reportVehicle(problem, next.result.variables.map((v) => v.after));
      out = { result: { ...next.result, ...rep, shimmyRecheck: k + 1 } as RunResult<VehicleReport>, stopped: next.stopped };
    }
    return out;
  })();
  return { done, stop: () => { stopped = true; cur.stop(); } };
}

/**
 * The vehicle optimizer over a pool of workers: the search runs here (light), every point it needs is
 * evaluated in a worker (the Jacobian's columns at once, `pool.size` damping trials at once).
 */
function runVehicleParallel(problem: VehicleProblem, onProgress: (p: ProgressInfo) => void): RunHandle<VehicleReport> {
  const pool = createPool({ type: 'vehicle', problem });
  let last: ProgressInfo | null = null;
  let stopped = false;
  let finish: (v: Awaited<RunHandle<VehicleReport>['done']>) => void = () => {};
  let fail: (e: unknown) => void = () => {};
  const done = new Promise<Awaited<RunHandle<VehicleReport>['done']>>((res, rej) => { finish = res; fail = rej; });
  const steps = vehicleSteps(problem, (info) => { last = info; onProgress(info); return !stopped; }, pool.size);
  runSteps(steps, (xs) => pool.map<number[] | null>(xs.map((x) => ({ kind: 'residuals', x }))))
    .then(async (lsq) => {
      const report = await pool.run<VehicleReport>({ kind: 'report', x: lsq.x });
      pool.terminate();
      finish({ result: { ...report, lsq, status: lsq.status, iterations: lsq.iterations, cost0: lsq.cost0, cost: lsq.cost } as RunResult<VehicleReport>, stopped: false });
    })
    .catch((e: unknown) => { pool.terminate(); if (!stopped) fail(e); });
  return {
    done,
    stop: () => {
      if (stopped) return;
      stopped = true;
      pool.terminate();
      const report = reportVehicle(problem, last?.x ?? vehicleBounds(problem).x0);
      finish({ result: { ...report, status: 'stopped', iterations: last?.iteration ?? 0, cost0: last?.cost0 ?? NaN, cost: last?.cost ?? NaN }, stopped: true });
    },
  };
}

/** Run a test in the worker. */
export function runTestJob(problem: VehicleProblem, segments: SegmentSpec[], opts: TestRunOptions): { done: Promise<TestRun>; cancel(): void } {
  const worker = new Worker(new URL('./optimizer.worker.ts', import.meta.url), { type: 'module' });
  const done = new Promise<TestRun>((res, rej) => {
    worker.onmessage = (e: MessageEvent) => {
      const m = e.data as { type: 'done'; result: TestRun } | { type: 'error'; message: string };
      worker.terminate();
      if (m.type === 'error') rej(new Error(m.message)); else res(m.result);
    };
    worker.onerror = (e) => { worker.terminate(); rej(new Error(e.message || 'Test worker failed')); };
  });
  worker.postMessage({ kind: 'test', problem, segments, opts });
  return { done, cancel: () => worker.terminate() };
}

/** Compute playback frames in the worker (`ride`: over time, Phase B, `handling`: steered by a driver, Phase C; otherwise steady states). */
export function runPlaybackJob(problem: VehicleProblem, segments: SegmentSpec[], ride = false, handling = false, driverSpeed = false): { done: Promise<PlaybackFrame[]>; cancel(): void } {
  const worker = new Worker(new URL('./optimizer.worker.ts', import.meta.url), { type: 'module' });
  const done = new Promise<PlaybackFrame[]>((res, rej) => {
    worker.onmessage = (e: MessageEvent) => {
      const m = e.data as { type: 'done'; result: PlaybackFrame[] } | { type: 'error'; message: string };
      worker.terminate();
      if (m.type === 'error') rej(new Error(m.message)); else res(m.result);
    };
    worker.onerror = (e) => { worker.terminate(); rej(new Error(e.message || 'Playback worker failed')); };
  });
  worker.postMessage({ kind: 'playback', problem, segments, ride, handling, driverSpeed });
  return { done, cancel: () => worker.terminate() };
}

/** A worker job with progress messages; stop() ends it (the caller keeps the last progress). */
function progressJob<R, P>(msg: unknown, onProgress: (p: P) => void): { done: Promise<R>; stop(): void } {
  const worker = new Worker(new URL('./optimizer.worker.ts', import.meta.url), { type: 'module' });
  let finish: (r: R) => void = () => {};
  let fail: (e: unknown) => void = () => {};
  const done = new Promise<R>((res, rej) => { finish = res; fail = rej; });
  worker.onmessage = (e: MessageEvent) => {
    const m = e.data as { type: 'progress'; info: P } | { type: 'done'; result: R } | { type: 'error'; message: string };
    if (m.type === 'progress') { onProgress(m.info); return; }
    worker.terminate();
    if (m.type === 'error') fail(new Error(m.message)); else finish(m.result);
  };
  worker.onerror = (e) => { worker.terminate(); fail(new Error(e.message || 'Worker failed')); };
  worker.postMessage(msg);
  return { done, stop: () => { worker.terminate(); fail(new Error('stopped')); } };
}

/** What matters most (DOE sensitivity) for a vehicle problem, in the worker. */
export function runSensitivityJob(problem: VehicleProblem, samples: number, onProgress: (p: { sample: number; of: number }) => void): { done: Promise<VehicleSensitivity | null>; stop(): void } {
  if (POOL_SIZE < 2) return progressJob<VehicleSensitivity | null, { sample: number; of: number }>({ kind: 'sensitivity', problem, samples }, onProgress);
  // Every DOE sample in its own task, over the pool.
  const pool = createPool({ type: 'vehicle', problem });
  const { us, xs } = sensitivityPlan(problem, samples);
  let n = 0;
  const done = Promise.all(xs.map((x) => pool.run<SensitivitySample>({ kind: 'sensitivity', x }).then((r) => { onProgress({ sample: ++n, of: xs.length }); return r; })))
    .then((out) => sensitivityResult(problem, us, out))
    .finally(() => pool.terminate());
  return { done, stop: () => pool.terminate() };
}

/** Tune springs / dampers / bars on the ride (Bayesian optimization), in the worker. */
export function runRatesJob(problem: VehicleProblem, tests: RateTest[], vars: RateVar[], budget: number, mode: 'pass' | 'improve', onProgress: (p: RateProgress) => void): { done: Promise<RateResult>; stop(): void } {
  if (POOL_SIZE < 2) return progressJob<RateResult, RateProgress>({ kind: 'rates', problem, tests, vars, budget, mode }, onProgress);
  // Bayesian batches of rate sets ("constant liar"), one set per worker at a time.
  const pool = createPool({ type: 'rates', problem, tests, vars, mode });
  let stopped = false;
  const steps = rateSteps(vars, { budget, batch: pool.size }, (i) => { onProgress(i); return !stopped; });
  const done = runSteps(steps, (xs) => pool.map<number[]>(xs.map((x) => ({ kind: 'score', x })))).finally(() => pool.terminate());
  return { done, stop: () => { stopped = true; pool.terminate(); } };
}

/** Fit a tire model to measured data, in the worker. */
export const runTireFitJob = (samples: TireSample[], name: string, onProgress: (p: { stage: string; iteration: number }) => void, unloadedRadius?: number) =>
  progressJob<TireFitResult, { stage: string; iteration: number }>({ kind: 'tirefit', samples, name, ...(unloadedRadius ? { unloadedRadius } : {}) }, onProgress);
