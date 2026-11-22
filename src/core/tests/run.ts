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
import { rideOn, type RideMeasures } from './ride';
import { classifyState, fadeFindings, worstSeverity, PROFILES, type CheckProfile, type Finding, type Severity } from './checks';
import { brakeStep, padFactors, type AxleTemps } from '../vehicle/brakeThermal';

export interface StateResult {
  state: RoadState;
  converged: boolean;
  pose: ChassisPose | null;
  corners: Record<CornerId, { tireLoad: number; lateralForce: number; longitudinalForce: number; brakeForce: number; travel: number; status: CornerStatus; inclination: number; onBumpStop: boolean }> | null;
  grip: GripSummary | null;
  findings: Finding[];
  severity: Severity;
  /** No Fail finding. */
  passed: boolean;
  /** Steering the state needs (turns only), slip angles included. */
  steer?: SteerNeed | null;
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
  /** Passes as steady states but fails over time (ride: bumps, transients). */
  rideFail?: boolean;
  /** Brake fade modeled: rotor temperatures at the start and end of the segment, °C. */
  brakeTemp?: { start: AxleTemps; end: AxleTemps };
}

export interface TestRunOptions {
  /** What to do when a segment fails. */
  onFail: 'report' | 'lift';
  /** Search the speed limit of failing segments (always on for 'lift'). */
  speedLimits?: boolean;
  /** Also drive the test over time (Phase B ride) and check every moment. */
  ride?: boolean;
  /** Over time, a driver steers along the path (Phase C handling; with `ride`). */
  handling?: boolean;
}

export interface TestRun {
  severity: Severity;
  passed: boolean;
  states: StateResult[];
  segments: SegmentResult[];
  /** Assembly failed (geometry can't be built). */
  error?: string;
  /** The ride over time (Phase B) when asked for: frames for playback. */
  ride?: { frames: PlaybackFrame[]; metrics?: RideMeasures; error?: string };
}

/** Segment physics plus the checks that decide its pass / fail. */
export type TestSegmentSpec = SegmentSpec & { checks?: CheckProfile; weight?: number };

/** Front − rear mean slip angle (rad, + = understeer) of a solved state; 0 without grip data. */
export function slipDifference(r: VehicleResult | null | undefined): number {
  const g = r?.grip;
  if (!g) return 0;
  const mean = (ids: CornerId[]) => ids.reduce((a, id) => a + Math.abs(g.corners[id].slipAngle), 0) / ids.length;
  const d = (mean(['FL', 'FR']) - mean(['RL', 'RR'])) * (Math.PI / 180);
  return Number.isFinite(d) ? d : 0;
}

/** Steering a segment's turn needs at a solved state (null on a straight or without steering data). */
export const steerNeedOf = (p: VehicleProblem, asm: AssembledVehicle, seg: Pick<SegmentSpec, 'path' | 'radius'>, result?: VehicleResult | null): SteerNeed | null =>
  (p.steering ? steerForTurn(asm.built, p.roots, p.steering, p.wheelbase, seg.path, seg.radius, slipDifference(result)) : null);

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

function evalState(p: VehicleProblem, asm: AssembledVehicle, st: RoadState, checks: CheckProfile, guess?: ChassisPose, seg?: Pick<SegmentSpec, 'path' | 'radius'>): StateResult {
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
  const steer = seg ? steerNeedOf(p, asm, seg, e?.result) : null;
  if (steer) st.rack = steer.rackUsed;
  const findings = classifyState(stateFacts(p, asm, st, e?.result ?? null, steer), checks);
  const severity = worstSeverity(findings);
  if (!e) return { state: st, converged: false, pose: null, corners: null, grip: null, findings, severity, passed: false, steer };
  const r = e.result;
  const corners = Object.fromEntries(CORNER_IDS.map((id) => {
    const c = r.corners[id];
    return [id, { tireLoad: c.tireLoad, lateralForce: c.lateralForce, longitudinalForce: c.longitudinalForce, brakeForce: c.brakeForce, travel: c.travel, status: c.status, inclination: c.inclination, onBumpStop: c.onBumpStop }];
  })) as StateResult['corners'];
  const out: StateResult = { state: st, converged: true, pose: r.pose, corners, grip: r.grip ?? null, findings, severity, passed: severity !== 'fail', steer };
  rawResults.set(out, r);
  return out;
}

/** The full solve behind each state result (for checks made after the solve, e.g. brake fade). */
const rawResults = new WeakMap<StateResult, VehicleResult>();

const dedupe = (fs: Finding[]): Finding[] => {
  const seen = new Map<string, Finding>();
  for (const f of fs) if (!seen.has(`${f.check}|${f.text}`)) seen.set(`${f.check}|${f.text}`, f);
  // Fails first.
  return [...seen.values()].sort((a, b) => (a.severity === b.severity ? 0 : a.severity === 'fail' ? -1 : 1));
};

/** Fastest speed scale (0–1) at which every sample of the segment has no Fail. */
function speedLimitOf(p: VehicleProblem, asm: AssembledVehicle, seg: TestSegmentSpec, index: number, checks: CheckProfile): number {
  const passes = (k: number) => segmentStates(seg, index, k, dimsOf(p, asm)).every((st) => evalState(p, asm, st, checks, undefined, seg).passed);
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
  // Brake fade: the rotors heat through the test (both hydraulics and fade modeled).
  const th = p.brakeLimit ? p.brakeThermal : undefined;
  let temp: AxleTemps | null = th ? { front: th.start, rear: th.start } : null;
  const fadeOf = (rs: StateResult[], seg: TestSegmentSpec, checks: CheckProfile): { start: AxleTemps; end: AxleTemps } | undefined => {
    if (!th || !temp || !p.brakeLimit) return undefined;
    // Energy into the brakes ≈ the samples' mean braking force × the distance (∫ F v dt = ∫ F ds).
    const ok = rs.filter((r) => r.corners);
    const mean = (f: (r: StateResult) => number) => (ok.length ? ok.reduce((a, r) => a + f(r), 0) / ok.length : 0);
    const force = { front: mean((r) => -(r.corners!.FL.brakeForce + r.corners!.FR.brakeForce)), rear: mean((r) => -(r.corners!.RL.brakeForce + r.corners!.RR.brakeForce)) };
    const v = Math.max(0.1, (seg.v0 + seg.v1) / 2), T = seg.distance / v;
    const start = temp, end = brakeStep(th, temp, force, v, T);
    temp = end;
    // Check every sample at the hottest the segment gets.
    const peak = { front: Math.max(start.front, end.front), rear: Math.max(start.rear, end.rear) };
    const fade = { temp: peak, factor: padFactors(th, peak) };
    for (const r of rs) {
      const st = rawResults.get(r);
      const extra = fadeFindings(st ?? null, fade, p.brakeLimit, checks);
      if (!extra.length) continue;
      r.findings = [...r.findings, ...extra];
      r.severity = worstSeverity(r.findings);
      r.passed = r.severity !== 'fail';
    }
    return { start, end };
  };
  segments.forEach((seg, i) => {
    const checks = seg.checks ?? PROFILES.default.checks;
    const rs = segmentStates(seg, i, 1, dimsOf(p, asm)).map((st) => {
      const r = evalState(p, asm, st, checks, guess, seg);
      if (r.pose) guess = r.pose;
      return r;
    });
    const brakeTemp = fadeOf(rs, seg, checks);
    states.push(...rs);
    const findings = dedupe(rs.flatMap((r) => r.findings));
    const severity = worstSeverity(findings);
    const res: SegmentResult = {
      index: i, severity, passed: severity !== 'fail', findings,
      maxUtilization: Math.max(...rs.map((r) => r.grip?.maxUtilization ?? Infinity)),
      impossible: findings.some((f) => f.check === 'beyondGrip'),
      // The sample needing the most steering.
      steer: rs.reduce<SteerNeed | null>((a, x) => (x.steer && (!a || Math.abs(x.steer.wheelAngle) > Math.abs(a.wheelAngle)) ? x.steer : a), null),
      ...(brakeTemp ? { brakeTemp } : {}),
    };
    if (!res.passed && (opts.onFail === 'lift' || opts.speedLimits)) {
      res.speedLimit = speedLimitOf(p, asm, seg, i, checks);
      if (opts.onFail === 'lift' && res.speedLimit > 0) res.lifted = segmentStates(seg, i, res.speedLimit, dimsOf(p, asm)).map((st) => evalState(p, asm, st, checks, undefined, seg));
    }
    segs.push(res);
  });
  let ride: TestRun['ride'];
  if (opts.ride) {
    const rr = rideOn(p, asm, segments, { handling: !!opts.handling });
    ride = { frames: withBrakeTemps(p, rr.frames), metrics: rr.metrics, ...(rr.error ? { error: rr.error } : {}) };
    segs.forEach((sr, i) => {
      // Add what only shows over time (the steady samples already report the rest).
      const steadyKeys = new Set(sr.findings.map((f) => `${f.check}|${(f.corners ?? []).join(',')}`));
      const extra = (rr.findings[i] ?? []).filter((f) => !steadyKeys.has(`${f.check}|${(f.corners ?? []).join(',')}`));
      if (!extra.length) return;
      sr.findings = dedupe([...sr.findings, ...extra]);
      const sev = worstSeverity(sr.findings);
      if (sr.passed && sev === 'fail') sr.rideFail = true;
      sr.severity = sev;
      sr.passed = sev !== 'fail';
    });
  }
  const severity = worstSeverity(segs.flatMap((s) => s.findings));
  return { severity, passed: severity !== 'fail', states, segments: segs, ...(ride ? { ride } : {}) };
}

/**
 * Rotor temperatures for frames that don't carry them (the ride over time): the braking force from each
 * frame's deceleration and grade, m·g·(−a_x − sin grade), split by the brake bias (no drag), integrated
 * frame to frame. Frames are returned unchanged when fade isn't modeled.
 */
export function withBrakeTemps(p: VehicleProblem, frames: PlaybackFrame[]): PlaybackFrame[] {
  const th = p.brakeLimit ? p.brakeThermal : undefined;
  if (!th || !frames.length || frames.every((f) => f.brakeTemp)) return frames;
  const bias = Math.min(1, Math.max(0, p.brakeBias ?? 0.6));
  let temp: AxleTemps = { front: th.start, rear: th.start };
  return frames.map((f, i) => {
    const out = { ...f, brakeTemp: temp };
    const dt = i + 1 < frames.length ? Math.max(0, frames[i + 1]!.t - f.t) : 0;
    const F = Math.max(0, p.mass * G * (-f.ax - Math.sin(f.grade)));
    temp = brakeStep(th, temp, { front: F * bias, rear: F * (1 - bias) }, f.speed, dt);
    return out;
  });
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
  /** Brake fade modeled: rotor temperatures at this moment, °C. */
  brakeTemp?: AxleTemps;
  /** Ride over time (Phase B): the body pose, each travel (mm) and tire load (N) at this moment. */
  ride?: { pose: ChassisPose; travel: Record<CornerId, number>; tireLoad: Record<CornerId, number> };
  /** Handling (Phase C): distance off the path (m, + left), sideslip (deg), yaw rate (rad/s), mean steer angle (deg), at full lock. */
  handling?: { pathError: number; sideslip: number; yawRate: number; steer: number; atLock: boolean; path: { x: number; y: number } };
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
  const th = p.brakeLimit ? p.brakeThermal : undefined;
  let temp: AxleTemps | null = th ? { front: th.start, rear: th.start } : null;
  segments.forEach((sg, i) => {
    const T = durations[i]!;
    if (!(T > 0)) return;
    const a = (sg.v1 - sg.v0) / T; // m/s², constant over the segment
    const checks = sg.checks ?? PROFILES.default.checks;
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
      const st: RoadState = { name: `${i + 1}@${sAlong.toFixed(1)}m`, segment: i, speed: v, ay, ax, at: sAlong, ...roadEffective(ay, ax, sg.grade, sg.bank), groundOffset: ground, grade: sg.grade, bank: sg.bank };
      const r = evalState(p, asm, st, checks, guess, sg);
      if (r.pose) guess = r.pose;
      let brakeTemp: AxleTemps | undefined;
      if (th && temp && p.brakeLimit) {
        const c = r.corners;
        const force = c ? { front: -(c.FL.brakeForce + c.FR.brakeForce), rear: -(c.RL.brakeForce + c.RR.brakeForce) } : { front: 0, rear: 0 };
        const extra = fadeFindings(rawResults.get(r) ?? null, { temp, factor: padFactors(th, temp) }, p.brakeLimit, checks);
        if (extra.length) { r.findings = [...r.findings, ...extra]; r.severity = worstSeverity(r.findings); }
        brakeTemp = temp;
        temp = brakeStep(th, temp, force, v, Math.min(dt, T - tt));
      }
      frames.push({
        t: t0 + tt, segment: i, s: sAlong, speed: v, ay, ax, grade: sg.grade, bank: sg.bank, groundOffset: ground,
        pos: { x, y, z }, heading, rack: r.steer?.rackUsed ?? 0, severity: r.severity,
        utilization: Object.fromEntries(CORNER_IDS.map((id) => [id, r.grip?.corners[id].utilization ?? NaN])) as Record<CornerId, number>,
        findings: r.findings.filter((f) => f.severity !== 'pass').map((f) => f.text),
        ...(brakeTemp ? { brakeTemp } : {}),
      });
    }
    t0 += T;
  });
  return frames;
}
