/// <reference lib="webworker" />
/** Runs an optimizer (corner or whole vehicle) off the main thread; posts progress after every iteration. */
import { optimizeCorner, type CornerProblem } from '../core/optimize/corner';
import { optimizeVehicle, type VehicleProblem } from '../core/optimize/vehicle';

type Job = { kind: 'corner'; problem: CornerProblem } | { kind: 'vehicle'; problem: VehicleProblem };

self.onmessage = (e: MessageEvent<Job>) => {
  try {
    const progress = (info: unknown) => { self.postMessage({ type: 'progress', info }); };
    const result = e.data.kind === 'vehicle' ? optimizeVehicle(e.data.problem, progress) : optimizeCorner(e.data.problem, progress);
    self.postMessage({ type: 'done', result });
  } catch (err) {
    self.postMessage({ type: 'error', message: err instanceof Error ? err.message : String(err) });
  }
};
