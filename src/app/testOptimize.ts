/**
 * Optimize from the Tests workspace.
 *  - Until it passes: run the test; while a Fail remains, run the vehicle optimizer with the test as its
 *    load cases (Test passes goal on, the user's other goals kept), apply the result (one undo step),
 *    re-run the test. Stops when it passes, when two rounds improve < 1 %, when nothing moves, or when
 *    the remaining failures can't be fixed by moving points; explains what blocks it.
 *  - Improve: the same loop with the Test grip reserve goal, until it stops improving.
 *  - Explore beyond the ranges: one optimizer run with the free ranges widened ×2 around the current
 *    design; the candidate is tested without applying it and shown for the user to accept or reject.
 */
import { create } from 'zustand';
import type { TestRun } from '../core/tests/run';
import type { DoubleWishboneGeometry } from '../core/suspension/doubleWishbone';
import { variableValue } from '../core/optimize/corner';
import type { CornerId } from '../core/vehicle/vehicle';
import { useApp, mergedCorners, OPT_DEFAULT_RANGE, POINT_KEYS, type Field } from './store';
import { buildVehicleProblem, runVehicleOptimizer, runTestJob, designRoots, vehVarKey, pointKeyOf } from './optimizer';
import { segmentSpec, type TestDesign } from './tests';
import { pointAxisLocked } from './locks';
import { startTestRun, useRun } from './panels/TestsPanels';

export interface Exploration {
  /** Score of the current design and of the candidate (lower is better). */
  before: number;
  after: number;
  candidateRun: TestRun;
  /** Moves, with whether they leave the user's range. */
  moves: { key: string; label: string; before: number; after: number; outside: boolean }[];
  updates: { root: CornerId; key: (typeof POINT_KEYS)[number]; axis: 0 | 1 | 2; value: number }[];
}

interface LoopState {
  running: boolean;
  mode: 'pass' | 'improve' | 'explore' | null;
  round: number;
  log: string[];
  outcome: 'passed' | 'improved' | 'stuck' | 'stopped' | 'error' | null;
  explanation: string[];
  exploration: Exploration | null;
  cancel: (() => void) | null;
}
export const useLoop = create<LoopState>(() => ({ running: false, mode: null, round: 0, log: [], outcome: null, explanation: [], exploration: null, cancel: null }));

const log = (line: string) => useLoop.setState((s) => ({ log: [...s.log, line] }));
const UNFIXABLE = new Set(['beyondGrip', 'rollover', 'noSolution']);
const unfixable = (f: { check: string; text: string }) => UNFIXABLE.has(f.check) || (f.check === 'speedNotReached' && /No (powered|braked) wheels/.test(f.text));

/** A note when geometry could only gain a little (typical with the placeholder tire model). */
const smallGain = (a: number, b: number): string[] => (a > 0 && (a - b) / a < 0.02
  ? ['Only a small gain was possible from moving suspension points. With the placeholder tire model, cornering and braking grip is set mostly by the tires, the weight and the CG; geometry matters more for travel, bump stops, wheel lift and inclination, and will matter more with the official tire model (camber thrust).']
  : []);

/** Lower is better: fixable Fail findings dominate, then grip use over the limit, then (improve) average grip use. */
export function testScore(r: TestRun, mode: 'pass' | 'improve' | 'explore'): number {
  const fails = r.segments.flatMap((s) => s.findings).filter((f) => f.severity === 'fail' && !unfixable(f)).length;
  const over = r.states.reduce((a, s) => a + Math.max(0, (s.grip?.maxUtilization ?? 1) - 1), 0);
  const avg = r.states.reduce((a, s) => a + (s.grip?.maxUtilization ?? 1), 0) / Math.max(r.states.length, 1);
  return mode === 'improve' ? 100 * fails + 10 * over + avg : 100 * fails + 10 * over + 0.01 * avg;
}

/** Free every unlocked coordinate of every design (±25 mm) when nothing is free yet; asks first. */
function ensureFreeCoordinates(): boolean {
  const s = useApp.getState();
  if (Object.keys(s.vehicleOptimizer.ranges).length) return true;
  if (!window.confirm('No free coordinates are chosen for the vehicle optimizer. Free all available (unlocked) coordinates, ±25 mm?')) return false;
  const all = mergedCorners(s);
  const f = (x: number): Field => ({ text: String(Number(x.toFixed(2))), value: x });
  s.updateVehicleOptimizer((o) => {
    const ranges = { ...o.ranges };
    for (const { root } of designRoots(s)) {
      const g = all[root].geom;
      for (const k of POINT_KEYS) for (const a of [0, 1, 2] as const) {
        if (pointAxisLocked(s.locks, root, k, a, g.damperArm)) continue;
        const v = g.points[k][a].value;
        ranges[vehVarKey(root, k, a)] = { lo: f(v - OPT_DEFAULT_RANGE), hi: f(v + OPT_DEFAULT_RANGE) };
      }
    }
    return { ...o, ranges };
  });
  return true;
}

/** Point the vehicle optimizer at this test (keeping 'all tests' if chosen) and turn on the right goal. */
function setupGoals(test: TestDesign, mode: 'pass' | 'improve') {
  useApp.getState().updateVehicleOptimizer((o) => ({
    ...o,
    caseSource: o.caseSource === 'all' ? 'all' : test.id,
    goals: {
      ...o.goals,
      testPass: { ...o.goals.testPass, on: true },
      ...(mode === 'improve' ? { testReserve: { ...o.goals.testReserve, on: true } } : {}),
    },
  }));
}

export async function optimizeTest(test: TestDesign, mode: 'pass' | 'improve'): Promise<void> {
  if (useLoop.getState().running) return;
  if (!ensureFreeCoordinates()) return;
  setupGoals(test, mode);
  let stopped = false;
  let currentCancel: (() => void) | null = null;
  useLoop.setState({ running: true, mode, round: 0, log: [], outcome: null, explanation: [], exploration: null, cancel: () => { stopped = true; currentCancel?.(); } });
  try {
    let run = await startTestRun(test);
    if (!run) throw new Error(useRun.getState().error ?? 'The test could not run');
    let score = testScore(run, mode);
    const startScore = score;
    log(`Start: ${run.passed ? (run.severity === 'warn' ? 'passes with warnings' : 'passes') : 'fails'} (score ${score.toFixed(2)})`);
    let slow = 0;
    let lastAtLimit: string[] = [];
    for (let round = 1; round <= 8; round++) {
      if (stopped) { useLoop.setState({ outcome: 'stopped' }); return; }
      if (mode === 'pass' && run.passed) { useLoop.setState({ outcome: 'passed' }); log('The test passes.'); return; }
      if (mode === 'pass' && run.segments.every((s) => s.passed || s.impossible || s.findings.filter((f) => f.severity === 'fail').every(unfixable))) {
        useLoop.setState({ outcome: 'stuck', explanation: ['The remaining failures can\'t be fixed by moving suspension points (no powered / braked wheels, more than the tires can give, or rollover). Change the corner settings, the test speeds, or the tires.'] });
        return;
      }
      useLoop.setState({ round });
      const built = buildVehicleProblem(useApp.getState());
      if (built.blockers.length) throw new Error(built.blockers.join(' '));
      log(`Round ${round}: optimizing ${built.problem.variables.length} coordinates over ${built.problem.states?.length ?? 0} states…`);
      const h = runVehicleOptimizer({ ...built.problem, maxIterations: 20 }, () => {});
      currentCancel = h.stop;
      const { result } = await h.done;
      currentCancel = null;
      if (stopped) { useLoop.setState({ outcome: 'stopped' }); return; }
      lastAtLimit = result.variables.filter((v) => v.atLimit).map((v) => `${v.root} ${v.point} ${'XYZ'[v.axis]}`);
      const moved = Math.max(0, ...result.variables.map((v) => Math.abs(v.after - v.before)));
      if (moved < 0.05) { log('Nothing moved: the optimizer found no better design within the ranges.'); break; }
      useApp.getState().applyVehicleOptimized(result.variables.map((v) => ({ root: v.root!, key: pointKeyOf(v.point), axis: v.axis, value: v.after })));
      run = await startTestRun(test);
      if (!run) throw new Error(useRun.getState().error ?? 'The test could not run');
      const next = testScore(run, mode);
      const gain = score > 0 ? (score - next) / score : 0;
      log(`Round ${round}: ${run.passed ? (run.severity === 'warn' ? 'passes with warnings' : 'passes') : 'still fails'} · score ${score.toFixed(2)} → ${next.toFixed(2)} (${(gain * 100).toFixed(1)}% better) · largest move ${moved.toFixed(1)} mm`);
      slow = gain < 0.01 ? slow + 1 : 0;
      score = next;
      if (mode === 'improve' && slow >= 2) { useLoop.setState({ outcome: 'improved', explanation: smallGain(startScore, score) }); log('Stopped improving.'); return; }
      if (mode === 'pass' && slow >= 2) break;
    }
    if (mode === 'pass' && run.passed) { useLoop.setState({ outcome: 'passed' }); log('The test passes.'); return; }
    if (mode === 'improve') { useLoop.setState({ outcome: 'improved', explanation: smallGain(startScore, score) }); return; }
    // Explain what blocks it.
    const why: string[] = [];
    const fails = [...new Set(run.segments.flatMap((s) => s.findings).filter((f) => f.severity === 'fail').map((f) => f.text))];
    if (fails.length) why.push(`Still failing: ${fails.slice(0, 4).join('; ')}${fails.length > 4 ? '…' : ''}`);
    if (lastAtLimit.length) why.push(`${lastAtLimit.length} coordinate(s) stopped at their range limits (${lastAtLimit.slice(0, 4).join(', ')}${lastAtLimit.length > 4 ? '…' : ''}): try Explore beyond the ranges.`);
    const locks = Object.keys(useApp.getState().locks).length + useApp.getState().dimensions.length;
    if (locks) why.push(`${locks} locked value(s) / held dimension(s) limit what can move.`);
    why.push('Other options: lower the speed in the failing segments (Apply speed limit), change the pass rules, or the setup (springs, anti-roll bars, tire pressure).');
    useLoop.setState({ outcome: 'stuck', explanation: why });
  } catch (e) {
    useLoop.setState({ outcome: 'error', explanation: [e instanceof Error ? e.message : String(e)] });
  } finally {
    useLoop.setState({ running: false, cancel: null });
  }
}

/** One optimizer run with the free ranges widened ×2; the candidate is tested but not applied. */
export async function exploreRanges(test: TestDesign): Promise<void> {
  if (useLoop.getState().running) return;
  if (!ensureFreeCoordinates()) return;
  setupGoals(test, 'pass');
  let stopped = false;
  let currentCancel: (() => void) | null = null;
  useLoop.setState({ running: true, mode: 'explore', round: 1, log: [], outcome: null, explanation: [], exploration: null, cancel: () => { stopped = true; currentCancel?.(); } });
  try {
    const s = useApp.getState();
    const built = buildVehicleProblem(s);
    if (built.blockers.length) throw new Error(built.blockers.join(' '));
    const p = built.problem;
    const wide = p.variables.map((v) => {
      const now = variableValue(p.designs[v.root]!.geometry, v);
      return { ...v, lo: now - 2 * Math.max(now - v.lo, 0) - 1, hi: now + 2 * Math.max(v.hi - now, 0) + 1 };
    });
    log(`Optimizing ${wide.length} coordinates with the ranges widened ×2…`);
    const h = runVehicleOptimizer({ ...p, variables: wide, maxIterations: 25 }, () => {});
    currentCancel = h.stop;
    const { result } = await h.done;
    if (stopped) { useLoop.setState({ outcome: 'stopped' }); return; }
    // Test the candidate without applying it.
    const candidate = { ...p, designs: Object.fromEntries(Object.entries(p.designs).map(([r, d]) => [r, { ...d!, geometry: (result.geometries as Partial<Record<CornerId, DoubleWishboneGeometry>>)[r as CornerId] ?? d!.geometry }])) };
    const before = useRun.getState().result && useRun.getState().testId === test.id ? useRun.getState().result! : await startTestRun(test);
    if (!before) throw new Error('The test could not run');
    const job = runTestJob(candidate, test.segments.map((sg) => segmentSpec(sg, test)), { onFail: test.onFail, speedLimits: false });
    currentCancel = job.cancel;
    const after = await job.done;
    const moves = result.variables.map((v, i) => {
      const orig = p.variables[i]!;
      return {
        key: vehVarKey(v.root!, pointKeyOf(v.point), v.axis), label: `${v.root} ${pointKeyOf(v.point)} ${'XYZ'[v.axis]}`,
        before: v.before, after: v.after, outside: v.after < Math.min(orig.lo, orig.hi) - 1e-6 || v.after > Math.max(orig.lo, orig.hi) + 1e-6,
      };
    }).filter((m) => Math.abs(m.after - m.before) > 0.05);
    const exploration: Exploration = {
      before: testScore(before, 'pass'), after: testScore(after, 'pass'), candidateRun: after, moves,
      updates: result.variables.map((v) => ({ root: v.root!, key: pointKeyOf(v.point), axis: v.axis, value: v.after })),
    };
    useLoop.setState({ exploration, outcome: null });
    log(`Candidate: ${after.passed ? (after.severity === 'warn' ? 'passes with warnings' : 'passes') : 'still fails'} · score ${exploration.before.toFixed(2)} → ${exploration.after.toFixed(2)} · ${moves.filter((m) => m.outside).length} move(s) outside your ranges.`);
  } catch (e) {
    useLoop.setState({ outcome: 'error', explanation: [e instanceof Error ? e.message : String(e)] });
  } finally {
    useLoop.setState({ running: false, cancel: null });
  }
}

/** Use the explored candidate: apply it and widen the ranges that it left. */
export function acceptExploration(test: TestDesign) {
  const ex = useLoop.getState().exploration;
  if (!ex) return;
  const s = useApp.getState();
  s.applyVehicleOptimized(ex.updates);
  s.updateVehicleOptimizer((o) => {
    const ranges = { ...o.ranges };
    for (const m of ex.moves) {
      if (!m.outside || !ranges[m.key]) continue;
      const r = ranges[m.key]!;
      const lo = Math.min(r.lo.value, m.after - 5), hi = Math.max(r.hi.value, m.after + 5);
      ranges[m.key] = { lo: { text: String(Number(lo.toFixed(2))), value: lo }, hi: { text: String(Number(hi.toFixed(2))), value: hi } };
    }
    return { ...o, ranges };
  });
  useLoop.setState({ exploration: null, log: [...useLoop.getState().log, 'Applied the candidate and widened those ranges.'] });
  void startTestRun(test);
}

