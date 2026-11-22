/**
 * Run a test (a chain of segments) on the whole car: every segment's speed samples are solved as steady
 * states and classified by the segment's checks (Pass / Warning / Fail, see checks.ts). Failing segments
 * get their speed limit (the fastest speed scale with no Fail), and with "driver lifts" the segment is
 * re-run at that speed.
 */
import { assembleVehicle, solveCase, type VehicleProblem, type AssembledVehicle } from '../optimize/vehicle';
import type { DoubleWishboneGeometry } from '../suspension/doubleWishbone';
import { CORNER_IDS, type CornerId, type ChassisPose, type CornerStatus, type GripSummary, type VehicleResult } from '../vehicle/vehicle';
import { segmentStates, segmentLatG, roadEffective, G, type RoadState, type SegmentSpec, type CarDims } from './segments';
import { wheelHeights } from './road';
import { steerForTurn, type SteerNeed } from './steer';
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
  /** Steering the turn needs (turns only). */
  steer?: SteerNeed | null;
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

/** Steering a segment's turn needs (null on a straight or without steering data). */
export const steerNeedOf = (p: VehicleProblem, asm: AssembledVehicle, seg: Pick<SegmentSpec, 'path' | 'radius'>): SteerNeed | null =>
  (p.steering ? steerForTurn(asm.built, p.roots, p.steering, p.wheelbase, seg.path, seg.radius) : null);

export function stateFacts(p: VehicleProblem, asm: AssembledVehicle, st: RoadState, result: VehicleResult | null, steer?: SteerNeed | null) {
  const track = Math.abs(asm.chars.FL.contactPoint.x) + Math.abs(asm.chars.RL.contactPoint.x); // average track
  const along = st.accelG - st.brakingG;
  return {
    result, lateralG: st.lateralG, rolloverG: track / 2 / Math.max(p.cg.height, 1),
    weight: p.mass * G * st.gravityScale, brakeForce: p.mass * G * st.brakingG,
    requiredG: Math.hypot(st.lateralG, along) / Math.max(st.gravityScale, 1e-6),
    availableG: availableG(p, asm), steer,
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

function evalState(p: VehicleProblem, asm: AssembledVehicle, st: RoadState, checks: CheckProfile, guess?: ChassisPose, steer?: SteerNeed | null): StateResult {
  const spec = {
    name: st.name, kind: 'state' as const, g: Math.hypot(st.ay, st.ax), lateralG: st.lateralG, brakingG: st.brakingG, accelG: st.accelG,
    gravityScale: st.gravityScale, groundOffset: st.groundOffset, state: st,
  };
  let e = solveCase(p, asm, spec, guess);
  // The previous state's pose is usually a good start, but a very different state (a bump, a dip) can
  // send the solver astray from it: try again from the design pose.
  if (guess && !e?.result.converged) {
    const cold = solveCase(p, asm, spec);
    if (cold && (cold.result.converged || !e)) e = cold;
  }
  const findings = classifyState(stateFacts(p, asm, st, e?.result ?? null, steer), checks);
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
  const steer = steerNeedOf(p, asm, seg);
  const passes = (k: number) => segmentStates(seg, index, k, dimsOf(p, asm)).every((st) => evalState(p, asm, st, checks, undefined, steer).passed);
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
    const steer = steerNeedOf(p, asm, seg);
    const rs = segmentStates(seg, i, 1, dimsOf(p, asm)).map((st) => {
      if (steer) st.rack = steer.rackUsed;
      const r = evalState(p, asm, st, checks, guess, steer);
      if (r.pose) guess = r.pose;
      return r;
    });
    states.push(...rs);
    const findings = dedupe(rs.flatMap((r) => r.findings));
    const severity = worstSeverity(findings);
    const res: SegmentResult = {
      index: i, severity, passed: severity !== 'fail', findings,
      maxUtilization: Math.max(...rs.map((r) => r.grip?.maxUtilization ?? Infinity)),
      impossible: findings.some((f) => f.check === 'beyondGrip'), steer,
    };
    if (!res.passed && (opts.onFail === 'lift' || opts.speedLimits)) {
      res.speedLimit = speedLimitOf(p, asm, seg, i, checks);
      if (opts.onFail === 'lift' && res.speedLimit > 0) res.lifted = segmentStates(seg, i, res.speedLimit, dimsOf(p, asm)).map((st) => evalState(p, asm, st, checks, undefined, steer));
    }
    segs.push(res);
  });
  const severity = worstSeverity(segs.flatMap((s) => s.findings));
  return { severity, passed: severity !== 'fail', states, segments: segs };
}

/** Wheelbase and half track of the assembled car, mm. */
export const dimsOf = (p: VehicleProblem, asm: AssembledVehicle): CarDims => ({
  wheelbase: p.wheelbase, halfTrack: (Math.abs(asm.chars.FL.contactPoint.x) + Math.abs(asm.chars.RL.contactPoint.x)) / 2,
});

export interface PlaybackFrame {
  t: number;
  segment: number;
  /** Distance along the segment, m. */
  s: number;
  speed: number;
  ay: number;
  ax: number;
  grade: number;
  bank: number;
  groundOffset: Partial<Record<CornerId, number>>;
  /** Position on the test track, top view (m) and height (m); heading, rad. */
  pos: { x: number; y: number; z: number };
  heading: number;
  /** Rack travel for the turn, mm (left corner's rack, clamped to the limit). */
  rack: number;
  severity: Severity;
  utilization: Record<CornerId, number>;
  findings: string[];
}

/**
 * The car driven through the test at constant acceleration per segment, solved every 1/hz s (fewer
 * frames for long tests). Each frame is a steady state (Phase A): no transients yet.
 */
export function playbackFrames(
  p: VehicleProblem, geometries: Partial<Record<CornerId, DoubleWishboneGeometry>>, segments: TestSegmentSpec[], hz = 10, maxFrames = 600,
): PlaybackFrame[] {
  const asm = assembleVehicle(p, geometries);
  if (!asm) return [];
  const dims = dimsOf(p, asm);
  const durations = segments.map((sg) => {
    const v = (sg.v0 + sg.v1) / 2;
    return v > 0 ? sg.distance / v : 0;
  });
  const total = durations.reduce((a, b) => a + b, 0);
  const dt = Math.max(1 / hz, total / maxFrames);
  const frames: PlaybackFrame[] = [];
  let x = 0, y = 0, z = 0, heading = 0, t0 = 0;
  let guess: ChassisPose | undefined;
  segments.forEach((sg, i) => {
    const T = durations[i]!;
    if (!(T > 0)) return;
    const a = (sg.v1 - sg.v0) / T; // m/s², constant over the segment
    const checks = sg.checks ?? PROFILES.default.checks;
    const steer = steerNeedOf(p, asm, sg);
    let lastS = 0;
    for (let tt = 0; tt < T - 1e-9; tt += dt) {
      const sAlong = sg.v0 * tt + 0.5 * a * tt * tt;
      const v = sg.v0 + a * tt;
      // Advance the track position.
      const ds = sAlong - lastS;
      lastS = sAlong;
      const curv = sg.path === 'straight' ? 0 : (sg.path === 'left' ? 1 : -1) / Math.max(sg.radius, 0.1);
      heading += curv * ds;
      x += ds * Math.cos(heading);
      y += ds * Math.sin(heading);
      z += ds * Math.sin(sg.grade);
      const ay = segmentLatG(sg, v);
      const ax = sg.longG !== null && sg.longG !== undefined && Number.isFinite(sg.longG) ? sg.longG : a / G;
      const wh = sg.road ? wheelHeights(sg.road, sAlong, dims.wheelbase / 1000, dims.halfTrack / 1000) : { FL: 0, FR: 0, RL: 0, RR: 0 };
      const ground: Partial<Record<CornerId, number>> = {};
      for (const id of CORNER_IDS) { const h = (sg.bumps?.[id] ?? 0) + wh[id]; if (Math.abs(h) > 1e-6) ground[id] = h; }
      const st: RoadState = { name: `${i + 1}@${sAlong.toFixed(1)}m`, segment: i, speed: v, ay, ax, at: sAlong, ...roadEffective(ay, ax, sg.grade, sg.bank), groundOffset: ground, grade: sg.grade, bank: sg.bank, rack: steer?.rackUsed ?? 0 };
      const r = evalState(p, asm, st, checks, guess, steer);
      if (r.pose) guess = r.pose;
      frames.push({
        t: t0 + tt, segment: i, s: sAlong, speed: v, ay, ax, grade: sg.grade, bank: sg.bank, groundOffset: ground,
        pos: { x, y, z }, heading, rack: steer?.rackUsed ?? 0, severity: r.severity,
        utilization: Object.fromEntries(CORNER_IDS.map((id) => [id, r.grip?.corners[id].utilization ?? NaN])) as Record<CornerId, number>,
        findings: r.findings.filter((f) => f.severity !== 'pass').map((f) => f.text),
      });
    }
    t0 += T;
  });
  return frames;
}
