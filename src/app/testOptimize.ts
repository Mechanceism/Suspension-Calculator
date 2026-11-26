/**
 * Optimize from the Tests workspace, for the selected test or for every enabled test together
 * (weighted by their priorities).
 *  - Until it passes: run the tests; while a Fail remains, run the vehicle optimizer with the tests as its
 *    load cases (Test passes goal on, the user's other goals kept), try its move at the full step, ½ and ¼ on
 *    the tests as driven and keep the best (round 4, F24; one undo step per round). When two rounds improve < 1 % (or nothing moves), the free ranges are widened step by
 *    step (×2, ×3, ×4, ×5, ×10, …) up to the user's maximum widening, and it keeps going. Stops when it
 *    passes, when it's stuck at the maximum widening, or when the remaining failures can't be fixed by
 *    moving points; explains what blocks it.
 *  - Improve: the same loop with the Test grip reserve goal, until it stops improving.
 *  - Explore beyond the ranges: one optimizer run with the ranges widened to the maximum; the candidate is
 *    tested without applying it and shown for the user to accept or reject.
 */
import { create } from 'zustand';
import { planStartOf, type TestRun } from '../core/tests/run';
import type { Severity } from '../core/tests/checks';
import type { DoubleWishboneGeometry } from '../core/suspension/doubleWishbone';
import { variableValue } from '../core/optimize/corner';
import type { VehicleProblem } from '../core/optimize/vehicle';
import type { CornerId } from '../core/vehicle/vehicle';
import { layoutOf, useApp, mergedCorners, rootOf, pickDesign, OPT_DEFAULT_RANGE, POINT_KEYS, CORNER_NAMES, type Field, type RateUpdate, type AppState, type DamperKey, type DesignState, isVehScalar, type VehUpdateKey } from './store';
import { useSnapshots } from './snapshots';
import { isOneAxle } from '../core/suspension/doubleWishbone';
import { buildVehicleProblem, runVehicleOptimizer, runTestJob, runRatesJob, designRoots, vehVarKey, pointKeyOf, vehUpdateOf, vehRangeKeyOf, vehScalarKey } from './optimizer';
import { testScore as coreTestScore, isUnfixable as coreUnfixable } from '../core/tests/score';
import type { RateVar, RateTest, RateProgress } from '../core/optimize/rates';
import { lockKeys } from './locks';
import { designRideHeight } from '../core/optimize/vehicle';
import { planOption, rankWeight, segmentSpec, driverSpeedOf, plannedSpeeds, type TestDesign } from './tests';
import { pointAxisLocked } from './locks';
import { startTestRun, runTestsTogether, useRun, resultsOf, restoreResults } from './panels/TestsPanels';
import { POOL_SIZE, runLimited } from './workerPool';
import { sizeBrakes, hardestUse, type BrakeSizing } from './brakeLadder';

export type Scope = 'test' | 'all';

export interface Exploration {
  /** Score of the current design and of the candidate (lower is better). */
  before: number;
  after: number;
  candidate: { passed: boolean; severity: Severity };
  /** Moves, with whether they leave the user's range. */
  moves: { key: string; label: string; before: number; after: number; outside: boolean }[];
  updates: { root: CornerId; key: VehUpdateKey; axis: 0 | 1 | 2; value: number }[];
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
// Bars on by default (round 5): an axle's bar is tuned only when it has one (no bar, nothing added).
const DEFAULT_RATES: RateSettings = { springs: true, dampers: true, bars: true, spread: 2.5, budget: 30, withLoop: true };

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
  /** Size the brakes with the ladder inside Optimize until it passes / Improve (with the brake hydraulics on). */
  sizeBrakes: boolean;
  /** Drum axles whose drums ran out at the last sizing (the user may allow discs). */
  askDisc: ('front' | 'rear')[];
  /**
   * After a run (round 4, F23): separating the front and rear designs was tried and helped — the design it
   * found (applied only if the user accepts), where the rear started from, and the times.
   */
  splitOffer?: { state: DesignState; from: 'current' | 'snapshot'; before: number; after: number; snapshotName?: string } | null;
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
  sizeBrakes: (() => { try { return localStorage.getItem('susp.sizeBrakes') === '1'; } catch { return false; } })(), askDisc: [],
}));
export function setSizeBrakes(on: boolean) {
  useLoop.setState({ sizeBrakes: on });
  try { localStorage.setItem('susp.sizeBrakes', on ? '1' : '0'); } catch { /* private mode */ }
}

/**
 * Size the brakes (the ladder) from test runs and apply it; returns what changed (empty: nothing).
 * Without runs, from the last result of every test in the Tests panel.
 */
export function sizeBrakesFrom(runs?: TestRun[]): BrakeSizing | null {
  const all = runs ?? Object.values(useRun.getState().results).map((e) => e.result);
  const use = hardestUse(all);
  if (!use) return null;
  const z = sizeBrakes(useApp.getState(), use);
  if (!z) return null;
  useLoop.setState({ askDisc: z.askDisc });
  if (Object.keys(z.patch).length) useApp.getState().setBrakes(z.patch);
  return z;
}
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
/** The Test time goal (speeds as maximums): its weight (0 = off), and each test's time when the optimizing began. */
// Lap tests (planned speeds) are always scored on their time (F9): weight 1 unless set (0 = time ignored).
const timeWeight = () => { const g = useApp.getState().vehicleOptimizer.goals.testTime; return g?.on ? Math.max(0, g.weight.value) : 1; };
const timeRefs = new Map<string, number>();
export const testScore = (r: TestRun, mode: 'pass' | 'improve' | 'explore', testId?: string): number => {
  const w = timeWeight();
  if (w > 0 && testId && r.time && !timeRefs.has(testId)) timeRefs.set(testId, r.time);
  return coreTestScore(r, mode, w > 0 ? { weight: w, ref: testId ? timeRefs.get(testId) : undefined } : undefined);
};
/** A set of runs' score as the optimize loop counts it: each test's score, priority-weighted when several. */
const scoreOfRuns = (tests: TestDesign[], runs: TestRun[], mode: 'pass' | 'improve' | 'explore') => {
  const w = (t: TestDesign) => (tests.length > 1 ? rankWeight(t.rank, tests.length) : 1);
  const tw = tests.reduce((a, t) => a + w(t), 0) || 1;
  return tests.reduce((a, t, i) => a + w(t) * testScore(runs[i]!, mode, t.id), 0) / tw;
};
/** The same from stored results (null when one is missing). */
const scoreOfResults = (tests: TestDesign[], results: ReturnType<typeof resultsOf>, mode: 'pass' | 'improve' | 'explore') => {
  const runs = tests.map((t) => results[t.id]?.result);
  return runs.every(Boolean) ? scoreOfRuns(tests, runs as TestRun[], mode) : null;
};
/** The last applied rates tuning: the springs, dampers and bars it replaced and the tests' results then (to put back). */
let lastRates: (Pick<AppState, 'corners' | 'spring' | 'damper' | 'shared' | 'presetId'> & { results: ReturnType<typeof resultsOf> }) | null = null;
/** Put the rates (and the results) back as they were before the last tuning. */
function revertRates() {
  if (!lastRates) return;
  const { results, ...design } = lastRates;
  useApp.setState(design);
  restoreResults(results);
  lastRates = null;
}

/** The planned speeds of the tests' last runs (speeds as maximums), for the geometry optimizer's states. */
const lastPlans = () => Object.fromEntries(Object.entries(useRun.getState().results).map(([id, e]) => [id, e.result.segments.map((s) => s.plan)]));

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
      if (s.locks[`shared.${axle}.${a.antiRollBar === 'torsionBar' ? 'barRate' : 'arbRate'}`]) continue;
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
  lastRates = null;
  // On its own, times count against the current results (an earlier optimize run's references are stale).
  if (!inLoop) timeRefs.clear();
  const tests = testsInScope(scope, active);
  const s = useApp.getState();
  const settings = useLoop.getState().rates;
  const vars = rateVars(s, settings);
  if (!tests.length || !vars.length) {
    log(!tests.length ? 'Springs & dampers: no tests to tune on.' : 'Springs & dampers: nothing to tune (tick springs / dampers / bars, or unlock them).');
    return null;
  }
  const rateTests: RateTest[] = tests.map((t) => ({
    segments: t.segments.map((sg) => segmentSpec(sg, t)), weight: tests.length > 1 ? rankWeight(t.rank, tests.length) : 1, onFail: t.onFail, handling: t.handling !== false, driverSpeed: driverSpeedOf(t),
    // Planned once (no ladder: 30 tries), from where the last run's ladder left each segment, so a segment it
    // slowed isn't scored as failing at the full push (its scores then match the loop's, round 4).
    ...((): { plan?: ReturnType<typeof planOption>['plan'] } => {
      const po = planOption(t, false);
      const start = planStartOf(useRun.getState().results[t.id]?.result);
      return po.plan ? { plan: { ...po.plan, ...(start ? { start } : {}) } } : {};
    })(),
    // Lap tests: the springs and dampers are judged on the driven time too, against the last run's.
    ...((): { time?: { weight: number; ref: number } } => {
      // (Against the same time as the loop counts from — where this optimizing began — else the last run's.)
      const ref = timeRefs.get(t.id) ?? useRun.getState().results[t.id]?.result.time;
      return plannedSpeeds(t) && ref && ref > 0 && timeWeight() > 0 ? { time: { weight: timeWeight(), ref } } : {};
    })(),
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
    let improved = after < before * 0.999 || (before === Infinity && x.some((v, i) => Math.abs(v - vars[i]!.value) > 1e-6));
    if (improved) {
      // (What it replaces, to put back exactly if the tests as driven turn out worse.)
      const s1 = useApp.getState();
      lastRates = { corners: s1.corners, spring: s1.spring, damper: s1.damper, shared: s1.shared, presetId: s1.presetId, results: resultsOf(tests.map((t) => t.id)) };
      useApp.getState().applyRateValues(rateUpdates(useApp.getState(), vars, x));
      const changes = vars.map((v, i) => `${v.label} ${fmtRate(v, v.value)} → ${fmtRate(v, x[i]!)}`).filter((_, i) => Math.abs(x[i]! - vars[i]!.value) / Math.max(vars[i]!.value, 1e-9) > 0.01);
      log(`Springs & dampers: score ${Number.isFinite(before) ? before.toFixed(2) : '…'} → ${after.toFixed(2)}. ${changes.join('; ')}`);
    } else {
      log(`Springs & dampers: no better rates found (score ${before.toFixed(2)}); kept yours.`);
    }
    if (!inLoop) {
      // On its own: the tests as driven (with the ladder) decide, as in the loop — worse, the rates are put back.
      const base = lastRates ? scoreOfResults(tests, lastRates.results, mode) : null;
      const runs = await runTestsTogether(tests.map((t) => useApp.getState().tests.find((q) => q.id === t.id)).filter((t): t is TestDesign => !!t));
      if (improved && base !== null && runs.every(Boolean)) {
        const now = scoreOfRuns(tests, runs as TestRun[], mode);
        if (now > base * 1.0005 + 1e-6) { revertRates(); improved = false; log(`Springs & dampers: worse on the tests as driven (score ${base.toFixed(2)} → ${now.toFixed(2)}): put back.`); }
      }
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

/**
 * Round 5: the vehicle optimizer's other variables, freed with their default ranges — each design's static camber
 * (±1.5°), toe (±0.3°) and tire set pressure (gas model, ±25 %), each axle's static ride height (±15 mm about the
 * set or design height) — leaving out locked ones. Keys → ranges.
 */
export function adjustmentRanges(s: AppState): Record<string, { lo: Field; hi: Field }> {
  const all = mergedCorners(s);
  const f = (x: number, d = 2): Field => ({ text: String(Number(x.toFixed(d))), value: x });
  const out: Record<string, { lo: Field; hi: Field }> = {};
  for (const { root } of designRoots(s)) {
    const d = all[root];
    for (const [name, span] of [['staticCamber', 1.5], ['staticToe', 0.3]] as const) {
      if (s.locks[lockKeys.field(root, 'scalar', name)]) continue;
      const v = d.geom.scalars[name].value;
      out[vehScalarKey(root, name)] = { lo: f(v - span, 3), hi: f(v + span, 3) };
    }
    if (d.tireModel === 'gas' && !s.locks[lockKeys.field(root, 'tire', 'pressure')]) {
      const v = d.tire.pressure.value;
      out[vehScalarKey(root, 'tirePressure')] = { lo: f(v * 0.75, 1), hi: f(v * 1.25, 1) };
    }
  }
  // Ride height: about the set height, else where the car rests at its design position.
  let design = NaN;
  try { design = designRideHeight(buildVehicleProblem(s).problem); } catch { /* no car yet */ }
  for (const [root, axle] of [['FL', 'front'], ['RL', 'rear']] as const) {
    const v = s.rideHeight.on ? s.rideHeight[axle].value : design;
    if (Number.isFinite(v)) out[vehScalarKey(root, 'rideHeight')] = { lo: f(v - 15, 1), hi: f(v + 15, 1) };
  }
  return out;
}

/** Free every unlocked coordinate of every design (±25 mm) when nothing is free yet, and the other variables; asks first. */
function ensureFreeCoordinates(): boolean {
  const s = useApp.getState();
  if (Object.keys(s.vehicleOptimizer.ranges).length) return true;
  if (!window.confirm('No free coordinates are chosen for the vehicle optimizer. Free all available (unlocked) coordinates (±25 mm), static camber and toe, tire pressure and ride height?')) return false;
  const extra = adjustmentRanges(s);
  const all = mergedCorners(s);
  const f = (x: number): Field => ({ text: String(Number(x.toFixed(2))), value: x });
  s.updateVehicleOptimizer((o) => {
    const ranges = { ...o.ranges };
    for (const { root } of designRoots(s)) {
      const g = all[root].geom;
      for (const k of POINT_KEYS) for (const a of [0, 1, 2] as const) {
        if (pointAxisLocked(s.locks, root, k, a, g.damperArm, g.kind, layoutOf(g), g.steerMechanism, g.steeredAxle)) continue;
        const v = g.points[k][a].value;
        ranges[vehVarKey(root, k, a)] = { lo: f(v - OPT_DEFAULT_RANGE), hi: f(v + OPT_DEFAULT_RANGE) };
      }
    }
    return { ...o, ranges: { ...ranges, ...extra } };
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

/** The free ranges widened ×k about their centers (always containing the current value); points only — the adjustments (camber, toe, pressure, ride height) keep theirs. */
function widened(p: VehicleProblem, k: number): VehicleProblem['variables'] {
  if (k <= 1) return p.variables;
  return p.variables.map((v) => {
    if (isVehScalar(v.point)) return v;
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

/** Run the tests (several at once; the results show in the Tests panel); priority-weighted score. */
async function runSet(tests: TestDesign[], mode: 'pass' | 'improve' | 'explore', isStopped: () => boolean): Promise<SetRun | null> {
  if (isStopped()) return null;
  const fresh = tests.map((t) => useApp.getState().tests.find((x) => x.id === t.id) ?? t);
  const results = await runTestsTogether(fresh);
  if (isStopped()) return null;
  const runs: SetRun['runs'] = [];
  for (let i = 0; i < fresh.length; i++) {
    const run = results[i];
    if (!run) throw new Error(useRun.getState().error ?? `Test “${fresh[i]!.name}” could not run`);
    runs.push({ test: fresh[i]!, run });
  }
  return { runs, passed: runs.every((r) => r.run.passed), score: scoreOfRuns(runs.map((r) => r.test), runs.map((r) => r.run), mode) };
}

const describe = (set: SetRun) => {
  const failing = set.runs.filter((r) => !r.run.passed).length;
  const warn = set.runs.some((r) => r.run.severity === 'warn');
  // Speeds as maximums: the time too.
  const timed = set.runs.filter((r) => r.run.time);
  const time = timed.length ? ` · time ${timed.map((r) => `${r.run.time!.toFixed(2)} s`).join(' + ')}` : '';
  if (set.runs.length === 1) return (set.passed ? (warn ? 'passes with warnings' : 'passes') : 'fails') + time;
  return (set.passed ? `all ${set.runs.length} pass${warn ? ' (some with warnings)' : ''}` : `${failing} of ${set.runs.length} fail`) + time;
};

const MAX_ROUNDS = 40;

/**
 * Round 4 (F24): the share of each round's move tried on the tests as driven — the round's own goal (less grip
 * use at the planned states) doesn't always point toward a faster driven lap (F12: every full move made the
 * default car's lap slower), a smaller step of it may. The best is kept (when better than not moving).
 * Last the smallest: a design ends up as it was tried last least often.
 */
export const ROUND_STEPS = [1, 0.5, 0.25];

/**
 * Optimize, then — when the rear copies the front's design — try separating them (offerSplit) and offer it if
 * it helps.
 */
export async function optimizeTests(scope: Scope, active: TestDesign | null, mode: 'pass' | 'improve'): Promise<void> {
  useLoop.setState({ splitOffer: null });
  await optimizeTestsOnly(scope, active, mode);
  const o = useLoop.getState().outcome;
  if (o === 'passed' || o === 'improved' || o === 'stuck') await offerSplit(scope, active, mode);
}

/** Separate the front and rear designs (the rear's own copy, its optimizer ranges copied from the front's). */
export function separateRear(rear?: DesignState['corners'][CornerId]) {
  const s = useApp.getState();
  s.setLink('rearFromFront', false);
  const t = useApp.getState();
  if (rear) useApp.setState({ corners: { ...t.corners, RL: rear } });
  t.updateVehicleOptimizer((o) => ({
    ...o,
    ranges: { ...o.ranges, ...Object.fromEntries(Object.entries(o.ranges).filter(([k]) => k.startsWith('FL.')).map(([k, v]) => [`RL${k.slice(2)}`, v])) },
  }));
}

/**
 * Round 4, F23: with the rear copying the front, try separating them — one round with the rear free, from the
 * current design and (with a snapshot) from the snapshot's rear — then put the design back and offer the
 * faster one if it beats the current by ≥ 0.3 %.
 */
export async function offerSplit(scope: Scope, active: TestDesign | null, mode: 'pass' | 'improve') {
  const s0 = useApp.getState();
  if (!s0.links.rearFromFront || isOneAxle(mergedCorners(s0)[rootOf('RL', s0.links)].geom.kind)) return;
  const tests = testsInScope(scope, active);
  if (!tests.length) return;
  const before = pickDesign(s0);
  const results = useRun.getState().results;
  let stopped = false;
  let currentCancel: (() => void) | null = null;
  useLoop.setState({ running: true, cancel: () => { stopped = true; currentCancel?.(); useRun.getState().cancel?.(); } });
  const isStopped = () => stopped;
  // (The undo step too: the tries apply moves, and Undo must still go back to before the optimize run.)
  const undo0 = s0.vehOptUndo;
  const restore = () => { useApp.setState({ ...before, vehOptUndo: undo0 }); useRun.setState({ results }); };
  try {
    log('Trying separate front and rear designs (one round with the rear free)…');
    const base = await runSet(tests, mode, isStopped);
    if (!base) return;
    const tried: { state: DesignState; from: 'current' | 'snapshot'; score: number; time: number }[] = [];
    const snaps = useSnapshots.getState().list;
    const snap = snaps.find((x) => x.id === useSnapshots.getState().activeId) ?? snaps[snaps.length - 1];
    const starts: { from: 'current' | 'snapshot'; rear?: DesignState['corners'][CornerId] }[] = [{ from: 'current' }];
    if (snap) starts.push({ from: 'snapshot', rear: mergedCorners(snap.design)[rootOf('RL', snap.design.links)] });
    for (const st of starts) {
      if (stopped) break;
      separateRear(st.rear);
      const built = buildVehicleProblem(useApp.getState(), { caseSource: scope === 'all' ? 'all' : tests[0]!.id, plans: lastPlans() });
      if (built.blockers.length || !built.problem.variables.length) log(`Separate front and rear: couldn't try (${built.blockers.join(' ') || 'nothing free to move'}).`);
      else {
        const h = runVehicleOptimizer({ ...built.problem, maxIterations: 25 }, () => {});
        currentCancel = h.stop;
        const { result } = await h.done;
        currentCancel = null;
        if (!stopped) {
          useApp.getState().applyVehicleOptimized(result.variables.map((v) => vehUpdateOf(v, v.after)));
          const next = await runSet(tests, mode, isStopped);
          if (next) {
            const time = next.runs.reduce((a, r) => a + (r.run.time ?? 0), 0);
            tried.push({ state: pickDesign(useApp.getState()), from: st.from, score: next.score, time });
            log(`Separate, the rear from ${st.from === 'current' ? 'the current design' : `the snapshot “${snap!.name}”`}: score ${base.score.toFixed(2)} → ${next.score.toFixed(2)}${time ? ` · time ${time.toFixed(2)} s` : ''}`);
          }
        }
      }
      restore();
    }
    if (stopped) { log('Stopped trying separate front and rear.'); return; }
    const best = tried.sort((a, b) => a.score - b.score)[0];
    const baseTime = base.runs.reduce((a, r) => a + (r.run.time ?? 0), 0);
    if (best && best.score < base.score * (1 - 0.003)) {
      useLoop.setState({ splitOffer: { state: best.state, from: best.from, before: baseTime, after: best.time, ...(best.from === 'snapshot' ? { snapshotName: snap!.name } : {}) } });
      log('Separating the front and rear designs helps: see the offer below.');
    } else log('Separate front and rear designs didn\'t help: kept them shared.');
  } catch (e) {
    restore();
    log(`Trying separate front and rear failed: ${e instanceof Error ? e.message : String(e)}`);
  } finally {
    useLoop.setState({ running: false, cancel: null });
  }
}

/** Accept the offer: the separated design it found. */
export function acceptSplit() {
  const o = useLoop.getState().splitOffer;
  if (!o) return;
  useApp.setState(o.state);
  useLoop.setState({ splitOffer: null });
  void runTestsTogether(useApp.getState().tests.filter((t) => t.enabled !== false));
}

async function optimizeTestsOnly(scope: Scope, active: TestDesign | null, mode: 'pass' | 'improve'): Promise<void> {
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
  timeRefs.clear(); // times count against where this optimizing began
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
    // The brake ladder: after a test run, size the brakes to the hardest stop and run again if they changed.
    let brakeSizings = 0;
    const sizeAndRerun = async (): Promise<boolean> => {
      if (!useLoop.getState().sizeBrakes || !useApp.getState().brakes.on || brakeSizings >= 6) return false;
      const z = sizeBrakesFrom(set.runs.map((r) => r.run));
      if (!z) return false;
      for (const b of z.blocked) log(`Brakes: ${b}`);
      if (!z.changes.length) return false;
      brakeSizings++;
      log(`Brakes sized: ${z.changes.join('; ')}`);
      const next = await runSet(tests, mode, isStopped);
      if (!next) return false;
      set = next;
      return true;
    };
    await sizeAndRerun();
    // Springs / dampers on the ride, when geometry alone stops helping (once per stall).
    const tryRates = async (): Promise<boolean> => {
      if (!rates.withLoop || ratesTried || !rateVars(useApp.getState(), rates).length) return false;
      ratesTried = true;
      const r = await tuneSpringsDampers(scope, active, mode, { setCancel: (fn) => { currentCancel = fn; } });
      if (stopped || !r?.improved) return false;
      const next = await runSet(tests, mode, isStopped);
      if (!next) return false;
      // The tests as driven decide, as for a geometry round: worse, the rates are put back (round 4: kept before).
      if (next.score > set.score * 1.0005 + 1e-6) {
        revertRates();
        log(`After springs & dampers: ${describe(next)} · score ${set.score.toFixed(2)} → ${next.score.toFixed(2)}: worse, put back`);
        return false;
      }
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
      const built = buildVehicleProblem(useApp.getState(), { caseSource, plans: lastPlans() });
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
      let undone = false;
      if (moved >= 0.05) {
        // F24: the move at the full step, ½ and ¼, each driven; the best kept (if better than not moving).
        const at = (f: number) => result.variables.map((v) => vehUpdateOf(v, v.before + f * (v.after - v.before)));
        const ids = tests.map((t) => t.id);
        const kept = resultsOf(ids);
        const undoBefore = useApp.getState().vehOptUndo;
        let roundUndo: typeof undoBefore = null;
        let best: { f: number; set: SetRun; results: ReturnType<typeof resultsOf> } | null = null;
        const tried: string[] = [];
        for (const f of ROUND_STEPS) {
          useApp.getState().applyVehicleOptimized(at(f));
          roundUndo ??= useApp.getState().vehOptUndo;
          const next = await runSet(tests, mode, isStopped);
          if (!next) { useLoop.setState({ outcome: 'stopped' }); return; }
          tried.push(`${f === 1 ? 'full' : f === 0.5 ? '½' : '¼'} ${next.score.toFixed(2)}${next.runs.some((r) => r.run.time) ? ` (${next.runs.filter((r) => r.run.time).map((r) => `${r.run.time!.toFixed(2)} s`).join(' + ')})` : ''}`);
          if (!best || next.score < best.set.score) best = { f, set: next, results: resultsOf(ids) };
        }
        const steps = `steps tried: ${tried.join(', ')}`;
        if (!best || best.set.score > set.score * 1.0005 + 1e-6) {
          // Worse at every step (the round's steady states improved, the runs didn't): undo it, the results
          // shown back to the kept design's, and go on as if nothing moved (wider ranges next).
          log(`Round ${round}: no step better · score ${set.score.toFixed(2)} → best ${best ? best.set.score.toFixed(2) : '—'}: undone (${steps})`);
          // (Exactly the geometry from before the round: the trials' first apply kept it for its undo.)
          useApp.setState({ vehOptUndo: roundUndo });
          useApp.getState().undoVehicleOptimized();
          useApp.setState({ vehOptUndo: undoBefore });
          restoreResults(kept);
          gain = 0;
          undone = true;
        } else {
          const last = ROUND_STEPS[ROUND_STEPS.length - 1]!;
          if (best.f !== last) { useApp.getState().applyVehicleOptimized(at(best.f)); restoreResults(best.results); }
          useApp.setState({ vehOptUndo: roundUndo });
          if (k > 1) growRanges(at(best.f).map((u) => ({ key: vehRangeKeyOf(u), value: u.value })));
          gain = set.score > 0 ? (set.score - best.set.score) / set.score : 0;
          const step = best.f === 1 ? 'the full step' : best.f === 0.5 ? 'half the step' : 'a quarter of the step';
          log(`Round ${round}: ${describe(best.set)} · score ${set.score.toFixed(2)} → ${best.set.score.toFixed(2)} (${(gain * 100).toFixed(1)}% better) with ${step} · largest move ${(moved * best.f).toFixed(1)} mm (${steps})`);
          set = best.set;
          await sizeAndRerun();
        }
      } else {
        log(`Round ${round}: nothing moved${k > 1 ? ` at ×${k}` : ' within your ranges'}.`);
      }
      // Nothing moved, or undone (the same design again would repeat the same round exactly): wider ranges next.
      slow = moved < 0.05 || undone ? 2 : gain < 0.01 ? slow + 1 : 0;
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
    const built = buildVehicleProblem(s, { caseSource: scope === 'all' ? 'all' : tests[0]!.id, plans: lastPlans() });
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
    // The candidate on every test, several at once.
    const jobs = new Set<() => void>();
    currentCancel = () => { for (const c of jobs) c(); };
    const after = await runLimited(tests, POOL_SIZE, async (t) => {
      const job = runTestJob(candidate, t.segments.map((sg) => segmentSpec(sg, t)), { onFail: t.onFail, speedLimits: false, ...planOption(t, false) });
      let stop = () => {};
      const cancelled = new Promise<null>((res) => { stop = () => { job.cancel(); res(null); }; });
      jobs.add(stop);
      try { return await Promise.race([job.done, cancelled]); } finally { jobs.delete(stop); }
    }, () => stopped);
    if (stopped || after.some((r) => !r)) { useLoop.setState({ outcome: 'stopped' }); return; }
    const runsAfter = after as TestRun[];
    const w = (t: TestDesign) => (tests.length > 1 ? rankWeight(t.rank, tests.length) : 1);
    const tw = tests.reduce((a, t) => a + w(t), 0) || 1;
    const afterScore = tests.reduce((a, t, i) => a + w(t) * testScore(runsAfter[i]!, 'pass', t.id), 0) / tw;
    const moves = result.variables.map((v, i) => {
      const orig = p.variables[i]!;
      return {
        key: vehRangeKeyOf(vehUpdateOf(v, v.after)), label: isVehScalar(v.point) ? `${v.root} ${v.point}` : `${v.root} ${pointKeyOf(v.point)} ${'XYZ'[v.axis]}`,
        before: v.before, after: v.after, outside: v.after < Math.min(orig.lo, orig.hi) - 1e-6 || v.after > Math.max(orig.lo, orig.hi) + 1e-6,
      };
    }).filter((m) => Math.abs(m.after - m.before) > 0.05);
    const passed = runsAfter.every((r) => r.passed);
    const exploration: Exploration = {
      before: before.score, after: afterScore, moves, testIds: tests.map((t) => t.id),
      candidate: { passed, severity: runsAfter.some((r) => r.severity === 'fail') ? 'fail' : runsAfter.some((r) => r.severity === 'warn') ? 'warn' : 'pass' },
      updates: result.variables.map((v) => vehUpdateOf(v, v.after)),
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
