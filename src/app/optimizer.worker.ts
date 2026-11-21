/// <reference lib="webworker" />
/** Runs the corner optimizer off the main thread; posts progress after every iteration. */
import { optimizeCorner, type CornerProblem } from '../core/optimize/corner';

self.onmessage = (e: MessageEvent<CornerProblem>) => {
  try {
    const result = optimizeCorner(e.data, (info) => { self.postMessage({ type: 'progress', info }); });
    self.postMessage({ type: 'done', result });
  } catch (err) {
    self.postMessage({ type: 'error', message: err instanceof Error ? err.message : String(err) });
  }
};
