/// <reference lib="webworker" />
/** Runs optimizers (corner / whole vehicle) and tests off the main thread; posts progress after every iteration. */
import { optimizeCorner, type CornerProblem } from '../core/optimize/corner';
import { optimizeVehicle, type VehicleProblem } from '../core/optimize/vehicle';
import { runTest, playbackFrames, type TestRunOptions } from '../core/tests/run';
import type { SegmentSpec } from '../core/tests/segments';

type Job =
  | { kind: 'corner'; problem: CornerProblem }
  | { kind: 'vehicle'; problem: VehicleProblem }
  | { kind: 'test'; problem: VehicleProblem; segments: SegmentSpec[]; opts: TestRunOptions }
  | { kind: 'playback'; problem: VehicleProblem; segments: SegmentSpec[] };

self.onmessage = (e: MessageEvent<Job>) => {
  try {
    const j = e.data;
    if (j.kind === 'playback') {
      const geometries = Object.fromEntries(Object.entries(j.problem.designs).map(([r, d]) => [r, d!.geometry]));
      self.postMessage({ type: 'done', result: playbackFrames(j.problem, geometries, j.segments) });
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
