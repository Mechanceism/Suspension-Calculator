/**
 * Vehicle-level quasi-static equilibrium (L6, docs/MATH.md § L6).
 *
 * Vehicle frame: X = left (the FL corner's outboard), Y up (0 = frame bottom), Z forward
 * (0 = front axle). Each corner keeps its own local frame (X outboard, Y up, Z forward from its own
 * axle); left corners map X as-is, right corners mirror X, and rear corners shift Z by −wheelbase.
 *
 * Unknowns: chassis heave dz, roll φ (about +Z) and pitch θ (about +X) relative to the design pose.
 * For a given chassis pose each corner settles independently: the travel q where the virtual work
 * of the tire force, its lateral force, the unsprung weight / inertia and the spring balances along
 * the corner's one degree of freedom. Jacking forces through the instant centers come out of this
 * automatically. Then the whole car must balance: vertical force, roll moment and pitch moment.
 * Lateral tire forces are shared in proportion to each tire's vertical load.
 */
import { pedalForceNeeded } from './brakes';
import { hitchPoint, hitchForce, type TrailerSpec } from './towing';
import { type Vec3, vec3, add, sub, cross } from '../math/vec3';
import { illinois } from '../math/roots';
import { solveLinear } from '../math/linalg';
import { localPatch, type TireProfile } from '../tire/geometry';
import { tireForce, solveLoadedHeight, type TireForceModel } from '../tire/model';
import { springForce, type SpringSpec } from '../suspension/spring';
import type { CornerSampleAt } from './cornerTable';
import type { AxleTable, AxleSampleAt } from './axleTable';

/** What the vehicle solve needs of a corner's tabulated kinematics (independent corner or one wheel of a solid axle). */
export interface CornerTableLike { readonly lo: number; readonly hi: number; at(q: number): CornerSampleAt }
import { mfPeaks, mfSlipAngle, mfSlipRatio, type TireGrip } from '../tire/magicFormula';
import { aeroForces, type AeroInput } from './aero';

export type CornerId = 'FL' | 'FR' | 'RL' | 'RR';
export const CORNER_IDS: CornerId[] = ['FL', 'FR', 'RL', 'RR'];
export const isFront = (id: CornerId) => id === 'FL' || id === 'FR';
export const isLeft = (id: CornerId) => id === 'FL' || id === 'RL';

const G = 9.80665;

export type BrakeMount = 'none' | 'outboard' | 'inboard';
/**
 * Drive for a powered corner. chassis: diff on the chassis, torque through a halfshaft, so the
 * drive force acts at the wheel center. hub: hub motor, torque reacted by the upright, so the force
 * acts at the contact patch. none: not powered.
 */
export type DriveMount = 'none' | 'chassis' | 'hub';

export interface VehicleCorner {
  id: CornerId;
  /** Tabulated kinematics. If an anti-roll bar uses drop links, the table tracks the drop-link mount. */
  table: CornerTableLike;
  /**
   * One wheel of a solid axle: its motion depends on both sides' travel (the table gives the derivatives
   * with respect to the other side too), so the two wheels are always settled together.
   */
  axle?: { table: AxleTable; side: 'L' | 'R' };
  spring: SpringSpec;
  /** kg */
  unsprungMass: number;
  /** Tire geometry, vertical force model and, when this corner's tire differs from the car's, its grip model. */
  tire: { profile: TireProfile; model: TireForceModel; grip?: TireGrip };
  /**
   * Brake mounting. Outboard: the brake torque is reacted by the upright, so the braking force acts
   * at the contact patch. Inboard: reacted by the chassis, so it acts at the wheel center.
   */
  brake?: BrakeMount;
  drive?: DriveMount;
  /** Anti-lock brakes (default true). Without ABS a tire braked past its grip locks and slides. */
  abs?: boolean;
  /** Damper at the damper (coaxial with the spring): bump = compression, rebound = extension. */
  damper?: DamperSpec;
  /** No suspension: the corner's travel is held at 0 (only the tire is compliant). */
  rigid?: boolean;
  /** Fast vertical tire force (N) from the wheel-center height above the ground h0 (mm) and tilt (a lookup table). */
  tireForceAt?: (h0: number, tilt: number) => number;
}

export type DiffType = 'open' | 'locked' | 'lsd';

/**
 * Damper force curve, N·s/m and m/s. Linear: F = c·v. Two-stage (digressive when the high-speed rate is
 * lower): F = c_low·v up to the knee speed, then c_low·v_knee + c_high·(v − v_knee). Bump = compression
 * (the damper shortens), rebound = extension.
 */
export interface DamperSpec {
  bump: number;
  rebound: number;
  bumpHigh?: number;
  reboundHigh?: number;
  bumpKnee?: number;
  reboundKnee?: number;
  /**
   * A measured (dyno) curve per direction: [shaft speed m/s, force N] from 0 out, both growing. When given it
   * replaces the rates: linear between the points, the last segment's slope beyond them.
   */
  curve?: { bump: [number, number][]; rebound: [number, number][] };
}

/** Force (N) on a dyno curve at speed s ≥ 0 (m/s); from (0, 0) through the points, the end slope beyond. */
export function curveForce(pts: [number, number][], s: number): number {
  const p: [number, number][] = [[0, 0], ...pts.filter(([v]) => v > 0)];
  if (p.length < 2) return 0;
  let i = 0;
  while (i < p.length - 2 && s > p[i + 1]![0]) i++;
  const [v0, f0] = p[i]!, [v1, f1] = p[i + 1]!;
  return f0 + ((f1 - f0) * (s - v0)) / ((v1 - v0) || 1);
}

/** Read "shaft speed mm/s, force N" pairs, one per line (or ';'), as a curve (m/s, N); the lines it couldn't read. */
export function parseDamperCurve(text: string): { pts: [number, number][]; bad: string[] } {
  const pts: [number, number][] = [];
  const bad: string[] = [];
  for (const line of text.split(/[\n;]+/).map((l) => l.trim()).filter(Boolean)) {
    const m = /^(-?\d+(?:\.\d+)?)\s*[, \t]\s*(-?\d+(?:\.\d+)?)$/.exec(line);
    if (!m) { bad.push(line); continue; }
    pts.push([Math.abs(Number(m[1])) / 1000, Math.abs(Number(m[2]))]);
  }
  return { pts: pts.sort((a, b) => a[0] - b[0]), bad };
}

/** A clicker between two curves (full soft at t = 0, full firm at 1), blended at every speed either has. */
export function blendCurves(soft: [number, number][], firm: [number, number][], t: number): [number, number][] {
  if (!firm.length || !(t > 0)) return soft;
  if (!soft.length || t >= 1) return firm;
  const speeds = [...new Set([...soft, ...firm].map(([v]) => v))].sort((a, b) => a - b);
  return speeds.map((v) => [v, (1 - t) * curveForce(soft, v) + t * curveForce(firm, v)]);
}

/** Damper force (N) at shaft speed v (m/s, + = extending): the sign of v (it resists the motion). */
export function damperForce(d: DamperSpec, v: number): number {
  const ext = v > 0;
  const cv = d.curve && (ext ? d.curve.rebound : d.curve.bump);
  if (cv && cv.length) return Math.sign(v) * curveForce(cv, Math.abs(v));
  const c = ext ? d.rebound : d.bump;
  const ch = ext ? d.reboundHigh : d.bumpHigh;
  const knee = ext ? d.reboundKnee : d.bumpKnee;
  const s = Math.abs(v);
  const f = ch === undefined || knee === undefined || !(knee > 0) || s <= knee ? c * s : c * knee + ch * (s - knee);
  return Math.sign(v) * f;
}

/** Anti-roll bar between the two corners of an axle. */
export type AntiRollBar =
  | { kind: 'none' }
  /** Rate at the wheel, N/mm of left/right travel difference. */
  | { kind: 'wheelRate'; rate: number }
  /**
   * Torsion bar with drop links to a point on each arm (the corner tables track that point).
   * barRate in N·mm per radian of twist; lever = bar arm length (mm).
   */
  | { kind: 'torsionBar'; barRate: number; lever: number };

/** Heave (third) spring shared by the two corners of an axle: rate at the wheel, N/mm, on the average travel. */
export type HeaveSpring = { kind: 'none' } | { kind: 'wheelRate'; rate: number };

export interface AxleShared {
  antiRollBar: AntiRollBar;
  heaveSpring: HeaveSpring;
}

export interface VehicleInput {
  corners: VehicleCorner[];
  /** Total vehicle mass including unsprung masses, kg. */
  totalMass: number;
  /** Total CG at the static design position, vehicle frame (mm). */
  cg: Vec3;
  /** Front axle (Z = 0) to rear axle, mm. */
  wheelbase: number;
  /**
   * Ground height in the vehicle frame at the design position (mm). The hardpoints describe the car
   * at static ride height on level ground, so this includes the static tire compression
   * (see designGroundY).
   */
  groundY: number;
  /** Lateral acceleration, g (+ = toward +X, a left turn). */
  lateralG: number;
  /** Braking deceleration, g (≥ 0). */
  brakingG?: number;
  /** Fraction of the braking force on the front axle (0–1). */
  brakeBias?: number;
  /** Forward acceleration, g (≥ 0), driven by the powered corners. */
  accelG?: number;
  /** Fraction of the drive force on the front axle when both axles are powered (0–1). */
  driveSplit?: number;
  /** Shared components per axle. */
  shared?: { front: AxleShared; rear: AxleShared };
  /**
   * Share of gravity normal to the road (cos grade · cos bank, default 1). Grade and bank also add to
   * the longitudinal / lateral accelerations the tires must provide; the caller folds those in.
   */
  gravityScale?: number;
  /** Ground height change under each wheel, mm (+ = bump, − = pothole). */
  groundOffset?: Partial<Record<CornerId, number>>;
  /**
   * Tire grip model (Magic Formula). When given: lateral force within each axle is shared so both tires
   * use the same fraction of their grip (friction ellipse with their braking / drive force), and the
   * result reports grip use, slip angles and slip ratios. Without it, lateral force follows tire load.
   */
  tireGrip?: TireGrip;
  /**
   * Brake hydraulics: the most braking force each axle's brakes make at the most pedal force (N, at the
   * tires) and that pedal force (N). Omit = the brakes are always strong enough.
   */
  brakeLimit?: { front: number; rear: number; maxPedal: number };
  /** Towing a trailer (static: it follows the car's accelerations; forces at the hitch). Omit = none. */
  trailer?: TrailerSpec;
  /** Rolling resistance coefficient (rolling only): the tires' drag, force ÷ load. Omit = none. */
  rollingResistance?: number;
  /**
   * The car's speed (m/s) and yaw rate (rad/s, + = turning left), for a locked axle's wheel slips. Without
   * the yaw rate a steady turn's is used (lateral g · g ÷ speed).
   */
  speed?: number;
  yawRate?: number;
  /** Aerodynamics at the car's speed (drag on the body, lift / downforce at each axle). Omit = none. */
  aero?: AeroInput;
  /** Differential per axle for chassis-driven corners (default open). */
  diff?: { front?: DiffType; rear?: DiffType };
  /** Limited-slip torque bias ratio (default 2.5). */
  lsdBias?: number;
}

export type SlipState = 'grip' | 'sliding' | 'abs-limit' | 'locked' | 'wheelspin';

export interface CornerGrip {
  /** Peak force the tire can carry in the direction of its force (friction ellipse), N. */
  capacity: number;
  /** Peak lateral force toward the turn (camber thrust included) and peak longitudinal force, N. */
  capY: number;
  capX: number;
  /** √((Fx/capX)² + (Fy/capY)²) (> 1 = more than the tire can do). */
  utilization: number;
  /** Slip angle (deg, sign of the lateral force) and slip ratio the tire needs; NaN past its peak. */
  slipAngle: number;
  slipRatio: number;
  /** Inclination toward the turn, deg (+ = top leaning into the turn: camber thrust helps). */
  camberToTurn: number;
  state: SlipState;
  /** Force the tire actually delivers when over its limit (sliding: sliding friction; ABS: peak), N. */
  deliverable: number;
  /** Required − deliverable, N (0 when gripping). */
  shortfall: number;
}

export type LimitKind = 'understeer' | 'oversteer' | 'braking' | 'lock-up' | 'traction';

export interface GripSummary {
  corners: Record<CornerId, CornerGrip>;
  /** Lateral grip use per axle (the axle's share of the cornering force ÷ what its tires can still give). */
  axles: { front: number; rear: number };
  /** Every tire within its grip? */
  passed: boolean;
  /** What limits the car here (empty when passed). */
  limits: { kind: LimitKind; corners: CornerId[]; text: string }[];
  /** Worst tire grip use. */
  maxUtilization: number;
}

/** Corner frame → vehicle frame. */
export const placement = (id: CornerId, wheelbase: number) => {
  const side = isLeft(id) ? 1 : -1;
  const dz = isFront(id) ? 0 : -wheelbase;
  return {
    point: (p: Vec3) => vec3(side * p.x, p.y, p.z + dz),
    dir: (d: Vec3) => vec3(side * d.x, d.y, d.z),
  };
};

export interface ChassisPose {
  heave: number;
  roll: number;
  pitch: number;
}

/** Chassis pose: world = Rz(roll)·Rx(pitch)·p + (0, heave, 0). + pitch = nose down. */
export function poseFns(pose: ChassisPose) {
  const cr = Math.cos(pose.roll), sr = Math.sin(pose.roll);
  const cp = Math.cos(pose.pitch), sp = Math.sin(pose.pitch);
  const rot = (p: Vec3): Vec3 => {
    // Rx(pitch) then Rz(roll)
    const y1 = p.y * cp - p.z * sp;
    const z1 = p.y * sp + p.z * cp;
    return vec3(p.x * cr - y1 * sr, p.x * sr + y1 * cr, z1);
  };
  return { rot, point: (p: Vec3) => add(rot(p), vec3(0, pose.heave, 0)) };
}

export type CornerStatus = 'ok' | 'droop-limit' | 'bump-limit';

export interface CornerResult {
  id: CornerId;
  /** Wheel-center travel, mm (+ bump). */
  travel: number;
  status: CornerStatus;
  /** Vertical tire load, N. */
  tireLoad: number;
  /** Lateral tire force, N (world X). */
  lateralForce: number;
  /** Longitudinal tire force, N (world Z; braking is negative, drive positive). */
  longitudinalForce: number;
  /** Braking part (≤ 0) and drive part (≥ 0) of the longitudinal force, N. */
  brakeForce: number;
  driveForce: number;
  /** Spring force, N. */
  springForce: number;
  /** Generalized force from shared components (anti-roll bar + heave spring), N at the wheel. */
  sharedForce: number;
  /** Contact point and wheel center in world coordinates. */
  contact: Vec3;
  wheelCenter: Vec3;
  /** Wheel inclination to the ground, rad, + = top toward the corner's outboard side. */
  inclination: number;
  /** Spin axis in world coordinates (outboard). */
  axisWorld: Vec3;
  /** Spring length, mm, and whether the bump stop is engaged. */
  springLength: number;
  onBumpStop: boolean;
  /** Ground height under this wheel (world Y), mm. */
  groundY: number;
}

export interface VehicleResult {
  pose: ChassisPose;
  corners: Record<CornerId, CornerResult>;
  converged: boolean;
  iterations: number;
  /** Residuals: vertical force (N), roll and pitch moments (N·m). */
  residual: [number, number, number];
  sprungMass: number;
  sprungCg: Vec3;
  /** Things the user should know about the inputs (e.g. acceleration without powered corners). */
  notes: string[];
  /** Grip use and slip per tire (when a grip model is given). */
  grip?: GripSummary;
  /**
   * Velocity changes only come from the tires: acceleration needs powered wheels, braking needs braked
   * wheels. When asked for one without the other, it is left out of the solve and flagged here.
   * brakeCapacity: the brakes (hydraulics) can't make the braking asked even at full pedal force.
   */
  unmet: { accel: boolean; brake: boolean; brakeCapacity?: boolean };
  /** Aero forces at the solved pose, N (drag rearward; lift + up, − = downforce). */
  aero?: { drag: number; liftF: number; liftR: number };
  /** Brake hydraulics given: the pedal force this braking needs and the most the driver applies, N. */
  brakePedal?: { needed: number; max: number };
  /** Towing: the hitch (vehicle frame, design position, mm) and the trailer's force on the car there, N. */
  hitch?: { point: Vec3; force: Vec3 };
}

export function sprungProperties(input: VehicleInput) {
  let m = input.totalMass;
  let sum = vec3(input.cg.x * m, input.cg.y * m, input.cg.z * m);
  for (const c of input.corners) {
    const wc = placement(c.id, input.wheelbase).point(c.table.at(0).wc);
    m -= c.unsprungMass;
    sum = sub(sum, vec3(wc.x * c.unsprungMass, wc.y * c.unsprungMass, wc.z * c.unsprungMass));
  }
  return { mass: m, cg: vec3(sum.x / m, sum.y / m, sum.z / m) };
}

export const NO_SHARED: AxleShared = { antiRollBar: { kind: 'none' }, heaveSpring: { kind: 'none' } };
const partner = (id: CornerId): CornerId => ({ FL: 'FR', FR: 'FL', RL: 'RR', RR: 'RL' } as const)[id];

/**
 * Generalized force (N, along this corner's travel q) from the axle's shared components, with the
 * partner corner's travel held at `qOther`. Energy-based so left and right get equal and opposite
 * (anti-roll bar) or equal (heave spring) shares.
 */
function sharedForce(c: VehicleCorner, partnerC: VehicleCorner | undefined, axle: AxleShared, q: number, qOther: number): number {
  let f = 0;
  const arb = axle.antiRollBar;
  if (arb.kind === 'wheelRate') f -= arb.rate * (q - qOther);
  else if (arb.kind === 'torsionBar' && partnerC && arb.lever > 0 && c.axle && partnerC.axle && c.axle.table === partnerC.axle.table) {
    // One axle (solid axle, twist beam): both mounts move with both travels. U = ½ k θ², θ = (Δy_self − Δy_other) / lever,
    // so the force on this travel is −k θ / lever · (∂y_self/∂q_self − ∂y_other/∂q_self).
    const t = c.axle.table, me = c.axle.side, it = partnerC.axle.side;
    const a = t.at(me, q, qOther), b = t.at(it, qOther, q);
    const a0 = t.at(me, 0, 0), b0 = t.at(it, 0, 0);
    const twist = ((a.ex.y - a0.ex.y) - (b.ex.y - b0.ex.y)) / arb.lever;
    f -= ((arb.barRate * twist) / arb.lever) * (a.dex.y - b.dexX.y);
  } else if (arb.kind === 'torsionBar' && partnerC && arb.lever > 0) {
    // Twist = (drop-link mount height on this side − other side) / lever; torque = barRate · twist.
    const a = c.table.at(q);
    const b = partnerC.table.at(qOther);
    const y0a = c.table.at(0).ex.y;
    const y0b = partnerC.table.at(0).ex.y;
    const twist = ((a.ex.y - y0a) - (b.ex.y - y0b)) / arb.lever;
    f -= ((arb.barRate * twist) / arb.lever) * a.dex.y;
  }
  const hs = axle.heaveSpring;
  if (hs.kind === 'wheelRate') f -= hs.rate * (q + qOther) / 2;
  return f;
}

export interface CornerLoads {
  lateral: number;
  /** Braking force (≤ 0) and drive force (≥ 0), N along world Z. */
  brake: number;
  drive: number;
  /** Longitudinal acceleration of the car, m/s² (+ forward). */
  aZ: number;
}

/**
 * Virtual work along the corner's travel (N) at q, with the partner corner at qOther. Decreasing in q.
 * `tireExtra` adds to the vertical tire force while the tire touches the ground (ride model: tire damping).
 */
export function cornerWork(
  c: VehicleCorner, input: VehicleInput, pose: ChassisPose, f: CornerLoads,
  shared: { partner: VehicleCorner | undefined; axle: AxleShared }, q: number, qOther: number, tireExtra = 0,
) {
  const pl = placement(c.id, input.wheelbase);
  const P = poseFns(pose);
  const inboard = c.brake === 'inboard';
  const hub = c.drive === 'hub';
  const s: CornerSampleAt & Partial<Pick<AxleSampleAt, 'dwcX' | 'dcpmX' | 'dLX'>> = c.axle ? c.axle.table.at(c.axle.side, q, qOther) : c.table.at(q);
  const wc = P.point(pl.point(s.wc));
  const axis = P.rot(pl.dir(s.axis));
  // Tire forces work through the material point at the contact (not the lowest-point path).
  const dcp = P.rot(pl.dir(s.dcpm));
  const dwc = P.rot(pl.dir(s.dwc));
  const gY = input.groundY + (input.groundOffset?.[c.id] ?? 0);
  const h0 = wc.y - gY;
  // Tilt toward the corner's own outboard direction (mirrored axis already points outboard).
  let ft: number;
  if (c.tireForceAt) {
    const f0 = c.tireForceAt(h0, axis.y);
    ft = f0 > 0 ? Math.max(0, f0 + tireExtra) : 0;
  } else {
    const patch = localPatch(c.tire.profile, h0, axis.y);
    ft = patch.inContact ? Math.max(0, tireForce(c.tire.model, c.tire.profile, patch).force + tireExtra) : 0;
  }
  const fs = Number.isFinite(s.L) ? springForce(c.spring, s.L) : 0;
  const fShared = sharedForce(c, shared.partner, shared.axle, q, qOther);
  const work = ft * dcp.y + f.lateral * dcp.x
    // Braking force: at the patch (outboard brake) or the wheel center (inboard brake).
    + f.brake * (inboard ? dwc.z : dcp.z)
    // Drive force: at the wheel center (chassis diff, halfshaft) or the patch (hub motor).
    + f.drive * (hub ? dcp.z : dwc.z)
    - c.unsprungMass * G * (input.gravityScale ?? 1) * dwc.y
    - c.unsprungMass * input.lateralG * G * dwc.x
    - c.unsprungMass * f.aZ * dwc.z
    + (Number.isFinite(s.dL) ? fs * s.dL : 0)
    + fShared;
  // Solid axle: the same forces do work on the other side's travel too (the axle tilts / moves with it).
  let cross = 0;
  if (s.dwcX && s.dcpmX) {
    const dcpX = P.rot(pl.dir(s.dcpmX)), dwcX = P.rot(pl.dir(s.dwcX));
    cross = ft * dcpX.y + f.lateral * dcpX.x + f.brake * (inboard ? dwcX.z : dcpX.z) + f.drive * (hub ? dcpX.z : dwcX.z)
      - c.unsprungMass * G * (input.gravityScale ?? 1) * dwcX.y - c.unsprungMass * input.lateralG * G * dwcX.x - c.unsprungMass * f.aZ * dwcX.z
      + (Number.isFinite(s.dLX ?? NaN) ? fs * s.dLX! : 0);
  }
  return { work, cross, ft, fs, fShared, s, wc, axis, P, pl, gY };
}

export function cornerResult(c: VehicleCorner, input: VehicleInput, f: CornerLoads, q: number, status: CornerStatus, r: ReturnType<typeof cornerWork>): CornerResult {
  const cpWorld = r.P.point(r.pl.point(r.s.cp));
  return {
    id: c.id, travel: q, status, tireLoad: r.ft, lateralForce: f.lateral, longitudinalForce: f.brake + f.drive,
    brakeForce: f.brake, driveForce: f.drive,
    springForce: r.fs, sharedForce: r.fShared,
    contact: vec3(cpWorld.x, r.gY, cpWorld.z), wheelCenter: r.wc,
    // Axis points outboard; its upward component means the top leans inboard (negative camber sense).
    inclination: -Math.asin(Math.max(-1, Math.min(1, r.axis.y))),
    axisWorld: r.axis, groundY: r.gY,
    springLength: r.s.L,
    onBumpStop: c.spring.bumpStopLength !== undefined && Number.isFinite(r.s.L) && r.s.L < c.spring.bumpStopLength,
  };
}

/** 1-D settle of a corner with the partner's travel held fixed (bracketed, so it always converges). */
function settle1(work: (q: number) => number, lo: number, hi: number, guess?: number): { q: number; status: CornerStatus } {
  const wLo = work(lo);
  const wHi = work(hi);
  if (wLo <= 0) return { q: lo, status: 'droop-limit' };
  if (wHi >= 0) return { q: hi, status: 'bump-limit' };
  let a = lo, b = hi, fa = wLo, fb = wHi;
  if (guess !== undefined) {
    // Narrow bracket around the guess first (animation / Newton steps move q only a little).
    const ga = Math.max(lo, guess - 3), gb = Math.min(hi, guess + 3);
    const wa = work(ga), wb = work(gb);
    if (wa > 0 && wb < 0) { a = ga; b = gb; fa = wa; fb = wb; }
  }
  return { q: illinois(work, a, b, fa, fb, 1e-5), status: 'ok' };
}

/**
 * Settle both corners of an axle together when an anti-roll bar or heave spring couples them:
 * 2-unknown Newton on (q_left, q_right), then any corner pushed past its travel limit is held there
 * and the other re-settled.
 */
function settleAxle(
  cs: [VehicleCorner, VehicleCorner], input: VehicleInput, pose: ChassisPose, f: [CornerLoads, CornerLoads],
  axle: AxleShared, guess: [number | undefined, number | undefined],
): [CornerResult, CornerResult] {
  const [a, b] = cs;
  // Both travels' generalized forces at once: each its own wheel's work, plus (solid axle) the other
  // wheel's work on it. One evaluation = two corner evaluations.
  const both = (qa: number, qb: number): [number, number] => {
    const ra = cornerWork(a, input, pose, f[0], { partner: b, axle }, qa, qb);
    const rb = cornerWork(b, input, pose, f[1], { partner: a, axle }, qb, qa);
    return [ra.work + (b.axle ? rb.cross : 0), rb.work + (a.axle ? ra.cross : 0)];
  };
  const wA = (qa: number, qb: number) => both(qa, qb)[0];
  const wB = (qb: number, qa: number) => both(qa, qb)[1];
  let qa = guess[0] ?? 0;
  let qb = guess[1] ?? 0;
  const clampA = (q: number) => Math.min(a.table.hi, Math.max(a.table.lo, q));
  const clampB = (q: number) => Math.min(b.table.hi, Math.max(b.table.lo, q));
  // Remaining generalized force, not counting a corner held at a travel limit that pushes it further.
  const miss = (qa_: number, qb_: number, g: [number, number]) => Math.hypot(
    (qa_ <= a.table.lo + 1e-6 && g[0] < 0) || (qa_ >= a.table.hi - 1e-6 && g[0] > 0) ? 0 : g[0],
    (qb_ <= b.table.lo + 1e-6 && g[1] < 0) || (qb_ >= b.table.hi - 1e-6 && g[1] > 0) ? 0 : g[1]);
  const tol = 1e-6;
  let g = both(qa, qb);
  // Damped Newton: the step is cut back until the miss drops (the work changes slope sharply where a tire
  // leaves the ground, and a full step can jump between the two regimes without settling).
  for (let it = 0; it < 30 && miss(qa, qb, g) > tol; it++) {
    const [ga, gb] = g;
    const h = 1e-3;
    const [pa1, pb1] = both(qa + h, qb), [pa2, pb2] = both(qa, qb + h);
    const j11 = (pa1 - ga) / h;
    const j12 = (pa2 - ga) / h;
    const j21 = (pb1 - gb) / h;
    const j22 = (pb2 - gb) / h;
    const det = j11 * j22 - j12 * j21;
    if (!Number.isFinite(det) || Math.abs(det) < 1e-12) break;
    let da = (-ga * j22 + gb * j12) / det;
    let db = (-gb * j11 + ga * j21) / det;
    const m = Math.max(Math.abs(da), Math.abs(db));
    if (m > 10) { da *= 10 / m; db *= 10 / m; }
    const m0 = miss(qa, qb, g);
    let moved = false;
    for (let k = 0; k < 12; k++, da /= 2, db /= 2) {
      const na = clampA(qa + da), nb = clampB(qb + db);
      const gn = both(na, nb);
      if (miss(na, nb, gn) < m0) { moved = Math.abs(na - qa) > 1e-9 || Math.abs(nb - qb) > 1e-9; qa = na; qb = nb; g = gn; break; }
    }
    if (!moved) break;
  }
  // Fallback when Newton stalls: settle each wheel in turn with the other held (each 1-D settle is bracketed,
  // so it always lands on that wheel's equilibrium), repeated until both agree, then a few Newton-free sweeps.
  for (let sweep = 0; sweep < 60 && miss(qa, qb, g) > tol; sweep++) {
    qa = settle1((q) => wA(q, qb), a.table.lo, a.table.hi, qa).q;
    qb = settle1((q) => wB(q, qa), b.table.lo, b.table.hi, qb).q;
    g = both(qa, qb);
  }
  // Limits: if either corner is pinned, hold it and settle the other on its own.
  let sa: CornerStatus = 'ok';
  let sb: CornerStatus = 'ok';
  const pinned = (q: number, c: VehicleCorner, w: number) =>
    (q <= c.table.lo + 1e-6 && w < 0) ? 'droop-limit' : (q >= c.table.hi - 1e-6 && w > 0) ? 'bump-limit' : 'ok';
  sa = pinned(qa, a, wA(qa, qb));
  sb = pinned(qb, b, wB(qb, qa));
  if (sa !== 'ok' && sb === 'ok') ({ q: qb, status: sb } = settle1((q) => wB(q, qa), b.table.lo, b.table.hi, qb));
  else if (sb !== 'ok' && sa === 'ok') ({ q: qa, status: sa } = settle1((q) => wA(q, qb), a.table.lo, a.table.hi, qa));
  const ra = cornerWork(a, input, pose, f[0], { partner: b, axle }, qa, qb);
  const rb = cornerWork(b, input, pose, f[1], { partner: a, axle }, qb, qa);
  return [cornerResult(a, input, f[0], qa, sa, ra), cornerResult(b, input, f[1], qb, sb, rb)];
}

/** Moments about the vehicle origin: [roll about Z, pitch about X]. */
function momentOf(r: Vec3, f: Vec3): [number, number] {
  const m = cross(r, f);
  return [m.z, m.x];
}

export interface VehicleSolveOptions {
  guess?: ChassisPose;
  cornerGuess?: Partial<Record<CornerId, number>>;
  maxIterations?: number;
}

/** Braking-force shares: front axle gets the bias, split within each axle by tire load among braked corners. */
function brakeShares(input: VehicleInput, loads: Record<CornerId, number>): Record<CornerId, number> {
  const out: Record<CornerId, number> = { FL: 0, FR: 0, RL: 0, RR: 0 };
  const braked = (id: CornerId) => (input.corners.find((c) => c.id === id)?.brake ?? 'outboard') !== 'none';
  const axleLoad = (ids: CornerId[]) => ids.filter(braked).reduce((s, id) => s + Math.max(0, loads[id]), 0);
  const front: CornerId[] = ['FL', 'FR'];
  const rear: CornerId[] = ['RL', 'RR'];
  let bias = Math.min(1, Math.max(0, input.brakeBias ?? 0.6));
  if (axleLoad(front) <= 0) bias = 0;
  if (axleLoad(rear) <= 0) bias = axleLoad(front) > 0 ? 1 : bias;
  for (const [ids, share] of [[front, bias], [rear, 1 - bias]] as const) {
    const total = axleLoad(ids);
    for (const id of ids) out[id] = total > 0 && braked(id) ? (share * Math.max(0, loads[id])) / total : 0;
  }
  return out;
}

/**
 * Share an axle's lateral force F between its tires so both use the same fraction u of their grip
 * (friction ellipse with their longitudinal forces Fx; `capX` defaults to `cap`, a circle).
 * Returns the lateral forces and u.
 */
export function shareLateral(F: number, fx: number[], cap: number[], capX: number[] = cap): { fy: number[]; u: number } {
  const need = Math.abs(F);
  // Friction ellipse: (Fx/capX)² + (Fy/capY)² = u².
  const lat = (u: number) => cap.map((c, i) => c * Math.sqrt(Math.max(0, u * u - (fx[i]! / Math.max(capX[i]!, 1e-9)) ** 2)));
  const total = (u: number) => lat(u).reduce((a, b) => a + b, 0);
  if (cap.every((c) => !(c > 0))) return { fy: cap.map(() => F / cap.length), u: Infinity };
  let lo = 0, hi = 1;
  while (total(hi) < need && hi < 1e3) hi *= 2;
  for (let i = 0; i < 60; i++) { const m = (lo + hi) / 2; if (total(m) < need) lo = m; else hi = m; }
  const u = hi;
  const f = lat(u);
  const sum = f.reduce((a, b) => a + b, 0) || 1;
  return { fy: f.map((v) => (Math.sign(F) * v * need) / sum), u };
}

/** Tires' longitudinal slip stiffness per unit load (force per unit slip ÷ load): ≈ 15–25 for car tires. */
export const SLIP_STIFFNESS = 18;

/**
 * A locked axle (no differential) while turning at yaw rate r: both wheels turn at the same speed, but the
 * outside one has farther to go, so it is dragged back and the inside one pushes. Each wheel's slip
 * κ = (ωR − v) / v with v = u ∓ r · (half track) (left wheel at +y); force = C · κ, C = SLIP_STIFFNESS × load;
 * ωR so that the two add up to the drive asked (coasting: 0). A pair of forces against the yaw: the kart's
 * push (why karts lift the inside rear). Each is capped at its tire's grip. Returns [left, right], N.
 */
export function lockedAxleForces(drive: number, u: number, yaw: number, halfTrack: [number, number], loads: [number, number], peaks: [number, number] | null): [number, number] {
  const v = [u - yaw * halfTrack[0], u + yaw * halfTrack[1]].map((x) => Math.max(x, 0.3));
  const C = loads.map((fz) => SLIP_STIFFNESS * Math.max(fz, 0));
  const sumC = C[0]! + C[1]!;
  if (!(sumC > 0)) return [drive / 2, drive / 2];
  // Σ C_i (ωR − v_i) / v_i = drive → ωR.
  const a = C[0]! / v[0]! + C[1]! / v[1]!;
  const wR = (drive + C[0]! + C[1]!) / a;
  const f = [C[0]! * (wR - v[0]!) / v[0]!, C[1]! * (wR - v[1]!) / v[1]!];
  const cap = (x: number, i: number) => { const p = peaks ? peaks[i]! : Infinity; return Math.max(-p, Math.min(p, x)); };
  return [cap(f[0]!, 0), cap(f[1]!, 1)];
}

/** Within-axle drive split for a differential (forces in proportion; sums to 1). */
function diffSplit(diff: DiffType, loadL: number, loadR: number, bias: number): [number, number] {
  if (diff === 'open') return [0.5, 0.5];
  const l = Math.max(loadL, 0), r = Math.max(loadR, 0);
  if (l + r <= 0) return [0.5, 0.5];
  let a = l / (l + r);
  if (diff === 'lsd') {
    // The more-loaded side can take at most `bias` times the other side's torque.
    const lim = bias / (1 + bias);
    a = Math.min(lim, Math.max(1 - lim, a));
  }
  return [a, 1 - a];
}

/** What a load case asks of the tires, independent of the pose (see solveVehicle). */
export interface ForceSetup {
  /** Gravity share normal to the road and the car's weight on it, N. */
  gs: number;
  W: number;
  /** Total lateral (+ left), braking (magnitude) and drive force the tires must give, N; aZ in m/s² (+ forward). */
  latTotal: number;
  brakeTotal: number;
  driveTotal: number;
  aZ: number;
  driveShares: Record<CornerId, number>;
  /** Front share of the cornering force (yaw balance). */
  frontLatShare: number;
  notes: string[];
  unmet: { accel: boolean; brake: boolean; brakeCapacity?: boolean };
  /** Pedal force the braking needs (with brake hydraulics), N. */
  brakePedal?: { needed: number; max: number };
  /** Towing: hitch point (design, vehicle frame) and the trailer's force on the car, N. */
  hitch?: { point: Vec3; force: Vec3 };
}

export function forceSetup(input: VehicleInput): ForceSetup {
  const gs = input.gravityScale ?? 1;
  const W = input.totalMass * G * gs;
  const latTotalCar = input.totalMass * input.lateralG * G;
  const notes: string[] = [];
  // The car's own acceleration (inertia) and what the tires must push: drag adds to the drive needed
  // (or takes from the braking), at the design ride height.
  const kinematicZ = (Math.max(0, input.accelG ?? 0) - Math.max(0, input.brakingG ?? 0)) * G;
  const rh0 = { front: -input.groundY, rear: -input.groundY };
  const drag = input.aero ? aeroForces(input.aero, rh0, rh0).drag : 0;
  // Towing: the trailer's pull / push and side force at the hitch (it follows the car's accelerations).
  const hitch = input.trailer
    ? { point: hitchPoint(input.trailer, input.groundY, input.wheelbase), force: hitchForce(input.trailer, input.lateralG, kinematicZ / G, gs) }
    : undefined;
  // Rolling resistance: the tires' own drag (load × coefficient), pushed against like the air's.
  const rolling = Math.max(0, input.rollingResistance ?? 0) * gs;
  const tireNet = (input.accelG ?? 0) - (input.brakingG ?? 0) + drag / (input.totalMass * G) + rolling - (hitch ? hitch.force.z / (input.totalMass * G) : 0);
  let brakingG = Math.max(0, -tireNet);
  const powered = input.corners.filter((c) => (c.drive ?? 'none') !== 'none');
  const braked = input.corners.filter((c) => (c.brake ?? 'outboard') !== 'none');
  let accelG = Math.max(0, tireNet);
  const unmet: ForceSetup['unmet'] = { accel: false, brake: false };
  if (accelG > 1e-9 && powered.length === 0) {
    notes.push('No powered corners: the car cannot accelerate (mark corners as Powered).');
    accelG = 0;
    unmet.accel = true;
  }
  if (brakingG > 1e-9 && braked.length === 0) {
    notes.push('No brakes: the car cannot slow down.');
    brakingG = 0;
    unmet.brake = true;
  }
  const brakeTotal = input.totalMass * brakingG * G; // magnitude; acts rearward (−Z) on the tires
  const driveTotal = input.totalMass * accelG * G; // acts forward (+Z) on the powered tires
  // Inertia follows the car's acceleration (what the tires can't deliver is flagged as unmet).
  const aZ = unmet.accel || unmet.brake ? (accelG - brakingG - rolling) * G - drag / input.totalMass : kinematicZ;
  // Drive shares: front/rear by the split (or all to the only powered axle), equal per powered
  // wheel within an axle (open differential).
  const driveShares: Record<CornerId, number> = { FL: 0, FR: 0, RL: 0, RR: 0 };
  {
    const fp = powered.filter((c) => isFront(c.id));
    const rp = powered.filter((c) => !isFront(c.id));
    const split = fp.length && rp.length ? Math.min(1, Math.max(0, input.driveSplit ?? 0.5)) : fp.length ? 1 : 0;
    for (const c of fp) driveShares[c.id] = split / fp.length;
    for (const c of rp) driveShares[c.id] = (1 - split) / rp.length;
  }
  // Cornering force: front/rear shares come from the CG position (yaw balance), not from the tires.
  const L = input.wheelbase;
  // The tires give the car's cornering force less what the hitch gives (the trailer pulls it outward).
  const latTotal = latTotalCar - (hitch?.force.x ?? 0);
  // Yaw balance about the front axle: rear tires · (−L) + hitch force · z_hitch = m · a_y · z_cg.
  let frontLatShare = L > 0 ? Math.min(1, Math.max(0, (L + input.cg.z) / L)) : 0.5;
  if (hitch && L > 0 && Math.abs(latTotal) > 1e-9) {
    const rear = (hitch.force.x * hitch.point.z - latTotalCar * input.cg.z) / L;
    frontLatShare = Math.min(1, Math.max(0, 1 - rear / latTotal));
  }
  // Brake hydraulics: the pedal force this braking needs (the bias splits it front / rear).
  let brakePedal: ForceSetup['brakePedal'];
  if (input.brakeLimit && brakeTotal > 0) {
    const bias = Math.min(1, Math.max(0, input.brakeBias ?? 0.6));
    const L = input.brakeLimit;
    const needed = pedalForceNeeded({ front: brakeTotal * bias, rear: brakeTotal * (1 - bias) }, L, L.maxPedal);
    brakePedal = { needed, max: L.maxPedal };
    if (needed > L.maxPedal * (1 + 1e-6)) {
      unmet.brakeCapacity = true;
      notes.push(`The brakes can't make this braking: it needs ${Number.isFinite(needed) ? needed.toFixed(0) : '∞'} N of pedal force (most ${L.maxPedal.toFixed(0)} N).`);
    }
  }
  return { gs, W, latTotal, brakeTotal, driveTotal, aZ, driveShares, frontLatShare, notes, unmet, ...(brakePedal ? { brakePedal } : {}), ...(hitch ? { hitch } : {}) };
}

/**
 * Lateral, braking and drive force of each tire for the current tire loads: braking by bias then load,
 * drive by split and differential, cornering by yaw balance front / rear and, within an axle, so both
 * tires use the same share of their grip (when their peaks are known) or by load.
 */
export function tireForcesFor(input: VehicleInput, fs: ForceSetup, loads: Record<CornerId, number>, caps: Record<CornerId, TireCaps> | null): Record<CornerId, CornerLoads> {
  const bShares = brakeShares(input, loads);
  const dShares = { ...fs.driveShares };
  const diffOf = (front: boolean): DiffType => (front ? input.diff?.front : input.diff?.rear) ?? 'open';
  const chassisAxle = (l: CornerId, r: CornerId) => [l, r].every((id) => (input.corners.find((c) => c.id === id)?.drive ?? 'none') === 'chassis');
  // A locked axle while turning: forces from the wheels' slips (below), not shares of the drive.
  const lockedDrive: Partial<Record<CornerId, number>> = {};
  for (const [l, r, front] of [['FL', 'FR', true], ['RL', 'RR', false]] as const) {
    if (!chassisAxle(l, r)) continue;
    const axleShare = dShares[l] + dShares[r];
    const u = input.speed ?? 0;
    const yaw = input.yawRate ?? (u > 0.5 ? (input.lateralG * G) / u : 0);
    if (diffOf(front) === 'locked' && u > 0.5 && Math.abs(yaw) > 1e-4) {
      const lc = input.corners.find((c) => c.id === l), rc = input.corners.find((c) => c.id === r);
      if (lc && rc) {
        const ht = (c: VehicleCorner) => Math.abs(c.table.at(0).cp.x) / 1000;
        const f = lockedAxleForces(fs.driveTotal * axleShare, u, yaw, [ht(lc), ht(rc)], [loads[l], loads[r]], caps ? [caps[l].x, caps[r].x] : null);
        lockedDrive[l] = f[0]; lockedDrive[r] = f[1];
        continue;
      }
    }
    const [a, b] = diffSplit(diffOf(front), loads[l], loads[r], input.lsdBias ?? 2.5);
    dShares[l] = axleShare * a; dShares[r] = axleShare * b;
  }
  const brakeF = (id: CornerId) => -fs.brakeTotal * bShares[id];
  const driveF = (id: CornerId) => lockedDrive[id] ?? fs.driveTotal * dShares[id];
  const lat: Record<CornerId, number> = { FL: 0, FR: 0, RL: 0, RR: 0 };
  for (const [l, r, share] of [['FL', 'FR', fs.frontLatShare], ['RL', 'RR', 1 - fs.frontLatShare]] as const) {
    const F = fs.latTotal * share;
    if (caps) {
      const sh = shareLateral(F, [brakeF(l) + driveF(l), brakeF(r) + driveF(r)], [caps[l].y, caps[r].y], [caps[l].x, caps[r].x]);
      lat[l] = sh.fy[0]!; lat[r] = sh.fy[1]!;
    } else {
      const t = Math.max(0, loads[l]) + Math.max(0, loads[r]);
      lat[l] = t > 0 ? (F * Math.max(0, loads[l])) / t : F / 2;
      lat[r] = F - lat[l];
    }
  }
  return Object.fromEntries(CORNER_IDS.map((id) => [id, { lateral: lat[id], brake: brakeF(id), drive: driveF(id), aZ: fs.aZ }])) as Record<CornerId, CornerLoads>;
}

/** Aero forces at a body pose (ride heights from the pose), or null without aero. */
export function aeroAt(input: VehicleInput, pose: ChassisPose): { drag: number; liftF: number; liftR: number } | null {
  if (!input.aero) return null;
  const P = poseFns(pose);
  const rh = { front: P.point(vec3(0, 0, 0)).y - input.groundY, rear: P.point(vec3(0, 0, -input.wheelbase)).y - input.groundY };
  const f = aeroForces(input.aero, rh, { front: -input.groundY, rear: -input.groundY }, { roll: pose.roll });
  return { drag: f.drag, liftF: f.liftF, liftR: f.liftR };
}

/**
 * External forces on the whole car as generalized forces of the body pose: net vertical force (N) and
 * roll / pitch moments about the origin (N·m). Zero in equilibrium; in the ride model they drive the
 * body (tire forces at the contacts, weight and the steady inertia of every mass).
 */
export function bodyResidual(input: VehicleInput, sp: { mass: number; cg: Vec3 }, fs: ForceSetup, pose: ChassisPose, corners: Record<CornerId, CornerResult>): [number, number, number] {
  const P = poseFns(pose);
  let fy = 0, mRoll = 0, mPitch = 0;
  const add2 = ([a, b]: [number, number]) => { mRoll += a; mPitch += b; };
  // Aero on the body: lift / downforce at each axle (ride heights of this pose), drag at its height.
  const aero = aeroAt(input, pose);
  if (aero) {
    const f = P.point(vec3(0, 0, 0)), r = P.point(vec3(0, 0, -input.wheelbase));
    fy += aero.liftF + aero.liftR;
    add2(momentOf(f, vec3(0, aero.liftF, 0)));
    add2(momentOf(r, vec3(0, aero.liftR, 0)));
    add2(momentOf(vec3(0, input.groundY + input.aero!.model.dragHeight, P.point(sp.cg).z), vec3(0, 0, -aero.drag)));
  }
  // Towing: the trailer's force on the body at the hitch.
  if (fs.hitch) {
    fy += fs.hitch.force.y;
    add2(momentOf(P.point(fs.hitch.point), fs.hitch.force));
  }
  for (const c of input.corners) {
    const r = corners[c.id];
    fy += r.tireLoad;
    add2(momentOf(r.contact, vec3(r.lateralForce, r.tireLoad, r.longitudinalForce)));
    // Unsprung weight and inertia (lateral, braking) at the wheel center.
    add2(momentOf(r.wheelCenter, vec3(-c.unsprungMass * input.lateralG * G, -c.unsprungMass * G * fs.gs, -c.unsprungMass * fs.aZ)));
  }
  const cg = P.point(sp.cg);
  add2(momentOf(cg, vec3(-sp.mass * input.lateralG * G, -sp.mass * G * fs.gs, -sp.mass * fs.aZ)));
  return [fy - fs.W, mRoll / 1000, mPitch / 1000];
}

/**
 * The car at a given body pose and wheel travels, without solving for equilibrium (the ride model's
 * state, for drawing and checks): corner forces, tire loads and grip.
 */
export function vehicleAt(input: VehicleInput, pose: ChassisPose, travel: Record<CornerId, number>, status?: Partial<Record<CornerId, CornerStatus>>): VehicleResult {
  const sp = sprungProperties(input);
  const fs = forceSetup(input);
  const byId = Object.fromEntries(input.corners.map((c) => [c.id, c])) as Partial<Record<CornerId, VehicleCorner>>;
  const partnerOf = (id: CornerId) => byId[partner(id)];
  let loads: Record<CornerId, number> = { FL: fs.W / 4, FR: fs.W / 4, RL: fs.W / 4, RR: fs.W / 4 };
  let caps: Record<CornerId, TireCaps> | null = null;
  let corners = {} as Record<CornerId, CornerResult>;
  for (let pass = 0; pass < 3; pass++) {
    const f = tireForcesFor(input, fs, loads, caps);
    corners = {} as Record<CornerId, CornerResult>;
    for (const c of input.corners) {
      const axle = (isFront(c.id) ? input.shared?.front : input.shared?.rear) ?? NO_SHARED;
      const w = cornerWork(c, input, pose, f[c.id], { partner: partnerOf(c.id), axle }, travel[c.id], travel[partner(c.id)]);
      corners[c.id] = cornerResult(c, input, f[c.id], travel[c.id], status?.[c.id] ?? 'ok', w);
    }
    loads = Object.fromEntries(CORNER_IDS.map((id) => [id, corners[id]?.tireLoad ?? 0])) as Record<CornerId, number>;
    if (input.tireGrip) caps = capacities(input, corners, Math.sign(fs.latTotal));
  }
  const out: VehicleResult = {
    pose, corners, converged: true, iterations: 0, residual: bodyResidual(input, sp, fs, pose, corners),
    sprungMass: sp.mass, sprungCg: sp.cg, notes: fs.notes, unmet: fs.unmet, ...(fs.brakePedal ? { brakePedal: fs.brakePedal } : {}), ...(fs.hitch ? { hitch: fs.hitch } : {}),
  };
  if (input.tireGrip && caps) out.grip = gripSummary(input, out, caps, fs.frontLatShare, fs.latTotal);
  return out;
}

export function solveVehicle(input: VehicleInput, options: VehicleSolveOptions = {}): VehicleResult {
  const r = solveVehicleOnce(input, options);
  const acc = Math.abs(input.lateralG) + Math.abs(input.brakingG ?? 0) + Math.abs(input.accelG ?? 0);
  if (acc < 1e-9 || (r.converged && !liftedUnexpectedly(input, r))) return r;
  // Load continuation: ramp the accelerations up from rest, each step starting from the last. From rest
  // the solver can otherwise land on the far, unstable balance (e.g. a "stoppie" on the front wheels)
  // or stall. The direct answer is kept when the ramp does no better.
  let pose: ChassisPose | undefined = undefined;
  let cornerGuess: Partial<Record<CornerId, number>> | undefined;
  let last: VehicleResult | null = null;
  const n = 6;
  for (let k = 1; k <= n; k++) {
    const f = k / n;
    const step = { ...input, lateralG: input.lateralG * f, brakingG: (input.brakingG ?? 0) * f, accelG: (input.accelG ?? 0) * f };
    last = solveVehicleOnce(step, { ...options, guess: pose ?? { heave: 0, roll: 0, pitch: 0 }, ...(cornerGuess ? { cornerGuess } : {}) });
    if (!last.converged) break;
    pose = last.pose;
    cornerGuess = Object.fromEntries(CORNER_IDS.map((id) => [id, last!.corners[id]?.travel]));
  }
  if (last && last.converged && (!r.converged || !liftedUnexpectedly(input, last))) return last;
  return r;
}

/**
 * An axle or a side off the ground that a rigid car would keep loaded (static share minus the rigid load
 * transfer, with 2 % of the weight to spare): the solve found a far, unstable balance.
 */
export function liftedUnexpectedly(input: VehicleInput, r: VehicleResult): boolean {
  const W = input.totalMass * G * (input.gravityScale ?? 1);
  const h = input.cg.y - input.groundY;
  const L = input.wheelbase;
  const lon = (input.brakingG ?? 0) - (input.accelG ?? 0);
  const front = W * (L + input.cg.z) / L + lon * input.totalMass * G * h / L;
  const rear = W - front;
  const ids = (input.corners.map((c) => c.id));
  const off = (list: CornerId[]) => list.every((id) => !ids.includes(id) || (r.corners[id]?.tireLoad ?? 0) <= 1e-6);
  const xs = input.corners.map((c) => Math.abs(r.corners[c.id]?.contact.x ?? 0)).filter((x) => x > 0);
  const track = xs.length ? (2 * xs.reduce((a, b) => a + b, 0)) / xs.length : 0;
  const side = track > 0 ? W / 2 - Math.abs(input.lateralG) * input.totalMass * G * h / track : 0;
  const spare = 0.02 * W;
  return (off(['FL', 'FR']) && front > spare) || (off(['RL', 'RR']) && rear > spare)
    || ((off(['FL', 'RL']) || off(['FR', 'RR'])) && side > spare);
}

function solveVehicleOnce(input: VehicleInput, options: VehicleSolveOptions = {}): VehicleResult {
  const sp = sprungProperties(input);
  const fs = forceSetup(input);
  const { W, latTotal, notes, unmet, frontLatShare } = fs;
  let caps: Record<CornerId, TireCaps> | null = null;
  const latSign = Math.sign(latTotal);
  const byId = Object.fromEntries(input.corners.map((c) => [c.id, c])) as Partial<Record<CornerId, VehicleCorner>>;
  const axleOf = (id: CornerId) => (isFront(id) ? input.shared?.front : input.shared?.rear) ?? NO_SHARED;
  const isCoupled = (a: AxleShared) => a.antiRollBar.kind !== 'none' || a.heaveSpring.kind !== 'none';

  // Tire-force shares (lateral by load; braking by bias then load) follow the solved loads.
  let loads: Record<CornerId, number> = { FL: W / 4, FR: W / 4, RL: W / 4, RR: W / 4 };
  const cornerGuess: Partial<Record<CornerId, number>> = { ...(options.cornerGuess ?? {}) };

  const evaluate = (pose: ChassisPose) => {
    const f = tireForcesFor(input, fs, loads, caps);
    const corners = {} as Record<CornerId, CornerResult>;
    for (const [l, r] of [['FL', 'FR'], ['RL', 'RR']] as const) {
      const cl = byId[l];
      const cr = byId[r];
      const axle = axleOf(l);
      if (cl && cr && (isCoupled(axle) || cl.axle || cr.axle) && !cl.rigid && !cr.rigid) {
        const [rl, rr] = settleAxle([cl, cr], input, pose, [f[l], f[r]], axle, [cornerGuess[l], cornerGuess[r]]);
        corners[l] = rl; corners[r] = rr;
        continue;
      }
      for (const c of [cl, cr]) {
        if (!c) continue;
        const fc = f[c.id];
        const work = (q: number) => cornerWork(c, input, pose, fc, { partner: undefined, axle: NO_SHARED }, q, 0).work;
        const { q, status } = c.rigid ? { q: 0, status: 'ok' as CornerStatus } : settle1(work, c.table.lo, c.table.hi, cornerGuess[c.id]);
        corners[c.id] = cornerResult(c, input, fc, q, status, cornerWork(c, input, pose, fc, { partner: undefined, axle: NO_SHARED }, q, 0));
      }
    }
    return { corners, res: bodyResidual(input, sp, fs, pose, corners) };
  };

  let pose: ChassisPose = options.guess ?? { heave: 0, roll: 0, pitch: 0 };
  let cur = evaluate(pose);
  const norm = (r: number[]) => Math.hypot(r[0]! / Math.max(W, 1), r[1]! / Math.max(W, 1), r[2]! / Math.max(W, 1));
  const tolN = 1e-7;
  let it = 0;
  const maxIt = options.maxIterations ?? 40;
  for (; it < maxIt; it++) {
    // Update the tire-force shares and partner travels from the latest solution.
    const nextLoads = Object.fromEntries(CORNER_IDS.map((id) => [id, cur.corners[id]?.tireLoad ?? 0])) as Record<CornerId, number>;
    let loadsMoved = CORNER_IDS.some((id) => Math.abs(nextLoads[id] - loads[id]) > 1e-4 * W);
    loads = nextLoads;
    if (input.tireGrip) {
      const next = capacities(input, cur.corners, latSign);
      if (!caps || CORNER_IDS.some((id) => Math.abs(next[id].y - caps![id].y) > 1e-4 * W || Math.abs(next[id].x - caps![id].x) > 1e-4 * W)) loadsMoved = true;
      caps = next;
    }
    if (loadsMoved) cur = evaluate(pose);
    for (const id of CORNER_IDS) cornerGuess[id] = cur.corners[id]?.travel;
    if (norm(cur.res) < tolN && !loadsMoved) break;

    // Newton step with a numeric Jacobian.
    const h = [0.01, 1e-5, 1e-5];
    const keys: (keyof ChassisPose)[] = ['heave', 'roll', 'pitch'];
    const J = [[0, 0, 0], [0, 0, 0], [0, 0, 0]];
    keys.forEach((k, j) => {
      const p2 = { ...pose, [k]: pose[k] + h[j]! };
      const r2 = evaluate(p2).res;
      for (let i = 0; i < 3; i++) J[i]![j] = (r2[i]! - cur.res[i]!) / h[j]!;
    });
    const step = solveLinear(J, cur.res.map((v) => -v));
    if (!step) break;
    // Limit the step (scaled as a whole: clipping one component alone turns the step off the Newton
    // direction, and it may then not go downhill at all), then backtrack until the residual drops.
    const lim = [20, 0.05, 0.05];
    const fit = Math.min(1, ...step.map((v, i) => (Math.abs(v) > lim[i]! ? lim[i]! / Math.abs(v) : 1)));
    let s = step.map((v) => v * fit);
    let accepted = false;
    for (let k = 0; k < 8; k++) {
      const trial = { heave: pose.heave + s[0]!, roll: pose.roll + s[1]!, pitch: pose.pitch + s[2]! };
      const rt = evaluate(trial);
      if (norm(rt.res) < norm(cur.res) || k === 7) { pose = trial; cur = rt; accepted = true; break; }
      s = s.map((v) => v / 2);
    }
    if (!accepted) break;
  }
  const out: VehicleResult = {
    pose, corners: cur.corners, converged: norm(cur.res) < 1e-5, iterations: it, residual: cur.res,
    sprungMass: sp.mass, sprungCg: sp.cg, notes, unmet, ...(fs.brakePedal ? { brakePedal: fs.brakePedal } : {}), ...(fs.hitch ? { hitch: fs.hitch } : {}),
  };
  if (input.tireGrip) out.grip = gripSummary(input, out, capacities(input, cur.corners, latSign), frontLatShare, latTotal);
  const aero = aeroAt(input, pose);
  if (aero) out.aero = aero;
  return out;
}

/** Inflation pressure of a tire model, kPa (the air-spring model's set pressure; none for the stiffness model). */
export const tirePressure = (m: TireForceModel): number | undefined => (m.kind === 'gas' ? m.conditions.setPressure : undefined);

/** A tire's peaks at its solved load, inclination and pressure (Magic Formula). */
export interface TireCaps {
  /** Peak lateral force toward the turn, peak longitudinal force, N. */
  y: number;
  x: number;
  slideY: number;
  slideX: number;
  /** Load, inclination toward the turn (rad) and pressure used. */
  fz: number;
  gamma: number;
  pressure?: number;
}

/**
 * Peak forces of each tire. Its inclination counts toward the turn (latSign: +1 left, −1 right): a wheel
 * whose top leans into the turn gets camber thrust on top of its peak. Straight ahead (latSign 0) the
 * camber only lowers the peak, so both lean directions are averaged.
 */
export function capacities(input: VehicleInput, corners: Record<CornerId, CornerResult>, latSign: number): Record<CornerId, TireCaps> {
  const out = {} as Record<CornerId, TireCaps>;
  for (const id of CORNER_IDS) out[id] = { y: 0, x: 0, slideY: 1, slideX: 1, fz: 0, gamma: 0 };
  for (const c of input.corners) {
    const r = corners[c.id];
    if (!r) continue;
    const m = c.tire.grip ?? input.tireGrip!;
    const fz = Math.max(r.tireLoad, 0);
    const pressure = tirePressure(c.tire.model);
    // inclination: + = top toward the outboard side; the outboard side is +X for left corners.
    const toward = r.inclination * (isLeft(c.id) ? 1 : -1) * latSign;
    if (latSign !== 0) {
      const pk = mfPeaks(m, { fz, gamma: toward, pressure });
      out[c.id] = { y: pk.y, x: pk.x, slideY: pk.slideY, slideX: pk.slideX, fz, gamma: toward, pressure };
    } else {
      const a = mfPeaks(m, { fz, gamma: r.inclination, pressure });
      const b = mfPeaks(m, { fz, gamma: -r.inclination, pressure });
      out[c.id] = { y: (a.y + b.y) / 2, x: a.x, slideY: (a.slideY + b.slideY) / 2, slideX: a.slideX, fz, gamma: 0, pressure };
    }
  }
  return out;
}

/** Grip use, slip states and what limits the car (see docs/MATH.md § Grip and slip). */
export function gripSummary(input: VehicleInput, r: VehicleResult, cap: Record<CornerId, TireCaps>, frontShare: number, latTotal: number): GripSummary {
  const latSign = Math.sign(latTotal);
  const byId = Object.fromEntries(input.corners.map((c) => [c.id, c])) as Partial<Record<CornerId, VehicleCorner>>;
  const corners = {} as Record<CornerId, CornerGrip>;
  for (const id of CORNER_IDS) {
    const m = byId[id]?.tire.grip ?? input.tireGrip!;
    const c = r.corners[id];
    const k = cap[id];
    const Cy = Math.max(k.y, 1e-9), Cx = Math.max(k.x, 1e-9);
    const fx = c.longitudinalForce, fy = c.lateralForce;
    const need = Math.hypot(fx, fy);
    const u = Math.hypot(fx / Cx, fy / Cy);
    // Peak force along the force's direction, and the sliding share there.
    const Cdir = need > 1e-9 && u > 0 ? need / u : Cy;
    const slide = need > 1e-9 ? (Math.abs(fx) * k.slideX + Math.abs(fy) * k.slideY) / (Math.abs(fx) + Math.abs(fy)) : k.slideY;
    let state: SlipState = 'grip';
    if (c.brakeForce < 0 && Math.abs(fx) > Cx) state = byId[id]?.abs === false ? 'locked' : 'abs-limit';
    else if (c.driveForce > 0 && Math.abs(fx) > Cx) state = 'wheelspin';
    else if (u > 1) state = 'sliding';
    const deliverable = state === 'grip' ? need : state === 'abs-limit' ? Cdir : slide * Cdir;
    // Slip the tire needs: the pure-slip force equivalent on the ellipse, inverted on its curve.
    const inp = { fz: k.fz, gamma: k.gamma, pressure: k.pressure };
    const ex = Math.min(0.9999, (fx / Cx) ** 2), ey = Math.min(0.9999, (fy / Cy) ** 2);
    const dirY = latSign || Math.sign(fy) || 1;
    const alpha = Math.abs(fy) < 1e-6 ? 0 : dirY * mfSlipAngle(m, (dirY * fy) / Math.sqrt(1 - ex), inp);
    const kappa = Math.abs(fx) < 1e-6 ? 0 : mfSlipRatio(m, fx / Math.sqrt(1 - ey), inp);
    corners[id] = {
      capacity: Cdir, capY: k.y, capX: k.x, utilization: u, state, deliverable, shortfall: Math.max(0, need - deliverable),
      slipAngle: (alpha * 180) / Math.PI, slipRatio: kappa, camberToTurn: (k.gamma * 180) / Math.PI,
    };
  }
  const axleU = (l: CornerId, rr: CornerId, share: number) =>
    shareLateral(latTotal * share, [r.corners[l].longitudinalForce, r.corners[rr].longitudinalForce], [cap[l].y, cap[rr].y], [cap[l].x, cap[rr].x]).u;
  const axles = { front: Math.abs(latTotal) > 1e-6 ? axleU('FL', 'FR', frontShare) : 0, rear: Math.abs(latTotal) > 1e-6 ? axleU('RL', 'RR', 1 - frontShare) : 0 };
  const limits: GripSummary['limits'] = [];
  const over = (ids: CornerId[], states: SlipState[]) => ids.filter((id) => states.includes(corners[id].state));
  const locked = over(CORNER_IDS, ['locked']);
  if (locked.length) limits.push({ kind: 'lock-up', corners: locked, text: `${locked.join(', ')} lock up (no ABS): sliding, no steering grip` });
  const abs = over(CORNER_IDS, ['abs-limit']);
  if (abs.length) limits.push({ kind: 'braking', corners: abs, text: `${abs.join(', ')} at the ABS limit: can't brake this hard` });
  const spin = over(CORNER_IDS, ['wheelspin']);
  if (spin.length) limits.push({ kind: 'traction', corners: spin, text: `${spin.join(', ')} wheelspin: not enough traction` });
  if (axles.front > 1 && axles.front >= axles.rear) limits.push({ kind: 'understeer', corners: ['FL', 'FR'], text: `Front axle out of grip (${(axles.front * 100).toFixed(0)}%): understeer, the car runs wide` });
  if (axles.rear > 1 && axles.rear > axles.front) limits.push({ kind: 'oversteer', corners: ['RL', 'RR'], text: `Rear axle out of grip (${(axles.rear * 100).toFixed(0)}%): oversteer, the rear slides` });
  const sliding = over(CORNER_IDS, ['sliding']).filter((id) => !limits.some((l) => l.corners.includes(id)));
  if (sliding.length) limits.push({ kind: isFront(sliding[0]!) ? 'understeer' : 'oversteer', corners: sliding, text: `${sliding.join(', ')} sliding` });
  const maxUtilization = Math.max(...CORNER_IDS.map((id) => corners[id].utilization));
  return { corners, axles, passed: limits.length === 0 && maxUtilization <= 1, limits, maxUtilization };
}

/**
 * Static corner weights from the CG (N), treating each axle as a beam: front/rear split by the CG's
 * Z position, left/right within each axle by its X position. Used to fit springs and as the default
 * corner load in the Corner workbench.
 */
export function staticCornerLoads(totalMass: number, cg: Vec3, wheelbase: number, contactX: Record<CornerId, number>): Record<CornerId, number> {
  const W = totalMass * G;
  const front = W * ((cg.z + wheelbase) / wheelbase);
  const rear = W - front;
  const split = (load: number, xl: number, xr: number) => {
    const left = load * ((cg.x - xr) / (xl - xr));
    return [left, load - left] as const;
  };
  const [fl, fr] = split(front, contactX.FL, -contactX.FR);
  const [rl, rr] = split(rear, contactX.RL, -contactX.RR);
  return { FL: fl, FR: fr, RL: rl, RR: rr };
}

/** Kinematic roll center of an axle from its two corners (world/vehicle front view). */
export function axleRollCenter(
  left: { contact: Vec3; ic: Vec3 | null; dir?: Vec3 }, right: { contact: Vec3; ic: Vec3 | null; dir?: Vec3 },
): { x: number; y: number } | null {
  const line = (c: { contact: Vec3; ic: Vec3 | null; dir?: Vec3 }) => {
    const d = c.ic ? sub(c.ic, c.contact) : c.dir;
    return d ? { p: c.contact, d } : null;
  };
  const a = line(left);
  const b = line(right);
  if (!a || !b) return null;
  const den = a.d.x * b.d.y - a.d.y * b.d.x;
  if (Math.abs(den) < 1e-12) return null;
  const t = ((b.p.x - a.p.x) * b.d.y - (b.p.y - a.p.y) * b.d.x) / den;
  return { x: a.p.x + a.d.x * t, y: a.p.y + a.d.y * t };
}


/**
 * Design ground height: the rigid-tire contact height raised by the average static tire compression so the car sits at its design ride height under static load.
 */
export function designGroundY(
  corners: { contactY: number; profile: TireProfile; model: TireForceModel; staticLoad: number; tilt: number }[],
): number {
  let sum = 0;
  for (const c of corners) {
    const h = solveLoadedHeight(c.model, c.profile, c.tilt, Math.max(c.staticLoad, 1)).centerHeight;
    sum += c.contactY + (c.profile.radius - h);
  }
  return sum / corners.length;
}
