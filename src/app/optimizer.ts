/**
 * App side of the corner optimizer: turns the active corner's setup (free coordinates + ranges, goals,
 * locks) into a CornerProblem, and runs it in a Web Worker so the UI stays responsive.
 */
import {
  GOAL_KINDS, type CornerProblem, type CornerOptimizeResult, type CornerReport, type HardpointId, type ProgressInfo, type Variable, type Hold,
} from '../core/optimize/corner';
import { reportCorner, variableValue } from '../core/optimize/corner';
import { POINT_KEYS, rootOf, toGeometry, defaultOptimizerSetup, type AppState, type PointKey, type OptimizerSetup } from './store';
import { STATE_KEY } from './anchors';
import { lockKeys, pointAxisLocked } from './locks';

const AXES = ['x', 'y', 'z'] as const;
export const varKey = (k: PointKey, axis: 0 | 1 | 2) => `${k}.${AXES[axis]}`;
export function parseVarKey(key: string): { k: PointKey; axis: 0 | 1 | 2 } | null {
  const [k, a] = key.split('.');
  const axis = AXES.indexOf(a as 'x');
  return (POINT_KEYS as readonly string[]).includes(k!) && axis >= 0 ? { k: k as PointKey, axis: axis as 0 | 1 | 2 } : null;
}
const POINT_OF: Record<HardpointId, PointKey> = Object.fromEntries(
  Object.entries(STATE_KEY).map(([pk, hp]) => [hp, pk]),
) as Record<HardpointId, PointKey>;
export const pointKeyOf = (id: HardpointId): PointKey => POINT_OF[id];

export const setupOf = (s: AppState): OptimizerSetup => s.optimizer[rootOf(s.activeCorner, s.links)] ?? defaultOptimizerSetup();

export interface BuiltProblem {
  problem: CornerProblem;
  /** Free coordinates skipped because they're locked. */
  skippedLocked: string[];
  /** Why it can't run yet (no goals, no variables…). */
  blockers: string[];
}

export function buildProblem(s: AppState): BuiltProblem {
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
  const holds: Hold[] = [];
  for (const arm of ['uca', 'lca'] as const) {
    for (const which of ['length', 'inclination', 'planAngle'] as const) {
      if (s.locks[lockKeys.derived(root, arm, which)]) holds.push({ arm, which });
    }
  }
  const goals = GOAL_KINDS.filter((k) => o.goals[k].on).map((k) => ({ kind: k, target: o.goals[k].target.value, weight: o.goals[k].weight.value }));
  const rack = Math.abs(o.rackCheck.value);
  const problem: CornerProblem = {
    geometry, droop: -Math.abs(s.droop), bump: Math.abs(s.bump), samples: 9,
    rackPositions: rack > 0 && s.settings[s.activeCorner].steered ? [-rack, rack] : [],
    rollAngle: o.rollAngle.value, goals, variables, holds, keepClose: Math.max(0, o.keepClose.value),
  };
  const blockers: string[] = [];
  if (!goals.length) blockers.push('Turn on at least one goal.');
  if (!variables.length) blockers.push(skippedLocked.length ? 'Every free coordinate is locked.' : 'Add at least one free coordinate.');
  if (goals.length && goals.every((g) => g.weight <= 0)) blockers.push('Every goal has weight 0.');
  return { problem, skippedLocked, blockers };
}

export interface RunHandle {
  stop(): void;
  done: Promise<{ result: CornerReport & { status: string; iterations: number; cost0: number; cost: number }; stopped: boolean }>;
}

/** Run in a worker. Stop keeps the best point found so far. */
export function runOptimizer(problem: CornerProblem, onProgress: (p: ProgressInfo) => void): RunHandle {
  const worker = new Worker(new URL('./optimizer.worker.ts', import.meta.url), { type: 'module' });
  let last: ProgressInfo | null = null;
  let finish: (v: Awaited<RunHandle['done']>) => void = () => {};
  let fail: (e: unknown) => void = () => {};
  const done = new Promise<Awaited<RunHandle['done']>>((res, rej) => { finish = res; fail = rej; });
  worker.onmessage = (e: MessageEvent) => {
    const m = e.data as { type: 'progress'; info: ProgressInfo } | { type: 'done'; result: CornerOptimizeResult } | { type: 'error'; message: string };
    if (m.type === 'progress') { last = m.info; onProgress(m.info); return; }
    worker.terminate();
    if (m.type === 'error') { fail(new Error(m.message)); return; }
    const r = m.result;
    finish({ result: { ...r, status: r.lsq.status, iterations: r.lsq.iterations, cost0: r.lsq.cost0, cost: r.lsq.cost }, stopped: false });
  };
  worker.onerror = (e) => { worker.terminate(); fail(new Error(e.message || 'Optimizer worker failed')); };
  worker.postMessage(problem);
  return {
    done,
    stop: () => {
      worker.terminate();
      // Best point so far (or the start, if no iteration finished yet).
      const x = last?.x ?? problem.variables.map((v) => variableValue(problem.geometry, v));
      const report = reportCorner(problem, x);
      finish({ result: { ...report, status: 'stopped', iterations: last?.iteration ?? 0, cost0: last?.cost0 ?? NaN, cost: last?.cost ?? NaN }, stopped: true });
    },
  };
}
