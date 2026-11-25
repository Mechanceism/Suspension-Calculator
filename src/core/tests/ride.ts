/**
 * Ride over time (Phase B): the whole car driven through a test as a dynamic system with 7 degrees of
 * freedom — body heave h, roll φ and pitch θ, and each corner's wheel travel q — integrated in time
 * (docs/MATH.md § Tests, Phase B).
 *
 *   M(x)·ẍ = Q(x, ẋ, t)
 *
 * Q uses the same forces as the steady solve (vehicle.ts): tire forces at the contacts (vertical from the
 * tire model at the road height under each wheel, plus tire damping; lateral / braking / drive from the
 * segment's accelerations, shared as in the steady solve), weight and the steady inertia of every mass,
 * springs, bump stops and anti-roll bars along each travel (virtual work), plus the dampers:
 * −c·(dL/dq)²·q̇ with c = bump rate while the damper shortens, rebound rate while it extends.
 * M comes from the kinetic energy of the sprung body (mass at its CG, roll and pitch inertia about it)
 * and the four unsprung masses moving with the body and along their wheel paths.
 *
 * The road comes in at the car's speed: each wheel follows the rough surface / bumps at its own position.
 * Accelerations change smoothly over a short ramp at segment boundaries (the driver steers / brakes
 * in). Travel limits are hard stops. RK4 with a fixed step; frames are recorded at `hz` and checked with
 * the pass rules like steady states.
 *
 * With `handling` (Phase C, handling.ts) a driver steers the car along the path: each tire's side force
 * comes from its slip angle, the car yaws and slides, and the lateral acceleration the ride model feels is
 * what the tires actually give (not the path's u²/R). New checks: distance off the line and sideslip.
 */
import { assembleVehicle, vehicleInputOf, type VehicleProblem, type AssembledVehicle } from '../optimize/vehicle';
import type { DoubleWishboneGeometry } from '../suspension/doubleWishbone';
import {
  CORNER_IDS, isFront, placement, poseFns, forceSetup, solveVehicle, tireForcesFor, bodyResidual, cornerWork, cornerResult,
  capacities, gripSummary, sprungProperties, NO_SHARED, damperForce, tirePressure, isLeft,
  type CornerId, type ChassisPose, type CornerResult, type CornerStatus, type VehicleCorner, type VehicleResult, type TireCaps,
} from '../vehicle/vehicle';
import { solveLinear } from '../math/linalg';
import { localPatch } from '../tire/geometry';
import { tireForce } from '../tire/model';
import { segmentLatG, roadEffective, G, type RoadState } from './segments';
import { wheelHeights } from './road';
import { aeroForces } from '../vehicle/aero';
import { swayTrailer, newSwayState, coupleTrailer, stepTrailer, followTrailer, swayOf, type SwayState } from './trailerSway';
import { classifyState, worstSeverity, PROFILES, type Finding } from './checks';
import { steerForTurn, steeringWheelAngle, type SteerNeed } from './steer';
import {
  handlingCar, handlingForces, stepHandling, driverCommand, wheelAngles, rackFor, effAt, kinematicForces, slipUse, handlingGrip,
  KINEMATIC_SPEED, type HandlingState, type HandlingForces, type TireNow, type DriverSpec,
} from './handling';
import { planAt, planAtTime, planDuration } from './plan';
import { stateFacts, slipDifference, dimsOf, powertrainForce, type PlaybackFrame, type TestSegmentSpec } from './run';
import { steeringEffort } from '../suspension/steeringEffort';
import { steeringLoads } from '../suspension/steering';
import { characteristics } from '../suspension/characteristics';
import { inputPerRev } from './steer';
import { vec3, sub, dot, cross, normalize } from '../math/vec3';

export interface RideOptions {
  /** Time step, s (default 2 ms). */
  dt?: number;
  /** Frames per second recorded (default 25). */
  hz?: number;
  /** Time over which accelerations change at a segment boundary, s (default 0.3). */
  ramp?: number;
  /** Most frames recorded (longer tests record less often). */
  maxFrames?: number;
  /** How often the pass rules are checked, s (default 0.01). */
  checkEvery?: number;
  /**
   * A grip problem (sliding, under / oversteer, ABS, wheelspin, near the limit) counts only when it lasts
   * this long, s (default 0.1): a tire overloaded for a few milliseconds as a bump unloads it doesn't
   * make the car slide. Wheel lift, bump-stop contact and bottoming count at once.
   */
  gripTime?: number;
  /** A driver steers the car along the path; tire side forces from slip angles (Phase C). */
  handling?: boolean;
  /**
   * With handling: the driver also works the throttle and brakes. The segments' speeds become targets; the
   * driver accelerates / brakes toward them within what the tires can give with the cornering they do,
   * and lifts when the car runs wide of the line. The car's speed and distance are then states.
   */
  driverSpeed?: boolean;
  driver?: DriverSpec;
  /**
   * Resume from the car's state saved at the start of a segment (`RideRun.checkpoints`), the segments before
   * it the same as when it was saved: only that segment on is driven (frames and findings from it on).
   */
  resume?: RideCheckpoint;
  /** Stop after this segment (index): a ladder judging one segment needn't drive the rest. */
  stopAfter?: number;
  /** Stop after the first segment this says yes to (given its findings over time): a ladder fixing segments in order. */
  stopWhen?: (segment: number, findings: Finding[]) => boolean;
  /** Time between recorded frames, s (default from the test's length); a resumed run keeps its checkpoint's. */
  frameDt?: number;
}

/** The car's whole state at the start of a segment (opaque), to resume a ride from there. */
export interface RideCheckpoint {
  segment: number;
  /** Frames recorded before it (over the whole run). */
  frameCount: number;
  frameDt: number;
  state: unknown;
}

export interface RideRun {
  frames: PlaybackFrame[];
  /** Findings over time per segment (first time each one happens). */
  findings: Finding[][];
  /** Smooth measures of how well the car rode (for tuning springs and dampers). */
  metrics: RideMeasures;
  error?: string;
  /** The state at the start of each segment driven, and after the last one (index = segment). */
  checkpoints?: (RideCheckpoint | undefined)[];
  frameDt?: number;
  /** The last segment driven (index). */
  last?: number;
  /** How long each segment took as driven, s (with the pedal driver: until its distance was covered). */
  times?: (number | undefined)[];
}

/**
 * A resumed run (from segment `from`) joined to the run it resumed: what came before `from` from the old one,
 * the rest from the new one (its metrics: they carry on from the checkpoint). Segments past where the new
 * one stopped have no findings or checkpoints yet.
 */
export function joinRide(prev: RideRun, next: RideRun, from: number): RideRun {
  if (from <= 0) return next;
  const n = Math.max(prev.findings.length, next.findings.length);
  const cut = next.checkpoints?.[from]?.frameCount ?? prev.checkpoints?.[from]?.frameCount ?? prev.frames.length;
  const cps = Array.from({ length: n + 1 }, (_, i) => (i < from ? prev.checkpoints?.[i] : next.checkpoints?.[i]));
  return {
    frames: [...prev.frames.slice(0, cut), ...next.frames],
    findings: Array.from({ length: n }, (_, i) => (i < from ? prev.findings[i] ?? [] : next.findings[i] ?? [])),
    metrics: next.metrics,
    ...(next.error ?? prev.error ? { error: next.error ?? prev.error } : {}),
    checkpoints: cps,
    times: Array.from({ length: n }, (_, i) => (i < from ? prev.times?.[i] : next.times?.[i])),
    ...(next.frameDt ?? prev.frameDt ? { frameDt: next.frameDt ?? prev.frameDt } : {}),
    ...(next.last !== undefined ? { last: next.last } : {}),
  };
}

export interface RideMeasures {
  /** Time a wheel was off the ground, s (summed over the four wheels). */
  liftTime: number;
  /** Time a suspension was on its bump stop, s (summed over the four). */
  bumpStopTime: number;
  /** Tire-load variation: RMS of each tire's load around its 0.5 s running mean ÷ its static load. Grip lost to bouncing. */
  loadVariation: number;
  /** RMS of the body's vertical acceleration, m/s² (comfort). */
  heaveAccRms: number;
  /** Time driven, s. */
  duration: number;
  /** Towing with handling: the largest trailer sway (deg). */
  maxSway?: number;
  /** Handling (driver steering): largest distance off the path (m) and largest sideslip (deg). */
  maxPathError?: number;
  maxSideslip?: number;
  /**
   * Energy (J): what the road's push on the bump faces took from (+) or gave to the forward motion, and
   * what the dampers and the tires' damping turned into heat. Over a run that ends settled the two match.
   */
  bumpWork?: number;
  dissipated?: number;
  /** Largest steering-wheel kick (N·m): the jolt above the 0.3 s running mean (front tires' forces). */
  maxKickback?: number;
}

const NO_METRICS: RideMeasures = { liftTime: 0, bumpStopTime: 0, loadVariation: 0, heaveAccRms: 0, duration: 0 };
const DEG = 180 / Math.PI;

const DEFAULT_RIDE = { rollInertia: 35, pitchInertia: 100, tireDamping: 100 };

/** Tire tables already built, by tire (profile + force model): reused across runs (optimizers run many). */
const TABLES = new Map<string, (h0: number, tilt: number) => number>();

/** Vertical tire force vs wheel-center height above the ground and tilt, tabulated once per tire. */
function tireTable(c: VehicleCorner): (h0: number, tilt: number) => number {
  const key = JSON.stringify([c.tire.profile, c.tire.model]);
  const hit = TABLES.get(key);
  if (hit) return hit;
  const fn = buildTireTable(c);
  if (TABLES.size > 32) TABLES.delete(TABLES.keys().next().value!);
  TABLES.set(key, fn);
  return fn;
}

function buildTireTable(c: VehicleCorner): (h0: number, tilt: number) => number {
  const R = c.tire.profile.radius;
  const hLo = R - 90, hHi = R + 2, dh = 0.5;
  const tLo = -0.2, tHi = 0.2, dtl = 0.025;
  const nh = Math.round((hHi - hLo) / dh) + 1, nt = Math.round((tHi - tLo) / dtl) + 1;
  const data = new Float64Array(nh * nt);
  for (let i = 0; i < nh; i++) {
    for (let j = 0; j < nt; j++) {
      const patch = localPatch(c.tire.profile, hLo + i * dh, tLo + j * dtl);
      data[i * nt + j] = patch.inContact ? tireForce(c.tire.model, c.tire.profile, patch).force : 0;
    }
  }
  return (h0, tilt) => {
    if (h0 >= hHi) return 0;
    const fi = Math.max(0, (h0 - hLo) / dh), fj = Math.min(nt - 1, Math.max(0, (tilt - tLo) / dtl));
    const i = Math.min(nh - 2, Math.floor(fi)), j = Math.min(nt - 2, Math.floor(fj));
    const a = Math.min(1, fi - i), b = fj - j;
    const v = (ii: number, jj: number) => data[ii * nt + jj]!;
    const f = (1 - a) * ((1 - b) * v(i, j) + b * v(i, j + 1)) + a * ((1 - b) * v(i + 1, j) + b * v(i + 1, j + 1));
    // Below the table (a huge deflection): keep the last slope so the tire still pushes back.
    return h0 >= hLo ? f : f + ((hLo - h0) / dh) * (v(0, j) - v(1, j));
  };
}

const smooth = (u: number) => (u <= 0 ? 0 : u >= 1 ? 1 : u * u * (3 - 2 * u));
const PARTNER: Record<CornerId, CornerId> = { FL: 'FR', FR: 'FL', RL: 'RR', RR: 'RL' };

/** Steady accelerations of a segment at speed v (g) and its road tilt. */
function segmentAccel(sg: TestSegmentSpec, v: number, a: number) {
  const ay = segmentLatG(sg, v);
  const ax = sg.longG !== null && sg.longG !== undefined && Number.isFinite(sg.longG) ? sg.longG : a / G;
  return { ay, ax, grade: sg.grade, bank: sg.bank };
}

export function rideRun(
  p: VehicleProblem, geometries: Partial<Record<CornerId, DoubleWishboneGeometry>>, segments: TestSegmentSpec[], o: RideOptions = {},
): RideRun {
  const asm = assembleVehicle(p, geometries);
  if (!asm) return { frames: [], findings: segments.map(() => []), metrics: { ...NO_METRICS }, error: 'The suspension geometry cannot be assembled.' };
  return rideOn(p, asm, segments, o);
}


/**
 * Being over the limit costs speed only through what the tires can't deliver in the direction the car is
 * trying to go (round 4, F10): Σ over the corners of the force shortfall's longitudinal part ÷ the mass, m/s²
 * (its sideways part makes the car run wide, judged by Off the line).
 */
export function lostAcceleration(r: VehicleResult, mass: number): number {
  if (!r.grip || !(mass > 0)) return 0;
  let lost = 0;
  for (const id of CORNER_IDS) {
    const g = r.grip.corners[id], c = r.corners[id];
    const fx = Math.abs(c.longitudinalForce), need = Math.hypot(fx, c.lateralForce);
    if (g.shortfall > 0 && need > 1e-6) lost += (g.shortfall * fx) / need;
  }
  return lost / mass;
}

/** One spell over the limit that loses this much speed (m/s, ≈ 1 km/h) fails; less is noted. */
export const LOST_SPEED_FAIL = 1 / 3.6;

/** The ride on an already assembled car. */
export function rideOn(p: VehicleProblem, asm: AssembledVehicle, segments: TestSegmentSpec[], o: RideOptions = {}): RideRun {
  const dt = o.dt ?? 0.002;
  const ramp = Math.max(0, o.ramp ?? 0.3);
  const ride = p.ride ?? DEFAULT_RIDE;
  const dims = dimsOf(p, asm);
  const wb = dims.wheelbase / 1000, ht = dims.halfTrack / 1000;
  // Corners with tabulated tire forces (one table per tire design).
  const tables = new Map<object, (h0: number, tilt: number) => number>();
  const corners: VehicleCorner[] = asm.corners.map((c) => {
    const key = c.tire.profile;
    if (!tables.has(key)) tables.set(key, tireTable(c));
    return { ...c, tireForceAt: tables.get(key)! };
  });
  const byId = Object.fromEntries(corners.map((c) => [c.id, c])) as Record<CornerId, VehicleCorner>;
  // A planned segment (speeds as maximums) takes its plan's time; otherwise v₀ → v₁ at constant acceleration.
  const durations = segments.map((sg) => { if (sg.plan && sg.plan.s.length > 1) return planDuration(sg.plan); const v = (sg.v0 + sg.v1) / 2; return v > 0 ? sg.distance / v : 0; });
  const total = durations.reduce((a, b) => a + b, 0);
  const maxFrames = o.maxFrames ?? 1500;
  const resume = o.resume && o.resume.segment > 0 && o.resume.segment < segments.length ? o.resume : undefined;
  const frameDt = resume?.frameDt ?? o.frameDt ?? Math.max(1 / (o.hz ?? 25), total / maxFrames);
  const from = resume?.segment ?? 0;
  let stop = Math.min(segments.length - 1, o.stopAfter ?? segments.length - 1);
  const checkpoints: (RideCheckpoint | undefined)[] = [];
  const findings: Finding[][] = segments.map(() => []);
  const frames: PlaybackFrame[] = [];
  const checkDt = o.checkEvery ?? 0.01;
  const gripTime = o.gripTime ?? 0.1;
  const handling = !!o.handling;
  // Driven by a driver, a moment at full lock (catching a slide) isn't a failure; running off the line is.
  const INSTANT = new Set(['wheelLift', 'bumpStop', 'bottoming', 'rollover', 'noSolution', ...(handling ? ['pathError', 'spin', 'trailerSway'] : ['steerLimit'])]);
  // Over the limit is judged by what it costs (round 4, F10): with the driver steering, a tire past its grip for
  // a moment (like a squeal) is noted; it fails only when the speed it loses — the drive / brake force the
  // tires can't deliver, in the direction the car is trying to go — reaches LOST_SPEED_FAIL in one spell. Its
  // sideways part shows as running off the line (Off the line fails).
  const OVER_LIMIT = new Set(['understeer', 'oversteer', 'wheelspin', 'lockup', 'absActive']);
  if (!(total > 0)) return { frames, findings, metrics: { ...NO_METRICS }, frameDt };
  // The path's curvature at a distance along the whole test (1/m, + = left); past the end, the last segment's.
  const starts: number[] = [];
  segments.reduce((a, sg) => { starts.push(a); return a + sg.distance; }, 0);
  const kappaOf = (sg: TestSegmentSpec) => {
    if (sg.path === 'straight') return 0;
    const sign = sg.path === 'left' ? 1 : -1;
    const vm = (sg.v0 + sg.v1) / 2;
    if (sg.latG !== null && sg.latG !== undefined && Number.isFinite(sg.latG) && vm > 1) return (sign * Math.abs(sg.latG) * G) / (vm * vm);
    return sign / Math.max(sg.radius, 0.1);
  };
  const kappas = segments.map(kappaOf);
  // The road's height along the test (m; each segment a straight slope, as the course is drawn), and the grade
  // the car is at: the slope from where its rear axle is to where its front axle is (s is the front axle's
  // distance). Over a change of grade the car pitches as the wheelbase passes it — not in a fixed time — so it
  // sits on the road with both axles (before, the grade eased over 0.3 s from when the front reached it, and
  // the rear sank into the road past a crest).
  const zStart: number[] = [];
  segments.reduce((z, sg) => { zStart.push(z); return z + sg.distance * Math.sin(sg.grade); }, 0);
  const zAt = (S: number) => {
    if (S <= 0 || !segments.length) return S * Math.sin(segments[0]?.grade ?? 0);
    let j = 0;
    while (j < segments.length - 1 && S >= starts[j + 1]!) j++;
    return zStart[j]! + (S - starts[j]!) * Math.sin(segments[j]!.grade);
  };
  const gradeAt = (S: number) => (wb > 0 ? Math.asin(Math.max(-1, Math.min(1, (zAt(S) - zAt(S - wb)) / wb))) : segments[0]?.grade ?? 0);
  const kappaAt = (S: number) => {
    let j = 0;
    while (j < segments.length - 1 && S >= starts[j + 1]!) j++;
    return kappas[j]!;
  };

  // The road and accelerations at time t.
  const kinAt = (i: number, tt: number) => {
    const sg = segments[i]!;
    if (sg.plan && sg.plan.s.length > 1) { const q = planAtTime(sg.plan, tt); return kinFrom(i, q.s, q.v, q.a, tt); }
    const T = durations[i]!;
    const a = (sg.v1 - sg.v0) / T;
    return kinFrom(i, sg.v0 * tt + 0.5 * a * tt * tt, sg.v0 + a * tt, a, tt);
  };
  /** The road and accelerations at distance s along segment i, speed v, acceleration a (m/s²), tt s into it. */
  const kinFrom = (i: number, s: number, v: number, a: number, tt: number) => {
    const sg = segments[i]!;
    let k = segmentAccel(sg, v, a);
    // Ramp from the previous segment's end over the first `ramp` seconds.
    if (i > 0 && ramp > 0 && tt < ramp && durations[i - 1]! > 0) {
      const pv = segments[i - 1]!;
      const pa = (pv.v1 - pv.v0) / durations[i - 1]!;
      const prev = segmentAccel(pv, pv.v1, pa);
      const u = smooth(tt / ramp);
      k = { ay: prev.ay + (k.ay - prev.ay) * u, ax: prev.ax + (k.ax - prev.ax) * u, grade: prev.grade + (k.grade - prev.grade) * u, bank: prev.bank + (k.bank - prev.bank) * u };
    }
    k = { ...k, grade: gradeAt(starts[i]! + s) };
    const wh = sg.road ? wheelHeights(sg.road, s, wb, ht) : { FL: 0, FR: 0, RL: 0, RR: 0 };
    const ground = {} as Record<CornerId, number>;
    for (const id of CORNER_IDS) ground[id] = (sg.bumps?.[id] ?? 0) + wh[id];
    return { s, v, ...k, ground };
  };
  /** The handling model's yaw rate now (rad/s), once it runs. */
  let yawNow: number | undefined;
  const inputAt = (k: ReturnType<typeof kinAt>, ayH?: number) => {
    const eff = roadEffective(ayH ?? k.ay, k.ax, k.grade, k.bank);
    // With handling, the car's own yaw rate (a locked axle's wheel slips follow it).
    return { ...vehicleInputOf(p, asm, { lateralG: eff.lateralG, brakingG: eff.brakingG, accelG: eff.accelG, gravityScale: eff.gravityScale, groundOffset: k.ground, speed: k.v }), corners, ...(yawNow !== undefined ? { yawRate: yawNow } : {}) };
  };

  // Start from the steady state at t = 0.
  const k0 = kinAt(0, 0);
  const in0 = inputAt(k0);
  const sp = sprungProperties(in0);
  const steady = solveVehicle(in0);
  const x = [steady.pose.heave / 1000, steady.pose.roll, steady.pose.pitch, ...CORNER_IDS.map((id) => steady.corners[id].travel / 1000)];
  const v = [0, 0, 0, 0, 0, 0, 0];
  let loads = Object.fromEntries(CORNER_IDS.map((id) => [id, steady.corners[id].tireLoad])) as Record<CornerId, number>;
  let caps: Record<CornerId, TireCaps> | null = null;
  let groundPrev = { ...k0.ground };
  const staticLoad = { ...loads };
  const loadMean = { ...loads };
  let liftTime = 0, bumpStopTime = 0, loadVarSum = 0, accSum = 0, metricCount = 0, lastMetricT = 0;
  const status: Record<CornerId, CornerStatus> = { FL: 'ok', FR: 'ok', RL: 'ok', RR: 'ok' };

  // Handling: the car, its planar state (from the steady turn at t = 0, settled by driving it for a while).
  const car = handling ? handlingCar(p, asm, Object.fromEntries(asm.corners.map((c) => [c.id, tirePressure(c.tire.model)])) as Record<CornerId, number | undefined>) : null;
  const tireNow = (res: Record<CornerId, CornerResult>) => Object.fromEntries(CORNER_IDS.map((id) => [id, {
    fz: res[id].tireLoad, gammaLeft: res[id].inclination * (isLeft(id) ? 1 : -1), fx: res[id].longitudinalForce,
  }])) as Record<CornerId, TireNow>;
  let tires = tireNow(steady.corners);
  // Speed from forces (driver mode): rolling resistance, drag at the design ride height, the bumps' push.
  const crr = Math.max(0, p.rollingResistance ?? 0);
  const rh0 = { front: -asm.groundY, rear: -asm.groundY };
  const dragAt = (u: number) => (p.aero && u > 0 ? aeroForces({ model: p.aero.model, rho: p.aero.rho, speed: u }, rh0, rh0).drag : 0);
  // The powertrain's push at a speed (F5), N; none = only the tires limit the drive.
  const ptForce = powertrainForce(p, asm);
  let bumpPush = 0, bumpWork = 0, dissipated = 0;
  const push = { FL: 0, FR: 0, RL: 0, RR: 0 } as Record<CornerId, number>;
  // Kickback: each steered front corner's design state, its steering ratio and the forces' torque about
  // its steering axis (brake / drive at the contact through the scrub radius, side force through the
  // trail, load through the axis's tilt, and the bump's push through the wheel center: the kingpin offset
  // there). Net at the steering wheel: left − right (each corner's + turns its wheel's front outboard).
  const kickers = p.steering ? (['FL', 'FR'] as const).filter((id) => p.steering!.steered[id]).flatMap((id) => {
    const corner = asm.built.get(p.roots[id]);
    if (!corner) return [];
    const st0 = corner.solve({ travel: 0 });
    if (st0.solve.status !== 'converged') return [];
    const eff = steeringEffort(corner, st0, { cFactor: inputPerRev(0, p.steering!), mu: 1, load: 1, lateralG: 0, pneumaticTrail: 0 });
    return eff ? [{ id, st0, ratio: eff.ratio, contact: characteristics(st0).contactPoint }] : [];
  }) : [];
  const kickTorque = (res: Record<CornerId, CornerResult>) => {
    let t = 0;
    for (const k of kickers) {
      const r = res[k.id];
      const side = isLeft(k.id) ? 1 : -1;
      const pt = k.st0.points;
      const u = normalize(sub(pt.steerUpper, pt.steerLower));
      const contactT = steeringLoads(k.st0, k.contact, { vertical: r.tireLoad, lateral: side * r.lateralForce, longitudinal: r.longitudinalForce, pneumaticTrail: p.pneumaticTrail ?? 0 }, vec3(1, 0, 0), 1).axisTorque;
      const pushT = dot(u, cross(sub(pt.wheelCenter, pt.steerLower), vec3(0, 0, push[k.id])));
      t += side * (contactT + pushT) * k.ratio / 1000; // N·m at the steering wheel
    }
    return t;
  };
  let kickMean = NaN, maxKick = 0;
  let H: HandlingState | null = null;
  let maxPathError = 0, maxSideslip = 0, maxSway = 0;
  /** Forces of the tires on the handling state; in the slow (kinematic) mode, what the motion needs. */
  const handlingNow = (u: number, grav: number): HandlingForces => {
    const wheels = wheelAngles(car!.table, H!.rack, H!.delta);
    if (u >= KINEMATIC_SPEED) return handlingForces(car!, H!, u, tires, wheels);
    const total = car!.mass * (u * H!.r - grav);
    const loadsNow = Object.fromEntries(CORNER_IDS.map((id) => [id, tires[id].fz])) as Record<CornerId, number>;
    const fy = kinematicForces(car!, total, loadsNow);
    return { fy, alpha: { FL: 0, FR: 0, RL: 0, RR: 0 }, wheels, sumFy: total, mz: 0 };
  };
  /** Advance the planar state by h (two sub-steps) and learn the understeer; returns the forces at the start. */
  const trailer = p.trailer;
  const hitchZ = trailer ? (-p.wheelbase - trailer.hitchBehindRear - asm.cg.z) / 1000 : 0; // m from the CG (negative: behind)
  // Trailer sway: with a driver steering, the trailer is its own yawing body (trailerSway.ts).
  const tw = trailer && car ? swayTrailer(trailer, -hitchZ * 1000) : null;
  const TS: SwayState | null = tw ? newSwayState() : null;
  let rtdot = 0;
  /**
   * Towing: the hitch's side force. Above walking pace the coupled car + trailer accelerations (returned as
   * the forces that give them); slower, F = −m_t·τ·a with a = (ΣF_tires + F) / m (the trailer follows).
   */
  /** Aero side force against the sideslip, at its center of pressure (yaws the car about the CG). */
  const withAero = (fh: HandlingForces, u: number): HandlingForces => {
    const am = p.aero?.model;
    if (!am?.CsA || !H || !(u > KINEMATIC_SPEED)) return fh;
    const F = aeroForces({ model: am, rho: p.aero!.rho, speed: u }, { front: 0, rear: 0 }, { front: 0, rear: 0 }, { sideslip: Math.atan2(H.v, u) }).side;
    const aCp = (-(am.sideCp ?? p.wheelbase * 0.6) - asm.cg.z) / 1000; // m ahead of the CG
    return { ...fh, sumFy: fh.sumFy + F, mz: fh.mz + aCp * F, tireFy: fh.tireFy ?? fh.sumFy };
  };
  const withHitch = (fh: HandlingForces, u = 0, grav = 0, ax = 0): HandlingForces => {
    if (!trailer || !car) return fh;
    if (tw && TS && H && u >= KINEMATIC_SPEED) {
      const a = coupleTrailer(tw, TS, { m: car.mass, I: car.yawInertia }, u, H.v, H.r, ax, grav, fh.sumFy, fh.mz);
      rtdot = a.rtdot;
      return { ...fh, sumFy: car.mass * (a.vdot + u * H.r - grav), mz: car.yawInertia * a.rdot, tireFy: fh.tireFy ?? fh.sumFy };
    }
    const mt = trailer.mass * Math.min(1, Math.max(0, trailer.tongueShare));
    const F = (-mt * fh.sumFy) / (car.mass + mt);
    return { ...fh, sumFy: fh.sumFy + F, mz: fh.mz + hitchZ * F, tireFy: fh.sumFy };
  };
  const advance = (u: number, S: number, grav: number, h: number, kAt: (s: number) => number, ax = 0): HandlingForces => {
    const cmd = driverCommand(car!, H!, u, kAt, S, grav, o.driver);
    const kap = kAt(S);
    let first: HandlingForces | null = null;
    for (let sub = 0; sub < 2; sub++) {
      const fh = withHitch(withAero(handlingNow(u, grav), u), u, grav, ax);
      if (!first) first = fh;
      stepHandling(car!, H!, u, kap, fh, grav, cmd, h / 2, o.driver);
      if (tw && TS) {
        if (u >= KINEMATIC_SPEED) stepTrailer(tw, TS, u, H!.v, H!.r, rtdot, h / 2);
        else followTrailer(tw, TS, u, H!.v, H!.r, h / 2);
      }
    }
    const ayT = (first!.tireFy ?? first!.sumFy) / (car!.mass * G);
    if (u >= KINEMATIC_SPEED && Math.abs(ayT) > 0.15) {
      const sd = (first!.alpha.FL + first!.alpha.FR) / 2 - (first!.alpha.RL + first!.alpha.RR) / 2;
      H!.K += (sd / ayT - H!.K) * Math.min(1, h / 1.0);
      H!.K = Math.max(-0.05, Math.min(0.15, H!.K));
    }
    return first!;
  };
  if (car) {
    const u0 = k0.v, kap0 = kappaAt(0);
    const K0 = Math.abs(in0.lateralG) > 0.05 ? slipDifference(steady) / Math.abs(in0.lateralG) : 0;
    const grav0 = G * Math.sin(k0.bank) * Math.cos(k0.grade);
    const d0 = Math.atan(car.L * kap0) + (K0 * (u0 * u0 * kap0 - grav0)) / G;
    const rk = rackFor(car.table, d0);
    H = { v: 0, r: u0 * kap0, eY: 0, ePsi: 0, delta: effAt(car.table, rk.rack, d0), rack: rk.rack, cmd: rk.needed, atLock: rk.atLock, K: K0, want: d0 };
    // Settle on the first segment's curve (held at t = 0) before the clock starts (resumed: restored below).
    if (!resume) for (let n = 0; n < 750; n++) advance(u0, 0, grav0, dt, () => kap0);
  }

  /** Accelerations, corner results and body forces at state (x, v). */
  const evaluate = (input: ReturnType<typeof inputAt>, fs: ReturnType<typeof forceSetup>, f: ReturnType<typeof tireForcesFor>, gdot: Record<CornerId, number>, xs: number[], vs: number[]) => {
    const pose: ChassisPose = { heave: xs[0]! * 1000, roll: xs[1]!, pitch: xs[2]! };
    const P = poseFns(pose);
    const q = (k: number) => xs[3 + k]! * 1000;
    const Q = new Array<number>(7).fill(0);
    const M = Array.from({ length: 7 }, () => new Array<number>(7).fill(0));
    const res = {} as Record<CornerId, CornerResult>;
    // Power turned into heat by the dampers and the tires' damping, W.
    let diss = 0;
    // Velocity Jacobian of a point (world, mm) w.r.t. heave (m), roll, pitch: columns, in m per unit.
    const jac = (pt: { x: number; y: number; z: number }) => {
      const rx = pt.x / 1000, ry = (pt.y - pose.heave) / 1000, rz = pt.z / 1000;
      return [[0, 1, 0], [-ry, rx, 0], [0, -rz, ry]] as const;
    };
    const addMass = (m: number, cols: (readonly [number, number, number] | undefined)[]) => {
      for (let a = 0; a < 7; a++) {
        const ca = cols[a];
        if (!ca) continue;
        for (let b = 0; b < 7; b++) {
          const cb = cols[b];
          if (!cb) continue;
          M[a]![b]! += m * (ca[0] * cb[0] + ca[1] * cb[1] + ca[2] * cb[2]);
        }
      }
    };
    CORNER_IDS.forEach((id, k) => {
      const c = byId[id];
      const pl = placement(id, p.wheelbase);
      const axle = (isFront(id) ? p.shared.front : p.shared.rear) ?? NO_SHARED;
      const shared = { partner: byId[PARTNER[id]], axle };
      const qo = q(CORNER_IDS.indexOf(PARTNER[id]));
      // First without tire damping to get the wheel's motion, then with it (the tire force is linear in it).
      const cw0 = cornerWork(c, input, pose, f[id], shared, q(k), qo);
      const s = cw0.s;
      const wc = cw0.wc;
      const dwc = P.rot(pl.dir(s.dwc));
      // Solid axle: the wheel also moves with the other side's travel.
      const kp = CORNER_IDS.indexOf(PARTNER[id]);
      const sx = s as typeof s & { dwcX?: { x: number; y: number; z: number }; dLX?: number };
      const dwcX = c.axle && sx.dwcX ? P.rot(pl.dir(sx.dwcX)) : null;
      const J = jac(wc);
      // Wheel-center vertical velocity, m/s: body motion at the wheel + travel(s).
      const vy = J[0][1] * vs[0]! + J[1][1] * vs[1]! + J[2][1] * vs[2]! + dwc.y * vs[3 + k]! + (dwcX ? dwcX.y * vs[3 + kp]! : 0);
      const tireExtra = ride.tireDamping * (gdot[id] - vy);
      const cw = tireExtra ? cornerWork(c, input, pose, f[id], shared, q(k), qo, tireExtra) : cw0;
      const dL = Number.isFinite(s.dL) ? s.dL : 0;
      const dLX = dwcX && Number.isFinite(sx.dLX ?? NaN) ? sx.dLX! : 0;
      const Ldot = dL * vs[3 + k]! + dLX * vs[3 + kp]!;
      const fd = c.damper ? damperForce(c.damper, Ldot) : 0;
      diss += fd * Ldot + ride.tireDamping * (gdot[id] - vy) * (gdot[id] - vy);
      Q[3 + k]! += cw.work - dL * fd;
      if (dwcX) Q[3 + kp]! += cw.cross - dLX * fd;
      res[id] = cornerResult(c, input, f[id], q(k), status[id], cw);
      const cols: (readonly [number, number, number] | undefined)[] = [J[0], J[1], J[2], undefined, undefined, undefined, undefined];
      cols[3 + k] = [dwc.x, dwc.y, dwc.z];
      if (dwcX) cols[3 + kp] = [dwcX.x, dwcX.y, dwcX.z];
      addMass(c.unsprungMass, cols);
    });
    const body = bodyResidual(input, sp, fs, pose, res);
    Q[0] = body[0]; Q[1] = body[1]; Q[2] = body[2];
    const Jc = jac(P.point(sp.cg));
    addMass(sp.mass, [Jc[0], Jc[1], Jc[2]]);
    M[1]![1]! += ride.rollInertia;
    M[2]![2]! += ride.pitchInertia;
    // A rigid corner (no suspension) has no travel: its row and column drop out (q stays 0).
    CORNER_IDS.forEach((id, k) => {
      if (!byId[id].rigid) return;
      for (let j = 0; j < 7; j++) { M[3 + k]![j] = 0; M[j]![3 + k] = 0; }
      M[3 + k]![3 + k] = 1; Q[3 + k] = 0;
    });
    const acc = solveLinear(M, Q) ?? new Array<number>(7).fill(0);
    return { acc, res, pose, diss };
  };

  let t0 = 0, nextFrame = 0;
  let x2d = 0, y2d = 0, heading = 0;
  // The driver working the pedals (driverSpeed): speed and distance as states, the profile as targets.
  const drv = handling && !!o.driverSpeed;
  let uDrv = segments[0]?.v0 ?? 0, sCarry = 0;
  // Each tire's side force at the last step: what's left of its grip along the road (the pedal driver's limit).
  let lastFy: Record<CornerId, number> | null = null;
  const times: (number | undefined)[] = segments.map(() => undefined);
  const muEst = steady.grip ? CORNER_IDS.reduce((a, id) => a + steady.grip!.corners[id].capacity, 0) / (p.mass * G * Math.max(in0.gravityScale ?? 1, 0.1)) : 1;
  const canDrive = corners.some((c) => c.drive !== 'none'), canBrake = corners.some((c) => c.brake !== 'none');
  // Save / restore everything that carries from one segment to the next.
  const save = (segment: number): RideCheckpoint => ({
    segment, frameCount: (resume?.frameCount ?? 0) + frames.length, frameDt,
    state: structuredClone({
      x, v, loads, caps, groundPrev, loadMean, status, tires, bumpPush, bumpWork, dissipated, push, kickMean, maxKick, H, TS, rtdot, yawNow,
      maxPathError, maxSideslip, maxSway, t0, nextFrame, x2d, y2d, heading, uDrv, sCarry, liftTime, bumpStopTime, loadVarSum, accSum, metricCount, lastMetricT, lastFy,
    }),
  });
  if (resume) {
    const st = structuredClone(resume.state) as {
      x: number[]; v: number[]; loads: typeof loads; caps: typeof caps; groundPrev: typeof groundPrev; loadMean: typeof loadMean; status: typeof status;
      tires: typeof tires; bumpPush: number; bumpWork: number; dissipated: number; push: typeof push; kickMean: number; maxKick: number; H: HandlingState | null;
      TS: SwayState | null; rtdot: number; yawNow: number | undefined; maxPathError: number; maxSideslip: number; maxSway: number; t0: number; nextFrame: number;
      x2d: number; y2d: number; heading: number; uDrv: number; sCarry: number; liftTime: number; bumpStopTime: number; loadVarSum: number; accSum: number;
      metricCount: number; lastMetricT: number; lastFy: Record<CornerId, number> | null;
    };
    x.splice(0, x.length, ...st.x); v.splice(0, v.length, ...st.v);
    loads = st.loads; caps = st.caps; groundPrev = st.groundPrev; tires = st.tires;
    Object.assign(loadMean, st.loadMean); Object.assign(status, st.status); Object.assign(push, st.push);
    bumpPush = st.bumpPush; bumpWork = st.bumpWork; dissipated = st.dissipated; kickMean = st.kickMean; maxKick = st.maxKick;
    H = st.H; if (TS && st.TS) Object.assign(TS, st.TS); rtdot = st.rtdot; yawNow = st.yawNow;
    maxPathError = st.maxPathError; maxSideslip = st.maxSideslip; maxSway = st.maxSway;
    t0 = st.t0; nextFrame = st.nextFrame; x2d = st.x2d; y2d = st.y2d; heading = st.heading; uDrv = st.uDrv; sCarry = st.sCarry;
    liftTime = st.liftTime; bumpStopTime = st.bumpStopTime; loadVarSum = st.loadVarSum; accSum = st.accSum; metricCount = st.metricCount; lastMetricT = st.lastMetricT;
    lastFy = st.lastFy;
  }
  segments.forEach((sg, i) => {
    if (i < from || i > stop) return;
    checkpoints[i] = save(i);
    const T = durations[i]!;
    if (!(T > 0)) return;
    const checks = sg.checks ?? PROFILES.default.checks;
    /** Per check: when the current spell began, whether it was reported, how many spells counted. */
    const spells = new Map<string, { since: number; first: Finding; reported: boolean; count: number; countedThis?: boolean; firstT?: number; lost: number; worst: number }>();
    let nextCheck = t0;
    const nSteps = Math.max(1, Math.ceil(T / dt));
    const h = T / nSteps;
    let lastS = 0;
    // Driver speed control: the segment lasts until its distance is covered (at most a few times its nominal time).
    const maxSteps = drv ? nSteps * 4 + Math.ceil(5 / h) : nSteps;
    const aProf = sg.distance > 0 ? (sg.v1 * sg.v1 - sg.v0 * sg.v0) / (2 * sg.distance) : 0;
    let sDrv = sCarry, segEnd = false, tEnd = T, lifted = 0, slowed = 0, held = 0, kickSeg = 0, kickT = 0, vMin = Infinity;
    for (let n = 1; n <= maxSteps && !(drv && segEnd); n++) {
      const tt = n * h;
      let kin: ReturnType<typeof kinFrom>;
      if (drv) {
        // Target: the profile's speed here; command: the profile's acceleration plus a correction toward it.
        // The driver never aims above what the tires can corner (0.95 μ g R) here, or than they can still
        // brake down to it for a tighter bend up to 40 m ahead.
        const planned = sg.plan && sg.plan.s.length > 1 ? planAt(sg.plan, Math.min(sDrv, sg.distance)) : null;
        let vT = planned ? Math.max(0.1, planned.v) : Math.sqrt(Math.max(0.01, sg.v0 * sg.v0 + 2 * aProf * Math.min(sDrv, sg.distance)));
        const vSet = vT;
        const aBrake = 0.8 * muEst * G;
        for (let d = 0; d <= 40; d += 2) {
          const kd = Math.abs(kappaAt(starts[i]! + sDrv + d));
          if (kd > 1e-6) vT = Math.min(vT, Math.sqrt((0.95 * muEst * G) / kd + 2 * aBrake * d));
        }
        if (vT < vSet - 0.05) slowed += h;
        let aCmd = (planned ? planned.a : aProf) + 1.5 * (vT - uDrv);
        // Running wide of the line (off it toward the outside of the turn): lift / brake to tighten the line.
        const kap = kappaAt(starts[i]! + sDrv);
        const wide = H && Math.abs(kap) > 1e-6 ? -Math.sign(kap) * H.eY : 0;
        if (wide > 0.25) { aCmd = Math.min(aCmd, -G * Math.min(0.5, 0.15 + (wide - 0.25))); lifted += h; }
        // Within the tires: what is left of their grip after the cornering, and only the pedals the car has.
        const ayNow = (uDrv * uDrv * Math.abs(kap)) / G;
        const axMax = G * Math.sqrt(Math.max(0, muEst * muEst - ayNow * ayNow));
        // Speed from forces: the tires push what the driver asks (the target's acceleration plus the drag,
        // grade and rolling resistance the driver expects), within their grip and the pedals the car has;
        // coasting, nothing. The car then speeds up or slows by what the forces leave, bumps included.
        const mass = p.mass;
        const drag = dragAt(uDrv), gradeF = mass * G * Math.sin(sg.grade), rr = crr * mass * G * Math.cos(sg.grade);
        let Ft = sg.coast ? 0 : mass * aCmd + drag + gradeF + rr;
        // Within the tires as they are now (round 4): each driven / braked tire's grip along the road at its load
        // this step, after the side force it carries — a tire going light over a bump or loaded up in a turn
        // gives less — not one grip estimate for the whole car; and within the powertrain.
        const along = (which: 'drive' | 'brake') => {
          if (!caps) return mass * axMax;
          let sum = 0;
          for (const c of corners) {
            if ((which === 'drive' ? c.drive : c.brake) === 'none') continue;
            const k = caps[c.id], fy = lastFy?.[c.id] ?? 0;
            sum += k.x * Math.sqrt(Math.max(0, 1 - (fy / Math.max(k.y, 1e-6)) ** 2));
          }
          return sum;
        };
        const driveMax = canDrive ? (ptForce ? Math.min(along('drive'), ptForce(uDrv)) : along('drive')) : 0;
        const brakeMax = canBrake ? along('brake') : 0;
        const want = Ft;
        Ft = Math.max(-brakeMax, Math.min(driveMax, Ft));
        if (!sg.coast && Math.abs(Ft - want) > 0.02 * mass * G) held += h;
        const aSmooth = (Ft - drag - gradeF - rr) / mass;
        uDrv = Math.max(0.5, uDrv + h * (aSmooth - bumpPush / mass));
        vMin = Math.min(vMin, uDrv);
        sDrv += h * uDrv;
        segEnd = sDrv >= sg.distance || n === maxSteps;
        if (segEnd) { tEnd = tt; sCarry = Math.max(0, sDrv - sg.distance); }
        kin = kinFrom(i, Math.min(sDrv, sg.distance), uDrv, aSmooth, tt);
      } else {
        kin = kinAt(i, tt);
        segEnd = n === nSteps;
      }
      // Handling: the tires' side forces now set the lateral acceleration the body feels.
      let hf: HandlingForces | null = null;
      let ayH: number | undefined;
      if (H) {
        const grav = G * Math.sin(kin.bank) * Math.cos(kin.grade);
        hf = advance(kin.v, starts[i]! + kin.s, grav, h, kappaAt, kin.ax * G);
        yawNow = H.r;
        ayH = (hf.sumFy / car!.mass + grav) / (G * Math.max(Math.cos(kin.bank), 0.1));
      }
      const input = inputAt(kin, ayH);
      const fs = forceSetup(input);
      const f = tireForcesFor(input, fs, loads, caps);
      if (hf) for (const id of CORNER_IDS) f[id] = { ...f[id], lateral: hf.fy[id] };
      const gdot = {} as Record<CornerId, number>;
      for (const id of CORNER_IDS) gdot[id] = (kin.ground[id] - groundPrev[id]) / 1000 / h;
      groundPrev = { ...kin.ground };
      // RK4 on (x, v).
      const deriv = (xs: number[], vs: number[]) => evaluate(input, fs, f, gdot, xs, vs).acc;
      const add = (a: number[], b: number[], s: number) => a.map((ai, j) => ai + b[j]! * s);
      const a1 = deriv(x, v);
      const x2 = add(x, v, h / 2), v2 = add(v, a1, h / 2);
      const a2 = deriv(x2, v2);
      const x3 = add(x, v2, h / 2), v3 = add(v, a2, h / 2);
      const a3 = deriv(x3, v3);
      const x4 = add(x, v3, h), v4 = add(v, a3, h);
      const a4 = deriv(x4, v4);
      for (let j = 0; j < 7; j++) {
        x[j] = x[j]! + (h / 6) * (v[j]! + 2 * v2[j]! + 2 * v3[j]! + v4[j]!);
        v[j] = v[j]! + (h / 6) * (a1[j]! + 2 * a2[j]! + 2 * a3[j]! + a4[j]!);
      }
      // Hard travel limits.
      CORNER_IDS.forEach((id, k) => {
        const c = byId[id];
        const qmm = x[3 + k]! * 1000;
        status[id] = 'ok';
        if (qmm < c.table.lo) { x[3 + k] = c.table.lo / 1000; if (v[3 + k]! < 0) v[3 + k] = 0; status[id] = 'droop-limit'; }
        else if (qmm > c.table.hi) { x[3 + k] = c.table.hi / 1000; if (v[3 + k]! > 0) v[3 + k] = 0; status[id] = 'bump-limit'; }
      });
      if (!x.every(Number.isFinite)) return void findings[i]!.push({ check: 'noSolution', severity: 'fail', text: `The ride simulation became unstable at ${(t0 + tt).toFixed(2)} s` });
      const now = evaluate(input, fs, f, gdot, x, v);
      // The road's push on the tires climbing (or rolling off) a bump face: the load tilted with the road,
      // horizontal = load × road slope (= load × ground rise speed ÷ car speed), through the wheel center.
      const uNow = Math.max(kin.v, 0.5);
      bumpPush = 0;
      for (const id of CORNER_IDS) {
        push[id] = -now.res[id].tireLoad * gdot[id] / uNow;
        bumpPush -= push[id];
        bumpWork += now.res[id].tireLoad * gdot[id] * h;
      }
      dissipated += (now.diss ?? 0) * h;
      if (kickers.length) {
        const T = kickTorque(now.res);
        kickMean = Number.isFinite(kickMean) ? kickMean + (T - kickMean) * Math.min(1, h / 0.3) : T;
        const kick = Math.abs(T - kickMean);
        if (kick > kickSeg) { kickSeg = kick; kickT = t0 + tt; }
      }
      loads = Object.fromEntries(CORNER_IDS.map((id) => [id, now.res[id].tireLoad])) as Record<CornerId, number>;
      caps = capacities(input, now.res, Math.sign(fs.latTotal));
      tires = tireNow(now.res);
      lastFy = Object.fromEntries(CORNER_IDS.map((id) => [id, now.res[id].lateralForce])) as Record<CornerId, number>;
      // Track position (top view).
      const ds = kin.s - lastS;
      lastS = kin.s;
      const curv = sg.path === 'straight' ? 0 : (sg.path === 'left' ? 1 : -1) / Math.max(sg.radius, 0.1);
      heading += curv * ds;
      x2d += ds * Math.cos(heading);
      y2d += ds * Math.sin(heading);
      const t = t0 + tt;
      const beta = H ? Math.atan2(H.v, Math.max(kin.v, 0.5)) * DEG : 0;
      if (H) { maxPathError = Math.max(maxPathError, Math.abs(H.eY)); if (kin.v >= KINEMATIC_SPEED) maxSideslip = Math.max(maxSideslip, Math.abs(beta)); }
      const isFrame = !(t + 1e-9 < nextFrame && !segEnd);
      const isCheck = isFrame || t + 1e-9 >= nextCheck;
      if (!isCheck) continue;
      // Ride measures, accumulated at each check.
      const dtm = t - lastMetricT;
      lastMetricT = t;
      for (const id of CORNER_IDS) {
        const fz = now.res[id].tireLoad;
        if (fz < 25) liftTime += dtm;
        if (now.res[id].onBumpStop) bumpStopTime += dtm;
        loadMean[id] += (fz - loadMean[id]) * Math.min(1, dtm / 0.5);
        loadVarSum += ((fz - loadMean[id]) / Math.max(staticLoad[id], 1)) ** 2;
      }
      accSum += (now.acc[0] ?? 0) ** 2;
      metricCount++;
      nextCheck = t + checkDt;
      if (isFrame) nextFrame = t + frameDt;
      // Check this moment (and record a frame).
      const result: VehicleResult = {
        pose: now.pose, corners: now.res, converged: true, iterations: 0, residual: [0, 0, 0],
        sprungMass: sp.mass, sprungCg: sp.cg, notes: fs.notes, unmet: fs.unmet, ...(fs.brakePedal ? { brakePedal: fs.brakePedal } : {}), ...(fs.hitch ? { hitch: fs.hitch } : {}),
      };
      result.grip = gripSummary(input, result, caps, fs.frontLatShare, fs.latTotal);
      if (H && hf && kin.v >= KINEMATIC_SPEED) {
        const fxs = Object.fromEntries(CORNER_IDS.map((id) => [id, now.res[id].longitudinalForce])) as Record<CornerId, number>;
        const fys = Object.fromEntries(CORNER_IDS.map((id) => [id, now.res[id].lateralForce])) as Record<CornerId, number>;
        handlingGrip(result.grip, fxs, fys, caps, slipUse(car!, hf.alpha, tires));
      }
      const ay = ayH ?? kin.ay;
      const eff = roadEffective(ay, kin.ax, kin.grade, kin.bank);
      const offsets = Object.fromEntries(CORNER_IDS.filter((id) => Math.abs(kin.ground[id]) > 1e-6).map((id) => [id, kin.ground[id]])) as Partial<Record<CornerId, number>>;
      const st: RoadState = { name: `${i + 1}@${t.toFixed(2)}s`, segment: i, speed: kin.v, ay, ax: kin.ax, at: kin.s, ...eff, groundOffset: offsets, grade: kin.grade, bank: kin.bank };
      // Steering: what the driver steers (handling), or what the turn needs (slip difference quantized
      // to 0.05° so the rack search is cached).
      const steer = H ? handlingSteer(H, sg.path === 'straight', kappaAt(starts[i]! + kin.s))
        : p.steering && sg.path !== 'straight'
          ? steerForTurn(asm.built, p.roots, p.steering, p.wheelbase, sg.path, sg.radius, Math.round(slipDifference(result) / 8.7e-4) * 8.7e-4) : null;
      st.rack = steer?.rackUsed ?? 0;
      const sw = TS ? swayOf(TS) : null;
      if (sw) maxSway = Math.max(maxSway, sw.sway * DEG);
      const hd = H ? { pathError: H.eY, sideslip: kin.v >= KINEMATIC_SPEED ? beta : 0, atLock: H.atLock, ...(sw && TS ? { sway: sw.sway * DEG, jackknife: sw.jackknife, articulation: TS.phi * DEG } : {}) } : undefined;
      const fnd = classifyState({ ...stateFacts(p, asm, st, result, steer), handling: hd }, checks).filter((x) => x.check !== 'beyondGrip');
      // What being over the limit costs now: the longitudinal part of the force the tires can't deliver, m/s².
      const lostAcc = lostAcceleration(result, p.mass);
      // Spells: a check that holds now continues (or starts) its spell; others end theirs.
      const now2 = new Set<string>();
      for (const x of fnd) {
        now2.add(x.check);
        let sp2 = spells.get(x.check);
        if (!sp2) {
          sp2 = { since: t, first: x, reported: false, count: 0, lost: 0, worst: 0 };
          spells.set(x.check, sp2);
        } else if (sp2.since < 0) {
          sp2.since = t;
          sp2.countedThis = false;
          sp2.lost = 0;
        }
        sp2.lost += lostAcc * checkDt;
        sp2.worst = Math.max(sp2.worst, sp2.lost);
        const lasted = t - sp2.since + checkDt;
        if (lasted + 1e-9 >= (INSTANT.has(x.check) ? 0 : gripTime) && sp2.since >= 0 && !sp2.countedThis) {
          sp2.count++;
          sp2.countedThis = true;
          if (!sp2.reported) { sp2.reported = true; sp2.first = x; sp2.firstT = sp2.since; }
        }
      }
      for (const [k, sp2] of spells) if (!now2.has(k) && sp2.since >= 0) { sp2.since = -1; sp2.countedThis = false; }
      if (!isFrame) continue;
      // The car on the line it actually drives (handling) or on the path.
      const off = H?.eY ?? 0;
      frames.push({
        t, segment: i, s: kin.s, speed: kin.v, ay, ax: kin.ax, grade: kin.grade, bank: kin.bank, groundOffset: offsets,
        pos: { x: x2d - off * Math.sin(heading), y: y2d + off * Math.cos(heading), z: 0 }, heading: heading + (H?.ePsi ?? 0),
        rack: H ? H.rack : steer?.rackUsed ?? 0, severity: worstSeverity(fnd),
        ...(H ? { handling: { pathError: H.eY, sideslip: beta, yawRate: H.r, steer: H.delta * DEG, atLock: H.atLock, path: { x: x2d, y: y2d }, ...(sw && TS ? { trailer: { articulation: TS.phi * DEG, sway: sw.sway * DEG } } : {}) } } : {}),
        utilization: Object.fromEntries(CORNER_IDS.map((id) => [id, result.grip?.corners[id].utilization ?? NaN])) as Record<CornerId, number>,
        findings: fnd.filter((x) => x.severity !== 'pass').map((x) => x.text),
        ride: {
          pose: now.pose,
          travel: Object.fromEntries(CORNER_IDS.map((id) => [id, now.res[id].travel])) as Record<CornerId, number>,
          tireLoad: Object.fromEntries(CORNER_IDS.map((id) => [id, now.res[id].tireLoad])) as Record<CornerId, number>,
        },
      });
    }
    // One finding per check: when it first happened and how often.
    for (const sp2 of spells.values()) {
      if (!sp2.reported) continue;
      const x = sp2.first;
      const ft = sp2.firstT ?? 0;
      const at = ` (at ${ft.toFixed(1)} s${sp2.count > 1 ? `, ${sp2.count} times` : ''})`;
      if (handling && OVER_LIMIT.has(x.check)) {
        const kmh = sp2.worst * 3.6;
        const cost = kmh >= 0.05 ? `costs ≈ ${kmh.toFixed(1)} km/h of speed` : 'costs no speed';
        const brief = sp2.worst < LOST_SPEED_FAIL;
        findings[i]!.push({ ...x, severity: brief && x.severity === 'fail' ? 'warn' : x.severity, t: ft, text: `${x.text}${at}: ${brief ? `brief, ${cost} (like a tire squeal: noted)` : cost}` });
      } else findings[i]!.push({ ...x, t: ft, text: `${x.text}${at}` });
    }
    // Kickback: a jolt at the steering wheel above the limit.
    maxKick = Math.max(maxKick, kickSeg);
    {
      const kc = checks.kickback ?? PROFILES.default.checks.kickback;
      if (kc && kc.severity !== 'pass' && kickSeg > (kc.threshold ?? 5)) findings[i]!.push({ check: 'kickback', severity: kc.severity, text: `Kickback: a ${kickSeg.toFixed(1)} N·m jolt at the steering wheel (bump / braking forces through the scrub radius and the kingpin offset) at ${kickT.toFixed(1)} s`, t: kickT });
    }
    // The driver lifted, or the tires / pedals couldn't hold the speed, and the car ended well short of it: say so.
    const vEnd = sg.plan && sg.plan.v.length ? sg.plan.v[sg.plan.v.length - 1]! : sg.v1;
    if (drv && !sg.coast && (lifted > 0 || slowed > 0 || held > 0.2) && uDrv < vEnd - 0.5) {
      const sev = (checks.speedNotReached ?? PROFILES.default.checks.speedNotReached).severity;
      // (Not the "Driver lifts" option: the pedal driver slows down by itself when the car runs wide.)
      const why = lifted > 0 ? `slowed down to stay on the line (for ${lifted.toFixed(1)} s)` : slowed > 0 ? 'slowed for the turn (the tires cannot take it at the set speed)' : `couldn't hold the speed (${!canDrive ? 'no powered wheels against drag, grade and rolling resistance' : 'not enough grip or brakes'})`;
      const low = Number.isFinite(vMin) && vMin < uDrv - 0.5 ? `down to ${(vMin * 3.6).toFixed(0)} km/h, ` : '';
      // Planned speeds: being slower than the plan is noted — the driven time shows what it cost.
      const sevNow = sg.plan && sev === 'fail' ? 'warn' : sev;
      if (sevNow !== 'pass') findings[i]!.push({ check: 'speedNotReached', severity: sevNow, text: `The driver ${why}: ${low}${(uDrv * 3.6).toFixed(0)} km/h at the end instead of ${(vEnd * 3.6).toFixed(0)} km/h${sg.plan ? ' (planned)' : ''}`, t: t0 + tEnd });
    }
    times[i] = drv ? tEnd : T;
    t0 += drv ? tEnd : T;
    if (i < stop && o.stopWhen?.(i, findings[i]!)) stop = i;
  });
  checkpoints[stop + 1] = save(stop + 1);
  const nAcc = Math.max(1, metricCount);
  const metrics: RideMeasures = {
    liftTime, bumpStopTime, duration: total,
    loadVariation: Math.sqrt(loadVarSum / Math.max(1, metricCount * 4)),
    heaveAccRms: Math.sqrt(accSum / nAcc),
    ...(H ? { maxPathError, maxSideslip } : {}),
    ...(TS ? { maxSway } : {}),
    bumpWork, dissipated, ...(kickers.length ? { maxKickback: maxKick } : {}),
  };
  return { frames, findings, metrics, checkpoints, frameDt, last: stop, times };

  /** The driver's steering as a steering need (for the Steering lock check and the display). */
  function handlingSteer(hs: HandlingState, straight: boolean, kappa: number): SteerNeed | null {
    const tb = car!.table;
    if (tb.ideal || (tb.none && straight)) return null;
    const lockEff = Math.abs(effAt(tb, Math.sign(hs.cmd || hs.rack || 1) * tb.limit, 0));
    const wheel = hs.want;
    const turn = Math.atan(car!.L * kappa);
    // Mostly steering back toward the line (well off it, and most of the angle isn't the turn's).
    const recovering = Math.abs(hs.eY) > 0.5 && Math.abs(wheel - turn) > Math.abs(turn);
    return {
      rack: hs.cmd, rackUsed: hs.rack, wheelAngle: wheel * DEG, slip: (wheel - turn) * DEG, maxAngle: lockEff * DEG,
      steeringWheel: p.steering && p.steering.cFactor > 0 ? steeringWheelAngle(hs.cmd, p.steering) : NaN,
      limit: tb.limit, over: tb.none || Math.abs(hs.cmd) > tb.limit + 1e-6, none: tb.none,
      ...(recovering ? { offLine: hs.eY, turnAngle: turn * DEG } : {}),
    };
  }
}
