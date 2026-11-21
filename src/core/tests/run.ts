/**
 * Run a test (a chain of segments) on the whole car: every segment's speed samples are solved as steady
 * states, with grip use and slip per tire. Failing segments can get their speed limit (the fastest
 * speed scale at which every tire stays within its grip, with margin), and with "driver lifts" the
 * segment is re-run at that speed.
 */
import { assembleVehicle, solveCase, type VehicleProblem, type AssembledVehicle } from '../optimize/vehicle';
import type { DoubleWishboneGeometry } from '../suspension/doubleWishbone';
import { CORNER_IDS, type CornerId, type ChassisPose, type CornerStatus, type GripSummary } from '../vehicle/vehicle';
import { segmentStates, type RoadState, type SegmentSpec } from './segments';

export interface StateResult {
  state: RoadState;
  converged: boolean;
  pose: ChassisPose | null;
  corners: Record<CornerId, { tireLoad: number; lateralForce: number; longitudinalForce: number; travel: number; status: CornerStatus; inclination: number }> | null;
  grip: GripSummary | null;
  /** Every tire within (1 − margin) of its grip, and no suspension at a travel limit. */
  passed: boolean;
  /** Corners at a travel limit (bottoming / topping out). */
  atLimit: CornerId[];
}

export interface SegmentResult {
  index: number;
  passed: boolean;
  /** Worst tire grip use across the segment's samples. */
  maxUtilization: number;
  /** Plain-language reasons it fails. */
  reasons: string[];
  /** Fastest speed scale (× the segment's speeds) that passes, when searched. */
  speedLimit?: number;
  /** "Driver lifts": the segment re-run at its speed limit. */
  lifted?: StateResult[];
}

export interface TestRunOptions {
  /** Required grip reserve, 0–1 (0.1 = no tire above 90% of its grip). */
  margin: number;
  /** What to do when a segment fails. */
  onFail: 'report' | 'lift';
  /** Search the speed limit of failing segments (always on for 'lift'). */
  speedLimits?: boolean;
}

export interface TestRun {
  passed: boolean;
  states: StateResult[];
  segments: SegmentResult[];
  /** Assembly failed (geometry can't be built). */
  error?: string;
}

function evalState(p: VehicleProblem, asm: AssembledVehicle, st: RoadState, margin: number, guess?: ChassisPose): StateResult {
  const e = solveCase(p, asm, {
    name: st.name, kind: 'state', g: Math.hypot(st.ay, st.ax), lateralG: st.lateralG, brakingG: st.brakingG, accelG: st.accelG,
    gravityScale: st.gravityScale, groundOffset: st.groundOffset, state: st,
  }, guess);
  if (!e) return { state: st, converged: false, pose: null, corners: null, grip: null, passed: false, atLimit: [] };
  const r = e.result;
  const corners = Object.fromEntries(CORNER_IDS.map((id) => {
    const c = r.corners[id];
    return [id, { tireLoad: c.tireLoad, lateralForce: c.lateralForce, longitudinalForce: c.longitudinalForce, travel: c.travel, status: c.status, inclination: c.inclination }];
  })) as StateResult['corners'];
  const atLimit = CORNER_IDS.filter((id) => r.corners[id].status !== 'ok');
  const grip = r.grip ?? null;
  const passed = !!grip && grip.maxUtilization <= 1 - margin && atLimit.length === 0;
  return { state: st, converged: true, pose: r.pose, corners, grip, passed, atLimit };
}

function reasonsOf(results: StateResult[], margin: number): string[] {
  const out = new Set<string>();
  for (const s of results) {
    if (!s.converged) { out.add(`${s.state.name}: the car can't settle (solve did not converge)`); continue; }
    for (const l of s.grip?.limits ?? []) out.add(l.text);
    if (s.grip && s.grip.maxUtilization > 1 - margin && s.grip.maxUtilization <= 1) out.add(`Grip use ${(s.grip.maxUtilization * 100).toFixed(0)}% is above the ${((1 - margin) * 100).toFixed(0)}% allowed`);
    if (s.atLimit.length) out.add(`${s.atLimit.join(', ')} at a travel limit (bottoming / topping out)`);
  }
  return [...out];
}

/** Fastest speed scale (0–1) at which every sample of the segment passes. */
function speedLimitOf(p: VehicleProblem, asm: AssembledVehicle, seg: SegmentSpec, index: number, margin: number): number {
  const passes = (k: number) => segmentStates(seg, index, k).every((st) => evalState(p, asm, st, margin).passed);
  if (!passes(0.02)) return 0;
  let lo = 0.02, hi = 1;
  for (let i = 0; i < 12; i++) {
    const m = (lo + hi) / 2;
    if (passes(m)) lo = m; else hi = m;
  }
  return lo;
}

export function runTest(
  p: VehicleProblem, geometries: Partial<Record<CornerId, DoubleWishboneGeometry>>, segments: SegmentSpec[], opts: TestRunOptions,
): TestRun {
  const asm = assembleVehicle(p, geometries);
  if (!asm) return { passed: false, states: [], segments: [], error: 'The suspension geometry cannot be assembled.' };
  const states: StateResult[] = [];
  const segs: SegmentResult[] = [];
  let guess: ChassisPose | undefined;
  segments.forEach((seg, i) => {
    const rs = segmentStates(seg, i).map((st) => {
      const r = evalState(p, asm, st, opts.margin, guess);
      if (r.pose) guess = r.pose;
      return r;
    });
    states.push(...rs);
    const passed = rs.every((r) => r.passed);
    const res: SegmentResult = {
      index: i, passed,
      maxUtilization: Math.max(...rs.map((r) => r.grip?.maxUtilization ?? Infinity)),
      reasons: passed ? [] : reasonsOf(rs, opts.margin),
    };
    if (!passed && (opts.onFail === 'lift' || opts.speedLimits)) {
      res.speedLimit = speedLimitOf(p, asm, seg, i, opts.margin);
      if (opts.onFail === 'lift' && res.speedLimit > 0) res.lifted = segmentStates(seg, i, res.speedLimit).map((st) => evalState(p, asm, st, opts.margin));
    }
    segs.push(res);
  });
  return { passed: segs.every((s) => s.passed), states, segments: segs };
}
