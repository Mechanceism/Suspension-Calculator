/**
 * Compare (R9): the current design (A) and a snapshot (B) run in the current app on both sets of tests —
 * model A / B on tests A / B, the four pairings — so the two are always comparable (the snapshot's saved
 * scores are shown beside them as its "last run"). A test both sets have (the same track: segments,
 * speeds, options) is run once per model.
 */
import { create } from 'zustand';
import { useApp, pickDesign, type AppState, type DesignState } from './store';
import { buildVehicleProblem, runTestJob } from './optimizer';
import { planOption, segmentSpec, driverSpeedOf, type TestDesign } from './tests';
import { POOL_SIZE, runLimited } from './workerPool';
import { withDesign } from './designOverride';
import { serializeProject } from './project';
import type { TestRun } from '../core/tests/run';
import type { Snapshot } from './snapshots';

export type Side = 'A' | 'B';
/** One test row of the comparison: from tests A, tests B, or both (the same track). */
export interface CompareTest { key: string; name: string; from: Side | 'both'; a?: TestDesign; b?: TestDesign }

/** What makes two tests the same track (not their id, name, rank or whether they are ticked). */
const trackOf = (t: TestDesign) => {
  const { id: _i, name: _n, rank: _r, enabled: _e, segments, ...rest } = t;
  return canonical({ ...rest, segments: segments.map(({ id: _s, ...sg }) => sg) });
};
/** JSON with the keys sorted (a test read back from a file may list them in another order); undefined left out. */
function canonical(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(canonical).join(',')}]`;
  if (v && typeof v === 'object') return `{${Object.keys(v).filter((k) => (v as Record<string, unknown>)[k] !== undefined).sort().map((k) => `${JSON.stringify(k)}:${canonical((v as Record<string, unknown>)[k])}`).join(',')}}`;
  return JSON.stringify(v) ?? 'null';
}

/** The tests to compare on: the enabled tests of each design, one row for a track both have. */
export function compareTests(testsA: TestDesign[], testsB: TestDesign[]): CompareTest[] {
  const on = (ts: TestDesign[]) => ts.filter((t) => t.enabled !== false);
  const rows: CompareTest[] = on(testsA).map((a) => ({ key: `A:${a.id}`, name: a.name, from: 'A' as const, a }));
  for (const b of on(testsB)) {
    const same = rows.find((r) => r.a && !r.b && trackOf(r.a) === trackOf(b));
    if (same) { same.b = b; same.from = 'both'; if (same.name !== b.name) same.name = `${same.name} / ${b.name}`; }
    else rows.push({ key: `B:${b.id}`, name: b.name, from: 'B', b });
  }
  return rows;
}

/** A design value that differs: where it is (readable path) and its text in each design. */
export interface DesignDiff { path: string; a: string; b: string }
/** Not the car: file bookkeeping, the optimizer setups, locks, the wizard, held dimensions, the sweep settings. */
const NOT_THE_CAR = new Set(['format', 'formatVersion', 'appVersion', 'name', 'savedAt', 'units', 'activeCorner', 'optimizer', 'vehicleOptimizer', 'locks', 'wizardLocks', 'setupStatus', 'dimensions', 'motion', 'presetId', 'tests', 'results']);
/** Containers left out of the paths (they only group values). */
const SILENT = new Set(['fields']);

/** The model's values that differ between two designs (their files' model parts compared value by value). */
export function designDifferences(a: DesignState, b: DesignState): DesignDiff[] {
  const fa = serializeProject(a, '', { tests: false }) as unknown as Record<string, unknown>;
  const fb = serializeProject(b, '', { tests: false }) as unknown as Record<string, unknown>;
  const out: DesignDiff[] = [];
  const isField = (v: unknown): v is { text?: string; value?: number } => typeof v === 'object' && v !== null && !Array.isArray(v) && 'value' in v && ('text' in v || Object.keys(v).length <= 2);
  const show = (v: unknown): string => (v === undefined ? '—' : isField(v) ? (v.text?.trim() ? v.text : String(v.value)) : typeof v === 'object' && v !== null ? JSON.stringify(v).slice(0, 60) : String(v));
  const same = (x: unknown, y: unknown) => (isField(x) && isField(y) ? x.value === y.value : JSON.stringify(x) === JSON.stringify(y));
  const walk = (x: unknown, y: unknown, path: string[]) => {
    if (same(x, y)) return;
    const objs = typeof x === 'object' && x !== null && typeof y === 'object' && y !== null && !isField(x) && !isField(y) && Array.isArray(x) === Array.isArray(y);
    if (objs) {
      const keys = [...new Set([...Object.keys(x as object), ...Object.keys(y as object)])];
      for (const k of keys) walk((x as Record<string, unknown>)[k], (y as Record<string, unknown>)[k], SILENT.has(k) ? path : [...path, k]);
      return;
    }
    out.push({ path: path.join(' › '), a: show(x), b: show(y) });
  };
  for (const k of [...new Set([...Object.keys(fa), ...Object.keys(fb)])]) if (!NOT_THE_CAR.has(k)) walk(fa[k], fb[k], [k]);
  return out;
}

interface CompareState {
  /** The snapshot these runs are for (and the design A they ran on). */
  snapshotId: string | null;
  running: boolean;
  done: number;
  total: number;
  /** Runs by `${row key}|${model}`. */
  runs: Record<string, TestRun>;
  rows: CompareTest[];
  error: string | null;
  /** The current design they ran on (stale once it changes). */
  from: DesignState | null;
  cancel: (() => void) | null;
}
export const useCompare = create<CompareState>(() => ({ snapshotId: null, running: false, done: 0, total: 0, runs: {}, rows: [], error: null, from: null, cancel: null }));
export const runKey = (row: CompareTest, model: Side) => `${row.key}|${model}`;

/** The app state with model B in place of the current one (the sliders and settings as they are). */
const stateFor = (s: AppState, model: Side, snap: Snapshot): AppState => (model === 'A' ? s : withDesign(s, snap.design));

/** Run both models on every row's test (its own copy for each side: a test both have runs as tests A's). */
export async function runCompare(snap: Snapshot): Promise<void> {
  useCompare.getState().cancel?.();
  const s = useApp.getState();
  const rows = compareTests(s.tests, snap.design.tests);
  const jobs = rows.flatMap((row) => (['A', 'B'] as const).map((model) => ({ row, model, test: (row.a ?? row.b)! })));
  let stopped = false;
  const cancels = new Set<() => void>();
  useCompare.setState({ snapshotId: snap.id, running: true, done: 0, total: jobs.length, runs: {}, rows, error: null, from: pickDesign(s), cancel: () => { stopped = true; for (const c of cancels) c(); } });
  const problems = { A: buildVehicleProblem(stateFor(s, 'A', snap)).problem, B: buildVehicleProblem(stateFor(s, 'B', snap)).problem };
  try {
    await runLimited(jobs, POOL_SIZE, async ({ row, model, test }) => {
      const job = runTestJob(problems[model], test.segments.map((sg) => segmentSpec(sg, test)), {
        onFail: test.onFail, speedLimits: true, ride: test.ride !== false, handling: test.ride !== false && test.handling !== false, driverSpeed: driverSpeedOf(test), ...planOption(test),
      });
      cancels.add(job.cancel);
      try {
        const r = await job.done;
        if (!stopped) useCompare.setState((st) => ({ runs: { ...st.runs, [runKey(row, model)]: r }, done: st.done + 1 }));
      } catch (e) {
        if (!stopped) useCompare.setState((st) => ({ error: `${test.name} (${model === 'A' ? 'current' : 'snapshot'}): ${e instanceof Error ? e.message : String(e)}`, done: st.done + 1 }));
      } finally { cancels.delete(job.cancel); }
    }, () => stopped);
  } finally {
    useCompare.setState({ running: false, cancel: null });
  }
}
