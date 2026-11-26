/**
 * Run a test (a chain of segments) on the whole car: every segment's speed samples are solved as steady
 * states and classified by the segment's checks (Pass / Warning / Fail, see checks.ts). Failing segments
 * get their speed limit (the fastest speed scale with no Fail), and with "driver lifts" the segment is
 * re-run at that speed.
 */
import { assembleVehicle, solveCase, type VehicleProblem, type AssembledVehicle } from '../optimize/vehicle';
import type { DoubleWishboneGeometry } from '../suspension/doubleWishbone';
import { CORNER_IDS, type CornerId, type ChassisPose, type CornerStatus, type GripSummary, type VehicleResult } from '../vehicle/vehicle';
import { segmentStates, segmentLatG, roadEffective, topSpeed, G, type RoadState, type SegmentSpec, type CarDims } from './segments';
import { planDuration, planSpeeds, SHAPE_LABEL, LAUNCH_SPEED, type PlanCar, type PlanShape, type SegmentPlan } from './plan';
import { wheelHeights } from './road';
import { steerForTurn, type SteerNeed } from './steer';
import { rideOn, joinRide, type RideMeasures, type RideEnd } from './ride';
import { classifyState, fadeFindings, pedalFindings, worstSeverity, PROFILES, type CheckProfile, type Finding, type Severity } from './checks';
import { brakeStep, padFactors, type AxleTemps } from '../vehicle/brakeThermal';
import { pedalTravel } from '../vehicle/brakes';
import { shimmyKicks } from '../optimize/shimmyOf';
import { aeroForces } from '../vehicle/aero';
import { wheelDrive, rpmTopSpeed } from '../vehicle/powertrain';
import { powerUse, type PowerUse } from './powerUse';

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
  /** "Driver lifts": the segment re-run at its speed limit (and judged there). */
  lifted?: StateResult[];
  /** "Driver lifts": the speed scale it was driven at over time (× its speeds, < 1 when the driver lifted there). */
  drivenScale?: number;
  /** Passes as steady states but fails over time (ride: bumps, transients). */
  rideFail?: boolean;
  /** Planned speeds: what it was planned at, how (the way of taking it and the grip target), and its time (s): as
   * driven when the pedal driver drove it (`driven`), else the plan's; `plannedTime` the plan's. */
  plannedTime?: number;
  driven?: boolean;
  plan?: SegmentPlan;
  approach?: PlanShape;
  gripTarget?: number;
  time?: number;
  /** Brake fade modeled: rotor temperatures at the start and end of the segment, °C. */
  brakeTemp?: { start: AxleTemps; end: AxleTemps };
  /** Planned speeds: what it asks of the powertrain (F7). */
  power?: PowerUse;
  /** Grip only: the ladder drove it at its own set speeds (they passed at the full push where its grip didn't). */
  capped?: boolean;
  /** Over time the car went off course or spun before it got here (round 4, F25): not driven; its time is the plan's. */
  notReached?: boolean;
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
  /** With handling: the driver also works the throttle and brakes (the speeds become targets; lifts when running wide). */
  driverSpeed?: boolean;
  /**
   * Speeds as maximums (plan.ts): the set speeds are the most the driver may go; the speeds are planned to
   * this share of the tires' grip (0–1), and a segment that still fails over time is tried other ways and
   * then at lower grip targets. Omitted: the set speeds are held exactly (with `onFail`).
   */
  plan?: {
    gripTarget: number; /** Try other ways / lower targets when a segment fails (default on; optimizers plan once). */ ladder?: boolean; /** Grip only: no set-speed caps (plan.ts § PlanOptions). */ gripOnly?: { topSpeed: number };
    /**
     * Where each segment's ladder starts (null: the plan at the test's target): a run's choices — how it was taken,
     * the driver's push, driven at its set speeds — so a run without the ladder drives what an earlier run with it
     * settled on (round 4: the springs and dampers tuner, which plans once, scored segments the ladder would have
     * slowed as failing, so its scores didn't match the optimize loop's).
     */
    start?: (PlanStart | null)[];
  };
}

/** A segment's place on the ladder (TestRunOptions.plan.start): from a run's segment results. */
export interface PlanStart { shape: PlanShape; target: number; capped?: boolean }

/** Each segment's ladder choices in a run (for TestRunOptions.plan.start). */
export const planStartOf = (r: TestRun | undefined): (PlanStart | null)[] | undefined =>
  r?.segments.map((s) => (s.gripTarget !== undefined ? { shape: s.approach ?? 'plan', target: s.gripTarget, ...(s.capped ? { capped: true } : {}) } : null));

export interface TestRun {
  severity: Severity;
  passed: boolean;
  states: StateResult[];
  segments: SegmentResult[];
  /** Assembly failed (geometry can't be built). */
  error?: string;
  /** The ride over time (Phase B) when asked for: frames for playback. */
  ride?: { frames: PlaybackFrame[]; metrics?: RideMeasures; error?: string };
  /**
   * Brake hydraulics: the most each axle's braking asks of its (faded) capacity over the steady states
   * (1 = the most pedal force; > 1 = too weak), and with the detailed hydraulics the longest pedal and the
   * most master-cylinder stroke used.
   */
  brakeUse?: { front: number; rear: number; pedal?: number; strokeUse?: number };
  /** Shimmy check: the fastest speed tried where the wheels kept wobbling (and with which parts). */
  shimmy?: { speed: number; worn: boolean; fresh: boolean };
  /** Planned speeds: the test's time (s) — as driven when the pedal driver drove it (`driven`), else the plan's — the plan's (`plannedTime`), and its distance (m). */
  time?: number;
  plannedTime?: number;
  driven?: boolean;
  distance?: number;
  /** Planned speeds: what the test asks of the powertrain over the whole test (F7; each segment's is on it). */
  power?: PowerUse;
  /**
   * Did not finish (round 4, F25): over time the car went off course or spun in this segment, at this time (s),
   * and the run ended there. A Fail; the segments after it weren't driven (their time is the plan's).
   */
  ended?: { segment: number; t: number; why: 'offCourse' | 'spun'; text: string };
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
    ...(p.trailer ? { hitch: { load: result?.hitch ? -result.hitch.force.y : NaN, limit: p.trailer.tongueLimit ?? 0, share: p.trailer.tongueShare } } : {}),
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

/**
 * Speeds as maximums: the car's limits for the planner — braking / driving from its static grip (each axle's
 * peak force over its load, at rest on the level), cornering from turns of the test's radii at the push the
 * driver plans to (`target`).
 */
function planCarOf(p: VehicleProblem, asm: AssembledVehicle, target = 0.95, radii: number[] = []): PlanCar | null {
  const st: RoadState = { name: 'rest', segment: 0, speed: 10, ay: 0, ax: 0, lateralG: 0, brakingG: 0, accelG: 0, gravityScale: 1, groundOffset: {}, grade: 0, bank: 0 };
  const r = evalState(p, asm, st, PROFILES.default.checks);
  if (!r.grip || !r.corners) return null;
  const axle = (ids: CornerId[]) => {
    const load = ids.reduce((a, id) => a + Math.max(1, r.corners![id].tireLoad), 0);
    return { y: ids.reduce((a, id) => a + r.grip!.corners[id].capY, 0) / load, x: ids.reduce((a, id) => a + r.grip!.corners[id].capX, 0) / load, load };
  };
  const fr = axle(['FL', 'FR']), rr = axle(['RL', 'RR']);
  // Cornering as the car really does it (load moving to the outside wheels, the tires' load sensitivity, the
  // wheels' lean, a locked axle's scrub, aero at that speed), at the push the driver plans to: in a turn of each
  // of the test's radii, find the lateral g at which the harder-working axle uses `target` of its grip, and
  // read each axle's grip there (round 4: it was read in one turn at 60 % of the static grip at 12 m/s, where
  // the geometry's effect near the limit hardly shows, and a kart's tight turns scrub more than that one).
  const t = Math.min(0.99, Math.max(0.3, target));
  const turnAt = (ay: number, radius: number) => {
    const v = Math.sqrt(ay * G * radius);
    const turn: RoadState = { name: 'turn', segment: 0, speed: v, ay, ax: 0, ...roadEffective(ay, 0, 0, 0), groundOffset: {}, grade: 0, bank: 0 };
    const rt = evalState(p, asm, turn, PROFILES.default.checks, undefined, { path: 'left', radius });
    const a = rt.grip?.axles;
    return a && a.front > 0.05 && a.rear > 0.05 ? a : null;
  };
  /** Secant on the worst axle's grip use (a few whole-car solves); null = no turn could be solved. */
  const atTarget = (radius: number, g0: number) => {
    let a0 = turnAt(g0, radius);
    if (!a0) return null;
    let best = { g: g0, a: a0 };
    const miss = (a: { front: number; rear: number }) => Math.abs(Math.max(a.front, a.rear) - t);
    let g1 = Math.max(0.05, (g0 * t) / Math.max(a0.front, a0.rear));
    for (let k = 0; k < 6 && miss(best.a) >= 0.002; k++) {
      const a1 = turnAt(g1, radius);
      if (!a1) break;
      if (miss(a1) <= miss(best.a)) best = { g: g1, a: a1 };
      const u0 = Math.max(a0.front, a0.rear), u1 = Math.max(a1.front, a1.rear);
      const slope = (u1 - u0) / (g1 - g0);
      const g2 = slope > 1e-6 ? g1 + (t - u1) / slope : g1 * Math.sqrt(t / u1);
      g0 = g1; a0 = a1; g1 = Math.min(3 * g1, Math.max(0.5 * g1, g2));
    }
    // No speed brings it down to the target (e.g. a locked axle's scrub in a tight turn uses the grip at any
    // speed): slowing down doesn't help, so this radius isn't planned from (the checks report it).
    if (miss(best.a) > 0.02) return null;
    return { front: Math.min(fr.y, best.g / best.a.front), rear: Math.min(rr.y, best.g / best.a.rear) };
  };
  // The radii: the test's turns (at most five, spread from the tightest to the widest), else one 20 m turn.
  const all = [...new Set(radii.filter((r) => r > 0.5 && Number.isFinite(r)).map((r) => Math.round(r * 2) / 2))].sort((a, b) => a - b);
  const pick = all.length <= 5 ? all : [0, 1, 2, 3, 4].map((k) => all[Math.round((k * (all.length - 1)) / 4)]!);
  const lateralAt: { radius: number; front: number; rear: number }[] = [];
  let warm = t * Math.min(fr.y, rr.y);
  for (const radius of pick.length ? [...new Set(pick)] : [20]) {
    const m = atTarget(radius, 0.8 * warm);
    if (!m) continue;
    lateralAt.push({ radius, ...m });
    warm = t * Math.min(m.front, m.rear);
  }
  if (!lateralAt.length && pick.length) { const m = atTarget(20, 0.8 * warm); if (m) lateralAt.push({ radius: 20, ...m }); }
  // Straights and fixed-g turns: the widest measured turn.
  const wide = lateralAt[lateralAt.length - 1];
  const muF = wide ? wide.front : fr.y, muR = wide ? wide.rear : rr.y;
  const set = p.settings;
  const drive = powertrainForce(p, asm);
  return {
    muFront: muF, muRear: muR, muLongFront: fr.x, muLongRear: rr.x, ...(lateralAt.length > 1 ? { lateralAt } : {}),
    frontShare: fr.load / (fr.load + rr.load), cgHeight: p.cg.height, wheelbase: p.wheelbase, track: 2 * dimsOf(p, asm).halfTrack,
    brakeBias: p.brakeBias, driveSplit: p.driveSplit,
    brakesFront: set.FL.brake !== 'none' || set.FR.brake !== 'none', brakesRear: set.RL.brake !== 'none' || set.RR.brake !== 'none',
    drivenFront: set.FL.drive !== 'none' || set.FR.drive !== 'none', drivenRear: set.RL.drive !== 'none' || set.RR.drive !== 'none',
    ...(p.brakeLimit ? { brakeForce: { front: p.brakeLimit.front, rear: p.brakeLimit.rear } } : {}),
    mass: p.mass, rollingResistance: p.rollingResistance ?? 0,
    ...(drive ? { drive, ...(p.powertrain ? { gearTop: rpmTopSpeed(p.powertrain, drivenRadius(p, asm)) } : {}) } : {}),
    ...(p.aero ? { dragArea: aeroForces({ model: p.aero.model, rho: p.aero.rho, speed: 10 }, { front: -asm.groundY, rear: -asm.groundY }, { front: -asm.groundY, rear: -asm.groundY }).drag / 100 } : {}),
  };
}

/** The driven wheels' loaded radius, m (wheel center above the contact point, averaged). */
export function drivenRadius(p: VehicleProblem, asm: AssembledVehicle): number {
  const ids = CORNER_IDS.filter((id) => p.settings[id].drive !== 'none');
  const use = ids.length ? ids : CORNER_IDS;
  return use.reduce((a, id) => a + (asm.chars[id].wheelCenter.y - asm.chars[id].contactPoint.y), 0) / use.length / 1000;
}

/** The powertrain's push at speed v (m/s), N — null without a powertrain or powered wheels. */
export function powertrainForce(p: VehicleProblem, asm: AssembledVehicle): ((v: number) => number) | null {
  const pt = p.powertrain;
  if (!pt || !CORNER_IDS.some((id) => p.settings[id].drive !== 'none')) return null;
  const r = drivenRadius(p, asm);
  return (v: number) => wheelDrive(pt, v, r).force;
}

/**
 * Speeds as maximums: what a failing segment tries next, in order — the other ways of taking it at the
 * test's grip target, then lower grip targets (with a finding saying so).
 */
export const PLAN_SHAPES: PlanShape[] = ['brakeIn', 'coastIn', 'hold', 'accelIn'];
/** Failures over time that taking a segment another way or slower can cure. */
const PLAN_HELPS = new Set(['understeer', 'oversteer', 'pathError', 'spin', 'offCourse', 'wheelLift', 'rollover', 'trailerSway', 'nearLimit', 'lockup', 'wheelspin', 'steerLimit', 'speedNotReached']);

/** Failures over time that driving slower can cure (Driver lifts). */
const LIFT_HELPS = new Set(['understeer', 'oversteer', 'pathError', 'spin', 'offCourse', 'wheelLift', 'rollover', 'trailerSway', 'nearLimit']);

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
    const T = seg.plan && seg.plan.s.length > 1 ? planDuration(seg.plan) : seg.distance / Math.max(0.1, (seg.v0 + seg.v1) / 2);
    const v = Math.max(0.1, seg.distance / Math.max(T, 1e-6));
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
  // How much of each axle's (faded) brake capacity the stops ask; with the detailed hydraulics, the pedal.
  let brakeUse: TestRun['brakeUse'];
  const brakeUseOf = (rs: StateResult[], temps: { start: AxleTemps; end: AxleTemps } | undefined, checks: CheckProfile) => {
    const L = p.brakeLimit;
    if (!L) return;
    const factor = th && temps ? padFactors(th, { front: Math.max(temps.start.front, temps.end.front), rear: Math.max(temps.start.rear, temps.end.rear) }) : { front: 1, rear: 1 };
    brakeUse ??= { front: 0, rear: 0 };
    for (const r of rs) {
      if (!r.corners) continue;
      const use = (d: number, cap: number, f: number) => (d > 1e-9 ? (cap * f > 0 ? d / (cap * f) : Infinity) : 0);
      const uf = use(-(r.corners.FL.brakeForce + r.corners.FR.brakeForce), L.front, factor.front);
      const ur = use(-(r.corners.RL.brakeForce + r.corners.RR.brakeForce), L.rear, factor.rear);
      brakeUse.front = Math.max(brakeUse.front, uf);
      brakeUse.rear = Math.max(brakeUse.rear, ur);
      const share = Math.max(uf, ur);
      if (!p.brakeDetail || !(share > 0)) continue;
      // The driver pushes at most the most pedal force; the pressure (and the fluid) follow the pedal.
      const t = pedalTravel(p.brakeDetail.system, p.brakeDetail.detail, Math.min(1, share));
      brakeUse.pedal = Math.max(brakeUse.pedal ?? 0, t.pedal);
      brakeUse.strokeUse = Math.max(brakeUse.strokeUse ?? 0, t.strokeUse);
      const extra = pedalFindings(t, p.brakeDetail.detail.maxPedalTravel, checks);
      if (!extra.length) continue;
      r.findings = [...r.findings, ...extra];
      r.severity = worstSeverity(r.findings);
      r.passed = r.severity !== 'fail';
    }
  };
  // Speeds as maximums: plan, check it (steady states and over time), and take each segment that still fails
  // up the ladder — the other ways of taking it, then lower grip targets (each about 15 % slower there) —
  // until it passes or the ladder ends.
  const gripTarget = Math.min(1, Math.max(0.3, opts.plan?.gripTarget ?? 0.95));
  const rideOpts = { handling: !!opts.handling, driverSpeed: !!opts.handling && !!opts.driverSpeed };
  let planRide: ReturnType<typeof rideOn> | null = null;
  /**
   * Per segment: the way it is taken (rung of PLAN_SHAPES) and its grip target; once lowered, the lowest
   * target known to fail (`failAt`), and while trying halfway back up, the one known to pass (`passAt`).
   */
  let tries: {
    shape: number; target: number; lowered?: boolean; failAt?: number; passAt?: number; ups?: number;
    /** Grip only: driven at its own set speeds (tried before the push is lowered), and whether that was tried. */
    capped?: boolean; capTried?: boolean;
    /** Lowering: what it fails for (the checks), since which target, how many lowerings in a row it stayed the same; done: slowing doesn't cure it. */
    why?: string; whySince?: number; same?: number; done?: boolean; lowerings?: number; lowest?: number;
  }[] = [];
  const tryOf = (i: number): { shape: PlanShape; target: number } => {
    const t = tries[i];
    return t ? { shape: t.shape < 0 ? 'plan' : PLAN_SHAPES[t.shape]!, target: t.target } : { shape: 'plan', target: gripTarget };
  };
  // Steady states of a planned segment, kept while its plan is the same (the ladder and the results share them).
  const steadyCache = new Map<string, StateResult[]>();
  const planKey = (i: number, sg: TestSegmentSpec) => `${i}|${sg.plan ? sg.plan.v.map((x) => x.toFixed(2)).join(',') : `${sg.v0},${sg.v1}`}`;
  const steadyOf = (i: number, sg: TestSegmentSpec) => {
    const key = planKey(i, sg);
    let rs = steadyCache.get(key);
    if (!rs) { rs = segmentStates(sg, i, 1, dimsOf(p, asm)).map((st) => evalState(p, asm, st, sg.checks ?? PROFILES.default.checks, undefined, sg)); steadyCache.set(key, rs); }
    return rs;
  };
  let planCar: PlanCar | null = null;
  if (opts.plan) {
    const car = planCar = planCarOf(p, asm, gripTarget, segments.filter((sg) => sg.path !== 'straight' && !(sg.latG !== null && sg.latG !== undefined && Number.isFinite(sg.latG))).map((sg) => sg.radius));
    if (car) {
      const base = segments;
      tries = base.map((_, i) => {
        const s0 = opts.plan?.start?.[i];
        if (!s0 || !(s0.target > 0)) return { shape: -1, target: gripTarget };
        const target = Math.min(gripTarget, Math.max(0.2, s0.target));
        return { shape: s0.shape === 'plan' ? -1 : Math.max(-1, PLAN_SHAPES.indexOf(s0.shape)), target, ...(target < gripTarget - 1e-9 ? { lowered: true } : {}), ...(s0.capped ? { capped: true, capTried: true } : {}) };
      });
      const build = () => {
        const pl = planSpeeds(base, car, base.map((_, i) => tryOf(i).target), base.map((_, i) => tryOf(i).shape),
          opts.plan?.gripOnly ? { gripOnly: { ...opts.plan.gripOnly, capped: tries.map((t) => !!t?.capped) } } : {});
        return base.map((sg, i) => ({ ...sg, plan: pl.plans[i]! }));
      };
      const fails = (fs: Finding[]) => fs.some((f) => f.severity === 'fail' && PLAN_HELPS.has(f.check));
      const steadyBad = (i: number) => fails(steadyOf(i, segments[i]!).flatMap((r) => r.findings));
      /** Segment i up the ladder one rung (`fs`: what it fails for now); false at its end. */
      const climb = (i: number, fs: Finding[] = []): boolean => {
        const sg = segments[i]!, t = tries[i]!;
        if (t.done) return false;
        // Halfway back up failed: back to the target that passed (that one is the answer, unless it's worth another try).
        if (t.passAt !== undefined) { t.failAt = t.target; t.target = t.passAt; t.passAt = undefined; return true; }
        // The other ways first (at the test's own grip target only), skipping any that plans the same speeds
        // here (e.g. coasting in when the segment is held at its set speed anyway).
        if (!t.lowered) {
          // Grip only: when its own plan fails, first its set speeds at the full push (round 4, F11: the ladder
          // took the first way that passed — e.g. a kart's sweeper held at 44 km/h where its set 56 km/h passes —
          // and ended slower than with the set speeds as caps); if those fail too, the other ways at its grip.
          if (opts.plan?.gripOnly && !t.capTried) {
            const now = planKey(i, sg);
            t.capTried = true; t.capped = true; t.shape = -1;
            if (planKey(i, build()[i]!) !== now) return true;
            t.capped = false;
          } else if (t.capped) { t.capped = false; t.shape = -1; }
          const now = planKey(i, sg);
          while (t.shape < PLAN_SHAPES.length - 1) {
            t.shape++;
            if (planKey(i, build()[i]!) !== now) return true;
          }
        }
        // Every way failed: a lower grip target, slow enough to take about 15 % off its lowest speed — unless
        // slowing doesn't cure it: failing for the same checks after two lowerings in a row, it goes back to the
        // target where that began (no slower than does any good) and is reported failing there.
        const why = [...new Set([...fs, ...steadyOf(i, sg).flatMap((r) => r.findings)].filter((f) => f.severity === 'fail' && PLAN_HELPS.has(f.check)).map((f) => f.check))].sort().join(',');
        if (why !== t.why) { t.why = why; t.whySince = t.target; t.same = 0; } else t.same = (t.same ?? 0) + 1;
        if ((t.same ?? 0) >= 2 || (t.lowerings ?? 0) >= 4 || t.target <= 0.2 + 1e-9) {
          t.done = true;
          t.lowest = t.target;
          if (t.whySince === undefined || Math.abs(t.whySince - t.target) < 1e-9) return false;
          t.target = t.whySince; t.shape = -1; t.lowered = t.target < gripTarget - 1e-9;
          return true;
        }
        const v = sg.plan?.v ?? [sg.v0, sg.v1];
        const vLow = Math.min(...v.filter((x) => x > 0.5));
        const k = Math.abs(sg.path === 'straight' ? 0 : 1 / Math.max(sg.radius, 0.1));
        const mu = Math.min(car.muFront, car.muRear);
        const forSpeed = k > 0 && Number.isFinite(vLow) ? ((0.85 * vLow) ** 2 * k) / (G * mu) : t.target * 0.8;
        t.shape = -1; // the plan's own way, at the lower target
        t.lowered = true;
        t.failAt = t.target;
        t.lowerings = (t.lowerings ?? 0) + 1;
        t.target = Math.max(0.2, Math.min(t.target * 0.85, forSpeed));
        return true;
      };
      /**
       * A lowered segment that passes: try halfway back up toward the lowest target known to fail, while the gap
       * is over 2 points (at most four times: each try drives the segment again) — nearer the highest that passes
       * than the first that did (round 4: was 4 points, twice, and stopped after a raise that passed: the default car's Autocross (simple) hairpin stayed at 75 %, now 92.5 %).
       */
      // (Asked only while the segment passes: a `passAt` still set then means the raised target passed too, so it
      // is the new one that passes — round 4: it used to stop there, after one raise.)
      const canRaise = (i: number) => { const t = tries[i]!; return !!t.lowered && t.failAt !== undefined && t.failAt - t.target > 0.02 && (t.ups ?? 0) < 4; };
      const raise = (i: number) => { const t = tries[i]!; t.passAt = t.target; t.target = (t.target + t.failAt!) / 2; t.ups = (t.ups ?? 0) + 1; };
      segments = build();
      const ladder = opts.plan.ladder !== false;
      if (!opts.ride) {
        // Steady states only: every failing segment up a rung at once, then plan again.
        for (let iter = 0; ladder && iter <= PLAN_SHAPES.length + 12; iter++) {
          let changed = false;
          segments.forEach((_, i) => { if (steadyBad(i) && climb(i)) changed = true; });
          if (!changed) break;
          segments = build();
        }
      } else {
        // Over time, in order along the test: the first segment that fails (and can still climb) goes up a
        // rung, and the ride is driven again only from the first segment whose speeds that changed (braking
        // earlier can reach back into the segments before) up to it — the car's state saved at each
        // segment's start, so what comes before is not driven again — then on from there.
        const n = segments.length;
        // Driving on stops at the first segment that fails and can still climb (no use driving past it).
        const canClimb = (k: number) => !tries[k]!.done && (tries[k]!.passAt !== undefined || tries[k]!.target > 0.2 + 1e-9);
        const stopWhen = ladder ? (k: number, fs: Finding[]) => ((fails(fs) || steadyBad(k)) ? canClimb(k) : canRaise(k)) : undefined;
        let run = rideOn(p, asm, segments, { ...rideOpts, ...(stopWhen ? { stopWhen } : {}) });
        const frameDt = run.frameDt;
        let valid = (run.last ?? n - 1) + 1; // segments whose ride results are up to date: [0, valid)
        for (let guard = 0; ladder && guard < 40 * n; guard++) {
          let i = -1;
          for (let k = 0; k < valid; k++) {
            if (steadyBad(k) || fails(run.findings[k] ?? [])) { if (climb(k, run.findings[k])) { i = k; break; } }
            else if (canRaise(k)) { raise(k); i = k; break; }
          }
          if (i < 0) {
            // (A run that went off course or spun isn't driven on: the test didn't finish.)
            if (valid >= n || run.ended) break;
            const cp = run.checkpoints?.[valid];
            run = cp ? joinRide(run, rideOn(p, asm, segments, { ...rideOpts, resume: cp, frameDt, stopWhen }), valid) : rideOn(p, asm, segments, { ...rideOpts, frameDt, stopWhen });
            valid = (run.last ?? n - 1) + 1;
            continue;
          }
          const before = segments;
          segments = build();
          let from = segments.findIndex((sg, k) => planKey(k, sg) !== planKey(k, before[k]!));
          if (from < 0) continue; // the same speeds (the ladder moves on next time)
          from = Math.min(from, i);
          const cp = from > 0 ? run.checkpoints?.[from] : undefined;
          const part = rideOn(p, asm, segments, { ...rideOpts, frameDt, stopAfter: i, ...(cp ? { resume: cp } : {}) });
          run = cp ? joinRide(run, part, from) : part;
          valid = i + 1;
        }
        if (valid < n && !run.ended) run = rideOn(p, asm, segments, { ...rideOpts, frameDt }); // the ladder's guard ran out mid-way
        planRide = run;
      }
    }
  }
  segments.forEach((seg, i) => {
    const checks = seg.checks ?? PROFILES.default.checks;
    const rs = opts.plan && seg.plan ? steadyOf(i, seg) : segmentStates(seg, i, 1, dimsOf(p, asm)).map((st) => {
      const r = evalState(p, asm, st, checks, guess, seg);
      if (r.pose) guess = r.pose;
      return r;
    });
    const brakeTemp = fadeOf(rs, seg, checks);
    brakeUseOf(rs, brakeTemp, checks);
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
    if (!opts.plan && !res.passed && (opts.onFail === 'lift' || opts.speedLimits)) {
      res.speedLimit = speedLimitOf(p, asm, seg, i, checks);
      if (opts.onFail === 'lift' && res.speedLimit > 0) {
        res.lifted = segmentStates(seg, i, res.speedLimit, dimsOf(p, asm)).map((st) => evalState(p, asm, st, checks, undefined, seg));
        // The driver lifts: the segment is judged at the speed it is driven at.
        res.findings = dedupe(res.lifted.flatMap((r) => r.findings));
        res.severity = worstSeverity(res.findings);
        res.passed = res.severity !== 'fail';
      }
    }
    segs.push(res);
  });
  let ride: TestRun['ride'];
  // With the pedal driver: how long each segment took as driven (the test's time is that, not the plan's).
  let drivenTimes: (number | undefined)[] | undefined;
  let ended: RideEnd | undefined;
  if (opts.ride) {
    // Driver lifts: over time the segments are driven at the speed scale that passed the steady check, and a
    // segment still failing over time (running wide, sliding, spinning, lifting a wheel) is driven 12 % slower
    // again, up to six times.
    const lift = !opts.plan && opts.onFail === 'lift';
    const scale = segs.map((sr) => (lift && sr.lifted && sr.speedLimit && sr.speedLimit > 0 ? sr.speedLimit : 1));
    const driven = () => segments.map((sg, i) => (scale[i]! < 1 ? { ...sg, v0: sg.v0 * scale[i]!, v1: sg.v1 * scale[i]! } : sg));
    let rr = planRide ?? rideOn(p, asm, driven(), rideOpts);
    if (lift) {
      for (let k = 0; k < 6; k++) {
        const bad = rr.findings.map((fs) => fs.some((f) => f.severity === 'fail' && LIFT_HELPS.has(f.check)));
        let changed = false;
        bad.forEach((b, i) => { if (b && scale[i]! > 0.3) { scale[i] = scale[i]! * 0.88; changed = true; } });
        if (!changed) break;
        rr = rideOn(p, asm, driven(), rideOpts);
      }
      scale.forEach((sc, i) => { if (sc < 1 && segs[i]) { segs[i]!.drivenScale = sc; segs[i]!.speedLimit = Math.min(segs[i]!.speedLimit ?? 1, sc); } });
    }
    ride = { frames: withBrakeTemps(p, rr.frames), metrics: rr.metrics, ...(rr.error ? { error: rr.error } : {}) };
    if (opts.handling && opts.driverSpeed && !rr.error) drivenTimes = rr.times;
    if (rr.ended) {
      ended = rr.ended;
      segs.forEach((sr, i) => { if (i > rr.ended!.segment) sr.notReached = true; });
    }
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
  // Shimmy: the wheels kicked at the test's fastest speeds (new and worn parts); reported on the fastest segment.
  let shimmy: TestRun['shimmy'];
  if (p.shimmy?.check && segments.length) {
    const fastest = segments.reduce((bi, sg, i) => (topSpeed(sg) > topSpeed(segments[bi]!) ? i : bi), 0);
    const top = topSpeed(segments[fastest]!);
    for (const k of [1, 0.8, 0.6]) {
      const u = top * k;
      if (u < 3) continue;
      const kk = shimmyKicks(p, u, geometries);
      if (!kk) break;
      if (kk.fresh.shimmies || kk.worn.shimmies) {
        shimmy = { speed: u, worn: kk.worn.shimmies, fresh: kk.fresh.shimmies };
        const checks = segments[fastest]!.checks ?? PROFILES.default.checks;
        const sev = (checks.shimmy ?? PROFILES.default.checks.shimmy)?.severity ?? 'fail';
        if (sev !== 'pass') {
          const sr = segs[fastest]!;
          sr.findings = dedupe([...sr.findings, { check: 'shimmy', severity: sev, text: `Shimmy: knocked at ${(u * 3.6).toFixed(0)} km/h the front wheels keep wobbling ${kk.fresh.shimmies ? 'even with new parts' : 'with worn parts (free play, softer steering, weaker damper)'}` }]);
          sr.severity = worstSeverity(sr.findings);
          sr.passed = sr.severity !== 'fail';
        }
        break;
      }
    }
  }
  // Speeds as maximums: how each segment was taken, and a finding where the grip target had to come down.
  let time: number | undefined;
  let plannedTime = 0;
  if (opts.plan && segments.every((sg) => sg.plan)) {
    time = 0;
    const pct = (x: number) => `${Math.round(x * 100)} %`;
    segs.forEach((sr, i) => {
      const sg = segments[i]!, t = tryOf(i);
      sr.plan = sg.plan; sr.approach = t.shape; sr.gripTarget = t.target;
      if (tries[i]?.capped) sr.capped = true;
      // The time it took as driven (the pedal driver, within the tires and the powertrain as they are each
      // moment), else the plan's; the plan's is kept beside it.
      sr.plannedTime = planDuration(sg.plan!);
      const driven = drivenTimes?.[i];
      sr.time = driven !== undefined && Number.isFinite(driven) && driven > 0 ? driven : sr.plannedTime;
      if (driven !== undefined) sr.driven = true;
      time! += sr.time;
      plannedTime += sr.plannedTime;
      // (The grip target is shown as the driver's push: how much of the tires' grip the driver plans to use.)
      const lowest = tries[i]?.lowest;
      const tried = lowest !== undefined && lowest < t.target - 1e-9 ? `; slowing down more didn't help (tried down to ${pct(lowest)})` : '';
      const checks = sg.checks ?? PROFILES.default.checks;
      const sev = (checks.gripTarget ?? PROFILES.default.checks.gripTarget)?.severity ?? 'warn';
      let text = '';
      if (t.target < gripTarget - 1e-9) {
        const still = !sr.passed ? `; even at ${pct(t.target)} it still fails there` : '';
        text = `Had to lower the driver's push to ${pct(t.target)} of the grip (from ${pct(gripTarget)}): at ${pct(gripTarget)} ${sg.v0 < LAUNCH_SPEED ? 'it failed over time (from a standstill only its own plan applies)' : `every way of taking it (${(['plan', 'brakeIn', 'coastIn', 'hold', 'accelIn'] as PlanShape[]).map((x) => SHAPE_LABEL[x]).join(', ')}) failed over time`}${still}${tried}`;
      } else if (tried && !sr.passed) text = `Slowing down doesn't cure it: it fails with the driver pushing to ${pct(t.target)} of the grip${tried}`;
      if (text && sev !== 'pass') {
        sr.findings = dedupe([...sr.findings, { check: 'gripTarget', severity: sev, text }]);
        sr.severity = worstSeverity(sr.findings);
        sr.passed = sr.severity !== 'fail';
      }
    });
  }
  // What it asks of the powertrain (and what the tires alone would want).
  let power: PowerUse | undefined;
  if (time !== undefined && planCar) {
    const use = powerUse(segments.map((sg) => sg.plan!), segments, planCar, segs.map((sr) => sr.gripTarget ?? gripTarget), drivenRadius(p, asm), p.powertrain);
    use.segments.forEach((u, i) => { segs[i]!.power = u; });
    power = use.total;
  }
  const severity = worstSeverity(segs.flatMap((s) => s.findings));
  return {
    ...(power ? { power } : {}),
    severity, passed: severity !== 'fail', states, segments: segs, ...(ride ? { ride } : {}), ...(brakeUse ? { brakeUse } : {}), ...(shimmy ? { shimmy } : {}),
    ...(time !== undefined ? { time, plannedTime, driven: segs.some((s) => s.driven), distance: segments.reduce((a, sg) => a + sg.distance, 0) } : {}),
    ...(ended ? { ended } : {}),
  };
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
  handling?: { pathError: number; sideslip: number; yawRate: number; steer: number; atLock: boolean; path: { x: number; y: number }; trailer?: { articulation: number; sway: number } };
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
