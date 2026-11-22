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
import { classifyState, worstSeverity, PROFILES, type Finding } from './checks';
import { steerForTurn, type SteerNeed } from './steer';
import {
  handlingCar, handlingForces, stepHandling, driverCommand, wheelAngles, rackFor, effAt, kinematicForces, slipUse, handlingGrip,
  KINEMATIC_SPEED, type HandlingState, type HandlingForces, type TireNow, type DriverSpec,
} from './handling';
import { stateFacts, slipDifference, dimsOf, type PlaybackFrame, type TestSegmentSpec } from './run';

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
  driver?: DriverSpec;
}

export interface RideRun {
  frames: PlaybackFrame[];
  /** Findings over time per segment (first time each one happens). */
  findings: Finding[][];
  /** Smooth measures of how well the car rode (for tuning springs and dampers). */
  metrics: RideMeasures;
  error?: string;
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
  /** Handling (driver steering): largest distance off the path (m) and largest sideslip (deg). */
  maxPathError?: number;
  maxSideslip?: number;
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
  const durations = segments.map((sg) => { const v = (sg.v0 + sg.v1) / 2; return v > 0 ? sg.distance / v : 0; });
  const total = durations.reduce((a, b) => a + b, 0);
  const maxFrames = o.maxFrames ?? 1500;
  const frameDt = Math.max(1 / (o.hz ?? 25), total / maxFrames);
  const findings: Finding[][] = segments.map(() => []);
  const frames: PlaybackFrame[] = [];
  const checkDt = o.checkEvery ?? 0.01;
  const gripTime = o.gripTime ?? 0.1;
  const handling = !!o.handling;
  // Driven by a driver, a moment at full lock (catching a slide) isn't a failure; running off the line is.
  const INSTANT = new Set(['wheelLift', 'bumpStop', 'bottoming', 'rollover', 'noSolution', ...(handling ? ['pathError', 'spin'] : ['steerLimit'])]);
  if (!(total > 0)) return { frames, findings, metrics: { ...NO_METRICS } };
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
  const kappaAt = (S: number) => {
    let j = 0;
    while (j < segments.length - 1 && S >= starts[j + 1]!) j++;
    return kappas[j]!;
  };

  // The road and accelerations at time t.
  const kinAt = (i: number, tt: number) => {
    const sg = segments[i]!;
    const T = durations[i]!;
    const a = (sg.v1 - sg.v0) / T;
    const s = sg.v0 * tt + 0.5 * a * tt * tt;
    const v = sg.v0 + a * tt;
    let k = segmentAccel(sg, v, a);
    // Ramp from the previous segment's end over the first `ramp` seconds.
    if (i > 0 && ramp > 0 && tt < ramp && durations[i - 1]! > 0) {
      const pv = segments[i - 1]!;
      const pa = (pv.v1 - pv.v0) / durations[i - 1]!;
      const prev = segmentAccel(pv, pv.v1, pa);
      const u = smooth(tt / ramp);
      k = { ay: prev.ay + (k.ay - prev.ay) * u, ax: prev.ax + (k.ax - prev.ax) * u, grade: prev.grade + (k.grade - prev.grade) * u, bank: prev.bank + (k.bank - prev.bank) * u };
    }
    const wh = sg.road ? wheelHeights(sg.road, s, wb, ht) : { FL: 0, FR: 0, RL: 0, RR: 0 };
    const ground = {} as Record<CornerId, number>;
    for (const id of CORNER_IDS) ground[id] = (sg.bumps?.[id] ?? 0) + wh[id];
    return { s, v, ...k, ground };
  };
  const inputAt = (k: ReturnType<typeof kinAt>, ayH?: number) => {
    const eff = roadEffective(ayH ?? k.ay, k.ax, k.grade, k.bank);
    return { ...vehicleInputOf(p, asm, { lateralG: eff.lateralG, brakingG: eff.brakingG, accelG: eff.accelG, gravityScale: eff.gravityScale, groundOffset: k.ground, speed: k.v }), corners };
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
  let H: HandlingState | null = null;
  let maxPathError = 0, maxSideslip = 0;
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
  const advance = (u: number, S: number, grav: number, h: number, kAt: (s: number) => number): HandlingForces => {
    const cmd = driverCommand(car!, H!, u, kAt, S, grav, o.driver);
    const kap = kAt(S);
    let first: HandlingForces | null = null;
    for (let sub = 0; sub < 2; sub++) {
      const fh = handlingNow(u, grav);
      if (!first) first = fh;
      stepHandling(car!, H!, u, kap, fh, grav, cmd, h / 2, o.driver);
    }
    const ayT = first!.sumFy / (car!.mass * G);
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
    // Settle on the first segment's curve (held at t = 0) before the clock starts.
    for (let n = 0; n < 750; n++) advance(u0, 0, grav0, dt, () => kap0);
  }

  /** Accelerations, corner results and body forces at state (x, v). */
  const evaluate = (input: ReturnType<typeof inputAt>, fs: ReturnType<typeof forceSetup>, f: ReturnType<typeof tireForcesFor>, gdot: Record<CornerId, number>, xs: number[], vs: number[]) => {
    const pose: ChassisPose = { heave: xs[0]! * 1000, roll: xs[1]!, pitch: xs[2]! };
    const P = poseFns(pose);
    const q = (k: number) => xs[3 + k]! * 1000;
    const Q = new Array<number>(7).fill(0);
    const M = Array.from({ length: 7 }, () => new Array<number>(7).fill(0));
    const res = {} as Record<CornerId, CornerResult>;
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
      const J = jac(wc);
      // Wheel-center vertical velocity, m/s: body motion at the wheel + travel.
      const vy = J[0][1] * vs[0]! + J[1][1] * vs[1]! + J[2][1] * vs[2]! + dwc.y * vs[3 + k]!;
      const tireExtra = ride.tireDamping * (gdot[id] - vy);
      const cw = tireExtra ? cornerWork(c, input, pose, f[id], shared, q(k), qo, tireExtra) : cw0;
      const dL = Number.isFinite(s.dL) ? s.dL : 0;
      const Ldot = dL * vs[3 + k]!;
      Q[3 + k] = cw.work - (c.damper ? dL * damperForce(c.damper, Ldot) : 0);
      res[id] = cornerResult(c, input, f[id], q(k), status[id], cw);
      const cols: (readonly [number, number, number] | undefined)[] = [J[0], J[1], J[2], undefined, undefined, undefined, undefined];
      cols[3 + k] = [dwc.x, dwc.y, dwc.z];
      addMass(c.unsprungMass, cols);
    });
    const body = bodyResidual(input, sp, fs, pose, res);
    Q[0] = body[0]; Q[1] = body[1]; Q[2] = body[2];
    const Jc = jac(P.point(sp.cg));
    addMass(sp.mass, [Jc[0], Jc[1], Jc[2]]);
    M[1]![1]! += ride.rollInertia;
    M[2]![2]! += ride.pitchInertia;
    const acc = solveLinear(M, Q) ?? new Array<number>(7).fill(0);
    return { acc, res, pose };
  };

  let t0 = 0, nextFrame = 0;
  let x2d = 0, y2d = 0, heading = 0;
  segments.forEach((sg, i) => {
    const T = durations[i]!;
    if (!(T > 0)) return;
    const checks = sg.checks ?? PROFILES.default.checks;
    /** Per check: when the current spell began, whether it was reported, how many spells counted. */
    const spells = new Map<string, { since: number; first: Finding; reported: boolean; count: number; countedThis?: boolean; firstT?: number }>();
    let nextCheck = t0;
    const nSteps = Math.max(1, Math.ceil(T / dt));
    const h = T / nSteps;
    let lastS = 0;
    for (let n = 1; n <= nSteps; n++) {
      const tt = n * h;
      const kin = kinAt(i, tt);
      // Handling: the tires' side forces now set the lateral acceleration the body feels.
      let hf: HandlingForces | null = null;
      let ayH: number | undefined;
      if (H) {
        const grav = G * Math.sin(kin.bank) * Math.cos(kin.grade);
        hf = advance(kin.v, starts[i]! + kin.s, grav, h, kappaAt);
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
      loads = Object.fromEntries(CORNER_IDS.map((id) => [id, now.res[id].tireLoad])) as Record<CornerId, number>;
      caps = capacities(input, now.res, Math.sign(fs.latTotal));
      tires = tireNow(now.res);
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
      const isFrame = !(t + 1e-9 < nextFrame && n < nSteps);
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
        sprungMass: sp.mass, sprungCg: sp.cg, notes: fs.notes, unmet: fs.unmet,
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
      const hd = H ? { pathError: H.eY, sideslip: kin.v >= KINEMATIC_SPEED ? beta : 0, atLock: H.atLock } : undefined;
      const fnd = classifyState({ ...stateFacts(p, asm, st, result, steer), handling: hd }, checks).filter((x) => x.check !== 'beyondGrip');
      // Spells: a check that holds now continues (or starts) its spell; others end theirs.
      const now2 = new Set<string>();
      for (const x of fnd) {
        now2.add(x.check);
        let sp2 = spells.get(x.check);
        if (!sp2) {
          sp2 = { since: t, first: x, reported: false, count: 0 };
          spells.set(x.check, sp2);
        } else if (sp2.since < 0) {
          sp2.since = t;
          sp2.countedThis = false;
        }
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
        ...(H ? { handling: { pathError: H.eY, sideslip: beta, yawRate: H.r, steer: H.delta * DEG, atLock: H.atLock, path: { x: x2d, y: y2d } } } : {}),
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
      findings[i]!.push({ ...x, t: ft, text: `${x.text} (at ${ft.toFixed(1)} s${sp2.count > 1 ? `, ${sp2.count} times` : ''})` });
    }
    t0 += T;
  });
  const nAcc = Math.max(1, metricCount);
  const metrics: RideMeasures = {
    liftTime, bumpStopTime, duration: total,
    loadVariation: Math.sqrt(loadVarSum / Math.max(1, metricCount * 4)),
    heaveAccRms: Math.sqrt(accSum / nAcc),
    ...(H ? { maxPathError, maxSideslip } : {}),
  };
  return { frames, findings, metrics };

  /** The driver's steering as a steering need (for the Steering lock check and the display). */
  function handlingSteer(hs: HandlingState, straight: boolean, kappa: number): SteerNeed | null {
    const tb = car!.table;
    if (tb.ideal || (tb.none && straight)) return null;
    const lockEff = Math.abs(effAt(tb, Math.sign(hs.cmd || hs.rack || 1) * tb.limit, 0));
    const wheel = hs.want;
    return {
      rack: hs.cmd, rackUsed: hs.rack, wheelAngle: wheel * DEG, slip: (wheel - Math.atan(car!.L * kappa)) * DEG, maxAngle: lockEff * DEG,
      steeringWheel: p.steering && p.steering.cFactor > 0 ? (hs.cmd / p.steering.cFactor) * 360 : NaN,
      limit: tb.limit, over: tb.none || Math.abs(hs.cmd) > tb.limit + 1e-6, none: tb.none,
    };
  }
}
