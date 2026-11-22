/**
 * Optimize from the Tests workspace, for the selected test or for every enabled test together
 * (weighted by their priorities).
 *  - Until it passes: run the tests; while a Fail remains, run the vehicle optimizer with the tests as its
 *    load cases (Test passes goal on, the user's other goals kept), apply the result (one undo step per
 *    round), re-run. When two rounds improve < 1 % (or nothing moves), the free ranges are widened step by
 *    step (×2, ×3, ×4, ×5, ×10, …) up to the user's maximum widening, and it keeps going. Stops when it
 *    passes, when it's stuck at the maximum widening, or when the remaining failures can't be fixed by
 *    moving points; explains what blocks it.
 *  - Improve: the same loop with the Test grip reserve goal, until it stops improving.
 *  - Explore beyond the ranges: one optimizer run with the ranges widened to the maximum; the candidate is
 *    tested without applying it and shown for the user to accept or reject.
 */
import { create } from 'zustand';
import type { TestRun } from '../core/tests/run';
import type { Severity } from '../core/tests/checks';
import type { DoubleWishboneGeometry } from '../core/suspension/doubleWishbone';
import { variableValue } from '../core/optimize/corner';
import type { VehicleProblem } from '../core/optimize/vehicle';
import type { CornerId } from '../core/vehicle/vehicle';
import { layoutOf, useApp, mergedCorners, OPT_DEFAULT_RANGE, POINT_KEYS, CORNER_NAMES, type Field, type RateUpdate, type AppState, type DamperKey } from './store';
import { buildVehicleProblem, runVehicleOptimizer, runTestJob, runRatesJob, designRoots, vehVarKey, pointKeyOf } from './optimizer';
import { testScore as coreTestScore, isUnfixable as coreUnfixable } from '../core/tests/score';
import type { RateVar, RateTest, RateProgress } from '../core/optimize/rates';
import { lockKeys } from './locks';
import { rankWeight, segmentSpec, type TestDesign } from './tests';
import { pointAxisLocked } from './locks';
import { startTestRun, useRun } from './panels/TestsPanels';

export type Scope = 'test' | 'all';

export interface Exploration {
  /** Score of the current design and of the candidate (lower is better). */
  before: number;
  after: number;
  candidate: { passed: boolean; severity: Severity };
  /** Moves, with whether they leave the user's range. */
  moves: { key: string; label: string; before: number; after: number; outside: boolean }[];
  updates: { root: CornerId; key: (typeof POINT_KEYS)[number]; axis: 0 | 1 | 2; value: number }[];
  /** Tests it was explored on. */
  testIds: string[];
}

/** Widening steps tried in turn; "no limit" keeps going to the last. */
export const WIDEN_STEPS = [1, 2, 3, 4, 5, 10, 20, 50, 100, 1000];
/** Choices for the maximum widening (0 = no limit). */
export const WIDEN_CHOICES = [1, 2, 3, 4, 5, 10, 0];

/** Springs / dampers / bars tuned on the ride (Bayesian optimization). */
export interface RateSettings {
  springs: boolean;
  dampers: boolean;
  bars: boolean;
  /** Search range: current value ÷ spread … × spread. */
  spread: number;
  /** Tests per tuning (each runs every test in scope, steady and over time). */
  budget: number;
  /** Also tune them inside Optimize until it passes / Improve (when geometry alone stops helping). */
  withLoop: boolean;
}
const DEFAULT_RATES: RateSettings = { springs: true, dampers: true, bars: false, spread: 2.5, budget: 30, withLoop: true };

interface LoopState {
  running: boolean;
  mode: 'pass' | 'improve' | 'explore' | 'rates' | null;
  rates: RateSettings;
  /** Rate tuning progress. */
  rateProgress: RateProgress | null;
  scope: Scope;
  /** Maximum range widening (× the user's ranges; 0 = no limit). */
  maxWiden: number;
  /** Widening in use this round. */
  widen: number;
  round: number;
  log: string[];
  outcome: 'passed' | 'improved' | 'stuck' | 'stopped' | 'error' | null;
  explanation: string[];
  exploration: Exploration | null;
  cancel: (() => void) | null;
}

const loadWiden = (): number => {
  try { const v = Number(localStorage.getItem('susp.maxWiden')); return WIDEN_CHOICES.includes(v) && localStorage.getItem('susp.maxWiden') !== null ? v : 5; } catch { return 5; }
};
const loadRates = (): RateSettings => {
  try { return { ...DEFAULT_RATES, ...(JSON.parse(localStorage.getItem('susp.rates') ?? '{}') as Partial<RateSettings>) }; } catch { return { ...DEFAULT_RATES }; }
};
export const useLoop = create<LoopState>(() => ({
  running: false, mode: null, scope: 'test', maxWiden: loadWiden(), widen: 1, round: 0, log: [], outcome: null, explanation: [], exploration: null, cancel: null,
  rates: loadRates(), rateProgress: null,
}));
export function setRateSettings(patch: Partial<RateSettings>) {
  const rates = { ...useLoop.getState().rates, ...patch };
  useLoop.setState({ rates });
  try { localStorage.setItem('susp.rates', JSON.stringify(rates)); } catch { /* private mode */ }
}
export function setMaxWiden(v: number) {
  useLoop.setState({ maxWiden: v });
  try { localStorage.setItem('susp.maxWiden', String(v)); } catch { /* private mode */ }
}
export const widenLabel = (v: number) => (v === 0 ? 'No limit' : v === 1 ? 'My ranges only' : `Up to ×${v}`);

const log = (line: string) => useLoop.setState((s) => ({ log: [...s.log, line] }));
const unfixable = coreUnfixable;
/** A failure the optimizer can't fix by moving suspension points or changing rates. */
export const isUnfixable = coreUnfixable;

/** A note when geometry could only gain a little (typical with the placeholder tire model). */
const smallGain = (a: number, b: number): string[] => (a > 0 && (a - b) / a < 0.02
  ? ['Only a small gain was possible. In a steady turn the grip is set mostly by the tires, the weight and the CG; geometry changes it through load transfer and the wheels\' lean (camber thrust), and matters more for travel, bump stops and wheel lift.']
  : []);

/** Lower is better: fixable Fail findings dominate, then grip use over the limit, then (improve) average grip use, plus the ride measures. */
export const testScore = (r: TestRun, mode: 'pass' | 'improve' | 'explore'): number => coreTestScore(r, mode);

/** The springs, dampers and bars to tune (locked values left out), with their search ranges. */
export function rateVars(s: AppState, settings: RateSettings): RateVar[] {
  const all = mergedCorners(s);
  const out: RateVar[] = [];
  const k = Math.max(1.05, settings.spread);
  const range = (v: number) => ({ lo: Math.max(1e-3, v / k), hi: v * k });
  for (const { root, corners } of designRoots(s)) {
    const d = all[root];
    const name = corners.length > 1 ? corners.join('/') : CORNER_NAMES[root];
    const locked = (group: 'spring' | 'damper', key: string) => !!s.locks[lockKeys.field(root, group, key)];
    if (settings.springs && !locked('spring', 'springRate')) {
      const v = d.spring.springRate.value;
      if (v > 0) out.push({ kind: 'spring', root, ...range(v), value: v, label: `${name} spring rate` });
    }
    if (settings.dampers) {
      const keys: [RateVar['kind'], DamperKey, string][] = [['bump', 'bumpDamping', 'bump'], ['rebound', 'reboundDamping', 'rebound']];
      if (d.damperMode === 'twoStage') keys.push(['bumpHigh', 'bumpDampingHigh', 'bump, high speed'], ['reboundHigh', 'reboundDampingHigh', 'rebound, high speed']);
      for (const [kind, key, label] of keys) {
        if (locked('damper', key)) continue;
        const v = Math.max(d.damper[key].value, 100);
        out.push({ kind, root, ...range(v), value: v, label: `${name} damping, ${label}` });
      }
    }
  }
  if (settings.bars) {
    for (const axle of ['front', 'rear'] as const) {
      const a = s.shared[axle];
      if (a.antiRollBar === 'wheelRate' && a.arbRate.value > 0) out.push({ kind: 'arb', axle, ...range(a.arbRate.value), value: a.arbRate.value, label: `${axle} anti-roll bar (N/mm at the wheel)` });
      if (a.antiRollBar === 'torsionBar' && a.barRate.value > 0) {
        // N·m/deg → N·mm/rad, as the problem uses.
        const v = a.barRate.value * 1000 * (180 / Math.PI);
        out.push({ kind: 'arb', axle, ...range(v), value: v, label: `${axle} anti-roll bar` });
      }
    }
  }
  return out;
}

/** Store updates for tuned rates. */
function rateUpdates(s: AppState, vars: RateVar[], x: number[]): RateUpdate[] {
  const keyOf: Record<Exclude<RateVar['kind'], 'arb' | 'spring'>, DamperKey> = { bump: 'bumpDamping', rebound: 'reboundDamping', bumpHigh: 'bumpDampingHigh', reboundHigh: 'reboundDampingHigh' };
  return vars.map((v, i): RateUpdate => {
    const val = x[i]!;
    if (v.kind === 'arb') {
      const torsion = s.shared[v.axle!].antiRollBar === 'torsionBar';
      return { axle: v.axle, section: 'shared', key: torsion ? 'barRate' : 'arbRate', value: torsion ? val / 1000 / (180 / Math.PI) : val };
    }
    if (v.kind === 'spring') return { root: v.root, section: 'spring', key: 'springRate', value: val };
    return { root: v.root, section: 'damper', key: keyOf[v.kind], value: val };
  });
}

const fmtRate = (v: RateVar, x: number) => (v.kind === 'spring' ? `${x.toFixed(1)} N/mm` : v.kind === 'arb' ? x.toFixed(1) : `${Math.round(x)} N·s/m`);

/**
 * Tune springs / dampers / bars on the tests in scope (steady states + ride over time) by Bayesian
 * optimization in the worker; applies the best rates when they score better (one undo step).
 * Inside the optimize loop (`inLoop`), it uses the loop's running state and cancel.
 */
export async function tuneSpringsDampers(scope: Scope, active: TestDesign | null, mode: 'pass' | 'improve' = 'pass', inLoop?: { setCancel: (fn: (() => void) | null) => void }): Promise<{ improved: boolean; before: number; after: number } | null> {
  if (!inLoop && useLoop.getState().running) return null;
  const tests = testsInScope(scope, active);
  const s = useApp.getState();
  const settings = useLoop.getState().rates;
  const vars = rateVars(s, settings);
  if (!tests.length || !vars.length) {
    log(!tests.length ? 'Springs & dampers: no tests to tune on.' : 'Springs & dampers: nothing to tune (tick springs / dampers / bars, or unlock them).');
    return null;
  }
  const rateTests: RateTest[] = tests.map((t) => ({
    segments: t.segments.map((sg) => segmentSpec(sg, t)), weight: tests.length > 1 ? rankWeight(t.rank, tests.length) : 1, onFail: t.onFail, handling: t.handling !== false,
  }));
  const { problem } = buildVehicleProblem(s);
  let last: RateProgress | null = null;
  let stopped = false;
  if (!inLoop) useLoop.setState({ running: true, mode: 'rates', scope, log: [], outcome: null, explanation: [], exploration: null, rateProgress: null });
  log(`Springs & dampers: tuning ${vars.length} rate(s) on ${tests.length} test(s) over time, ${settings.budget} tries…`);
  const job = runRatesJob(problem, rateTests, vars, settings.budget, mode, (info) => { last = info; useLoop.setState({ rateProgress: info }); });
  const stop = () => { stopped = true; job.stop(); };
  if (inLoop) inLoop.setCancel(stop); else useLoop.setState({ cancel: stop });
  try {
    let x: number[], before: number, after: number;
    try {
      const r = await job.done;
      ({ x, before, after } = r);
    } catch (e) {
      if (!stopped) throw e;
      const l = last as RateProgress | null;
      if (!l) { log('Springs & dampers: stopped before the first result.'); if (!inLoop) useLoop.setState({ outcome: 'stopped' }); return null; }
      // Stopped: keep the best found so far.
      x = l.bestX; after = l.best; before = Infinity;
      log('Springs & dampers: stopped; using the best rates found so far.');
    }
    const improved = after < before * 0.999 || (before === Infinity && x.some((v, i) => Math.abs(v - vars[i]!.value) > 1e-6));
    if (improved) {
      useApp.getState().applyRateValues(rateUpdates(useApp.getState(), vars, x));
      const changes = vars.map((v, i) => `${v.label} ${fmtRate(v, v.value)} → ${fmtRate(v, x[i]!)}`).filter((_, i) => Math.abs(x[i]! - vars[i]!.value) / Math.max(vars[i]!.value, 1e-9) > 0.01);
      log(`Springs & dampers: score ${Number.isFinite(before) ? before.toFixed(2) : '…'} → ${after.toFixed(2)}. ${changes.join('; ')}`);
    } else {
      log(`Springs & dampers: no better rates found (score ${before.toFixed(2)}); kept yours.`);
    }
    if (!inLoop) {
      for (const t of tests) { const fresh = useApp.getState().tests.find((q) => q.id === t.id); if (fresh) await startTestRun(fresh); }
      useLoop.setState({ outcome: stopped ? 'stopped' : improved ? 'improved' : 'stuck', explanation: improved ? [] : ['Your current springs and dampers already scored best among the rates tried. Widen the search range or try more tests.'] });
    }
    return { improved, before, after };
  } catch (e) {
    if (!inLoop) useLoop.setState({ outcome: 'error', explanation: [e instanceof Error ? e.message : String(e)] });
    else throw e;
    return null;
  } finally {
    if (!inLoop) useLoop.setState({ running: false, cancel: null, rateProgress: null });
    else { inLoop.setCancel(null); useLoop.setState({ rateProgress: null }); }
  }
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
        if (pointAxisLocked(s.locks, root, k, a, g.damperArm, g.kind, layoutOf(g), g.steerMechanism)) continue;
        const v = g.points[k][a].value;
        ranges[vehVarKey(root, k, a)] = { lo: f(v - OPT_DEFAULT_RANGE), hi: f(v + OPT_DEFAULT_RANGE) };
      }
    }
    return { ...o, ranges };
  });
  return true;
}

/** Turn on the test goals (the user's other goals are kept). */
function setupGoals(mode: 'pass' | 'improve') {
  useApp.getState().updateVehicleOptimizer((o) => ({
    ...o,
    goals: {
      ...o.goals,
      testPass: { ...o.goals.testPass, on: true },
      ...(mode === 'improve' ? { testReserve: { ...o.goals.testReserve, on: true } } : {}),
    },
  }));
}

/** The tests an optimize run covers. */
export function testsInScope(scope: Scope, active: TestDesign | null): TestDesign[] {
  const tests = useApp.getState().tests;
  if (scope === 'all') return tests.filter((t) => t.enabled !== false);
  return active ? [active] : [];
}

/** The free ranges widened ×k about their centers (always containing the current value). */
function widened(p: VehicleProblem, k: number): VehicleProblem['variables'] {
  if (k <= 1) return p.variables;
  return p.variables.map((v) => {
    const now = variableValue(p.designs[v.root]!.geometry, v);
    const c = (v.lo + v.hi) / 2, half = (Math.abs(v.hi - v.lo) / 2) * k + 1;
    return { ...v, lo: Math.min(c - half, now), hi: Math.max(c + half, now) };
  });
}

/** Grow the stored ranges to include values the widened optimizer moved to (+5 mm). */
function growRanges(moves: { key: string; value: number }[]) {
  useApp.getState().updateVehicleOptimizer((o) => {
    const ranges = { ...o.ranges };
    let changed = false;
    for (const m of moves) {
      const r = ranges[m.key];
      if (!r || (m.value >= Math.min(r.lo.value, r.hi.value) && m.value <= Math.max(r.lo.value, r.hi.value))) continue;
      const lo = Math.min(r.lo.value, m.value - 5), hi = Math.max(r.hi.value, m.value + 5);
      ranges[m.key] = { lo: { text: String(Number(lo.toFixed(2))), value: lo }, hi: { text: String(Number(hi.toFixed(2))), value: hi } };
      changed = true;
    }
    return changed ? { ...o, ranges } : o;
  });
}

interface SetRun { runs: { test: TestDesign; run: TestRun }[]; passed: boolean; score: number }

/** Run each test in turn (the results show in the Tests panel); priority-weighted score. */
async function runSet(tests: TestDesign[], mode: 'pass' | 'improve' | 'explore', isStopped: () => boolean): Promise<SetRun | null> {
  const runs: SetRun['runs'] = [];
  for (const t of tests) {
    if (isStopped()) return null;
    const fresh = useApp.getState().tests.find((x) => x.id === t.id) ?? t;
    const run = await startTestRun(fresh);
    if (!run) throw new Error(useRun.getState().error ?? `Test “${t.name}” could not run`);
    runs.push({ test: fresh, run });
  }
  const w = (t: TestDesign) => (tests.length > 1 ? rankWeight(t.rank, tests.length) : 1);
  const tw = runs.reduce((a, r) => a + w(r.test), 0) || 1;
  return { runs, passed: runs.every((r) => r.run.passed), score: runs.reduce((a, r) => a + w(r.test) * testScore(r.run, mode), 0) / tw };
}

const describe = (set: SetRun) => {
  const failing = set.runs.filter((r) => !r.run.passed).length;
  const warn = set.runs.some((r) => r.run.severity === 'warn');
  if (set.runs.length === 1) return set.passed ? (warn ? 'passes with warnings' : 'passes') : 'fails';
  return set.passed ? `all ${set.runs.length} pass${warn ? ' (some with warnings)' : ''}` : `${failing} of ${set.runs.length} fail`;
};

const MAX_ROUNDS = 40;

export async function optimizeTests(scope: Scope, active: TestDesign | null, mode: 'pass' | 'improve'): Promise<void> {
  if (useLoop.getState().running) return;
  const tests = testsInScope(scope, active);
  if (!tests.length) { useLoop.setState({ outcome: 'error', explanation: [scope === 'all' ? 'No enabled tests: tick at least one test.' : 'No test selected.'], log: [] }); return; }
  if (!ensureFreeCoordinates()) return;
  setupGoals(mode);
  const caseSource = scope === 'all' ? 'all' : tests[0]!.id;
  const maxWiden = useLoop.getState().maxWiden || Infinity;
  const steps = WIDEN_STEPS.filter((k) => k <= maxWiden);
  let wi = 0;
  let stopped = false;
  let currentCancel: (() => void) | null = null;
  const isStopped = () => stopped;
  useLoop.setState({ running: true, mode, scope, widen: 1, round: 0, log: [], outcome: null, explanation: [], exploration: null, cancel: () => { stopped = true; currentCancel?.(); useRun.getState().cancel?.(); } });
  try {
    const first = await runSet(tests, mode, isStopped);
    if (!first) { useLoop.setState({ outcome: 'stopped' }); return; }
    let set: SetRun = first;
    const startScore = set.score;
    log(`Start: ${describe(set)} (score ${set.score.toFixed(2)})`);
    let slow = 0;
    let lastAtLimit: string[] = [];
    let ratesTried = false;
    const rates = useLoop.getState().rates;
    // Springs / dampers on the ride, when geometry alone stops helping (once per stall).
    const tryRates = async (): Promise<boolean> => {
      if (!rates.withLoop || ratesTried || !rateVars(useApp.getState(), rates).length) return false;
      ratesTried = true;
      const r = await tuneSpringsDampers(scope, active, mode, { setCancel: (fn) => { currentCancel = fn; } });
      if (stopped || !r?.improved) return false;
      const next = await runSet(tests, mode, isStopped);
      if (!next) return false;
      log(`After springs & dampers: ${describe(next)} · score ${set.score.toFixed(2)} → ${next.score.toFixed(2)}`);
      set = next;
      return true;
    };
    for (let round = 1; round <= MAX_ROUNDS; round++) {
      if (stopped) { useLoop.setState({ outcome: 'stopped' }); return; }
      if (mode === 'pass' && set.passed) { useLoop.setState({ outcome: 'passed' }); log(set.runs.length > 1 ? 'Every test passes.' : 'The test passes.'); return; }
      if (mode === 'pass' && set.runs.every(({ run }) => run.segments.every((s) => s.passed || s.impossible || s.findings.filter((f) => f.severity === 'fail').every(unfixable)))) {
        useLoop.setState({ outcome: 'stuck', explanation: ['The remaining failures can\'t be fixed by moving suspension points (no powered / braked wheels, more than the tires can give, too tight for the steering, or rollover). Change the corner or steering settings, the test, or the tires.'] });
        return;
      }
      // Failing only over time (bumps at speed, transients): springs and dampers first.
      if (mode === 'pass' && !ratesTried && set.runs.every(({ run }) => run.segments.every((sg) => sg.passed || sg.rideFail || sg.findings.filter((f) => f.severity === 'fail').every(unfixable)))) {
        if (await tryRates()) { ratesTried = false; continue; }
        if (stopped) { useLoop.setState({ outcome: 'stopped' }); return; }
      }
      const k = steps[wi]!;
      useLoop.setState({ round, widen: k });
      const built = buildVehicleProblem(useApp.getState(), { caseSource });
      if (built.blockers.length) throw new Error(built.blockers.join(' '));
      const vars = widened(built.problem, k);
      log(`Round ${round}: optimizing ${vars.length} coordinates over ${built.problem.states?.length ?? 0} states${k > 1 ? ` (ranges ×${k})` : ''}…`);
      const h = runVehicleOptimizer({ ...built.problem, variables: vars, maxIterations: 25 }, () => {});
      currentCancel = h.stop;
      const { result } = await h.done;
      currentCancel = null;
      if (stopped) { useLoop.setState({ outcome: 'stopped' }); return; }
      lastAtLimit = result.variables.filter((v) => v.atLimit).map((v) => `${v.root} ${v.point} ${'XYZ'[v.axis]}`);
      const moved = Math.max(0, ...result.variables.map((v) => Math.abs(v.after - v.before)));
      let gain = 0;
      if (moved >= 0.05) {
        const updates = result.variables.map((v) => ({ root: v.root!, key: pointKeyOf(v.point), axis: v.axis, value: v.after }));
        useApp.getState().applyVehicleOptimized(updates);
        if (k > 1) growRanges(updates.map((u) => ({ key: vehVarKey(u.root, u.key, u.axis), value: u.value })));
        const next = await runSet(tests, mode, isStopped);
        if (!next) { useLoop.setState({ outcome: 'stopped' }); return; }
        gain = set.score > 0 ? (set.score - next.score) / set.score : 0;
        log(`Round ${round}: ${describe(next)} · score ${set.score.toFixed(2)} → ${next.score.toFixed(2)} (${(gain * 100).toFixed(1)}% better) · largest move ${moved.toFixed(1)} mm`);
        set = next;
      } else {
        log(`Round ${round}: nothing moved${k > 1 ? ` at ×${k}` : ' within your ranges'}.`);
      }
      slow = moved < 0.05 ? 2 : gain < 0.01 ? slow + 1 : 0;
      if (mode === 'pass' && set.passed) continue; // reported at the top of the next round
      if (slow >= 2) {
        if (wi + 1 < steps.length) {
          wi++;
          slow = 0;
          log(`No more progress: widening the ranges to ×${steps[wi]}.`);
          continue;
        }
        if (await tryRates()) { slow = 0; continue; }
        if (stopped) { useLoop.setState({ outcome: 'stopped' }); return; }
        if (mode === 'improve') { log('Stopped improving.'); break; }
        break;
      }
    }
    if (mode === 'pass' && set.passed) { useLoop.setState({ outcome: 'passed' }); log(set.runs.length > 1 ? 'Every test passes.' : 'The test passes.'); return; }
    if (mode === 'improve') { useLoop.setState({ outcome: 'improved', explanation: smallGain(startScore, set.score) }); return; }
    // Explain what blocks it.
    const why: string[] = [];
    const fails = [...new Set(set.runs.flatMap(({ test, run }) => run.segments.flatMap((s) => s.findings).filter((f) => f.severity === 'fail').map((f) => (set.runs.length > 1 ? `${test.name}: ${f.text}` : f.text))))];
    if (fails.length) why.push(`Still failing: ${fails.slice(0, 4).join('; ')}${fails.length > 4 ? '…' : ''}`);
    const widest = steps[wi]!;
    if (lastAtLimit.length) {
      why.push(`${lastAtLimit.length} coordinate(s) stopped at their range limits${widest > 1 ? ` (ranges ×${widest})` : ''}: ${lastAtLimit.slice(0, 4).join(', ')}${lastAtLimit.length > 4 ? '…' : ''}.`
        + (useLoop.getState().maxWiden !== 0 ? ' Allow more widening (Max widening) to go further.' : ''));
    } else if (widest > 1) {
      why.push(`Tried ranges up to ×${widest} without further progress: moving these points alone doesn't fix it.`);
    }
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

/** One optimizer run with the free ranges widened to the maximum; the candidate is tested but not applied. */
export async function exploreRanges(scope: Scope, active: TestDesign | null): Promise<void> {
  if (useLoop.getState().running) return;
  const tests = testsInScope(scope, active);
  if (!tests.length) return;
  if (!ensureFreeCoordinates()) return;
  setupGoals('pass');
  const max = useLoop.getState().maxWiden;
  const k = max === 0 ? 1000 : Math.max(2, max);
  let stopped = false;
  let currentCancel: (() => void) | null = null;
  useLoop.setState({ running: true, mode: 'explore', scope, widen: k, round: 1, log: [], outcome: null, explanation: [], exploration: null, cancel: () => { stopped = true; currentCancel?.(); } });
  try {
    const s = useApp.getState();
    const built = buildVehicleProblem(s, { caseSource: scope === 'all' ? 'all' : tests[0]!.id });
    if (built.blockers.length) throw new Error(built.blockers.join(' '));
    const p = built.problem;
    const wide = widened(p, k);
    log(`Optimizing ${wide.length} coordinates with the ranges widened ×${k}…`);
    const h = runVehicleOptimizer({ ...p, variables: wide, maxIterations: 30 }, () => {});
    currentCancel = h.stop;
    const { result } = await h.done;
    if (stopped) { useLoop.setState({ outcome: 'stopped' }); return; }
    // Test the candidate without applying it.
    const before = await runSet(tests, 'pass', () => stopped);
    if (!before) { useLoop.setState({ outcome: 'stopped' }); return; }
    const candidate = { ...p, designs: Object.fromEntries(Object.entries(p.designs).map(([r, d]) => [r, { ...d!, geometry: (result.geometries as Partial<Record<CornerId, DoubleWishboneGeometry>>)[r as CornerId] ?? d!.geometry }])) };
    const after: TestRun[] = [];
    for (const t of tests) {
      const job = runTestJob(candidate, t.segments.map((sg) => segmentSpec(sg, t)), { onFail: t.onFail, speedLimits: false });
      currentCancel = job.cancel;
      after.push(await job.done);
      if (stopped) { useLoop.setState({ outcome: 'stopped' }); return; }
    }
    const w = (t: TestDesign) => (tests.length > 1 ? rankWeight(t.rank, tests.length) : 1);
    const tw = tests.reduce((a, t) => a + w(t), 0) || 1;
    const afterScore = tests.reduce((a, t, i) => a + w(t) * testScore(after[i]!, 'pass'), 0) / tw;
    const moves = result.variables.map((v, i) => {
      const orig = p.variables[i]!;
      return {
        key: vehVarKey(v.root!, pointKeyOf(v.point), v.axis), label: `${v.root} ${pointKeyOf(v.point)} ${'XYZ'[v.axis]}`,
        before: v.before, after: v.after, outside: v.after < Math.min(orig.lo, orig.hi) - 1e-6 || v.after > Math.max(orig.lo, orig.hi) + 1e-6,
      };
    }).filter((m) => Math.abs(m.after - m.before) > 0.05);
    const passed = after.every((r) => r.passed);
    const exploration: Exploration = {
      before: before.score, after: afterScore, moves, testIds: tests.map((t) => t.id),
      candidate: { passed, severity: after.some((r) => r.severity === 'fail') ? 'fail' : after.some((r) => r.severity === 'warn') ? 'warn' : 'pass' },
      updates: result.variables.map((v) => ({ root: v.root!, key: pointKeyOf(v.point), axis: v.axis, value: v.after })),
    };
    useLoop.setState({ exploration, outcome: null });
    log(`Candidate: ${passed ? 'passes' : 'still fails'} · score ${exploration.before.toFixed(2)} → ${exploration.after.toFixed(2)} · ${moves.filter((m) => m.outside).length} move(s) outside your ranges.`);
  } catch (e) {
    useLoop.setState({ outcome: 'error', explanation: [e instanceof Error ? e.message : String(e)] });
  } finally {
    useLoop.setState({ running: false, cancel: null });
  }
}

/** Use the explored candidate: apply it and widen the ranges that it left. */
export async function acceptExploration() {
  const ex = useLoop.getState().exploration;
  if (!ex) return;
  const s = useApp.getState();
  s.applyVehicleOptimized(ex.updates);
  growRanges(ex.moves.filter((m) => m.outside).map((m) => ({ key: m.key, value: m.after })));
  useLoop.setState({ exploration: null, log: [...useLoop.getState().log, 'Applied the candidate and widened those ranges.'] });
  for (const id of ex.testIds) {
    const t = useApp.getState().tests.find((x) => x.id === id);
    if (t) await startTestRun(t);
  }
}
