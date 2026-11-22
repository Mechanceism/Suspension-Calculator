/// <reference lib="webworker" />
/** Runs optimizers (corner / whole vehicle) and tests off the main thread; posts progress after every iteration. */
import { optimizeCorner, type CornerProblem } from '../core/optimize/corner';
import { optimizeVehicle, vehicleSensitivity, type VehicleProblem } from '../core/optimize/vehicle';
import { tuneRates, type RateVar, type RateTest } from '../core/optimize/rates';
import { fitTire, type TireSample } from '../core/tire/fit';
import { runTest, playbackFrames, type TestRunOptions } from '../core/tests/run';
import { rideRun } from '../core/tests/ride';
import type { SegmentSpec } from '../core/tests/segments';

type Job =
  | { kind: 'corner'; problem: CornerProblem }
  | { kind: 'vehicle'; problem: VehicleProblem }
  | { kind: 'test'; problem: VehicleProblem; segments: SegmentSpec[]; opts: TestRunOptions }
  | { kind: 'playback'; problem: VehicleProblem; segments: SegmentSpec[]; ride?: boolean }
  | { kind: 'sensitivity'; problem: VehicleProblem; samples: number }
  | { kind: 'tirefit'; samples: TireSample[]; name: string }
  | { kind: 'rates'; problem: VehicleProblem; tests: RateTest[]; vars: RateVar[]; budget: number; mode: 'pass' | 'improve' };

self.onmessage = (e: MessageEvent<Job>) => {
  try {
    const j = e.data;
    if (j.kind === 'playback') {
      const geometries = Object.fromEntries(Object.entries(j.problem.designs).map(([r, d]) => [r, d!.geometry]));
      self.postMessage({ type: 'done', result: j.ride ? rideRun(j.problem, geometries, j.segments).frames : playbackFrames(j.problem, geometries, j.segments) });
      return;
    }
    if (j.kind === 'tirefit') {
      const r = fitTire(j.samples, { name: j.name }, (stage, iteration) => { self.postMessage({ type: 'progress', info: { stage, iteration } }); });
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
