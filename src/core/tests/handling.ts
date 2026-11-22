/**
 * Handling over time (Phase C): the car is steered along the test's path by a driver model, and each
 * tire's side force comes from its own slip angle (docs/MATH.md § Tests, Phase C).
 *
 * Planar states (on top of the ride's heave / roll / pitch / travels): lateral velocity v (m/s, + left),
 * yaw rate r (rad/s, + left), distance off the path eY (m, + left), heading error to the path ePsi (rad)
 * and the steering. The forward speed u follows the test's speed profile.
 *
 *   slip angle      α_i = δ_i − atan2(v + r·a_i, u − r·y_i)      (a_i forward, y_i left of the CG)
 *   side force      F_i = MF(α_i, load, inclination, pressure) · √(1 − (Fx_i / Fx,peak)²)
 *   lateral         v̇ = Σ F_i,y / m + g·sin(bank)·cos(grade) − u·r
 *   yaw             I_z·ṙ = Σ (a_i·F_i,y − y_i·F_i,x)
 *   path            ėY = u·sin ePsi + v·cos ePsi,   ėPsi = r − u·κ(s)
 *
 * Each wheel's steer angle comes from the car's own steering kinematics (a table of road-wheel angle vs
 * rack travel, so Ackermann / anti-Ackermann is in it) and the rack stops at its limit.
 *
 * Driver: looks a preview distance D = max(5 m, u·Tp), Tp = 0.7 s, ahead, predicts where the car will be if it keeps
 * its course (eY + D·sin χ, χ = course angle to the path) and steers so the car would arrive on the path
 * there (single-point preview), plus the understeer it has learned (K·a_y), through a steering lag and a
 * steering-rate limit:
 *   e = y_path(D) − (eY + D·sin χ),   δ_cmd = atan(2·L·e / D²) + K · (u²·2e / D² − g_bank) / g
 * Below 3 m/s the tires barely slip: the car follows its steering geometrically (kinematic bicycle).
 */
import type { AssembledVehicle, VehicleProblem } from '../optimize/vehicle';
import { CORNER_IDS, isFront, isLeft, placement, shareLateral, type CornerId, type GripSummary, type TireCaps } from '../vehicle/vehicle';
import { mfLateral, mfPeaks, mfPeakSlips, DEFAULT_MF, type TireGrip } from '../tire/magicFormula';
import { wheelSteerAngle } from './steer';
import { G } from './segments';

/** Road-wheel angle of each wheel vs rack travel (from the steering kinematics, at ride height). */
export interface SteerTable {
  /** Rack travel samples, mm (left corner's rack input), from −limit to +limit. */
  rack: number[];
  /** Each wheel's heading change, rad (+ = front of the wheel toward the left). */
  wheel: Record<CornerId, number[]>;
  /** Effective steer angle: mean steered front angle − mean steered rear angle, rad. */
  eff: number[];
  limit: number;
  /** No steered wheels (or the rack doesn't turn them). */
  none: boolean;
  /** No steering data: the front wheels take the commanded angle, no limit. */
  ideal: boolean;
}

const TABLES = new WeakMap<AssembledVehicle, SteerTable>();

export function steerTable(p: VehicleProblem, asm: AssembledVehicle): SteerTable {
  const hit = TABLES.get(asm);
  if (hit) return hit;
  const s = p.steering;
  const zeros = { FL: [], FR: [], RL: [], RR: [] } as Record<CornerId, number[]>;
  let t: SteerTable;
  if (!s) t = { rack: [], wheel: zeros, eff: [], limit: Infinity, none: false, ideal: true };
  else {
    const limit = Math.abs(s.rackLimit);
    const ids = CORNER_IDS.filter((id) => s.steered[id]);
    const N = 41;
    const rack = Array.from({ length: N }, (_, k) => -limit + (2 * limit * k) / (N - 1));
    const wheel = {} as Record<CornerId, number[]>;
    for (const id of CORNER_IDS) {
      const c = asm.built.get(p.roots[id]);
      wheel[id] = rack.map((r) => (!s.steered[id] || !c ? 0 : isLeft(id) ? wheelSteerAngle(c, r) : -wheelSteerAngle(c, -r)));
      fillGaps(wheel[id]);
    }
    const front = ids.filter(isFront), rear = ids.filter((id) => !isFront(id));
    const mean = (g: CornerId[], k: number) => (g.length ? g.reduce((a, id) => a + wheel[id][k]!, 0) / g.length : 0);
    const eff = rack.map((_, k) => mean(front, k) - mean(rear, k));
    const span = Math.abs(eff[N - 1]! - eff[0]!);
    t = { rack, wheel, eff, limit, none: !(limit > 0) || ids.length === 0 || !(span > 1e-4) || !eff.every(Number.isFinite), ideal: false };
  }
  TABLES.set(asm, t);
  return t;
}

/** Replace NaN samples (the corner couldn't be solved there) by the nearest solved one. */
function fillGaps(a: number[]) {
  const ok = a.map(Number.isFinite);
  if (!ok.some(Boolean)) { a.fill(0); return; }
  for (let i = 0; i < a.length; i++) {
    if (ok[i]) continue;
    let j = 1;
    while (!(ok[i - j] ?? false) && !(ok[i + j] ?? false)) j++;
    a[i] = ok[i - j] ? a[i - j]! : a[i + j]!;
  }
}

/** Linear interpolation on increasing (not necessarily even) samples xs. */
const lerp = (xs: number[], ys: number[], x: number) => {
  const n = xs.length;
  if (x <= xs[0]!) return ys[0]!;
  if (x >= xs[n - 1]!) return ys[n - 1]!;
  let lo = 0, hi = n - 1;
  while (hi - lo > 1) { const m = (lo + hi) >> 1; if (xs[m]! <= x) lo = m; else hi = m; }
  const w = xs[hi]! - xs[lo]!;
  return ys[lo]! + (w > 0 ? ((ys[hi]! - ys[lo]!) * (x - xs[lo]!)) / w : 0);
};

/** Rack travel (mm) for an effective steer angle, clamped to the limit; atLock when it needs more. */
export function rackFor(t: SteerTable, eff: number): { rack: number; needed: number; atLock: boolean } {
  if (t.ideal || t.none) return { rack: 0, needed: NaN, atLock: t.none && Math.abs(eff) > 1e-3 };
  const n = t.eff.length;
  const inc = t.eff[n - 1]! >= t.eff[0]!;
  const e = inc ? t.eff : [...t.eff].reverse();
  const r = inc ? t.rack : [...t.rack].reverse();
  const lo = e[0]!, hi = e[n - 1]!;
  if (eff >= lo && eff <= hi) { const rack = lerp(e, r, eff); return { rack, needed: rack, atLock: false }; }
  // Beyond full lock: the end of the table, and a linear estimate of what it would need.
  const end = eff > hi ? n - 1 : 0;
  const k = (e[n - 1]! - e[0]!) / (r[n - 1]! - r[0]!);
  return { rack: r[end]!, needed: r[end]! + (eff - e[end]!) / (k || 1e-9), atLock: true };
}

/** Each wheel's steer angle (rad, + left) at a rack travel, or the ideal front angle without data. */
export function wheelAngles(t: SteerTable, rack: number, effIdeal: number): Record<CornerId, number> {
  if (t.ideal) return { FL: effIdeal, FR: effIdeal, RL: 0, RR: 0 };
  if (t.none) return { FL: 0, FR: 0, RL: 0, RR: 0 };
  return Object.fromEntries(CORNER_IDS.map((id) => [id, lerp(t.rack, t.wheel[id], rack)])) as Record<CornerId, number>;
}

export const effAt = (t: SteerTable, rack: number, effIdeal: number) =>
  (t.ideal ? effIdeal : t.none ? 0 : lerp(t.rack, t.eff, rack));

/** The car as the handling model sees it. */
export interface HandlingCar {
  mass: number;
  /** Yaw inertia about the CG, kg·m². */
  yawInertia: number;
  /** Contact patch positions from the CG: a forward, y left, m. */
  pos: Record<CornerId, { a: number; y: number }>;
  /** Wheelbase and CG to rear axle, m. */
  L: number;
  b: number;
  grip: Record<CornerId, TireGrip>;
  pressure: Record<CornerId, number | undefined>;
  locks: Record<CornerId, boolean>;
  table: SteerTable;
}

export function handlingCar(p: VehicleProblem, asm: AssembledVehicle, pressure: Record<CornerId, number | undefined>): HandlingCar {
  const pos = {} as HandlingCar['pos'];
  const grip = {} as HandlingCar['grip'];
  const locks = {} as HandlingCar['locks'];
  for (const c of asm.corners) {
    const pt = placement(c.id, p.wheelbase).point(asm.chars[c.id].contactPoint);
    pos[c.id] = { a: (pt.z - asm.cg.z) / 1000, y: (pt.x - asm.cg.x) / 1000 };
    grip[c.id] = c.tire.grip ?? p.tireGrip ?? DEFAULT_MF;
    locks[c.id] = c.abs === false;
  }
  const L = Math.max(p.wheelbase / 1000, 0.1);
  const b = Math.min(L, Math.max(0, -(pos.RL.a + pos.RR.a) / 2));
  const yawInertia = p.ride?.yawInertia ?? p.mass * (0.45 * L) ** 2;
  return { mass: p.mass, yawInertia: Math.max(yawInertia, 1), pos, L, b, grip, pressure, locks, table: steerTable(p, asm) };
}

/** Planar state of the car. */
export interface HandlingState {
  v: number;
  r: number;
  eY: number;
  ePsi: number;
  /** Effective steer angle reached, rad (after lag and rate limit, clamped at full lock). */
  delta: number;
  /** Rack travel, mm, and the driver's command (may be beyond full lock). */
  rack: number;
  cmd: number;
  atLock: boolean;
  /** The driver's command, rad (effective road-wheel angle). */
  want: number;
  /** Learned understeer, rad per g of lateral acceleration. */
  K: number;
}

/** What each tire is doing now (from the ride model). */
export interface TireNow { fz: number; gammaLeft: number; fx: number }

export interface HandlingForces {
  /** Vehicle-frame lateral force per tire (N, + left), slip angle (rad). */
  fy: Record<CornerId, number>;
  alpha: Record<CornerId, number>;
  wheels: Record<CornerId, number>;
  sumFy: number;
  mz: number;
}

export const KINEMATIC_SPEED = 3;

/** Tire side forces and yaw moment at a state. */
export function handlingForces(car: HandlingCar, st: HandlingState, u: number, tires: Record<CornerId, TireNow>, wheels: Record<CornerId, number>): HandlingForces {
  const fy = {} as Record<CornerId, number>, alpha = {} as Record<CornerId, number>;
  let sumFy = 0, mz = 0;
  for (const id of CORNER_IDS) {
    const { a, y } = car.pos[id];
    const t = tires[id];
    const d = wheels[id];
    const vx = Math.max(u - st.r * y, 0.5), vy = st.v + st.r * a;
    const al = d - Math.atan2(vy, vx);
    alpha[id] = al;
    const inp = { fz: Math.max(t.fz, 0), gamma: t.gammaLeft, pressure: car.pressure[id] };
    let f = t.fz > 0 ? mfLateral(car.grip[id], al, inp) : 0;
    // Friction ellipse with the braking / drive force (a locked wheel has no side grip).
    if (f && t.fx) {
      const cx = Math.max(mfPeaks(car.grip[id], inp).x, 1e-6);
      const share = 1 - (t.fx / cx) ** 2;
      f *= share > 0 ? Math.sqrt(share) : car.locks[id] && t.fx < 0 ? 0 : 0.2;
    }
    const fyv = f * Math.cos(d) + t.fx * Math.sin(d);
    const fxv = t.fx * Math.cos(d) - f * Math.sin(d);
    fy[id] = fyv;
    sumFy += fyv;
    mz += a * fyv - y * fxv;
  }
  return { fy, alpha, wheels, sumFy, mz };
}

/** Lateral offset of the path D metres ahead, in the frame of its tangent here (m, + left). */
export function pathOffset(kappaAt: (s: number) => number, s: number, D: number): number {
  const n = 10, ds = D / n;
  let psi = 0, y = 0;
  for (let j = 0; j < n; j++) {
    const k = kappaAt(s + (j + 0.5) * ds);
    const mid = psi + (k * ds) / 2;
    y += Math.sin(mid) * ds;
    psi += k * ds;
  }
  return y;
}

export interface DriverSpec {
  /** Preview time, s (default 0.7). */
  preview?: number;
  /** Steering lag, s (default 0.05). */
  lag?: number;
  /** Most road-wheel steering rate, rad/s (default 0.9 ≈ 50°/s). */
  rate?: number;
}

/**
 * The driver's steering command (effective road-wheel angle, rad). `grav`: gravity's pull along the road
 * toward the left (m/s², a bank): the tires then need only u²κ − grav, and so does the understeer.
 */
export function driverCommand(car: HandlingCar, st: HandlingState, u: number, kappaAt: (s: number) => number, s: number, grav = 0, d: DriverSpec = {}): number {
  const D = Math.max(5, Math.max(u, 0) * (d.preview ?? 0.7));
  const chi = st.ePsi + Math.atan2(st.v, Math.max(u, 0.5));
  const e = pathOffset(kappaAt, s, D) - (st.eY + D * Math.sin(chi));
  const kappa = (2 * e) / (D * D);
  return Math.atan(car.L * kappa) + st.K * ((u * u * kappa - grav) / G);
}

/**
 * Advance the planar state by h with the forces at its start (semi-implicit: velocities first, then the
 * path errors with the new velocities). Returns the derivatives used.
 */
export function stepHandling(
  car: HandlingCar, st: HandlingState, u: number, kappa: number, f: HandlingForces, grav: number, cmd: number, h: number, d: DriverSpec = {},
) {
  // Steering: lag and rate limit toward the command, the rack stops at full lock.
  const rate = d.rate ?? 0.9, lag = d.lag ?? 0.05;
  // The driver can't steer past full lock (asks at most a little more, so a need beyond it shows).
  if (!car.table.ideal && !car.table.none) {
    const lockL = effAt(car.table, car.table.limit, 0), lockR = effAt(car.table, -car.table.limit, 0);
    const hi = Math.max(lockL, lockR) + 0.1, lo = Math.min(lockL, lockR) - 0.1;
    cmd = Math.max(lo, Math.min(hi, cmd));
  }
  const want = (cmd - st.delta) / lag;
  const next = st.delta + h * Math.max(-rate, Math.min(rate, want));
  const rk = rackFor(car.table, next);
  st.want = cmd;
  st.cmd = car.table.ideal ? NaN : rackFor(car.table, cmd).needed;
  st.rack = rk.rack;
  st.atLock = rk.atLock;
  st.delta = effAt(car.table, rk.rack, next);
  if (u < KINEMATIC_SPEED) {
    // Kinematic bicycle: no slip at the rear axle.
    st.r = (u * Math.tan(st.delta)) / car.L;
    st.v = st.r * car.b;
  } else {
    st.v += h * (f.sumFy / car.mass + grav - u * st.r);
    st.r += h * (f.mz / car.yawInertia);
    // Past ≈ 40° of sideslip the model means little: hold it there (the spin check has long failed).
    const vMax = u * Math.tan(0.7);
    st.v = Math.max(-vMax, Math.min(vMax, st.v));
    const rMax = Math.abs(u * kappa) + 2;
    st.r = Math.max(-rMax, Math.min(rMax, st.r));
  }
  st.eY += h * (u * Math.sin(st.ePsi) + st.v * Math.cos(st.ePsi));
  st.ePsi += h * (st.r - u * kappa);
}

/** Lateral force per tire in the kinematic (slow) mode: total by the yaw balance, within an axle by load. */
export function kinematicForces(car: HandlingCar, total: number, loads: Record<CornerId, number>): Record<CornerId, number> {
  const out = {} as Record<CornerId, number>;
  const frontShare = car.L > 0 ? car.b / car.L : 0.5;
  for (const [l, r, share] of [['FL', 'FR', frontShare], ['RL', 'RR', 1 - frontShare]] as const) {
    const F = total * share;
    const sum = Math.max(0, loads[l]) + Math.max(0, loads[r]);
    out[l] = sum > 0 ? (F * Math.max(0, loads[l])) / sum : F / 2;
    out[r] = F - out[l];
  }
  return out;
}

/** Slip angle ÷ the tire's peak slip angle (> 1 = past the peak: the tire slides). */
export function slipUse(car: HandlingCar, alpha: Record<CornerId, number>, tires: Record<CornerId, TireNow>): Record<CornerId, number> {
  const out = {} as Record<CornerId, number>;
  for (const id of CORNER_IDS) {
    const t = tires[id];
    if (!(t.fz > 25)) { out[id] = 0; continue; }
    const dir = Math.sign(alpha[id]) || 1;
    const pk = mfPeakSlips(car.grip[id], { fz: t.fz, gamma: dir * t.gammaLeft, pressure: car.pressure[id] }).alpha;
    out[id] = pk > 1e-6 ? Math.abs(alpha[id]) / pk : 0;
  }
  return out;
}

/**
 * Grip as the driven car uses it: the axles' use from the forces the tires actually give, and a tire past
 * its peak slip angle slides (its force can't exceed the peak, so the force alone wouldn't show it).
 */
export function handlingGrip(g: GripSummary, fx: Record<CornerId, number>, fy: Record<CornerId, number>, caps: Record<CornerId, TireCaps>, use: Record<CornerId, number>) {
  for (const id of CORNER_IDS) {
    const c = g.corners[id];
    if (use[id] > 1) {
      c.utilization = Math.max(c.utilization, use[id]);
      if (c.state === 'grip') c.state = 'sliding';
    }
  }
  const axle = (l: CornerId, r: CornerId) => {
    const u = shareLateral(fy[l] + fy[r], [fx[l], fx[r]], [caps[l].y, caps[r].y], [caps[l].x, caps[r].x]).u;
    const slide = (use[l] + use[r]) / 2;
    return slide > 1 ? Math.max(u, slide) : u;
  };
  g.axles = { front: axle('FL', 'FR'), rear: axle('RL', 'RR') };
  g.maxUtilization = Math.max(...CORNER_IDS.map((id) => g.corners[id].utilization));
  g.passed = g.passed && g.maxUtilization <= 1;
}
