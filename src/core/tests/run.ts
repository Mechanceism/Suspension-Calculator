/**
 * Run a test (a chain of segments) on the whole car: every segment's speed samples are solved as steady
 * states and classified by the segment's checks (Pass / Warning / Fail, see checks.ts). Failing segments
 * get their speed limit (the fastest speed scale with no Fail), and with "driver lifts" the segment is
 * re-run at that speed.
 */
import { assembleVehicle, solveCase, type VehicleProblem, type AssembledVehicle } from '../optimize/vehicle';
import type { DoubleWishboneGeometry } from '../suspension/doubleWishbone';
import { CORNER_IDS, type CornerId, type ChassisPose, type CornerStatus, type GripSummary, type VehicleResult } from '../vehicle/vehicle';
import { segmentStates, G, type RoadState, type SegmentSpec } from './segments';
import { classifyState, worstSeverity, PROFILES, type CheckProfile, type Finding, type Severity } from './checks';

export interface StateResult {
  state: RoadState;
  converged: boolean;
  pose: ChassisPose | null;
  corners: Record<CornerId, { tireLoad: number; lateralForce: number; longitudinalForce: number; travel: number; status: CornerStatus; inclination: number; onBumpStop: boolean }> | null;
  grip: GripSummary | null;
  findings: Finding[];
  severity: Severity;
  /** No Fail finding. */
  passed: boolean;
}

export interface SegmentResult {
  index: number;
  severity: Severity;
  /** No Fail finding in any sample. */
  passed: boolean;
  /** Worst tire grip use across the segment's samples. */
  maxUtilization: number;
  /** Findings across the samples (one per check and text). */
  findings: Finding[];
  /** Asks for more than the tires can give at its own speed: no suspension can pass it. */
  impossible: boolean;
  /** Fastest speed scale (× the segment's speeds) with no Fail, when searched. */
  speedLimit?: number;
  /** "Driver lifts": the segment re-run at its speed limit. */
  lifted?: StateResult[];
}

export interface TestRunOptions {
  /** What to do when a segment fails. */
  onFail: 'report' | 'lift';
  /** Search the speed limit of failing segments (always on for 'lift'). */
  speedLimits?: boolean;
}

export interface TestRun {
  severity: Severity;
  passed: boolean;
  states: StateResult[];
  segments: SegmentResult[];
  /** Assembly failed (geometry can't be built). */
  error?: string;
}

/** Segment physics plus the checks that decide its pass / fail. */
export type TestSegmentSpec = SegmentSpec & { checks?: CheckProfile; weight?: number };

export function stateFacts(p: VehicleProblem, asm: AssembledVehicle, st: RoadState, result: VehicleResult | null) {
  const track = Math.abs(asm.chars.FL.contactPoint.x) + Math.abs(asm.chars.RL.contactPoint.x); // average track
  const along = st.accelG - st.brakingG;
  return {
    result, lateralG: st.lateralG, rolloverG: track / 2 / Math.max(p.cg.height, 1),
    weight: p.mass * G * st.gravityScale, brakeForce: p.mass * G * st.brakingG,
    requiredG: Math.hypot(st.lateralG, along) / Math.max(st.gravityScale, 1e-6),
    availableG: availableG(p, asm),
  };
}

/** Most the tires can give with the car at rest on level ground, g (cached per assembled car). */
const restGrip = new WeakMap<AssembledVehicle, number>();
function availableG(p: VehicleProblem, asm: AssembledVehicle): number {
  const c = restGrip.get(asm);
  if (c !== undefined) return c;
  const e = solveCase(p, asm, { name: 'rest', kind: 'state', g: 0, lateralG: 0, brakingG: 0, accelG: 0 });
  const g = e?.result.grip;
  const v = g ? CORNER_IDS.reduce((a, id) => a + g.corners[id].capacity, 0) / (p.mass * G) : Infinity;
  restGrip.set(asm, v);
  return v;
}

function evalState(p: VehicleProblem, asm: AssembledVehicle, st: RoadState, checks: CheckProfile, guess?: ChassisPose): StateResult {
  const e = solveCase(p, asm, {
    name: st.name, kind: 'state', g: Math.hypot(st.ay, st.ax), lateralG: st.lateralG, brakingG: st.brakingG, accelG: st.accelG,
    gravityScale: st.gravityScale, groundOffset: st.groundOffset, state: st,
  }, guess);
  const findings = classifyState(stateFacts(p, asm, st, e?.result ?? null), checks);
  const severity = worstSeverity(findings);
  if (!e) return { state: st, converged: false, pose: null, corners: null, grip: null, findings, severity, passed: false };
  const r = e.result;
  const corners = Object.fromEntries(CORNER_IDS.map((id) => {
    const c = r.corners[id];
    return [id, { tireLoad: c.tireLoad, lateralForce: c.lateralForce, longitudinalForce: c.longitudinalForce, travel: c.travel, status: c.status, inclination: c.inclination, onBumpStop: c.onBumpStop }];
  })) as StateResult['corners'];
  return { state: st, converged: true, pose: r.pose, corners, grip: r.grip ?? null, findings, severity, passed: severity !== 'fail' };
}

const dedupe = (fs: Finding[]): Finding[] => {
  const seen = new Map<string, Finding>();
  for (const f of fs) if (!seen.has(`${f.check}|${f.text}`)) seen.set(`${f.check}|${f.text}`, f);
  // Fails first.
  return [...seen.values()].sort((a, b) => (a.severity === b.severity ? 0 : a.severity === 'fail' ? -1 : 1));
};

/** Fastest speed scale (0–1) at which every sample of the segment has no Fail. */
function speedLimitOf(p: VehicleProblem, asm: AssembledVehicle, seg: TestSegmentSpec, index: number, checks: CheckProfile): number {
  const passes = (k: number) => segmentStates(seg, index, k).every((st) => evalState(p, asm, st, checks).passed);
  if (!passes(0.02)) return 0;
  let lo = 0.02, hi = 1;
  for (let i = 0; i < 12; i++) {
    const m = (lo + hi) / 2;
    if (passes(m)) lo = m; else hi = m;
  }
  return lo;
}

export function runTest(
  p: VehicleProblem, geometries: Partial<Record<CornerId, DoubleWishboneGeometry>>, segments: TestSegmentSpec[], opts: TestRunOptions,
): TestRun {
  const asm = assembleVehicle(p, geometries);
  if (!asm) return { severity: 'fail', passed: false, states: [], segments: [], error: 'The suspension geometry cannot be assembled.' };
  const states: StateResult[] = [];
  const segs: SegmentResult[] = [];
  let guess: ChassisPose | undefined;
  segments.forEach((seg, i) => {
    const checks = seg.checks ?? PROFILES.default.checks;
    const rs = segmentStates(seg, i).map((st) => {
      const r = evalState(p, asm, st, checks, guess);
      if (r.pose) guess = r.pose;
      return r;
    });
    states.push(...rs);
    const findings = dedupe(rs.flatMap((r) => r.findings));
    const severity = worstSeverity(findings);
    const res: SegmentResult = {
      index: i, severity, passed: severity !== 'fail', findings,
      maxUtilization: Math.max(...rs.map((r) => r.grip?.maxUtilization ?? Infinity)),
      impossible: findings.some((f) => f.check === 'beyondGrip'),
    };
    if (!res.passed && (opts.onFail === 'lift' || opts.speedLimits)) {
      res.speedLimit = speedLimitOf(p, asm, seg, i, checks);
      if (opts.onFail === 'lift' && res.speedLimit > 0) res.lifted = segmentStates(seg, i, res.speedLimit).map((st) => evalState(p, asm, st, checks));
    }
    segs.push(res);
  });
  const severity = worstSeverity(segs.flatMap((s) => s.findings));
  return { severity, passed: severity !== 'fail', states, segments: segs };
}
