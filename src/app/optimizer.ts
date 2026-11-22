/**
 * App side of the optimizers: turns the setups (free coordinates + ranges, goals, locks) into a
 * CornerProblem or a VehicleProblem, and runs them in a Web Worker so the UI stays responsive.
 */
import {
  GOAL_KINDS, GOAL_META, reportCorner, variableValue,
  type CornerProblem, type CornerReport, type HardpointId, type ProgressInfo, type Variable, type Hold,
} from '../core/optimize/corner';
import {
  VEHICLE_GOAL_KINDS, reportVehicle,
  type VehicleProblem, type VehicleReport, type VehicleVariable, type VehicleHold,
} from '../core/optimize/vehicle';
import type { GripModel } from '../core/tire/grip';
import type { MFCoeffs, TireGrip } from '../core/tire/magicFormula';
import type { TirModel } from '../core/tire/tir';
import { airDensity, type AeroModel } from '../core/vehicle/aero';
import type { TireSample, TireFitResult } from '../core/tire/fit';
import type { TireForceModel } from '../core/tire/model';
import { CORNER_IDS, tirePressure, type AxleShared, type CornerId, type DamperSpec } from '../core/vehicle/vehicle';
import { vec3 } from '../core/math/vec3';
import {
  POINT_KEYS, rootOf, toGeometry, toProfile, toForceModel, mergedCorners, vehicleStaticLoads, defaultOptimizerSetup, GRIP_KEYS, MF_KEYS,
  type AppState, type PointKey, type OptimizerSetup, type SharedDesign, type GripKey, type MFKey, type Field, type DamperKey, type DamperMode,
} from './store';
import { STATE_KEY } from './anchors';
import { lockKeys, pointAxisLocked } from './locks';
import { toSpec } from './heldDimensions';
import type { SegmentSpec } from '../core/tests/segments';
import type { TestRun, TestRunOptions, PlaybackFrame } from '../core/tests/run';
import type { VehicleSensitivity } from '../core/optimize/vehicle';
import type { RateVar, RateTest, RateProgress, RateResult } from '../core/optimize/rates';
import { statesForTests } from './tests';

const AXES = ['x', 'y', 'z'] as const;
export const varKey = (k: PointKey, axis: 0 | 1 | 2) => `${k}.${AXES[axis]}`;
export function parseVarKey(key: string): { k: PointKey; axis: 0 | 1 | 2 } | null {
  const [k, a] = key.split('.');
  const axis = AXES.indexOf(a as 'x');
  return (POINT_KEYS as readonly string[]).includes(k!) && axis >= 0 ? { k: k as PointKey, axis: axis as 0 | 1 | 2 } : null;
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
export function aeroOf(s: Pick<AppState, 'aero'>): { model: AeroModel; rho: number } | undefined {
  const a = s.aero;
  if (!a?.on) return undefined;
  const model: AeroModel = a.file ?? { name: 'generic', CdA: a.CdA.value, ClAf: -a.downF.value, ClAr: -a.downR.value, rideHeightRef: 'absolute', dragHeight: a.dragHeight.value };
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
    const v = parseVarKey(key);
    if (!v) continue;
    if (pointAxisLocked(s.locks, root, v.k, v.axis, s.geom.damperArm)) { skippedLocked.push(key); continue; }
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
    rollAngle: o.rollAngle.value, goals, variables, holds: holdsFor(s, root), keepClose: Math.max(0, o.keepClose.value), starts: o.starts ?? 1,
    tire: model ? { profile: toProfile(s.geom), model, staticLoad, rollLoadFactor: o.rollLoadFactor.value, grip: gripModelOf(s.grip), tireGrip: tireGripFor(s, s.activeCorner === 'FL' || s.activeCorner === 'FR' ? 'front' : 'rear'), pressure: tirePressure(model) } : undefined,
  };
  const blockers: string[] = [];
  if (!goals.length) blockers.push('Turn on at least one goal.');
  if (!variables.length) blockers.push(skippedLocked.length ? 'Every free coordinate is locked.' : 'Add at least one free coordinate.');
  if (goals.length && goals.every((g) => g.weight <= 0)) blockers.push('Every goal has weight 0.');
  if (!model && goals.some((g) => GOAL_META[g.kind].maximize)) blockers.push('Contact area and grip need a tire model (Tire: stiffness or air spring).');
  return { problem, skippedLocked, blockers };
}

/** The corner designs in use (root corners) and which corners share each. */
export function designRoots(s: Pick<AppState, 'links'>): { root: CornerId; corners: CornerId[] }[] {
  const roots = [...new Set(CORNER_IDS.map((id) => rootOf(id, s.links)))];
  return roots.map((root) => ({ root, corners: CORNER_IDS.filter((id) => rootOf(id, s.links) === root) }));
}

/** A design's damper for the ride model (high-speed rates and knees only for two-stage dampers). */
export function damperOf(d: { damper: Record<DamperKey, Field>; damperMode: DamperMode }): DamperSpec {
  const v = (k: DamperKey) => Math.max(0, d.damper[k].value);
  const base = { bump: v('bumpDamping'), rebound: v('reboundDamping') };
  return d.damperMode === 'twoStage'
    ? { ...base, bumpHigh: v('bumpDampingHigh'), reboundHigh: v('reboundDampingHigh'), bumpKnee: v('bumpKnee'), reboundKnee: v('reboundKnee') }
    : base;
}

/** `caseSource` overrides the optimizer's load-case source (a test id or 'all'), e.g. for the Tests optimize loop. */
export function buildVehicleProblem(s: AppState, over: { caseSource?: string } = {}): BuiltProblem<VehicleProblem> {
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
    if (!roots.includes(v.root) || pointAxisLocked(s.locks, v.root, v.k, v.axis, all[v.root].geom.damperArm)) { skippedLocked.push(key); continue; }
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
      rackLimit: Math.abs(s.steer.rackLimit.value), cFactor: s.steer.cFactor.value,
    },
    ride: { rollInertia: Math.max(0.1, v.rollInertia.value), pitchInertia: Math.max(0.1, v.pitchInertia.value), tireDamping: Math.max(0, v.tireDamping.value) },
    mass: v.mass.value, cg: { x: v.cgX.value, height: v.cgY.value, z: v.cgZ.value }, wheelbase: v.wheelbase.value,
    brakeBias: v.brakeBias.value / 100, driveSplit: v.driveSplit.value / 100, autoPreload: s.autoPreload,
    shared: { front: toAxleShared(s.shared.front), rear: toAxleShared(s.shared.rear) },
    dropLinks: { front: dl(s.shared.front), rear: dl(s.shared.rear) },
    droop: Math.abs(s.droop), bump: Math.abs(s.bump),
    cases: { lateralG: Math.max(0, o.lateralG.value), brakingG: Math.max(0, o.brakingG.value), accelG: Math.max(0, o.accelG.value) },
    states: o.caseSource && (o.caseSource === 'all' || s.tests.some((x) => x.id === o.caseSource))
      ? statesForTests(s.tests, o.caseSource, { wheelbase: v.wheelbase.value, halfTrack: Math.abs(toGeometry(all[rootOf('FL', s.links)].geom).wheel.center.x) }) : undefined,
    goals, variables, holds, aero: aeroOf(s), grip: gripModelOf(s.grip), tireGrip: tireGripFor(s, 'front'), ...(s.tireFileRear ? { tireGripRear: tireGripFor(s, 'rear') } : {}), keepClose: Math.max(0, o.keepClose.value), starts: o.starts ?? 1,
  };
  const blockers: string[] = [];
  if (!goals.length) blockers.push('Turn on at least one goal.');
  if (!variables.length) blockers.push(skippedLocked.length ? 'Every free coordinate is locked.' : 'Add at least one free coordinate.');
  if (goals.length && goals.every((g) => g.weight <= 0)) blockers.push('Every goal has weight 0.');
  const c = problem.cases;
  if (!problem.states?.length && !c.lateralG && !c.brakingG && !c.accelG && goals.some((g) => !['antiDive', 'antiSquat', 'bumpSteer'].includes(g.kind))) {
    blockers.push('Turn on at least one load case (cornering, braking or accelerating).');
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

export const runVehicleOptimizer = (problem: VehicleProblem, onProgress: (p: ProgressInfo) => void): RunHandle<VehicleReport> =>
  run('vehicle', problem, onProgress, (x) => reportVehicle(problem, x ?? problem.variables.map((v) => variableValue(problem.designs[v.root]!.geometry, v))));

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

/** Compute playback frames in the worker (`ride`: over time, Phase B; otherwise steady states). */
export function runPlaybackJob(problem: VehicleProblem, segments: SegmentSpec[], ride = false): { done: Promise<PlaybackFrame[]>; cancel(): void } {
  const worker = new Worker(new URL('./optimizer.worker.ts', import.meta.url), { type: 'module' });
  const done = new Promise<PlaybackFrame[]>((res, rej) => {
    worker.onmessage = (e: MessageEvent) => {
      const m = e.data as { type: 'done'; result: PlaybackFrame[] } | { type: 'error'; message: string };
      worker.terminate();
      if (m.type === 'error') rej(new Error(m.message)); else res(m.result);
    };
    worker.onerror = (e) => { worker.terminate(); rej(new Error(e.message || 'Playback worker failed')); };
  });
  worker.postMessage({ kind: 'playback', problem, segments, ride });
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
export const runSensitivityJob = (problem: VehicleProblem, samples: number, onProgress: (p: { sample: number; of: number }) => void) =>
  progressJob<VehicleSensitivity | null, { sample: number; of: number }>({ kind: 'sensitivity', problem, samples }, onProgress);

/** Tune springs / dampers / bars on the ride (Bayesian optimization), in the worker. */
export const runRatesJob = (problem: VehicleProblem, tests: RateTest[], vars: RateVar[], budget: number, mode: 'pass' | 'improve', onProgress: (p: RateProgress) => void) =>
  progressJob<RateResult, RateProgress>({ kind: 'rates', problem, tests, vars, budget, mode }, onProgress);

/** Fit a tire model to measured data, in the worker. */
export const runTireFitJob = (samples: TireSample[], name: string, onProgress: (p: { stage: string; iteration: number }) => void) =>
  progressJob<TireFitResult, { stage: string; iteration: number }>({ kind: 'tirefit', samples, name }, onProgress);
