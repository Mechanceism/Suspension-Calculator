/// <reference lib="webworker" />
/** Runs optimizers (corner / whole vehicle) and tests off the main thread; posts progress after every iteration. */
import { optimizeCorner, type CornerProblem } from '../core/optimize/corner';
import { optimizeVehicle, vehicleSensitivity, vehicleObjective, reportVehicle, sensitivitySample, assembleVehicle, vehicleInputOf, type VehicleProblem } from '../core/optimize/vehicle';
import { rolloverStats } from '../core/vehicle/rollover';
import { tuneRates, scoreTests, withRates, type RateVar, type RateTest } from '../core/optimize/rates';
import type { PoolContext, PoolTask } from './workerPool';
import { fitTire, type TireSample } from '../core/tire/fit';
import { runTest, playbackFrames, withBrakeTemps, type TestRunOptions } from '../core/tests/run';
import { rideRun } from '../core/tests/ride';
import type { SegmentSpec } from '../core/tests/segments';

type Job =
  | { kind: 'corner'; problem: CornerProblem }
  | { kind: 'vehicle'; problem: VehicleProblem }
  | { kind: 'test'; problem: VehicleProblem; segments: SegmentSpec[]; opts: TestRunOptions }
  | { kind: 'playback'; problem: VehicleProblem; segments: SegmentSpec[]; ride?: boolean; handling?: boolean; driverSpeed?: boolean }
  | { kind: 'sensitivity'; problem: VehicleProblem; samples: number }
  | { kind: 'tirefit'; samples: TireSample[]; name: string; unloadedRadius?: number }
  | { kind: 'rates'; problem: VehicleProblem; tests: RateTest[]; vars: RateVar[]; budget: number; mode: 'pass' | 'improve' }
  | { kind: 'rollover'; problem: VehicleProblem };

// Pool worker (workerPool.ts): one context, then many small tasks.
let pool: { ctx: PoolContext; obj?: ReturnType<typeof vehicleObjective> } | null = null;
function poolTask(t: PoolTask): unknown {
  if (!pool) throw new Error('Pool worker has no context');
  const c = pool.ctx;
  if (c.type === 'rates') {
    const p = c.problem as VehicleProblem;
    return [scoreTests(withRates(p, c.vars as RateVar[], t.x), c.tests as RateTest[], c.mode).score];
  }
  const p = c.problem as VehicleProblem;
  if (t.kind === 'report') return reportVehicle(p, t.x);
  pool.obj ??= vehicleObjective(p);
  if (t.kind === 'sensitivity') return sensitivitySample(p, pool.obj, t.x);
  return pool.obj.residuals(t.x);
}

self.onmessage = (e: MessageEvent<Job | { kind: 'pool-init'; ctx: PoolContext } | { kind: 'pool-task'; task: PoolTask }>) => {
  try {
    const m = e.data;
    if (m.kind === 'pool-init') { pool = { ctx: m.ctx }; return; }
    if (m.kind === 'pool-task') { self.postMessage({ type: 'pool-result', result: poolTask(m.task) }); return; }
    const j = m;
    if (j.kind === 'playback') {
      const geometries = Object.fromEntries(Object.entries(j.problem.designs).map(([r, d]) => [r, d!.geometry]));
      self.postMessage({ type: 'done', result: j.ride ? withBrakeTemps(j.problem, rideRun(j.problem, geometries, j.segments, { handling: !!j.handling, driverSpeed: !!j.driverSpeed }).frames) : playbackFrames(j.problem, geometries, j.segments) });
      return;
    }
    if (j.kind === 'tirefit') {
      const r = fitTire(j.samples, { name: j.name, ...(j.unloadedRadius ? { unloadedRadius: j.unloadedRadius } : {}) }, (stage, iteration) => { self.postMessage({ type: 'progress', info: { stage, iteration } }); });
      self.postMessage({ type: 'done', result: r });
      return;
    }
    if (j.kind === 'sensitivity') {
      const r = vehicleSensitivity(j.problem, j.samples, (k, n) => { self.postMessage({ type: 'progress', info: { sample: k, of: n } }); });
      self.postMessage({ type: 'done', result: r });
      return;
    }
    if (j.kind === 'rates') {
      const r = tuneRates(j.problem, j.tests, j.vars, { budget: j.budget, mode: j.mode }, (info) => { self.postMessage({ type: 'progress', info }); });
      self.postMessage({ type: 'done', result: r });
      return;
    }
    if (j.kind === 'rollover') {
      const geometries = Object.fromEntries(Object.entries(j.problem.designs).map(([r, d]) => [r, d!.geometry]));
      const asm = assembleVehicle(j.problem, geometries);
      self.postMessage({ type: 'done', result: asm ? rolloverStats(vehicleInputOf(j.problem, asm, { lateralG: 0, brakingG: 0, accelG: 0 }), j.problem.ride?.rollInertia ?? 0) : null });
      return;
    }
    if (j.kind === 'test') {
      const geometries = Object.fromEntries(Object.entries(j.problem.designs).map(([r, d]) => [r, d!.geometry]));
      self.postMessage({ type: 'done', result: runTest(j.problem, geometries, j.segments, j.opts) });
      return;
    }
    const progress = (info: unknown) => { self.postMessage({ type: 'progress', info }); };
    const result = j.kind === 'vehicle' ? optimizeVehicle(j.problem, progress) : optimizeCorner(j.problem, progress);
    self.postMessage({ type: 'done', result });
  } catch (err) {
    self.postMessage({ type: 'error', message: err instanceof Error ? err.message : String(err) });
  }
};
